import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/ops/doctor.js";
import { installationKey } from "../../src/telemetry/storage.js";
import { workspace, write } from "../helpers.js";
import { traceFixture } from "../telemetry/helpers.js";

afterEach(() => vi.unstubAllGlobals());
async function setup(user = "router:\n  provider: mock\n") {
  const ctx = await workspace();
  const directory = join(ctx.root, "data");
  await write(join(ctx.home, ".config/skilldispatch/config.yaml"), user);
  return { ...ctx, directory, env: { SKILLDISPATCH_DATA_DIR: directory } };
}
describe("offline installation doctor", () => {
  it("reports a usable empty install without creating directories or keys", async () => {
    const ctx = await setup();
    const before = await readdir(ctx.root);
    const result = await runDoctor(ctx);
    expect(result.usable).toBe(true);
    expect(result.checks).toContainEqual({
      code: "api_key",
      status: "PASS",
      detail: "Mock provider needs no API key; credentials are not used.",
    });
    for (const code of [
      "data_directory",
      "installation_key",
      "trace_destination",
    ])
      expect(result.checks.find((c) => c.code === code)?.status).toBe("WARN");
    expect(result.checks.find((c) => c.code === "trace_schema")?.status).toBe(
      "PASS",
    );
    expect(
      result.checks.find((c) => c.code === "hook_commands")?.detail,
    ).toContain("registration is not checked");
    expect(await readdir(ctx.root)).toEqual(before);
  });
  it("validates private key/trace, only counts lines and never calls the API", async () => {
    const ctx = await setup("router:\n  provider: jev\n");
    const fetch = vi.fn(() => {
      throw new Error("PRIVATE_API_KEY_SENTINEL");
    });
    vi.stubGlobal("fetch", fetch);
    await installationKey(ctx.directory);
    const t = traceFixture();
    t.prompt = { storage: "raw", raw: "PRIVATE_RAW_PROMPT_SENTINEL" };
    const path = join(ctx.directory, "traces.jsonl");
    await writeFile(path, `${JSON.stringify(t)}\n`, { mode: 0o600 });
    const result = await runDoctor({
      ...ctx,
      env: { ...ctx.env, TYPESAFE_API_KEY: "PRIVATE_API_KEY_SENTINEL" },
    });
    expect(result.usable).toBe(true);
    for (const code of [
      "installation_key",
      "trace_destination",
      "trace_health",
      "api_key",
    ])
      expect(result.checks.find((c) => c.code === code)?.status).toBe("PASS");
    expect(result.checks.find((c) => c.code === "valid_traces")?.value).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_|sessionKey|promptKey|skillId/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "  "])(
    "Jev with missing/blank credential %s is WARN, exit usable",
    async (apiKey) => {
      const ctx = await setup("router:\n  provider: jev\n");
      const result = await runDoctor({
        ...ctx,
        env: { ...ctx.env, TYPESAFE_API_KEY: apiKey },
      });
      expect(result.usable).toBe(true);
      expect(result.checks.find((c) => c.code === "api_key")?.status).toBe(
        "WARN",
      );
    },
  );
  it("invalid credential fails safely without leaking the value", async () => {
    const ctx = await setup("router:\n  provider: jev\n");
    const result = await runDoctor({
      ...ctx,
      env: { ...ctx.env, TYPESAFE_API_KEY: "PRIVATE_API_KEY\nSECRET" },
    });
    expect(result.usable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_API_KEY");
  });
  it("malformed user config fails without error excerpts", async () => {
    const ctx = await setup("router: [PRIVATE_CONFIG_SENTINEL");
    const result = await runDoctor(ctx);
    expect(result.usable).toBe(false);
    expect(result.checks.find((c) => c.code === "config")?.status).toBe("FAIL");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONFIG_SENTINEL");
  });
  it.each(["false", "true"])(
    "reads user trust %s and never assumes hooks are installed",
    async (trust) => {
      const ctx = await setup(
        `hook:\n  trustProjectConfig: ${trust}\nrouter:\n  provider: mock\n`,
      );
      await write(
        join(ctx.cwd, ".skilldispatch.yaml"),
        "hook:\n  trustProjectConfig: true\nrouter:\n  provider: jev\n",
      );
      const result = await runDoctor(ctx);
      expect(
        result.checks.find((c) => c.code === "hook_project_config")?.value,
      ).toBe(trust === "true");
      expect(result.checks.find((c) => c.code === "provider")?.value).toBe(
        trust === "true" ? "jev" : "mock",
      );
    },
  );
  it("untrusted malformed project config is ignored", async () => {
    const ctx = await setup();
    await write(join(ctx.cwd, ".skilldispatch.yaml"), "invalid: [");
    expect((await runDoctor(ctx)).usable).toBe(true);
  });
  it("invalid trace lines WARN without modifying the file", async () => {
    const ctx = await setup();
    await installationKey(ctx.directory);
    const path = join(ctx.directory, "traces.jsonl");
    await writeFile(path, "PRIVATE_INVALID_JSON\n", { mode: 0o600 });
    const result = await runDoctor(ctx);
    expect(result.usable).toBe(true);
    expect(result.checks.find((c) => c.code === "invalid_lines")).toMatchObject(
      { status: "WARN", value: 1 },
    );
    expect(await readFile(path, "utf8")).toBe("PRIVATE_INVALID_JSON\n");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_INVALID_JSON");
  });
  it.each(["trace", "directory", "key", "readonly_trace"])(
    "rejects unsafe %s",
    async (target) => {
      const ctx = await setup();
      await installationKey(ctx.directory);
      const path = join(ctx.directory, "traces.jsonl");
      await writeFile(path, "", { mode: 0o600 });
      if (target === "trace") await chmod(path, 0o644);
      if (target === "readonly_trace") await chmod(path, 0o400);
      if (target === "directory") await chmod(ctx.directory, 0o755);
      if (target === "key")
        await writeFile(join(ctx.directory, "install.key"), "short");
      if (process.platform !== "win32" || target === "key")
        expect((await runDoctor(ctx)).usable).toBe(false);
    },
  );
  it("rejects reserved installation-key trace destination without reading it as JSONL", async () => {
    const ctx = await setup();
    await installationKey(ctx.directory);
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      `telemetry:\n  tracePath: ${join(ctx.directory, "install.key")}\n`,
    );
    const result = await runDoctor(ctx);
    expect(result.usable).toBe(false);
    expect(
      result.checks.find((c) => c.code === "trace_destination")?.status,
    ).toBe("FAIL");
    expect(result.checks.some((c) => c.code === "valid_traces")).toBe(false);
  });
  it("reports disabled hook persistence without enabling it", async () => {
    const ctx = await setup(
      "telemetry:\n  enabled: false\nrouter:\n  provider: mock\n",
    );
    const result = await runDoctor(ctx);
    expect(result.usable).toBe(true);
    expect(result.checks.find((c) => c.code === "telemetry")?.status).toBe(
      "WARN",
    );
  });
});

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/ops/doctor.js";
import { manageRegistration } from "../../src/registration/manage.js";
import { workspace, write } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());
async function fixture(user = "router:\n  provider: mock\n") {
  const ctx = await workspace();
  const cliPath = join(ctx.root, "skilldispatch", "cli.js");
  await write(cliPath, "// installed fixture");
  await write(join(ctx.home, ".config/skilldispatch/config.yaml"), user);
  return {
    ...ctx,
    execution: {
      nodePath: process.execPath,
      cliPath,
      platform: process.platform,
    },
  };
}
it("reports registrations read-only, keeps routing readiness separate and never calls network", async () => {
  const ctx = await fixture();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const absent = await runDoctor(ctx, ctx.execution);
  expect(absent.usable).toBe(true);
  for (const host of ["codex", "claude"] as const) {
    expect(absent.checks.find((c) => c.code === `hook_${host}`)).toMatchObject({
      status: "WARN",
      value: "not-installed",
    });
    await manageRegistration(host, "install", ctx, ctx.execution);
  }
  const paths = [
    join(ctx.home, ".codex/hooks.json"),
    join(ctx.home, ".claude/settings.json"),
  ];
  const before = await Promise.all(paths.map((p) => readFile(p, "utf8")));
  const contents = await readdir(ctx.root);
  const installed = await runDoctor(ctx, ctx.execution);
  expect(installed.checks.find((c) => c.code === "hook_codex")).toMatchObject({
    status: "WARN",
    value: "installed",
  });
  expect(
    installed.checks.find((c) => c.code === "hook_codex")?.detail,
  ).toContain("codex_host_trust_not_verified");
  expect(installed.checks.find((c) => c.code === "hook_claude")).toMatchObject({
    status: "PASS",
    value: "installed",
  });
  expect(
    installed.checks.find((c) => c.code === "routing_ready"),
  ).toMatchObject({ status: "PASS", value: true });
  expect(await Promise.all(paths.map((p) => readFile(p, "utf8")))).toEqual(
    before,
  );
  expect(await readdir(ctx.root)).toEqual(contents);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, "", "INVALID\nSECRET"])(
  "Jev key %s does not claim routing ready or expose secrets",
  async (key) => {
    const ctx = await fixture("router:\n  provider: jev\n");
    const result = await runDoctor(
      { ...ctx, env: { TYPESAFE_API_KEY: key } },
      ctx.execution,
    );
    expect(result.checks.find((c) => c.code === "routing_ready")).toMatchObject(
      { status: "WARN", value: false },
    );
    expect(result.usable).toBe(key !== "INVALID\nSECRET");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  },
);
it("valid-shaped Jev key is only an offline prerequisite check", async () => {
  const ctx = await fixture();
  await write(
    join(ctx.home, ".config/skilldispatch/config.yaml"),
    "router:\n  provider: jev\n",
  );
  const result = await runDoctor(
    { ...ctx, env: { TYPESAFE_API_KEY: "PRIVATE_VALID_SHAPED_KEY" } },
    ctx.execution,
  );
  expect(result.checks.find((c) => c.code === "routing_ready")).toMatchObject({
    value: true,
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_VALID_SHAPED_KEY");
});
it("disabled telemetry is not shadow routing ready, mock needs no key", async () => {
  const ctx = await fixture(
    "telemetry:\n  enabled: false\nrouter:\n  provider: mock\n",
  );
  const result = await runDoctor(ctx, ctx.execution);
  expect(result.usable).toBe(true);
  expect(result.checks.find((c) => c.code === "routing_ready")).toMatchObject({
    status: "WARN",
    value: false,
  });
});
it("unsafe or malformed hook registration is WARN without changing installation exit semantics", async () => {
  const ctx = await fixture();
  await write(
    join(ctx.home, ".codex/config.toml"),
    'hooks = "PRIVATE_HOST_CONFIG"\n',
  );
  await write(join(ctx.home, ".claude/settings.json"), "{PRIVATE_HOST_CONFIG");
  const result = await runDoctor(ctx, ctx.execution);
  expect(result.usable).toBe(true);
  for (const host of ["codex", "claude"])
    expect(result.checks.find((c) => c.code === `hook_${host}`)).toMatchObject({
      status: "WARN",
      value: "conflict",
    });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_HOST_CONFIG");
});
it("host disableAllHooks is visible but never changed", async () => {
  const ctx = await fixture();
  await manageRegistration("claude", "install", ctx, ctx.execution);
  const path = join(ctx.home, ".claude/settings.json");
  const text = await readFile(path, "utf8");
  await write(path, text.replace("{", '{"disableAllHooks":true,'));
  const result = await runDoctor(ctx, ctx.execution);
  expect(result.checks.find((c) => c.code === "hook_claude")?.detail).toContain(
    "host_hooks_disabled",
  );
  expect(JSON.parse(await readFile(path, "utf8")).disableAllHooks).toBe(true);
});

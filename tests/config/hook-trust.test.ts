import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { workspace, write } from "../helpers.js";

describe("source-aware hook configuration", () => {
  it("defaults to user-only hook settings and never parses untrusted project input", async () => {
    const ctx = await workspace();
    await write(join(ctx.cwd, ".skilldispatch.yaml"), "{ invalid YAML");
    const result = await loadConfig({ ...ctx, mode: "hook" });
    expect(result.config.hook.trustProjectConfig).toBe(false);
    expect(result.config.router.provider).toBe("jev");
    expect(result.diagnostics).toEqual([]);
    await expect(loadConfig(ctx)).rejects.toThrow("Invalid YAML");
  });

  it.each([undefined, false, true])(
    "only a user-layer opt-in enables project settings (%s)",
    async (trusted) => {
      const ctx = await workspace();
      await write(
        join(ctx.home, ".config/skilldispatch/config.yaml"),
        `policy: {threshold: 0.8}\n${trusted === undefined ? "" : `hook: {trustProjectConfig: ${trusted}}\n`}`,
      );
      await write(
        join(ctx.cwd, ".skilldispatch.yaml"),
        "hook: {trustProjectConfig: true}\nrouter: {provider: mock}\npolicy: {threshold: 0.2}\ntelemetry: {prompt: raw}\n",
      );
      const { config } = await loadConfig({ ...ctx, mode: "hook" });
      expect(config.hook.trustProjectConfig).toBe(trusted === true);
      expect(config.router.provider).toBe(trusted === true ? "mock" : "jev");
      expect(config.policy.threshold).toBe(trusted === true ? 0.2 : 0.8);
      expect(config.telemetry.prompt).toBe(trusted === true ? "raw" : "hash");
    },
  );

  it("preserves CLI layering while treating the trust switch as user-only in every mode", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "hook: {trustProjectConfig: false}\npolicy: {threshold: 0.8, maxSkills: 2}\n",
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "hook: {trustProjectConfig: true}\nrouter: {provider: mock}\npolicy: {threshold: 0.3}\n",
    );
    await write(
      join(ctx.cwd, "override.yaml"),
      "hook: {trustProjectConfig: true}\npolicy: {threshold: 0.4}\n",
    );
    const cli = await loadConfig({ ...ctx, configPath: "override.yaml" });
    expect(cli.config).toMatchObject({
      hook: { trustProjectConfig: false },
      router: { provider: "mock" },
      policy: { threshold: 0.4, maxSkills: 2 },
    });
    expect(cli.diagnostics.map((d) => d.code)).toEqual([
      "ignored_config_setting",
      "ignored_config_setting",
    ]);
    const hook = await loadConfig({
      ...ctx,
      mode: "hook",
      configPath: "override.yaml",
    });
    expect(hook.config).toMatchObject({
      hook: { trustProjectConfig: false },
      router: { provider: "jev" },
      policy: { threshold: 0.8, maxSkills: 2 },
    });
  });

  it("project and explicit layers cannot revoke a user trust choice", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "hook: {trustProjectConfig: true}\n",
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "hook: {trustProjectConfig: false}\nrouter: {provider: mock}\n",
    );
    await write(
      join(ctx.cwd, "override.yaml"),
      "hook: {trustProjectConfig: false}\n",
    );
    expect(
      (await loadConfig({ ...ctx, configPath: "override.yaml" })).config.hook
        .trustProjectConfig,
    ).toBe(true);
    expect(
      (await loadConfig({ ...ctx, mode: "hook" })).config.router.provider,
    ).toBe("mock");
  });

  it.each(['"true"', "1", "null"])(
    "rejects a non-boolean user trust switch (%s)",
    async (value) => {
      const ctx = await workspace();
      await write(
        join(ctx.home, ".config/skilldispatch/config.yaml"),
        `hook: {trustProjectConfig: ${value}}`,
      );
      await expect(loadConfig({ ...ctx, mode: "hook" })).rejects.toThrow(
        "Invalid SkillDispatch config",
      );
    },
  );
});

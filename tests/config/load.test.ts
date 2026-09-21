import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { workspace, write } from "../helpers.js";

describe("SkillDispatch configuration", () => {
  it("rejects config directories and oversized files", async () => {
    const ctx = await workspace();
    await mkdir(join(ctx.cwd, "directory.yaml"));
    await write(join(ctx.cwd, "large.yaml"), "x".repeat(1_048_577));
    await expect(
      loadConfig({ ...ctx, configPath: "directory.yaml" }),
    ).rejects.toThrow("Cannot read");
    await expect(
      loadConfig({ ...ctx, configPath: "large.yaml" }),
    ).rejects.toThrow("Cannot read");
  });
  it("uses defaults without creating files", async () => {
    const ctx = await workspace();
    const { config, diagnostics } = await loadConfig(ctx);
    expect(config).toEqual({
      router: { provider: "mock", timeoutMs: 2500, mock: {} },
      policy: { threshold: 0.75, maxSkills: 4 },
      discovery: { agents: ["codex", "claude-code"] },
    });
    expect(diagnostics).toEqual([]);
  });
  it("merges defaults, user, project and explicit config at field granularity", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "policy:\n  threshold: 0.6\n  maxSkills: 2\nrouter:\n  mock:\n    scores:\n      react: 0.8\n",
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "policy:\n  threshold: 0.9\ndiscovery:\n  agents: [codex]\n",
    );
    await write(
      join(ctx.cwd, "override.yaml"),
      "policy:\n  maxSkills: 3\nrouter:\n  mock:\n    scores:\n      tests: 0.91\n",
    );
    const { config } = await loadConfig({
      ...ctx,
      configPath: "override.yaml",
    });
    expect(config.policy).toEqual({ threshold: 0.9, maxSkills: 3 });
    expect(config.discovery.agents).toEqual(["codex"]);
    expect(config.router.mock.scores).toEqual({ react: 0.8, tests: 0.91 });
  });
  it("warns for unknown keys without echoing values", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "apiKey: secret-value\nrouter:\n  unknown: sentinel-config-value\n",
    );
    const result = await loadConfig(ctx);
    expect(result.diagnostics).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("sentinel-config-value");
  });
  it.each([
    "policy: [broken",
    "policy:\n  threshold: 2",
    "policy:\n  maxSkills: 0",
    "router:\n  provider: jev",
    "discovery:\n  agents: [unknown]",
    "router:\n  mock:\n    scores:\n      skill: .nan",
  ])("rejects invalid config (%s)", async (source) => {
    const ctx = await workspace();
    await write(join(ctx.cwd, ".skilldispatch.yaml"), source);
    await expect(loadConfig(ctx)).rejects.toThrow(/Invalid/);
  });
  it("errors for missing explicit config", async () => {
    const ctx = await workspace();
    await expect(
      loadConfig({ ...ctx, configPath: "missing.yaml" }),
    ).rejects.toThrow("Cannot read");
  });
});

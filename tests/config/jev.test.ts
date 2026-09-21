import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { workspace, write } from "../helpers.js";

describe("Jev configuration", () => {
  it("merges only explicitly configured fields without resetting inherited values", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "router:\n  jev:\n    model: jev-1.13.0\n    chunkSize: 24\n    concurrency: 1\n    requestTimeoutMs: 900\n    maxRetries: 1\n",
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  jev:\n    concurrency: 2\n",
    );
    const { config } = await loadConfig(ctx);
    expect(config.router.jev).toEqual({
      model: "jev-1.13.0",
      chunkSize: 24,
      concurrency: 2,
      requestTimeoutMs: 900,
      maxRetries: 1,
    });
    expect(config.router.provider).toBe("jev");
  });

  it.each([
    "chunkSize: 49",
    "chunkSize: 0",
    "concurrency: 0",
    "concurrency: 9",
    "concurrency: 1.5",
    "requestTimeoutMs: 2147483648",
    "requestTimeoutMs: 0",
    "maxRetries: 3",
    "maxRetries: -1",
  ])("rejects invalid Jev limits (%s)", async (setting) => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      `router:\n  jev:\n    ${setting}\n`,
    );
    await expect(loadConfig(ctx)).rejects.toThrow(
      "Invalid SkillDispatch config",
    );
  });

  it("never accepts an API key from YAML or includes its value in diagnostics", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  jev:\n    apiKey: synthetic-config-secret\n",
    );
    const result = await loadConfig(ctx);
    expect(result.diagnostics[0]?.code).toBe("unknown_config_key");
    expect(JSON.stringify(result)).not.toContain("synthetic-config-secret");
  });

  it("accepts the local concurrency ceiling of 8", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  jev:\n    concurrency: 8\n",
    );
    expect((await loadConfig(ctx)).config.router.jev.concurrency).toBe(8);
  });
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { workspace, write } from "../helpers.js";

describe("telemetry config", () => {
  it("defaults to enabled/hash and layers fields without resetting inherited values", async () => {
    const ctx = await workspace();
    expect((await loadConfig(ctx)).config.telemetry).toEqual({
      enabled: true,
      prompt: "hash",
    });
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "telemetry:\n  prompt: none\n  tracePath: ~/private/events.jsonl\n",
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "telemetry:\n  enabled: false\n",
    );
    expect((await loadConfig(ctx)).config.telemetry).toEqual({
      enabled: false,
      prompt: "none",
      tracePath: "~/private/events.jsonl",
    });
  });
  it.each([
    "prompt: raw",
    "prompt: none",
    "prompt: hash",
    "tracePath: /private/events.jsonl",
  ])("accepts explicit settings %s", async (setting) => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      `telemetry:\n  ${setting}\n`,
    );
    expect((await loadConfig(ctx)).diagnostics).toEqual([]);
  });
  it.each([
    "prompt: invalid",
    "enabled: 1",
    "tracePath: relative.jsonl",
    "tracePath: ''",
    'tracePath: "/private/\\0events"',
  ])("rejects unsafe settings %s", async (setting) => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      `telemetry:\n  ${setting}\n`,
    );
    await expect(loadConfig(ctx)).rejects.toThrow(
      "Invalid SkillDispatch config",
    );
  });
});

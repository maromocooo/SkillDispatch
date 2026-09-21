import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseClaudeInput } from "../../src/hooks/claude.js";
import { parseCodexInput } from "../../src/hooks/codex.js";
import { MAX_HOOK_INPUT_BYTES, readHookJson } from "../../src/hooks/stdin.js";

async function fixture(host: string) {
  return JSON.parse(
    await readFile(
      new URL(`../fixtures/hooks/${host}.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe.each(["codex", "claude"] as const)("%s hook input", (host) => {
  const parse = host === "codex" ? parseCodexInput : parseClaudeInput;
  it("parses current fields and discards unknown extensions and transcript paths", async () => {
    const raw = await fixture(host);
    const input = parse({
      ...raw,
      unknown_future: { secret: true },
      agent_id: "id",
      agent_type: "custom",
      permission_mode: "future-mode",
    });
    expect(input).toMatchObject({
      agent: host === "codex" ? "codex" : "claude-code",
      cwd: raw.cwd,
      prompt: raw.prompt,
      sessionId: raw.session_id,
    });
    expect(JSON.stringify(input)).not.toMatch(
      /transcript|unknown_future|agent_id|permission_mode/,
    );
    if (host === "codex")
      expect(input).toMatchObject({ turnId: raw.turn_id, model: raw.model });
    else {
      expect(input?.turnId).toBeUndefined();
      expect(input?.model).toBeUndefined();
    }
  });
  it.each([
    "prompt",
    "session_id",
    "cwd",
    "hook_event_name",
    "permission_mode",
    "transcript_path",
  ])("rejects missing or wrongly typed %s", async (field) => {
    const raw = await fixture(host);
    expect(parse({ ...raw, [field]: 123 })).toBeUndefined();
    delete raw[field];
    expect(parse(raw)).toBeUndefined();
  });
  it("rejects wrong events, relative cwd, invalid optional fields and non-objects", async () => {
    const raw = await fixture(host);
    expect(parse({ ...raw, hook_event_name: "Stop" })).toBeUndefined();
    expect(parse({ ...raw, cwd: "relative" })).toBeUndefined();
    expect(parse({ ...raw, agent_id: 3 })).toBeUndefined();
    expect(parse(null)).toBeUndefined();
    expect(parse([])).toBeUndefined();
  });
  it.each([
    "{PRIVATE_HOOK_PROMPT_SENTINEL",
    "x".repeat(MAX_HOOK_INPUT_BYTES + 1),
  ])("silently rejects invalid JSON/oversized stdin %#", async (source) => {
    expect(parse(await readHookJson(Readable.from([source])))).toBeUndefined();
  });
});

describe("hook wire details and bounded stdin", () => {
  it("Codex allows null transcript but requires model and turn_id", async () => {
    const raw = await fixture("codex");
    expect(parseCodexInput({ ...raw, transcript_path: null })).toBeDefined();
    for (const field of ["model", "turn_id"]) {
      const missing = { ...raw };
      delete missing[field];
      expect(parseCodexInput(missing)).toBeUndefined();
    }
  });
  it("Claude ignores model/turn extensions, validates optional current common fields", async () => {
    const raw = await fixture("claude");
    const result = parseClaudeInput({
      ...raw,
      model: "future-model",
      turn_id: "future-turn",
      effort: { level: "max" },
    });
    expect(result?.model).toBeUndefined();
    expect(result?.turnId).toBeUndefined();
    for (const field of ["prompt_id", "scratchpad_dir", "effort"])
      expect(parseClaudeInput({ ...raw, [field]: 42 })).toBeUndefined();
  });
  it("reassembles UTF-8 bytes and accepts exactly the byte limit", async () => {
    const source = Buffer.from(JSON.stringify({ prompt: "日本語" }));
    expect(
      await readHookJson(
        Readable.from([...source].map((byte) => Buffer.from([byte]))),
      ),
    ).toEqual({ prompt: "日本語" });
    expect(
      await readHookJson(
        Readable.from([`"${"a".repeat(MAX_HOOK_INPUT_BYTES - 2)}"`]),
      ),
    ).toHaveLength(MAX_HOOK_INPUT_BYTES - 2);
    expect(
      await readHookJson(
        Readable.from(["あ".repeat(MAX_HOOK_INPUT_BYTES / 2)]),
      ),
    ).toBeUndefined();
  });
  it("fails open on stream error, early close and stalled input", async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error("PRIVATE_STREAM_ERROR"));
      },
    });
    expect(await readHookJson(broken)).toBeUndefined();
    const closed = new Readable({
      read() {
        this.destroy();
      },
    });
    expect(await readHookJson(closed)).toBeUndefined();
    const stalled = new Readable({ read() {} });
    expect(await readHookJson(stalled, 10)).toBeUndefined();
    expect(stalled.destroyed).toBe(true);
  });
});

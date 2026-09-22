import {
  link,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MAX_HOOK_INPUT_BYTES, readHookJson } from "../../src/hooks/stdin.js";
import {
  createInvocationEvent,
  observeClaudeSkill,
  parseSkillHook,
} from "../../src/observability/claude-skill-hook.js";
import {
  InvocationReader,
  invocationPath,
  JsonlInvocationSink,
  MAX_INVOCATION_BYTES,
} from "../../src/observability/invocation-storage.js";
import {
  invocationEvents,
  invocationSchema,
} from "../../src/observability/invocation-types.js";
import { dataDirectory } from "../../src/telemetry/storage.js";
import { createRouteTrace } from "../../src/telemetry/trace.js";
import { skillText, workspace, write } from "../helpers.js";
import { skill, traceInput } from "../telemetry/helpers.js";

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}

import { eventFixture, hostInput } from "./helpers.js";

describe("Claude Skill observer input and privacy", () => {
  it.each(["anthropic-skills:pdf", "codex:codex-cli-runtime"])(
    "resolves exact native namespace %s without alias guesses",
    (native) => {
      const synced = native.startsWith("anthropic-skills:");
      const item = skill("Display name", {
        agent: "claude-code",
        scope: "user",
        metadata: {
          commandName: native,
          claude: {
            origin: synced ? "synced" : "plugin",
            nativeInvocationName: native,
            modelInvocable: true,
            ...(synced
              ? {}
              : {
                  pluginName: "codex",
                  pluginId: "openai-codex@fixture",
                  pluginVersion: "1",
                }),
          },
        },
      });
      const input = parseSkillHook(
        hostInput({ tool_input: { skill: native } }),
      );
      if (!input) throw new Error();
      expect(
        createInvocationEvent(input, Buffer.alloc(32, 1), [item]).skill,
      ).toMatchObject({
        resolved: true,
        name: "Display name",
        nativeInvocationName: native,
      });
      const ambiguous = createInvocationEvent(input, Buffer.alloc(32, 1), [
        item,
        { ...item, id: "b".repeat(64) },
      ]);
      expect(ambiguous.skill.resolved).toBe(false);
      expect(ambiguous.diagnosticCode).toBe("ambiguous_skill_invocation");
      input.tool_input.skill = native.split(":")[1] ?? "invalid";
      expect(
        createInvocationEvent(input, Buffer.alloc(32, 1), [item]).skill
          .resolved,
      ).toBe(false);
    },
  );
  it("isolates tool id tuple boundaries", () => {
    expect(
      eventFixture({ session_id: "a\0b", tool_use_id: "c" }).toolUseKey,
    ).not.toBe(
      eventFixture({ session_id: "a", tool_use_id: "b\0c" }).toolUseKey,
    );
  });

  it.each(invocationEvents)("projects %s without private values", (event) => {
    const input = parseSkillHook(
      hostInput({
        hook_event_name: event,
        future: { secret: "PRIVATE_FUTURE" },
        duration_ms: 12,
        is_interrupt: true,
      }),
    );
    expect(input).toBeDefined();
    if (!input) return;
    const record = createInvocationEvent(input, Buffer.alloc(32, 1), []);
    expect(record.phase).toBe(
      {
        PreToolUse: "attempted",
        PostToolUse: "succeeded",
        PostToolUseFailure: "failed",
      }[event],
    );
    expect(record.durationMs).toBe(event === "PreToolUse" ? undefined : 12);
    expect(record.isInterrupt).toBe(
      event === "PostToolUseFailure" ? true : undefined,
    );
    expect(JSON.stringify(record)).not.toContain("PRIVATE_");
  });
  it.each([
    { tool_name: "Bash" },
    { tool_use_id: undefined },
    { session_id: undefined },
    { hook_event_name: "UserPromptExpansion" },
    { tool_input: {} },
    { tool_input: { name: "jira-ticket" } },
    { tool_input: { skill: "/jira-ticket" } },
    { tool_input: { skill: "review\ninstructions" } },
    { tool_input: { skill: "../private" } },
    { duration_ms: -1 },
    { agent_id: 12 },
    { cwd: "relative" },
  ])("safe no-op for malformed input %#", (extra) =>
    expect(parseSkillHook(hostInput(extra))).toBeUndefined(),
  );
  it("allows absent prompt id without inventing correlation", () =>
    expect(eventFixture({ prompt_id: undefined }).promptKey).toBeUndefined());
  it("marks subagent id presence, never persists it or agent type", () => {
    const event = eventFixture({
      agent_id: "PRIVATE_AGENT",
      agent_type: "PRIVATE_TYPE",
    });
    expect(event.executionContext.kind).toBe("subagent");
    expect(JSON.stringify(event)).not.toContain("PRIVATE_");
    expect(
      eventFixture({ agent_type: "custom-main" }).executionContext.kind,
    ).toBe("main");
  });
  it("matches route HMAC domains exactly and separates sessions for tool ids", () => {
    const route = createRouteTrace({
      ...traceInput(),
      agent: "claude-code",
      promptCorrelationId: "PRIVATE_PROMPT_ID",
    });
    const event = eventFixture();
    expect(event.sessionKey).toBe(route.host.sessionKey);
    expect(event.promptKey).toBe(route.host.promptKey);
    expect(event.toolUseKey).not.toBe(event.sessionKey);
    expect(eventFixture({ session_id: "other" }).toolUseKey).not.toBe(
      event.toolUseKey,
    );
  });
  it.each(["{", "x".repeat(MAX_HOOK_INPUT_BYTES + 1)])(
    "rejects malformed or oversized stdin",
    async (input) => {
      expect(await readHookJson(Readable.from([input]))).toBeUndefined();
    },
  );
  it("resolves catalog exact native id, not display names; never fetches", async () => {
    const w = await workspace();
    await write(
      join(w.home, ".claude/skills/jira-ticket/SKILL.md"),
      skillText("Display label"),
    );
    await write(
      join(w.home, ".config/skilldispatch/config.yaml"),
      "router:\n  provider: jev\n",
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("PRIVATE_KEY"));
    try {
      await observeClaudeSkill(hostInput({ cwd: w.repo }), w);
      const records = await collect(
        new InvocationReader(invocationPath(w), []).read(),
      );
      const record = records[0];
      expect(record?.kind).toBe("valid");
      if (record?.kind === "valid")
        expect(record.trace.skill).toMatchObject({
          resolved: true,
          name: "Display label",
          nativeInvocationName: "jira-ticket",
          origin: "local-user",
        });
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(invocationPath(w), "utf8")).not.toContain(
        "PRIVATE_",
      );
    } finally {
      fetch.mockRestore();
    }
  });
  it("honors user opt-out even if trusted project enables telemetry", async () => {
    const w = await workspace();
    await write(
      join(w.home, ".config/skilldispatch/config.yaml"),
      "hook:\n  trustProjectConfig: true\ntelemetry:\n  enabled: false\n",
    );
    await write(
      join(w.cwd, ".skilldispatch.yaml"),
      "telemetry:\n  enabled: true\n",
    );
    const sink = { write: vi.fn() };
    await observeClaudeSkill(hostInput({ cwd: w.cwd }), w, {
      makeSink: () => sink,
    });
    expect(sink.write).not.toHaveBeenCalled();
  });
  it("keeps unresolved events when discovery fails and swallows writer errors", async () => {
    const w = await workspace();
    const sink = { write: vi.fn().mockRejectedValue(new Error("PRIVATE")) };
    await expect(
      observeClaudeSkill(hostInput({ cwd: w.repo }), w, {
        discover: async () => {
          throw new Error("PRIVATE");
        },
        makeSink: () => sink,
      }),
    ).resolves.toBeUndefined();
    expect(sink.write.mock.calls[0]?.[0]).toMatchObject({
      skill: { resolved: false },
      diagnosticCode: "catalog_unavailable",
    });
  });
});

describe("invocation storage safety", () => {
  async function setup() {
    const w = await workspace();
    const path = invocationPath(w);
    await mkdir(dataDirectory(w), { recursive: true, mode: 0o700 });
    return {
      w,
      path,
      sink: new JsonlInvocationSink(path, [
        join(dataDirectory(w), "install.key"),
      ]),
    };
  }
  it("creates private storage and writes concurrent parseable single lines", async () => {
    const { w, path, sink } = await setup();
    await Promise.all(
      Array.from({ length: 12 }, () => sink.write(eventFixture())),
    );
    expect((await collect(new InvocationReader(path, []).read())).length).toBe(
      12,
    );
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dataDirectory(w))).mode & 0o777).toBe(0o700);
    }
  });
  it.each(["symlink", "hardlink", "permission", "directory", "key"])(
    "refuses unsafe %s destinations",
    async (kind) => {
      const { w, path, sink } = await setup();
      const other = join(dataDirectory(w), "private");
      await writeFile(other, "PRIVATE", { mode: 0o600 });
      if (kind === "symlink") await symlink(other, path);
      if (kind === "hardlink") await link(other, path);
      if (kind === "permission") {
        await writeFile(path, "PRIVATE", { mode: 0o644 });
        if (process.platform === "win32") return;
      }
      if (kind === "directory") await mkdir(path);
      if (kind === "key") {
        await new JsonlInvocationSink(other, [other]).write(eventFixture());
      } else await sink.write(eventFixture());
      expect(await readFile(other, "utf8")).toBe("PRIVATE");
      if (kind !== "key")
        await expect(
          collect(new InvocationReader(path, []).read()),
        ).rejects.toThrow();
    },
  );
  it("isolates corrupt/oversized/truncated lines", async () => {
    const { path, sink } = await setup();
    await sink.write(eventFixture());
    const valid = await readFile(path, "utf8");
    await writeFile(
      path,
      `${valid}bad\n{}\n${"x".repeat(2 * 1024 * 1024 + 1)}\n${valid}{`,
      { mode: 0o600 },
    );
    const records = await collect(new InvocationReader(path, []).read());
    expect(records.map((r) => r.kind)).toEqual([
      "valid",
      "invalid",
      "invalid",
      "invalid",
      "valid",
      "invalid",
    ]);
  });
  it("bounds append and validates event schema", async () => {
    const { path, sink } = await setup();
    await sink.write({
      ...eventFixture(),
      skill: {
        resolved: false,
        nativeInvocationName: "x".repeat(MAX_INVOCATION_BYTES),
      },
    });
    expect(await collect(new InvocationReader(path, []).read())).toEqual([]);
  });
  it("events validate against the shipped JSON Schema and reject private extras", async () => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addFormat("uuid", fullFormats.uuid);
    ajv.addFormat("date-time", fullFormats["date-time"]);
    const validate = ajv.compile(
      JSON.parse(
        await readFile("schemas/skill-invocation.schema.json", "utf8"),
      ),
    );
    expect(validate(eventFixture())).toBe(true);
    for (const extra of [
      { args: "PRIVATE" },
      { tool_response: {} },
      { error: "PRIVATE" },
      { cwd: "/PRIVATE" },
      { session_id: "PRIVATE" },
    ])
      expect(validate({ ...eventFixture(), ...extra })).toBe(false);
  });
  it("shipped schema matches runtime schema", async () => {
    expect(
      JSON.parse(
        await readFile("schemas/skill-invocation.schema.json", "utf8"),
      ),
    ).toEqual(z.toJSONSchema(invocationSchema, { target: "draft-2020-12" }));
  });
});

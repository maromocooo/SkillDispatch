import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseCodexInput } from "../../src/hooks/codex.js";
import { buildCodexAdvisory } from "../../src/hooks/codex-advisory.js";
import { runHook } from "../../src/hooks/runtime.js";
import { inspectRegistration } from "../../src/registration/inspect.js";
import { manageRegistration } from "../../src/registration/manage.js";
import { routeTraceV2Schema } from "../../src/telemetry/types.js";
import { workspace, write } from "../helpers.js";
import { skill, traceInput } from "../telemetry/helpers.js";

const candidate = (name = "example", enabled = true) =>
  skill(name, {
    enabled,
    metadata: {
      codex: {
        nativeName: name,
        origin: "system",
        configuredEnabled: enabled,
        modelInvocable: enabled,
        sessionAvailability: "unconfirmed",
      },
    },
  });
const select = (s: ReturnType<typeof skill>) => ({
  skillId: s.id,
  name: s.name,
  probability: 0.9,
  selected: true,
});
describe("Codex user-owned advisory", () => {
  it("emits official JSON with safe native names and task-preserving wording, without private fields", () => {
    const s = candidate("foo:review");
    const output = buildCodexAdvisory([select(s)], [s]);
    expect(output.injectedSkillIds).toEqual([s.id]);
    expect(JSON.parse(output.output ?? "").hookSpecificOutput).toMatchObject({
      hookEventName: "UserPromptSubmit",
    });
    expect(output.output).toContain("Continue the original task");
    expect(output.output).not.toMatch(/PRIVATE_|0\.9|Skill tool|\$foo/);
  });
  it.each(["disabled", "duplicate", "unsafe"])(
    "omits %s references",
    (kind) => {
      const s = candidate(
        kind === "unsafe" ? "bad\u001b[2J" : "a",
        kind !== "disabled",
      );
      expect(
        buildCodexAdvisory([select(s)], kind === "duplicate" ? [s, s] : [s])
          .output,
      ).toBeUndefined();
    },
  );
  it("bounds context at complete identifiers and handles zero selection", () => {
    const skills = Array.from({ length: 80 }, (_, i) =>
      candidate(`skill-${i}-${"a".repeat(100)}`),
    );
    const r = buildCodexAdvisory(skills.map(select), skills);
    expect(
      Buffer.byteLength(
        JSON.parse(r.output ?? "").hookSpecificOutput.additionalContext,
      ),
    ).toBeLessThanOrEqual(4096);
    expect(r.injectedSkillIds.length).toBeLessThan(skills.length);
    expect(buildCodexAdvisory([], skills).output).toBeUndefined();
  });
  it("rejects subagent user-prompt routing", () => {
    expect(
      parseCodexInput({
        session_id: "s",
        turn_id: "t",
        cwd: "/fixture",
        hook_event_name: "UserPromptSubmit",
        model: "m",
        permission_mode: "default",
        prompt: "p",
        transcript_path: null,
        agent_id: "child",
      }),
    ).toBeUndefined();
  });
  it("reconciles opt-in sync and shadow async in custom CODEX_HOME, detects mismatch, preserves unrelated handlers", async () => {
    const c = await workspace(),
      codex = join(c.root, "custom");
    const env = { ...c, env: { CODEX_HOME: codex } };
    const execution = {
      nodePath: process.execPath,
      cliPath: join(c.root, "cli.js"),
      platform: process.platform,
    };
    await write(execution.cliPath, "// fixture");
    const config = join(c.home, ".config/skilldispatch/config.yaml");
    await write(
      config,
      'hook: {codexContract: "0.155.1", modes: {codex: shadow}}',
    );
    const path = join(codex, "hooks.json");
    await write(
      path,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "unrelated" }] },
          ],
        },
      }),
    );
    await manageRegistration("codex", "install", env, execution);
    await write(
      config,
      'hook: {codexContract: "0.155.1", modes: {codex: advisory}}',
    );
    expect(
      (await inspectRegistration("codex", env, execution)).issues,
    ).toContain("hook_execution_mismatch");
    await manageRegistration("codex", "install", env, execution);
    expect(await inspectRegistration("codex", env, execution)).toMatchObject({
      mode: "advisory",
      execution: "sync",
      instructionObservers: { ready: true },
    });
    expect(
      (await manageRegistration("codex", "install", env, execution)).changed,
    ).toBe(false);
    await write(
      config,
      'hook: {codexContract: "0.155.1", modes: {codex: shadow}}',
    );
    await manageRegistration("codex", "install", env, execution);
    expect((await inspectRegistration("codex", env, execution)).execution).toBe(
      "async",
    );
    await manageRegistration("codex", "uninstall", env, execution);
    expect(
      JSON.parse(await readFile(path, "utf8")).hooks.UserPromptSubmit,
    ).toEqual([{ hooks: [{ type: "command", command: "unrelated" }] }]);
  });
  it("emits only with supported contract, explicit opt-in, complete routing and synchronous readiness", async () => {
    const c = await workspace();
    const input = {
      agent: "codex" as const,
      cwd: c.cwd,
      prompt: "synthetic",
      sessionId: "s",
      promptCorrelationId: "t",
    };
    const config = join(c.home, ".config/skilldispatch/config.yaml");
    const env = { ...c, env: { SKILLDISPATCH_DATA_DIR: join(c.root, "data") } };
    for (const [contract, mode, ready, score, emits] of [
      ["0.155.1", "advisory", true, 0.9, true],
      ["0.155.1", "advisory", false, 0.9, false],
      ["unknown", "advisory", true, 0.9, false],
      ["0.155.1", "shadow", true, 0.9, false],
      ["0.155.1", "advisory", true, 0, false],
    ] as const) {
      await write(
        config,
        `hook: {codexContract: "${contract}", modes: {codex: ${mode}}}\nrouter: {provider: mock, mock: {defaultProbability: ${score}}}`,
      );
      expect(
        (await runHook(input, env, { canAdvise: async () => ready })) !==
          undefined,
      ).toBe(emits);
    }
  });
  it("keeps shipped v2 schema in sync", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../../schemas/route-trace-next.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(schema).toEqual(
      z.toJSONSchema(routeTraceV2Schema, { target: "draft-2020-12" }),
    );
    expect(traceInput().key.byteLength).toBe(32);
  });
});

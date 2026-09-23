import {
  chmod,
  link,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodexDiscoveryAdapter } from "../../src/discovery/codex.js";
import { codexCatalogIdentity } from "../../src/discovery/codex-origin.js";
import {
  CodexReadSummary,
  readCodexReadIndex,
  traceInstructionReads,
} from "../../src/observability/codex-read-analytics.js";
import {
  createCodexReadEvent,
  literalInstructionRead,
  observeCodexRead,
  parseCodexRead,
} from "../../src/observability/codex-read-hook.js";
import {
  CodexReadReader,
  CodexReadSink,
  codexReadPath,
} from "../../src/observability/codex-read-storage.js";
import {
  type CodexReadEvent,
  codexReadSchema,
} from "../../src/observability/codex-read-types.js";
import { privateDirectory } from "../../src/telemetry/storage.js";
import { createRouteTrace } from "../../src/telemetry/trace.js";
import { workspace, write } from "../helpers.js";
import { schemaValidator, skill, traceInput } from "../telemetry/helpers.js";

const key = Buffer.alloc(32, 1);
const raw = () => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: {
    command: "cat '/fixture/skill/SKILL.md'",
    args: "PRIVATE_ARGS",
  },
  session_id: "PRIVATE_SESSION",
  turn_id: "PRIVATE_TURN",
  tool_use_id: "PRIVATE_TOOL",
  cwd: "/fixture",
  tool_response: "PRIVATE_RESPONSE",
  error: "PRIVATE_ERROR",
  transcript_path: "PRIVATE_TRANSCRIPT",
});
const candidate = () =>
  skill("review", {
    agent: "codex",
    path: "/fixture/skill/SKILL.md",
    metadata: {
      codex: {
        origin: "local-user",
        nativeName: "review",
        modelInvocable: true,
        configuredEnabled: true,
        sessionAvailability: "unconfirmed",
      },
    },
  });
function event(patch: Record<string, unknown> = {}) {
  const input = parseCodexRead({ ...raw(), ...patch });
  if (!input) throw new Error("Invalid fixture");
  return createCodexReadEvent(input, key, [candidate()], candidate().path);
}
async function index(events: CodexReadEvent[]) {
  return readCodexReadIndex({
    async *read() {
      for (const [i, e] of events.entries())
        yield { kind: "valid" as const, line: i + 1, trace: e };
    },
  });
}
const route = () => {
  const s = candidate();
  s.metadata.catalogIdentity = codexCatalogIdentity(s);
  return createRouteTrace({
    ...traceInput(),
    schemaVersion: "2.0",
    skills: [s],
    capabilities: { skillInstructionReadTelemetry: true },
    delivery: { kind: "codex-advisory", injectedSkillIds: [s.id] },
    result: {
      ...traceInput().result,
      allDecisions: [
        { skillId: s.id, name: s.name, selected: true, probability: 0.9 },
      ],
    },
  });
};
describe("narrow Codex instruction-read evidence", () => {
  it.each([
    "cat /fixture/SKILL.md",
    "cat -- '/fixture with space/SKILL.md'",
    '/bin/cat "/fixture/日本語/SKILL.md"',
  ])("accepts literal absolute read: %s", (command) =>
    expect(literalInstructionRead(command)).toBeDefined(),
  );
  it.each([
    'echo "cat /fixture/SKILL.md"',
    "grep x /fixture/SKILL.md",
    "find /fixture -name SKILL.md",
    "stat /fixture/SKILL.md",
    "ls /fixture/SKILL.md",
    "head /fixture/SKILL.md",
    "tail /fixture/SKILL.md",
    "sed -n '1,20p' /fixture/SKILL.md",
    "cat /fixture/SKILL.md | head",
    "cat /fixture/SKILL.md; true",
    "echo x > /fixture/SKILL.md",
    "cat $SKILL/SKILL.md",
    'cat "$(pwd)/SKILL.md"',
    "cat `pwd`/SKILL.md",
    "eval cat /fixture/SKILL.md",
    "cat ./SKILL.md",
    "cat /fixture/*/SKILL.md",
    "cat /fixture/{a,b}/SKILL.md",
    "cat /fixture/SKILL.md /other",
    "cat /fixture/SKILL.md\n",
    "cat -n /fixture/SKILL.md",
    "await tools.exec_command({cmd:'cat /fixture/SKILL.md'})",
  ])("rejects unsupported or partial/dynamic syntax: %s", (command) =>
    expect(literalInstructionRead(command)).toBeUndefined(),
  );
  it.each(["PreToolUse", "PostToolUse"])(
    "projects %s without tool data or invented exit outcome",
    (phase) => {
      const e = event({
        hook_event_name: phase,
        tool_response: { exit_code: 1, output: "PRIVATE" },
      });
      expect(e.outcome).toBe("unknown");
      expect(e.phase).toBe(
        phase === "PreToolUse" ? "attempted" : "terminal-observed",
      );
      expect(JSON.stringify(e)).not.toMatch(
        /PRIVATE|fixture|command|args|response|transcript|exit_code/,
      );
    },
  );
  it.each([
    { tool_name: "Skill" },
    { tool_use_id: undefined },
    { session_id: undefined },
    { hook_event_name: "PostToolUseFailure" },
    { tool_input: { command: "x".repeat(17000) } },
  ])("ignores unsupported input %#", (patch) =>
    expect(parseCodexRead({ ...raw(), ...patch })).toBeUndefined(),
  );
  it("retains missing turn without guessing correlation, and separates main/subagent/unknown", async () => {
    const events = [
      event({ turn_id: undefined }),
      event({ agent_id: "PRIVATE_AGENT" }),
      event({ agent_type: "worker" }),
    ];
    expect(events[0]?.promptKey).toBeUndefined();
    expect(events.map((e) => e.executionContext.kind)).toEqual([
      "main",
      "subagent",
      "unknown",
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_AGENT");
    const summary = new CodexReadSummary(await index(events));
    summary.add(route());
    expect(summary.result().observedInstructionReadAttemptPairs).toBe(0);
  });
  it("shares exact route session/turn HMAC domains, separated from Claude", () => {
    const e = event(),
      r = route();
    expect(e.sessionKey).toBe(r.host.sessionKey);
    expect(e.promptKey).toBe(r.host.promptKey);
    const claude = createRouteTrace({ ...traceInput(), agent: "claude-code" });
    expect(claude.host.sessionKey).not.toBe(e.sessionKey);
    expect(claude.host.promptKey).not.toBe(e.promptKey);
  });
  it("joins reverse order, dedupes phases and counts one route-skill pair for repeated reads", async () => {
    const pre = event(),
      post = event({ hook_event_name: "PostToolUse" }),
      second = event({ tool_use_id: "other" });
    const ix = await index([post, pre, pre, second]);
    const summary = new CodexReadSummary(ix);
    summary.add(route());
    expect(summary.result()).toMatchObject({
      recommended: 1,
      emitted: 1,
      observedInstructionReadAttemptPairs: 1,
      observedTerminalEventPairs: 1,
      terminalSuccess: "unsupported",
    });
    expect(ix.health).toMatchObject({
      duplicates: 1,
      attempted: 2,
      terminalObserved: 1,
      attemptedOnly: 1,
    });
    expect(
      traceInstructionReads(route(), ix).calls.every(
        (c) => c.outcome === "unknown",
      ),
    ).toBe(true);
  });
  it.each([
    "no-event",
    "other-turn",
    "other-session",
    "unresolved",
    "stale",
    "conflicting",
    "terminal-only",
    "old-trace",
  ])("does not invent adoption for %s", async (kind) => {
    const pre = event(
      kind === "other-turn"
        ? { turn_id: "different" }
        : kind === "other-session"
          ? { session_id: "different" }
          : {},
    );
    if (kind === "unresolved") pre.skill = { resolved: false };
    if (kind === "stale" && pre.skill.resolved)
      pre.skill.contentHash = "f".repeat(64);
    const post = event({ hook_event_name: "PostToolUse" });
    if (kind === "conflicting" && post.skill.resolved)
      post.skill.contentHash = "a".repeat(64);
    const ix = await index(
      kind === "no-event"
        ? []
        : kind === "terminal-only"
          ? [post]
          : kind === "conflicting"
            ? [post, pre]
            : [pre],
    );
    const r = route();
    if (kind === "old-trace") delete r.capabilities;
    const summary = new CodexReadSummary(ix);
    summary.add(r);
    expect(summary.result().observedInstructionReadAttemptPairs).toBe(0);
    expect(summary.result()).not.toHaveProperty("notInvoked");
    expect(summary.result()).not.toHaveProperty("conversion");
  });
  it("uses exact-file discovery and works without API credentials; unrelated tools do no discovery", async () => {
    const c = await workspace(),
      env = { ...c, env: { SKILLDISPATCH_DATA_DIR: join(c.root, "data") } };
    await write(
      join(c.home, ".config/skilldispatch/config.yaml"),
      'hook: {codexContract: "0.155.1"}',
    );
    const target = join(c.repo, ".agents/skills/react/SKILL.md");
    const discover = vi.fn(
      (
        context: import("../../src/runtime/context.js").RuntimeEnvironment,
        path: string,
      ) =>
        new CodexDiscoveryAdapter({
          adminRoots: [],
          targetPath: path,
        }).discover(context),
    );
    await observeCodexRead(
      { ...raw(), cwd: c.cwd, tool_input: { command: "echo safe" } },
      env,
      { discover },
    );
    expect(discover).not.toHaveBeenCalled();
    await observeCodexRead(
      { ...raw(), cwd: c.cwd, tool_input: { command: `cat '${target}'` } },
      env,
      { discover },
    );
    expect(discover).toHaveBeenCalledTimes(1);
    const data = await readFile(codexReadPath(env), "utf8");
    expect(data).not.toContain(c.root);
    expect(data).not.toMatch(/PRIVATE_|SKILL.md/);
    expect(JSON.parse(data).skill.resolved).toBe(true);
    const found = await discover(env, target);
    expect(found.skills).toHaveLength(1);
  });
  it("matches the strict published read schema and retains both old and new route contracts", async () => {
    const shipped = JSON.parse(
      await readFile(
        new URL(
          "../../schemas/codex-instruction-read.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(shipped).toEqual(
      z.toJSONSchema(codexReadSchema, { target: "draft-2020-12" }),
    );
    expect(
      codexReadSchema.safeParse({ ...event(), command: "private" }).success,
    ).toBe(false);
    expect((await schemaValidator())(route())).toBe(true);
  });
});
describe("Codex stream file security", () => {
  it("isolates corrupt and unsupported lines, and appends concurrent complete records privately", async () => {
    const c = await workspace(),
      path = join(c.root, "private/events.jsonl");
    const sink = new CodexReadSink(path, []);
    await Promise.all(Array.from({ length: 15 }, () => sink.write(event())));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, '{broken}\n{"schemaVersion":"99.0"}\n', {
      flag: "a",
    });
    const ix = await readCodexReadIndex(new CodexReadReader(path, []));
    expect(ix.health).toMatchObject({
      validEvents: 15,
      invalidLines: 1,
      unsupportedVersions: 1,
    });
  });
  it.each(["symlink", "hardlink", "permissions", "collision", "key-name"])(
    "refuses %s without modifying destination",
    async (kind) => {
      const c = await workspace(),
        dir = join(c.root, "private");
      await privateDirectory(dir);
      const original = join(dir, "original");
      await writeFile(original, "sentinel", { mode: 0o600 });
      const path = join(
        dir,
        kind === "key-name" ? "install.key" : "events.jsonl",
      );
      if (kind === "symlink") await symlink(original, path);
      if (kind === "hardlink") await link(original, path);
      if (kind === "permissions") {
        await writeFile(path, "sentinel", { mode: 0o644 });
        await chmod(path, 0o644);
      }
      const sink = new CodexReadSink(path, kind === "collision" ? [path] : []);
      await sink.write(event());
      expect(await readFile(original, "utf8")).toBe("sentinel");
      if (kind !== "collision" && kind !== "key-name")
        expect(await readFile(path, "utf8")).toBe("sentinel");
    },
  );
});

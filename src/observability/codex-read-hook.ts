import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import type { SkillDescriptor } from "../core/types.js";
import { CodexDiscoveryAdapter } from "../discovery/codex.js";
import {
  codexCatalogIdentity,
  codexMetadata,
  safeCodexName,
} from "../discovery/codex-origin.js";
import { codexReadEvents } from "../hosts/codex-contract.js";
import type { RuntimeEnvironment } from "../runtime/context.js";
import { keyedHash } from "../telemetry/privacy.js";
import { assertTraceDestination } from "../telemetry/reader.js";
import { dataDirectory, installationKey } from "../telemetry/storage.js";
import {
  CodexReadSink,
  codexReadStorageContext,
} from "./codex-read-storage.js";
import { type CodexReadEvent, codexReadSchema } from "./codex-read-types.js";

const id = z.string().min(1).max(4096);
const schema = z.object({
  hook_event_name: z.enum(codexReadEvents),
  tool_name: z.literal("Bash"),
  tool_input: z.object({ command: z.string().max(16384) }),
  session_id: id,
  turn_id: id.optional(),
  tool_use_id: id,
  cwd: z.string().refine(isAbsolute),
  agent_id: id.optional(),
  agent_type: id.optional(),
});
/** Deliberately not a shell interpreter. Relative paths lack the tool's actual workdir. */
export function literalInstructionRead(command: string): string | undefined {
  if (/[\p{Cc}\p{Cf}]/u.test(command)) return;
  const match =
    /^(?:cat|\/bin\/cat|\/usr\/bin\/cat) +(?:-- +)?(?:"([^"\\$`]+)"|'([^']+)'|(\/[^\s'"\\$`;&|<>()*?[\]{}!~]+)) *$/u.exec(
      command.trim(),
    );
  const path = match?.[1] ?? match?.[2] ?? match?.[3];
  return path && isAbsolute(path) && basename(path) === "SKILL.md"
    ? path
    : undefined;
}
export function parseCodexRead(raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return;
  const path = literalInstructionRead(parsed.data.tool_input.command);
  if (!path) return;
  return { ...parsed.data, path };
}
export function createCodexReadEvent(
  input: NonNullable<ReturnType<typeof parseCodexRead>>,
  key: Uint8Array,
  skills: readonly SkillDescriptor[],
  canonical: string,
): CodexReadEvent {
  const matches = skills.filter(
    (s) => s.agent === "codex" && s.path === canonical && safeCodexName(s.name),
  );
  const skill = matches.length === 1 ? matches[0] : undefined;
  return codexReadSchema.parse({
    schemaVersion: "1.0",
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    agent: "codex",
    evidence: "skill-instructions-read",
    phase:
      input.hook_event_name === "PreToolUse"
        ? "attempted"
        : "terminal-observed",
    outcome: "unknown",
    sessionKey: keyedHash(key, "session", `codex\0${input.session_id}`),
    ...(input.turn_id === undefined
      ? {}
      : {
          promptKey: keyedHash(key, "host-prompt", `codex\0${input.turn_id}`),
        }),
    toolUseKey: keyedHash(
      key,
      "tool-use",
      JSON.stringify(["codex", input.session_id, input.tool_use_id]),
    ),
    skill: skill
      ? {
          resolved: true,
          name: skill.name,
          origin: codexMetadata(skill)?.origin ?? "unknown",
          catalogIdentity: codexCatalogIdentity(skill),
          contentHash: skill.contentHash,
        }
      : { resolved: false },
    executionContext: {
      kind:
        input.agent_id !== undefined
          ? "subagent"
          : input.agent_type !== undefined
            ? "unknown"
            : "main",
    },
  });
}
export async function observeCodexRead(
  raw: unknown,
  environment: RuntimeEnvironment,
  overrides: {
    discover?: (
      env: RuntimeEnvironment,
      target: string,
    ) => Promise<{ skills: SkillDescriptor[] }>;
    write?: (event: CodexReadEvent) => Promise<void>;
  } = {},
) {
  try {
    const input = parseCodexRead(raw);
    if (!input) return; // No filesystem work for unrelated commands.
    const storage = await codexReadStorageContext(environment);
    if (!storage.enabled) return;
    await assertTraceDestination(storage.path, storage.protectedPaths);
    const canonical = await realpath(input.path).catch(() => input.path);
    const key = await installationKey(dataDirectory(environment));
    let skills: SkillDescriptor[] = [];
    try {
      skills = (
        await (
          overrides.discover ??
          ((env, target) =>
            new CodexDiscoveryAdapter({ targetPath: target }).discover(env))
        )({ ...environment, cwd: input.cwd }, canonical)
      ).skills;
    } catch {
      /* unresolved */
    }
    const event = createCodexReadEvent(input, key, skills, canonical);
    await (
      overrides.write ??
      ((value) =>
        new CodexReadSink(storage.path, storage.protectedPaths).write(value))
    )(event);
  } catch {
    /* local-only, silent, best effort */
  }
}

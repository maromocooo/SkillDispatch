import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config/load.js";
import type { SkillDescriptor } from "../core/types.js";
import { ClaudeDiscoveryAdapter } from "../discovery/claude.js";
import { claudeInvocationName } from "../discovery/claude-invocation.js";
import {
  claudeCatalogIdentity,
  claudeMetadata,
} from "../discovery/claude-origin.js";
import type { RuntimeEnvironment } from "../runtime/context.js";
import { keyedHash } from "../telemetry/privacy.js";
import { openPrivateFile } from "../telemetry/reader.js";
import {
  dataDirectory,
  installationKey,
  tracePath,
} from "../telemetry/storage.js";
import { invocationPath, JsonlInvocationSink } from "./invocation-storage.js";
import {
  type InvocationSink,
  invocationEvents,
  invocationSchema,
  nativeNameSchema,
  type SkillInvocationEvent,
} from "./invocation-types.js";

const hostId = z.string().min(1).max(4096);
const inputSchema = z.object({
  hook_event_name: z.enum(invocationEvents),
  tool_name: z.literal("Skill"),
  tool_input: z.object({ skill: nativeNameSchema }),
  session_id: hostId,
  prompt_id: hostId.optional(),
  tool_use_id: hostId,
  cwd: z.string().min(1).refine(isAbsolute),
  agent_id: hostId.optional(),
  agent_type: z.string().optional(),
  duration_ms: z.number().finite().nonnegative().optional(),
  is_interrupt: z.boolean().optional(),
});
export function parseSkillHook(raw: unknown) {
  const parsed = inputSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
export type SkillHookInput = NonNullable<ReturnType<typeof parseSkillHook>>;
export function createInvocationEvent(
  input: SkillHookInput,
  key: Uint8Array,
  skills: readonly SkillDescriptor[],
  catalogAvailable = true,
): SkillInvocationEvent {
  const matches = skills.filter(
    (s) => claudeInvocationName(s) === input.tool_input.skill,
  );
  const skill = matches.length === 1 ? matches[0] : undefined;
  const phase =
    input.hook_event_name === "PreToolUse"
      ? "attempted"
      : input.hook_event_name === "PostToolUse"
        ? "succeeded"
        : "failed";
  return invocationSchema.parse({
    schemaVersion: "1.0",
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    agent: "claude-code",
    phase,
    source: "model-skill-tool",
    sessionKey: keyedHash(key, "session", `claude-code\0${input.session_id}`),
    ...(input.prompt_id === undefined
      ? {}
      : {
          promptKey: keyedHash(
            key,
            "host-prompt",
            `claude-code\0${input.prompt_id}`,
          ),
        }),
    toolUseKey: keyedHash(
      key,
      "tool-use",
      JSON.stringify(["claude-code", input.session_id, input.tool_use_id]),
    ),
    skill: skill
      ? {
          nativeInvocationName: input.tool_input.skill,
          resolved: true,
          name: skill.name,
          origin: claudeMetadata(skill)?.origin ?? "unknown",
          catalogIdentity: claudeCatalogIdentity(skill),
          contentHash: skill.contentHash,
        }
      : { nativeInvocationName: input.tool_input.skill, resolved: false },
    executionContext: {
      kind: input.agent_id === undefined ? "main" : "subagent",
    },
    ...(phase !== "attempted" && input.duration_ms !== undefined
      ? { durationMs: input.duration_ms }
      : {}),
    ...(phase === "failed" && input.is_interrupt !== undefined
      ? { isInterrupt: input.is_interrupt }
      : {}),
    ...(!skill
      ? {
          diagnosticCode: !catalogAvailable
            ? "catalog_unavailable"
            : matches.length > 1
              ? "ambiguous_skill_invocation"
              : "unresolved_skill_invocation",
        }
      : {}),
  });
}

export async function observeClaudeSkill(
  raw: unknown,
  environment: RuntimeEnvironment,
  overrides: {
    discover?: (
      environment: RuntimeEnvironment,
    ) => Promise<{ skills: SkillDescriptor[] }>;
    makeSink?: (
      path: string,
      protectedPaths: readonly string[],
    ) => InvocationSink;
  } = {},
): Promise<void> {
  try {
    const input = parseSkillHook(raw);
    if (!input) return;
    // User-only authority even when routing explicitly trusts repository config.
    const { config } = await loadConfig({ ...environment, mode: "user" });
    if (!config.telemetry.enabled) return;
    const directory = dataDirectory(environment);
    const key = await installationKey(directory);
    const keyFile = await openPrivateFile(join(directory, "install.key"));
    if (!keyFile) return;
    try {
      if ((await keyFile.stat()).size !== 32) return;
    } finally {
      await keyFile.close();
    }
    let skills: SkillDescriptor[] = [],
      available = true;
    try {
      skills = (
        await (
          overrides.discover ??
          ((env) => new ClaudeDiscoveryAdapter().discover(env))
        )({ ...environment, cwd: input.cwd })
      ).skills;
    } catch {
      available = false;
    }
    const sink = (
      overrides.makeSink ??
      ((path, reserved) => new JsonlInvocationSink(path, reserved))
    )(invocationPath(environment), [
      join(directory, "install.key"),
      join(directory, "codex-instruction-reads.jsonl"),
      tracePath(environment, config.telemetry.tracePath),
    ]);
    await sink.write(createInvocationEvent(input, key, skills, available));
  } catch {
    /* Observers never block or output host data. */
  }
}

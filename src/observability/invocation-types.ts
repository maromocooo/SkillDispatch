import { z } from "zod";
import { digestSchema } from "../telemetry/types.js";

// No aliases, whitespace, paths, shell syntax, controls or instruction punctuation.
export const nativeNameSchema = z
  .string()
  .max(257)
  .regex(
    /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]{0,127}(?::[\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]{0,127})?$/u,
  );
export const invocationEvents = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
] as const;
export const invocationSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    eventId: z.uuid(),
    timestamp: z.iso.datetime(),
    agent: z.literal("claude-code"),
    phase: z.enum(["attempted", "succeeded", "failed"]),
    source: z.literal("model-skill-tool"),
    sessionKey: digestSchema,
    promptKey: digestSchema.optional(),
    toolUseKey: digestSchema,
    skill: z.discriminatedUnion("resolved", [
      z.strictObject({
        nativeInvocationName: nativeNameSchema,
        resolved: z.literal(false),
      }),
      z.strictObject({
        nativeInvocationName: nativeNameSchema,
        resolved: z.literal(true),
        name: z.string().min(1).max(1024),
        origin: z.enum([
          "local-user",
          "local-project",
          "synced",
          "plugin",
          "managed",
          "unknown",
        ]),
        catalogIdentity: digestSchema,
        contentHash: digestSchema,
      }),
    ]),
    executionContext: z.strictObject({ kind: z.enum(["main", "subagent"]) }),
    durationMs: z.number().finite().nonnegative().optional(),
    isInterrupt: z.boolean().optional(),
    diagnosticCode: z
      .enum([
        "unresolved_skill_invocation",
        "ambiguous_skill_invocation",
        "catalog_unavailable",
      ])
      .optional(),
  })
  .meta({
    $id: "https://skilldispatch.dev/schemas/skill-invocation-v1.json",
    title: "SkillDispatch Model Skill Invocation v1",
    description:
      "Observed Claude native Skill tool lifecycle, not task success or user-direct slash invocation.",
  });
export type SkillInvocationEvent = z.infer<typeof invocationSchema>;
export interface InvocationSink {
  write(event: SkillInvocationEvent): Promise<void>;
}

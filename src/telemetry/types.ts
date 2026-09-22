import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const safeModelSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const diagnosticCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
export const promptStorageSchema = z.enum(["none", "hash", "raw"]);
export type PromptStorage = z.infer<typeof promptStorageSchema>;

export const routeTraceSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    traceId: z.uuid(),
    timestamp: z.iso.datetime(),
    agent: z.enum(["codex", "claude-code"]),
    mode: z.enum(["shadow", "advisory"]),
    capabilities: z
      .strictObject({ skillInvocationTelemetry: z.literal(true) })
      .describe(
        "Observer registration and local persistence prerequisites were detected at routing time. Configuration does not confirm host reload, event delivery or complete observation of this turn. Async delivery is best effort; absence of events does not prove non-invocation.",
      )
      .optional(),
    delivery: z
      .strictObject({
        kind: z.enum(["none", "claude-advisory"]),
        injectedSkillIds: z.array(digestSchema),
      })
      .describe(
        "Recommendations emitted in host context output; not proof of host consumption or native invocation.",
      )
      .optional(),
    prompt: z.discriminatedUnion("storage", [
      z.strictObject({ storage: z.literal("none") }),
      z.strictObject({
        storage: z.literal("hash"),
        hash: digestSchema.describe(
          "Installation-local HMAC of exact prompt text; identical text correlates across submissions.",
        ),
      }),
      z.strictObject({ storage: z.literal("raw"), raw: z.string() }),
    ]),
    host: z.strictObject({
      event: z.literal("UserPromptSubmit"),
      sessionKey: digestSchema.optional(),
      promptKey: digestSchema
        .describe(
          "Installation-local HMAC of the host prompt submission ID (Codex turn_id or Claude prompt_id), separated by host. Different submission IDs produce different keys even for identical prompt text.",
        )
        .optional(),
      model: safeModelSchema.optional(),
    }),
    catalog: z.strictObject({
      fingerprint: digestSchema,
      skillCount: z.number().int().min(0),
      enabledSkillCount: z.number().int().min(0),
    }),
    router: z.strictObject({
      provider: safeModelSchema,
      model: safeModelSchema.optional(),
      latencyMs: z.number().min(0),
    }),
    policy: z.strictObject({
      threshold: z.number().min(0).max(1),
      maxSkills: z.number().int().min(1),
    }),
    outcome: z.enum(["complete", "partial", "failed"]),
    decisions: z.array(
      z.strictObject({
        skillId: digestSchema,
        name: z.string().min(1),
        agent: z.enum(["codex", "claude-code", "generic"]),
        scope: z.enum(["repo", "user", "admin", "system", "unknown"]),
        contentHash: digestSchema,
        catalogIdentity: digestSchema
          .describe(
            "Path-free adapter-owned catalog identity for exact version correlation.",
          )
          .optional(),
        probability: z.number().min(0).max(1),
        selected: z
          .boolean()
          .describe(
            "Selected by SkillDispatch routing policy; not evidence of host invocation.",
          ),
      }),
    ),
    diagnostics: z.array(
      z.strictObject({
        code: diagnosticCodeSchema,
        level: z.enum(["info", "warning", "error"]),
        skillIds: z.array(digestSchema).optional(),
      }),
    ),
  })
  .meta({
    $id: "https://skilldispatch.dev/schemas/route-trace-v1.json",
    title: "SkillDispatch Route Trace v1",
    description:
      "Local routing recommendations and optional advisory delivery. No host invocation or output quality is inferred.",
  });

export type RouteTrace = z.infer<typeof routeTraceSchema>;
export interface TraceSink {
  write(trace: RouteTrace): Promise<void>;
}

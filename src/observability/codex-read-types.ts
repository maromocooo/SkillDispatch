import { z } from "zod";
import { codexOrigins, safeCodexName } from "../discovery/codex-origin.js";
import { digestSchema } from "../telemetry/types.js";

const safeName = z.string().max(257).refine(safeCodexName);
export const codexReadSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    eventId: z.uuid(),
    timestamp: z.iso.datetime(),
    agent: z.literal("codex"),
    evidence: z.literal("skill-instructions-read"),
    phase: z.enum(["attempted", "terminal-observed"]),
    outcome: z
      .literal("unknown")
      .describe(
        "The verified Bash hook response has no authoritative exit status or completeness indication.",
      ),
    sessionKey: digestSchema,
    promptKey: digestSchema.optional(),
    toolUseKey: digestSchema,
    skill: z.discriminatedUnion("resolved", [
      z.strictObject({ resolved: z.literal(false) }),
      z.strictObject({
        resolved: z.literal(true),
        name: safeName,
        origin: z.enum(codexOrigins),
        catalogIdentity: digestSchema,
        contentHash: digestSchema,
      }),
    ]),
    executionContext: z.strictObject({
      kind: z.enum(["main", "subagent", "unknown"]),
    }),
  })
  .meta({
    $id: "https://skilldispatch.dev/schemas/codex-instruction-read-v1.json",
    title: "Codex instruction-read evidence v1",
    description:
      "Literal read requests and terminal events; not native invocation, full loading, compliance or task quality.",
  });
export type CodexReadEvent = z.infer<typeof codexReadSchema>;

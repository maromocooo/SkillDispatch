import { z } from "zod";
import type { RoutingPolicy } from "../core/types.js";
import type { MockProviderOptions } from "../providers/mock.js";

export const discoveryAgentSchema = z.enum(["codex", "claude-code"]);
export type DiscoveryAgent = z.infer<typeof discoveryAgentSchema>;
export const probabilitySchema = z.number().min(0).max(1);
export const maxSkillsSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const configFileSchema = z.object({
  router: z
    .object({
      provider: z.literal("mock").optional(),
      timeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
      mock: z
        .object({
          scores: z.record(z.string(), probabilitySchema).optional(),
          defaultProbability: probabilitySchema.optional(),
        })
        .optional(),
    })
    .optional(),
  policy: z
    .object({
      threshold: probabilitySchema.optional(),
      maxSkills: maxSkillsSchema.optional(),
    })
    .optional(),
  discovery: z
    .object({ agents: z.array(discoveryAgentSchema).min(1).optional() })
    .optional(),
});

export interface SkillDispatchConfig {
  router: { provider: "mock"; timeoutMs: number; mock: MockProviderOptions };
  policy: RoutingPolicy;
  discovery: { agents: DiscoveryAgent[] };
}

export const defaultConfig = (): SkillDispatchConfig => ({
  router: { provider: "mock", timeoutMs: 2500, mock: {} },
  policy: { threshold: 0.75, maxSkills: 4 },
  discovery: { agents: ["codex", "claude-code"] },
});

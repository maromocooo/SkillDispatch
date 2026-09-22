import { isAbsolute } from "node:path";
import { z } from "zod";
import type { RoutingPolicy } from "../core/types.js";
import {
  defaultJevOptions,
  jevOptionsSchema,
  type ResolvedJevOptions,
} from "../providers/jev/options.js";
import type { MockProviderOptions } from "../providers/mock.js";

export const discoveryAgentSchema = z.enum(["codex", "claude-code"]);
export type DiscoveryAgent = z.infer<typeof discoveryAgentSchema>;
export const probabilitySchema = z.number().min(0).max(1);
export const maxSkillsSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const hookModesSchema = z.object({
  claude: z.enum(["shadow", "advisory"]),
  codex: z.literal("shadow"),
});
export type HookModes = z.infer<typeof hookModesSchema>;

export const configFileSchema = z.object({
  hook: z
    .object({
      trustProjectConfig: z.boolean().optional(),
      modes: hookModesSchema.partial().optional(),
    })
    .optional(),
  telemetry: z
    .object({
      enabled: z.boolean().optional(),
      prompt: z.enum(["none", "hash", "raw"]).optional(),
      tracePath: z
        .string()
        .min(1)
        .refine(
          (path) =>
            !path.includes("\0") && (isAbsolute(path) || path.startsWith("~/")),
        )
        .optional(),
    })
    .optional(),
  router: z
    .object({
      provider: z.enum(["jev", "mock"]).optional(),
      timeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
      jev: jevOptionsSchema.partial().optional(),
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
  hook: { trustProjectConfig: boolean; modes: HookModes };
  telemetry: {
    enabled: boolean;
    prompt: "none" | "hash" | "raw";
    tracePath?: string;
  };
  router: {
    provider: "jev" | "mock";
    timeoutMs: number;
    mock: MockProviderOptions;
    jev: ResolvedJevOptions;
  };
  policy: RoutingPolicy;
  discovery: { agents: DiscoveryAgent[] };
}

export const defaultConfig = (): SkillDispatchConfig => ({
  hook: {
    trustProjectConfig: false,
    modes: { claude: "shadow", codex: "shadow" },
  },
  telemetry: { enabled: true, prompt: "hash" },
  router: {
    provider: "jev",
    timeoutMs: 2500,
    mock: {},
    jev: defaultJevOptions(),
  },
  policy: { threshold: 0.75, maxSkills: 4 },
  discovery: { agents: ["codex", "claude-code"] },
});

import { resolve } from "node:path";
import {
  type DiscoveryAgent,
  maxSkillsSchema,
  probabilitySchema,
} from "../config/schema.js";
import {
  createProvider,
  loadRuntimeContext,
  type RuntimeEnvironment,
} from "../runtime/context.js";

export interface CliOptions {
  agent?: DiscoveryAgent;
  cwd?: string;
  config?: string;
  json?: boolean;
  threshold?: string;
  maxSkills?: string;
}

export type CliEnvironment = RuntimeEnvironment;

/** The CLI is the composition root; domain code never chooses an agent/provider. */
export async function discoverForCommand(
  options: CliOptions,
  environment: CliEnvironment,
) {
  const context = await loadRuntimeContext(
    { ...environment, cwd: resolve(environment.cwd, options.cwd ?? ".") },
    {
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    },
  );
  const { config } = context;
  if (options.threshold !== undefined) {
    const parsed = probabilitySchema.safeParse(
      options.threshold.trim() ? Number(options.threshold) : Number.NaN,
    );
    if (!parsed.success)
      throw new Error("--threshold must be between 0 and 1.");
    config.policy.threshold = parsed.data;
  }
  if (options.maxSkills !== undefined) {
    const parsed = maxSkillsSchema.safeParse(Number(options.maxSkills));
    if (!parsed.success)
      throw new Error("--max-skills must be a positive integer.");
    config.policy.maxSkills = parsed.data;
  }
  return context;
}

/** Shared route/eval composition: config, catalog, provider and requesting agent. */
export async function routingForCommand(
  options: CliOptions,
  environment: CliEnvironment,
) {
  const context = await discoverForCommand(options, environment);
  const provider = createProvider(context.config, environment);
  return {
    ...context,
    provider,
    agent:
      context.agents.length === 1
        ? (context.agents[0] ?? "generic")
        : ("generic" as const),
  };
}

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import {
  type DiscoveryAgent,
  maxSkillsSchema,
  probabilitySchema,
} from "../config/schema.js";
import { finalizeCatalog } from "../discovery/catalog.js";
import { ClaudeDiscoveryAdapter } from "../discovery/claude.js";
import { CodexDiscoveryAdapter } from "../discovery/codex.js";
import type { DiscoveryAdapter } from "../discovery/types.js";

export interface CliOptions {
  agent?: DiscoveryAgent;
  cwd?: string;
  config?: string;
  json?: boolean;
  threshold?: string;
  maxSkills?: string;
}

export interface CliEnvironment {
  cwd: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** The CLI is the composition root; domain code never chooses an agent/provider. */
export async function discoverForCommand(
  options: CliOptions,
  environment: CliEnvironment,
) {
  const cwd = await realpath(resolve(environment.cwd, options.cwd ?? "."));
  const { config, diagnostics } = await loadConfig({
    cwd,
    home: environment.home,
    ...(options.config === undefined ? {} : { configPath: options.config }),
  });
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
  const agents = options.agent ? [options.agent] : config.discovery.agents;
  const adapters: Record<DiscoveryAgent, DiscoveryAdapter> = {
    codex: new CodexDiscoveryAdapter(),
    "claude-code": new ClaudeDiscoveryAdapter(),
  };
  const results = await Promise.all(
    agents.map((agent) =>
      adapters[agent].discover({
        cwd,
        home: environment.home,
        env: environment.env,
      }),
    ),
  );
  return {
    cwd,
    config,
    agents,
    catalog: finalizeCatalog([{ skills: [], diagnostics }, ...results]),
  };
}

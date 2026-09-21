import { realpath } from "node:fs/promises";
import { loadConfig } from "../config/load.js";
import type { DiscoveryAgent, SkillDispatchConfig } from "../config/schema.js";
import { finalizeCatalog } from "../discovery/catalog.js";
import { ClaudeDiscoveryAdapter } from "../discovery/claude.js";
import { CodexDiscoveryAdapter } from "../discovery/codex.js";
import type { DiscoveryAdapter } from "../discovery/types.js";
import { JevRouterProvider } from "../providers/jev.js";
import { MockRouterProvider } from "../providers/mock.js";
import type { RouterProvider } from "../providers/types.js";

export interface RuntimeEnvironment {
  cwd: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** Shared composition only. Core never imports discovery, config or provider SDKs. */
export async function loadRuntimeContext(
  environment: RuntimeEnvironment,
  options: { agent?: DiscoveryAgent; configPath?: string } = {},
) {
  const cwd = await realpath(environment.cwd);
  const { config, diagnostics } = await loadConfig({
    cwd,
    home: environment.home,
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
  });
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

export function createProvider(
  config: SkillDispatchConfig,
  environment: RuntimeEnvironment,
): RouterProvider {
  const apiKey = environment.env.TYPESAFE_API_KEY;
  return config.router.provider === "mock"
    ? new MockRouterProvider(config.router.mock)
    : new JevRouterProvider({
        ...config.router.jev,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
}

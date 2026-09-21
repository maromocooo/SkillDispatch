import type {
  AgentKind,
  Diagnostic,
  SkillDescriptor,
  SkillScope,
} from "../core/types.js";

export interface DiscoveryContext {
  cwd: string;
  home: string;
  /** Only the adapter's documented directory overrides need to be passed. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface DiscoveryResult {
  skills: SkillDescriptor[];
  diagnostics: Diagnostic[];
}

export interface DiscoveryAdapter {
  readonly agent: AgentKind;
  discover(context: DiscoveryContext): Promise<DiscoveryResult>;
}

export interface DiscoverySource {
  path: string;
  scope: SkillScope;
}

export interface DiscoveryMetadata {
  source: string;
  sourceIndex: number;
  /** Original directory entry before resolving the SKILL.md target. */
  path: string;
}

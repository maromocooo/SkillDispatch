export type AgentKind = "codex" | "claude-code" | "generic";
export type SkillScope = "repo" | "user" | "admin" | "system" | "unknown";

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  /** Canonical absolute SKILL.md path. */
  path: string;
  directory: string;
  scope: SkillScope;
  agent: AgentKind;
  /** Eligible for automatic routing; explicit host invocation may still work. */
  enabled: boolean;
  metadata: Record<string, unknown>;
  contentHash: string;
}

export interface Diagnostic {
  code: string;
  level: "info" | "warning" | "error";
  message: string;
  path?: string;
  skillIds?: string[];
}

export interface RouteRequest {
  prompt: string;
  cwd: string;
  agent: AgentKind;
  skills: readonly SkillDescriptor[];
}

export interface RoutingPolicy {
  threshold: number;
  maxSkills: number;
}

export interface ScoredSkill {
  skillId: string;
  name: string;
  probability: number;
  reasonCode?: string;
}

export interface SkillDecision extends ScoredSkill {
  selected: boolean;
}

export interface RouteResult {
  selected: SkillDecision[];
  allDecisions: SkillDecision[];
  router: { provider: string; model?: string; latencyMs: number };
  policy: RoutingPolicy;
  diagnostics: Diagnostic[];
}

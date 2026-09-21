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

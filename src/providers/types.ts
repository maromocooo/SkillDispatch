import type { AgentKind, SkillDescriptor } from "../core/types.js";

/** Metadata-only boundary; never includes SKILL.md bodies or arbitrary metadata. */
export type RoutingCandidate = Pick<
  SkillDescriptor,
  "id" | "name" | "description" | "scope"
>;

export interface ProviderRouteInput {
  prompt: string;
  cwd: string;
  agent: AgentKind;
  candidates: readonly RoutingCandidate[];
  signal?: AbortSignal;
}

export interface ProviderDecision {
  skillId: string;
  probability: number;
  reasonCode?: string;
}

export interface ProviderRouteOutput {
  decisions: ProviderDecision[];
  model?: string;
}

export interface RouterProvider {
  readonly name: string;
  judge(input: ProviderRouteInput): Promise<ProviderRouteOutput>;
}

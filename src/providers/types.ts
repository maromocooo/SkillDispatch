import type { AgentKind, Diagnostic, SkillDescriptor } from "../core/types.js";

/** Metadata-only boundary; never includes SKILL.md bodies or arbitrary metadata. */
export type RoutingCandidate = Pick<
  SkillDescriptor,
  "id" | "name" | "description" | "scope" | "agent"
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

/** Safe domain messages only: never raw SDK errors, prompts, keys or environment values. */
export type ProviderDiagnostic = Pick<
  Diagnostic,
  "code" | "level" | "message" | "skillIds"
>;

export interface ProviderRouteOutput {
  decisions: ProviderDecision[];
  /** Complete covers every candidate with a decision; partial has at least one failed ID. */
  completeness: "complete" | "partial";
  /** With decisions, forms a disjoint, duplicate-free partition of candidate IDs. */
  failedSkillIds?: string[];
  /** Optional skillIds must be unique and refer to input candidates. */
  diagnostics?: ProviderDiagnostic[];
  model?: string;
}

export interface RouterProvider {
  readonly name: string;
  judge(input: ProviderRouteInput): Promise<ProviderRouteOutput>;
}

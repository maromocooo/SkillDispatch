import type {
  Diagnostic,
  RoutingPolicy,
  SkillDescriptor,
} from "../core/types.js";

export type EvalSkill = Pick<
  SkillDescriptor,
  "id" | "name" | "agent" | "scope"
>;
export interface EvalSelection extends EvalSkill {
  probability: number;
}
export type EvalDiagnostic = Pick<Diagnostic, "code" | "level" | "skillIds">;
export interface EvalCaseResult {
  id: string;
  fullyLabeled: boolean;
  selected: EvalSelection[];
  truePositives: EvalSelection[];
  falsePositives: EvalSelection[];
  falseNegatives: EvalSkill[];
  unlabeledSelected: EvalSelection[];
  exactMatch: boolean | null;
  latencyMs: number;
  routing: {
    provider: string;
    model?: string;
    partial: boolean;
    failed: boolean;
  };
  diagnostics: EvalDiagnostic[];
}
export interface EvalMetrics {
  caseCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  unlabeledSelected: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  exactSetAccuracy: number | null;
  fullyLabeledCaseCount: number;
  averageSelectedSkills: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  providerPartialCount: number;
  providerFailureCount: number;
}
export interface EvalGateResult {
  metric: "precision" | "recall";
  minimum: number;
  actual: number | null;
  passed: boolean;
}
export interface EvalResult {
  version: 1;
  policy: RoutingPolicy;
  cases: EvalCaseResult[];
  metrics: EvalMetrics;
  gates: EvalGateResult[];
  passed: boolean;
  diagnostics: EvalDiagnostic[];
}

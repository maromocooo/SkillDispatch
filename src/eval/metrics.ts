import { compareText } from "../core/order.js";
import type {
  Diagnostic,
  RouteResult,
  SkillDescriptor,
} from "../core/types.js";
import { compareSkills, type ResolvedEvalCase } from "./resolve.js";
import type { EvalGates } from "./schema.js";
import type {
  EvalCaseResult,
  EvalDiagnostic,
  EvalGateResult,
  EvalMetrics,
  EvalSkill,
} from "./types.js";

export const evalSkill = ({
  id,
  name,
  agent,
  scope,
}: SkillDescriptor): EvalSkill => ({ id, name, agent, scope });

/** Deliberate output projection: no arbitrary messages, reason codes or paths. */
export function evalDiagnostics(
  diagnostics: readonly Diagnostic[],
): EvalDiagnostic[] {
  return diagnostics
    .map(({ code, level, skillIds }) => ({
      code,
      level,
      ...(skillIds === undefined
        ? {}
        : { skillIds: [...skillIds].sort(compareText) }),
    }))
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
}

export function scoreCase(
  item: ResolvedEvalCase,
  result: RouteResult,
  catalog: readonly SkillDescriptor[],
): EvalCaseResult {
  const byId = new Map(catalog.map((skill) => [skill.id, skill]));
  const positive = new Set(item.should.map((skill) => skill.id));
  const negative = new Set(item.should_not.map((skill) => skill.id));
  const selected = result.selected.map((decision) => {
    const skill = byId.get(decision.skillId);
    if (!skill)
      throw new Error("Evaluation received an unknown selected skill.");
    return { ...evalSkill(skill), probability: decision.probability };
  }); // Keep the core's probability/name/ID ranking.
  const selectedIds = new Set(selected.map((skill) => skill.id));
  const truePositives = selected.filter((skill) => positive.has(skill.id));
  const falsePositives = selected.filter(
    (skill) =>
      !positive.has(skill.id) && (item.fully_labeled || negative.has(skill.id)),
  );
  const falseNegatives = item.should
    .filter((skill) => !selectedIds.has(skill.id))
    .sort(compareSkills)
    .map(evalSkill);
  const codes = new Set(
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );
  return {
    id: item.id,
    fullyLabeled: item.fully_labeled,
    selected,
    truePositives,
    falsePositives,
    falseNegatives,
    unlabeledSelected: item.fully_labeled
      ? []
      : selected.filter(
          (skill) => !positive.has(skill.id) && !negative.has(skill.id),
        ),
    exactMatch: item.fully_labeled
      ? falsePositives.length === 0 && falseNegatives.length === 0
      : null,
    latencyMs: result.router.latencyMs,
    routing: {
      provider: result.router.provider,
      ...(result.router.model === undefined
        ? {}
        : { model: result.router.model }),
      partial: codes.has("provider_partial"),
      failed: [
        "provider_failed",
        "provider_timeout",
        "invalid_provider_response",
      ].some((code) => codes.has(code)),
    },
    diagnostics: evalDiagnostics(result.diagnostics),
  };
}

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator;

/** Micro-aggregate labeled predictions; nearest-rank latency percentiles. */
export function aggregateMetrics(
  cases: readonly EvalCaseResult[],
): EvalMetrics {
  const sum = (count: (item: EvalCaseResult) => number) =>
    cases.reduce((total, item) => total + count(item), 0);
  const tp = sum((item) => item.truePositives.length);
  const fp = sum((item) => item.falsePositives.length);
  const fn = sum((item) => item.falseNegatives.length);
  const fullyLabeled = cases.filter((item) => item.exactMatch !== null);
  const latencies = cases.map((item) => item.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies[Math.ceil(p * latencies.length) - 1] ?? null;
  return {
    caseCount: cases.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    unlabeledSelected: sum((item) => item.unlabeledSelected.length),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    exactSetAccuracy: ratio(
      fullyLabeled.filter((item) => item.exactMatch).length,
      fullyLabeled.length,
    ),
    fullyLabeledCaseCount: fullyLabeled.length,
    averageSelectedSkills: ratio(
      sum((item) => item.selected.length),
      cases.length,
    ),
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    providerPartialCount: sum((item) => Number(item.routing.partial)),
    providerFailureCount: sum((item) => Number(item.routing.failed)),
  };
}

export function evaluateGates(
  metrics: EvalMetrics,
  gates: EvalGates,
): EvalGateResult[] {
  const results: EvalGateResult[] = [];
  for (const metric of ["precision", "recall"] as const) {
    const minimum =
      gates[metric === "precision" ? "min_precision" : "min_recall"];
    if (minimum !== undefined) {
      const actual = metrics[metric];
      results.push({
        metric,
        minimum,
        actual,
        passed: actual !== null && actual >= minimum,
      });
    }
  }
  return results;
}

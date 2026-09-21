import { compareText } from "./order.js";
import type { RoutingPolicy, ScoredSkill, SkillDecision } from "./types.js";

export const DEFAULT_POLICY: Readonly<RoutingPolicy> = Object.freeze({
  threshold: 0.75,
  maxSkills: 4,
});

export function validatePolicy(policy: RoutingPolicy): void {
  if (
    !Number.isFinite(policy.threshold) ||
    policy.threshold < 0 ||
    policy.threshold > 1
  )
    throw new RangeError("threshold must be between 0 and 1.");
  if (!Number.isSafeInteger(policy.maxSkills) || policy.maxSkills < 1)
    throw new RangeError("maxSkills must be a positive integer.");
}

/** Inclusive threshold, probability descending, then name/id in code-point order. */
export function applyPolicy(
  decisions: readonly ScoredSkill[],
  policy: RoutingPolicy = DEFAULT_POLICY,
): { selected: SkillDecision[]; allDecisions: SkillDecision[] } {
  validatePolicy(policy);
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (
      !Number.isFinite(decision.probability) ||
      decision.probability < 0 ||
      decision.probability > 1
    )
      throw new RangeError("probability must be between 0 and 1.");
    if (ids.has(decision.skillId)) throw new Error("Duplicate skill decision.");
    ids.add(decision.skillId);
  }
  const ranked = [...decisions].sort(
    (a, b) =>
      b.probability - a.probability ||
      compareText(a.name, b.name) ||
      compareText(a.skillId, b.skillId),
  );
  let selectedCount = 0;
  const allDecisions = ranked.map((decision) => {
    const selected =
      decision.probability >= policy.threshold &&
      selectedCount < policy.maxSkills;
    if (selected) selectedCount++;
    return { ...decision, selected };
  });
  return {
    allDecisions,
    selected: allDecisions.filter((decision) => decision.selected),
  };
}

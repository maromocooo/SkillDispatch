import { compareText } from "../core/order.js";
import type { SkillDescriptor } from "../core/types.js";
import {
  type EvalCase,
  type EvalDataset,
  EvalInputError,
  type SkillSelector,
} from "./schema.js";

export interface ResolvedEvalCase
  extends Omit<EvalCase, "should" | "should_not"> {
  should: SkillDescriptor[];
  should_not: SkillDescriptor[];
}

export const compareSkills = (
  a: Pick<SkillDescriptor, "name" | "agent" | "scope" | "id">,
  b: Pick<SkillDescriptor, "name" | "agent" | "scope" | "id">,
): number =>
  compareText(a.name, b.name) ||
  compareText(a.agent, b.agent) ||
  compareText(a.scope, b.scope) ||
  compareText(a.id, b.id);

export function resolveSelector(
  selector: SkillSelector,
  catalog: readonly SkillDescriptor[],
): SkillDescriptor {
  const matches = catalog.filter(
    (skill) =>
      skill.name === selector.name &&
      (selector.agent === undefined || skill.agent === selector.agent) &&
      (selector.scope === undefined || skill.scope === selector.scope),
  );
  if (matches.length === 0) throw new EvalInputError("unknown_eval_skill");
  if (matches.length !== 1) throw new EvalInputError("ambiguous_eval_skill");
  return matches[0] as SkillDescriptor;
}

/** Resolve the entire dataset before any requests. Disabled skills remain labelable. */
export function resolveEvalCases(
  dataset: EvalDataset,
  catalog: readonly SkillDescriptor[],
): ResolvedEvalCase[] {
  if (new Set(catalog.map((skill) => skill.id)).size !== catalog.length)
    throw new EvalInputError("invalid_eval_catalog");
  return dataset.cases.map((item) => {
    const positive = item.should
      .map((selector) => resolveSelector(selector, catalog))
      .sort(compareSkills);
    const negative = item.should_not
      .map((selector) => resolveSelector(selector, catalog))
      .sort(compareSkills);
    const positives = new Set(positive.map((skill) => skill.id));
    const negatives = new Set(negative.map((skill) => skill.id));
    if (
      positives.size !== positive.length ||
      negatives.size !== negative.length
    )
      throw new EvalInputError("duplicate_eval_label");
    if (negative.some((skill) => positives.has(skill.id)))
      throw new EvalInputError("conflicting_eval_labels");
    return { ...item, should: positive, should_not: negative };
  });
}

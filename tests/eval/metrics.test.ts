import { describe, expect, it } from "vitest";
import { applyPolicy, DEFAULT_POLICY } from "../../src/core/policy.js";
import {
  aggregateMetrics,
  evaluateGates,
  scoreCase,
} from "../../src/eval/metrics.js";
import { resolveEvalCases } from "../../src/eval/resolve.js";
import { validateEvalDataset } from "../../src/eval/schema.js";
import { skill } from "./helpers.js";

function score(
  positive: string[],
  negative: string[],
  selected: string[],
  full = false,
  latencyMs = 10,
) {
  const catalog = ["a", "b", "c"].map((id) => skill(id));
  const [item] = resolveEvalCases(
    validateEvalDataset({
      version: 1,
      cases: [
        {
          id: "test",
          prompt: "PRIVATE_EVAL_PROMPT_SENTINEL",
          should: positive.map((name) => ({ name })),
          should_not: negative.map((name) => ({ name })),
          fully_labeled: full,
        },
      ],
    }),
    catalog,
  );
  if (!item) throw new Error("Missing fixture");
  return scoreCase(
    item,
    {
      ...applyPolicy(
        selected.map((id) => ({ skillId: id, name: id, probability: 0.9 })),
      ),
      router: { provider: "mock", latencyMs },
      policy: DEFAULT_POLICY,
      diagnostics: [],
    },
    catalog,
  );
}

describe("eval metric semantics", () => {
  it.each([
    {
      label: "perfect multi-skill",
      pos: ["a", "b"],
      neg: ["c"],
      selected: ["b", "a"],
      full: true,
      tp: 2,
      fp: 0,
      fn: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      exact: 1,
    },
    {
      label: "explicit false positive",
      pos: ["a"],
      neg: ["b"],
      selected: ["a", "b"],
      full: false,
      tp: 1,
      fp: 1,
      fn: 0,
      precision: 0.5,
      recall: 1,
      f1: 2 / 3,
      exact: null,
    },
    {
      label: "false negative",
      pos: ["a", "b"],
      neg: [],
      selected: ["a"],
      full: true,
      tp: 1,
      fp: 0,
      fn: 1,
      precision: 1,
      recall: 0.5,
      f1: 2 / 3,
      exact: 0,
    },
    {
      label: "unlabeled selections excluded",
      pos: ["a"],
      neg: [],
      selected: ["a", "c"],
      full: false,
      tp: 1,
      fp: 0,
      fn: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      exact: null,
    },
    {
      label: "full labels make unspecified negative",
      pos: ["a"],
      neg: [],
      selected: ["a", "c"],
      full: true,
      tp: 1,
      fp: 1,
      fn: 0,
      precision: 0.5,
      recall: 1,
      f1: 2 / 3,
      exact: 0,
    },
    {
      label: "empty expected and selected",
      pos: [],
      neg: [],
      selected: [],
      full: true,
      tp: 0,
      fp: 0,
      fn: 0,
      precision: null,
      recall: null,
      f1: null,
      exact: 1,
    },
    {
      label: "no positives with false positive",
      pos: [],
      neg: ["a"],
      selected: ["a"],
      full: false,
      tp: 0,
      fp: 1,
      fn: 0,
      precision: 0,
      recall: null,
      f1: 0,
      exact: null,
    },
    {
      label: "no labeled predictions",
      pos: ["a"],
      neg: [],
      selected: ["c"],
      full: false,
      tp: 0,
      fp: 0,
      fn: 1,
      precision: null,
      recall: 0,
      f1: 0,
      exact: null,
    },
    {
      label: "all unlabeled",
      pos: [],
      neg: [],
      selected: ["c"],
      full: false,
      tp: 0,
      fp: 0,
      fn: 0,
      precision: null,
      recall: null,
      f1: null,
      exact: null,
    },
  ])(
    "$label",
    ({
      pos,
      neg,
      selected,
      full,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
      exact,
    }) => {
      const result = score(pos, neg, selected, full);
      const metrics = aggregateMetrics([result]);
      expect(metrics).toMatchObject({
        truePositives: tp,
        falsePositives: fp,
        falseNegatives: fn,
        precision,
        recall,
        f1,
        exactSetAccuracy: exact,
        averageSelectedSkills: selected.length,
      });
      expect(JSON.stringify(result)).not.toContain(
        "PRIVATE_EVAL_PROMPT_SENTINEL",
      );
      expect(result.unlabeledSelected.length).toBe(
        full ? 0 : selected.length - tp - fp,
      );
    },
  );
  it("micro-aggregates and measures exact sets only on fully labeled cases", () => {
    const cases = [
      score(["a", "b"], [], ["a", "b"], true, 100),
      score(["a"], ["b"], ["b"], false, 10),
      score([], [], [], true, 20),
    ];
    const result = aggregateMetrics(cases);
    expect(result).toMatchObject({
      caseCount: 3,
      precision: 2 / 3,
      recall: 2 / 3,
      f1: 2 / 3,
      fullyLabeledCaseCount: 2,
      exactSetAccuracy: 1,
      averageSelectedSkills: 1,
      p50LatencyMs: 20,
      p95LatencyMs: 100,
    });
    expect(aggregateMetrics([...cases].reverse())).toEqual(result);
    expect(aggregateMetrics(cases)).toEqual(result);
  });
  it("uses nearest rank percentiles and handles no observations without NaN", () => {
    const cases = Array.from({ length: 20 }, (_, i) =>
      score([], [], [], false, i + 1),
    );
    expect(aggregateMetrics(cases)).toMatchObject({
      p50LatencyMs: 10,
      p95LatencyMs: 19,
    });
    expect(aggregateMetrics([])).toMatchObject({
      caseCount: 0,
      precision: null,
      recall: null,
      f1: null,
      exactSetAccuracy: null,
      averageSelectedSkills: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
    });
  });
  it("gates are inclusive; undefined metrics cannot pass even a zero gate", () => {
    const metrics = aggregateMetrics([score(["a", "b"], ["c"], ["a", "c"])]);
    expect(
      evaluateGates(metrics, { min_precision: 0.5, min_recall: 0.5 }).every(
        (gate) => gate.passed,
      ),
    ).toBe(true);
    expect(
      evaluateGates(metrics, { min_precision: 0.51, min_recall: 0.51 }).every(
        (gate) => !gate.passed,
      ),
    ).toBe(true);
    expect(
      evaluateGates(aggregateMetrics([]), {
        min_precision: 0,
        min_recall: 0,
      }).every((gate) => !gate.passed),
    ).toBe(true);
  });
});

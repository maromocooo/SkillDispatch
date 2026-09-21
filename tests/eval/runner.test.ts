import { afterEach, describe, expect, it, vi } from "vitest";
import { runEvaluation } from "../../src/eval/runner.js";
import { validateEvalDataset } from "../../src/eval/schema.js";
import { MockRouterProvider } from "../../src/providers/mock.js";
import type { RouterProvider } from "../../src/providers/types.js";
import { skill } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());
const dataset = (names: string[], full = true) =>
  validateEvalDataset({
    version: 1,
    cases: [
      {
        id: "case",
        prompt: "PRIVATE_EVAL_PROMPT_SENTINEL",
        should: names.map((name) => ({ name })),
        fully_labeled: full,
      },
    ],
  });
const options = (provider: RouterProvider, ids = ["a", "b", "c"]) => ({
  skills: ids.map((id) => skill(id)),
  provider,
  cwd: "/private",
  agent: "codex" as const,
});

describe("eval runner through real route and policy", () => {
  it.each([0, 1, 3])("routes %i selected skills", async (count) => {
    const ids = ["a", "b", "c"].slice(0, count);
    const result = await runEvaluation(
      dataset(ids),
      options(new MockRouterProvider({ defaultProbability: 1 }), ids),
    );
    expect(result.cases[0]?.selected.map((item) => item.id)).toEqual(ids);
    expect(result.metrics).toMatchObject({
      exactSetAccuracy: 1,
      providerFailureCount: 0,
      providerPartialCount: 0,
    });
    expect(result.passed).toBe(true);
  });
  it("handles no-skill expectation with a nonempty catalog", async () => {
    const result = await runEvaluation(
      dataset([]),
      options(new MockRouterProvider({ defaultProbability: 0 })),
    );
    expect(result.metrics).toMatchObject({
      exactSetAccuracy: 1,
      averageSelectedSkills: 0,
    });
  });
  it("uses actual policy; disabled positive expectations become false negatives", async () => {
    const result = await runEvaluation(dataset(["a", "b", "c"]), {
      ...options(new MockRouterProvider({ scores: { a: 0.9, b: 0.8, c: 1 } })),
      skills: [skill("a"), skill("b"), skill("c", { enabled: false })],
      policy: { threshold: 0.85, maxSkills: 1 },
    });
    expect(result.cases[0]?.selected.map((item) => item.id)).toEqual(["a"]);
    expect(result.cases[0]?.falseNegatives.map((item) => item.id)).toEqual([
      "b",
      "c",
    ]);
    expect(result.policy).toEqual({ threshold: 0.85, maxSkills: 1 });
  });
  it.each([false, true])(
    "retains partial selections, including all-failed partial=%s",
    async (allFailed) => {
      const provider: RouterProvider = {
        name: "partial",
        judge: async () => ({
          completeness: "partial",
          decisions: allFailed ? [] : [{ skillId: "a", probability: 0.95 }],
          failedSkillIds: allFailed ? ["a", "b", "c"] : ["b", "c"],
          model: "fixture",
        }),
      };
      const result = await runEvaluation(
        dataset(["a", "b"]),
        options(provider),
      );
      expect(result.metrics).toMatchObject({
        truePositives: allFailed ? 0 : 1,
        falseNegatives: allFailed ? 2 : 1,
        providerPartialCount: 1,
        providerFailureCount: 0,
      });
      expect(result.cases[0]?.routing).toEqual({
        provider: "partial",
        model: "fixture",
        partial: true,
        failed: false,
      });
      expect(result.cases[0]?.diagnostics[0]?.code).toBe("provider_partial");
    },
  );
  it.each(["provider_failed", "provider_timeout", "invalid_provider_response"])(
    "includes %s in reliability and quality metrics",
    async (code) => {
      const provider: RouterProvider = {
        name: "broken",
        judge: async () => {
          if (code === "provider_failed")
            throw new Error("PRIVATE_EVAL_PROMPT_SENTINEL synthetic-secret");
          if (code === "provider_timeout") return new Promise(() => {});
          return { completeness: "complete", decisions: [] };
        },
      };
      const result = await runEvaluation(dataset(["a"]), {
        ...options(provider),
        timeoutMs: 5,
      });
      expect(result.metrics).toMatchObject({
        providerFailureCount: 1,
        providerPartialCount: 0,
        falseNegatives: 1,
        recall: 0,
        exactSetAccuracy: 0,
      });
      expect(result.cases[0]?.diagnostics[0]?.code).toBe(code);
      expect(result.passed).toBe(true); // Reliability is reported, not an implicit gate.
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_EVAL_PROMPT_SENTINEL|synthetic-secret/,
      );
    },
  );
  it("preflights every case before calling any provider", async () => {
    const judge = vi.fn();
    const input = dataset(["a"]);
    const firstCase = input.cases[0];
    if (!firstCase) throw new Error("Missing fixture");
    input.cases.push({
      ...firstCase,
      id: "later",
      should: [{ name: "missing" }],
    });
    await expect(
      runEvaluation(input, options({ name: "spy", judge })),
    ).rejects.toThrow("unknown_eval_skill");
    expect(judge).not.toHaveBeenCalled();
  });
  it("projects diagnostics without messages, paths, reason codes or raw prompts", async () => {
    const provider: RouterProvider = {
      name: "safe",
      judge: async (input) => ({
        completeness: "complete",
        decisions: input.candidates.map((item) => ({
          skillId: item.id,
          probability: 1,
          reasonCode: input.prompt,
        })),
        diagnostics: [
          { code: "fixture_warning", level: "warning", message: input.prompt },
        ],
        model: "fixture",
      }),
    };
    const result = await runEvaluation(dataset(["a"]), {
      ...options(provider),
      diagnostics: [
        {
          code: "discovery_warning",
          level: "warning",
          message: "PRIVATE_EVAL_PROMPT_SENTINEL",
          path: "/private/path",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_EVAL_PROMPT_SENTINEL|\/private\/path|reasonCode|description|contentHash/,
    );
    expect(result.diagnostics).toEqual([
      { code: "discovery_warning", level: "warning" },
    ]);
    expect(result.cases[0]?.diagnostics).toEqual([
      { code: "fixture_warning", level: "warning" },
    ]);
  });
  it("reproduces ordering and metrics given a fixed clock", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const input = dataset(["b", "a"]);
    const firstCase = input.cases[0];
    if (!firstCase) throw new Error("Missing fixture");
    input.cases.push({ ...firstCase, id: "second" });
    const opts = options(new MockRouterProvider({ defaultProbability: 0.9 }));
    const first = await runEvaluation(input, opts);
    const second = await runEvaluation(input, {
      ...opts,
      skills: [...opts.skills].reverse(),
    });
    expect(second).toEqual(first);
    expect(first.cases.map((item) => item.id)).toEqual(["case", "second"]);
  });
  it("applies file gates and field-by-field overrides with validation", async () => {
    const input = {
      ...dataset(["a", "b"]),
      gates: { min_recall: 1, min_precision: 1 },
    };
    const opts = options(
      new MockRouterProvider({ scores: { a: 1 }, defaultProbability: 0 }),
    );
    expect((await runEvaluation(input, opts)).passed).toBe(false);
    const result = await runEvaluation(input, {
      ...opts,
      gates: { min_recall: 0.5 },
    });
    expect(result.passed).toBe(true);
    expect(result.gates.map((gate) => gate.minimum)).toEqual([1, 0.5]);
    await expect(
      runEvaluation(input, { ...opts, gates: { min_precision: Number.NaN } }),
    ).rejects.toThrow("invalid_eval_input");
  });
});

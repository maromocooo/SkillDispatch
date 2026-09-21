import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runEvaluation } from "../../src/eval/runner.js";
import { loadEvalFile, parseEvalYaml } from "../../src/eval/schema.js";
import { MockRouterProvider } from "../../src/providers/mock.js";
import { skill } from "./helpers.js";

describe("shipped eval dataset", () => {
  it("runs all illustrative cases against a matching catalog without network", async () => {
    const dataset = await loadEvalFile(
      fileURLToPath(new URL("../../evals/example.yaml", import.meta.url)),
    );
    const catalog = [
      "react-patterns",
      "frontend-testing",
      "accessibility-review",
      "deployment",
    ].map((id) => skill(id));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden"));
    try {
      const result = await runEvaluation(dataset, {
        skills: catalog,
        cwd: "/fixture",
        agent: "codex",
        provider: new MockRouterProvider({ defaultProbability: 0 }),
      });
      expect(result.cases.map((item) => item.id)).toEqual([
        "explicit-react",
        "implicit-accessibility",
        "react-login",
        "unrelated-no-skill",
        "overlapping-workflows",
        "specific-keyboard-review",
        "negation",
        "japanese",
        "mixed-language",
      ]);
      expect(result.metrics.caseCount).toBe(9);
      expect(result.metrics.fullyLabeledCaseCount).toBe(1);
      expect(result.metrics.recall).toBe(0); // Pipeline fixture, not Jev semantic accuracy.
      for (const item of dataset.cases)
        expect(JSON.stringify(result)).not.toContain(item.prompt);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("can label a specific skill positive and an overlapping broad skill negative", async () => {
    const input = parseEvalYaml(
      "version: 1\ncases:\n  - id: broad-versus-specific\n    prompt: Check keyboard focus; no general refactor.\n    should: [{name: keyboard-review}]\n    should_not: [{name: general-frontend}]\n",
    );
    const result = await runEvaluation(input, {
      skills: [
        skill("keyboard-review", {
          description: "Review frontend keyboard focus",
        }),
        skill("general-frontend", {
          description: "Review and implement frontend code",
        }),
      ],
      cwd: "/fixture",
      agent: "codex",
      provider: new MockRouterProvider({ defaultProbability: 1 }),
    });
    expect(result.metrics).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      precision: 0.5,
    });
    expect(result.cases[0]?.falsePositives[0]?.name).toBe("general-frontend");
  });
});

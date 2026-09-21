import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadEvalFile,
  parseEvalYaml,
  validateEvalDataset,
} from "../../src/eval/schema.js";
import { workspace, write } from "../helpers.js";

const minimal = { version: 1, cases: [{ id: "one", prompt: "Private input" }] };
describe("eval input schema", () => {
  it("applies defaults and preserves request text", () => {
    expect(validateEvalDataset(minimal)).toEqual({
      ...minimal,
      cases: [
        {
          ...minimal.cases[0],
          should: [],
          should_not: [],
          fully_labeled: false,
        },
      ],
      gates: {},
    });
  });
  it.each([
    { cases: minimal.cases },
    { ...minimal, version: 2 },
    { ...minimal, cases: [] },
    { ...minimal, cases: [...minimal.cases, ...minimal.cases] },
    { ...minimal, gates: { min_recall: 1.01 } },
    { ...minimal, gates: { min_precision: -0.1 } },
    { ...minimal, unexpected: true },
    ...[
      { prompt: "  " },
      { id: " " },
      { fully_labeled: "false" },
      { should: ["a"] },
      { should: [{ name: " " }] },
      { should: [{ name: "a", agent: "other" }] },
      { should: [{ name: "a", scope: "project" }] },
      { should: [{ name: "a", path: "/private" }] },
      { should: [{ name: "a" }], should_not: [{ name: "a" }] },
      { should: [{ name: "a" }, { name: " a " }] },
    ].map((extra) => ({
      ...minimal,
      cases: [{ ...minimal.cases[0], ...extra }],
    })),
  ])("rejects malformed dataset %# with a safe error", (value) => {
    expect(() => validateEvalDataset(value)).toThrow("invalid_eval_input");
  });
  it.each([
    "prompt: [PRIVATE_EVAL_PROMPT_SENTINEL",
    "x: 1\nx: 2",
    "x: &x {y: *x}",
    "x: !unknown value",
    "x".repeat(1024 * 1024 + 1),
  ])("never exposes YAML source on errors %#", (source) => {
    try {
      parseEvalYaml(source);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("invalid_eval_input");
      expect(String(error)).not.toContain("PRIVATE_EVAL_PROMPT_SENTINEL");
    }
  });
  it("loads valid YAML and rejects directories/missing files safely", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, "eval.yaml"),
      "version: 1\ncases:\n  - id: japanese\n    prompt: 日本語 and English\n    should: [{name: react-patterns, agent: codex, scope: repo}]\n    fully_labeled: true\ngates: {min_recall: 0.9}\n",
    );
    const dataset = await loadEvalFile(join(ctx.cwd, "eval.yaml"));
    expect(dataset.cases[0]?.should[0]?.name).toBe("react-patterns");
    expect(dataset.gates.min_recall).toBe(0.9);
    await expect(loadEvalFile(ctx.cwd)).rejects.toThrow("unreadable_eval_file");
    await expect(
      loadEvalFile(join(ctx.cwd, "PRIVATE_EVAL_PROMPT_SENTINEL")),
    ).rejects.toThrow("unreadable_eval_file");
  });
});

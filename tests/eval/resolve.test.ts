import { describe, expect, it } from "vitest";
import { resolveEvalCases, resolveSelector } from "../../src/eval/resolve.js";
import { validateEvalDataset } from "../../src/eval/schema.js";
import { skill } from "./helpers.js";

const catalog = [
  skill("unique"),
  skill("cr", { name: "security", scope: "repo" }),
  skill("cu", { name: "security", scope: "user" }),
  skill("cl", { name: "security", agent: "claude-code" }),
];
describe("eval selector resolution", () => {
  it("resolves a unique name", () =>
    expect(resolveSelector({ name: "unique" }, catalog).id).toBe("unique"));
  it("qualifies cross-agent same-name skills", () =>
    expect(
      resolveSelector({ name: "security", agent: "claude-code" }, catalog).id,
    ).toBe("cl"));
  it("qualifies same-agent duplicate names by scope", () =>
    expect(
      resolveSelector(
        { name: "security", agent: "codex", scope: "user" },
        catalog,
      ).id,
    ).toBe("cu"));
  it.each([
    { name: "security" },
    { name: "security", agent: "codex" as const },
  ])("rejects ambiguity %#", (selector) =>
    expect(() => resolveSelector(selector, catalog)).toThrow(
      "ambiguous_eval_skill",
    ),
  );
  it("rejects unknown skills", () =>
    expect(() => resolveSelector({ name: "unknown" }, catalog)).toThrow(
      "unknown_eval_skill",
    ));
  it.each([true, false])(
    "rejects resolved overlap or duplicate labels (overlap=%s)",
    (overlap) => {
      const labels = [{ name: "unique" }, { name: "unique", agent: "codex" }];
      const dataset = validateEvalDataset({
        version: 1,
        cases: [
          {
            id: "one",
            prompt: "x",
            should: overlap ? labels.slice(0, 1) : labels,
            should_not: overlap ? labels.slice(1) : [],
          },
        ],
      });
      expect(() => resolveEvalCases(dataset, catalog)).toThrow(
        overlap ? "conflicting_eval_labels" : "duplicate_eval_label",
      );
    },
  );
  it("retains disabled labeled positives and rejects duplicate catalog IDs", () => {
    const dataset = validateEvalDataset({
      version: 1,
      cases: [{ id: "one", prompt: "x", should: [{ name: "off" }] }],
    });
    expect(
      resolveEvalCases(dataset, [skill("off", { enabled: false })])[0]
        ?.should[0]?.enabled,
    ).toBe(false);
    expect(() =>
      resolveEvalCases(dataset, [skill("off"), skill("off")]),
    ).toThrow("invalid_eval_catalog");
  });
  it("preserves case order and orders labels independently of catalog order", () => {
    const dataset = validateEvalDataset({
      version: 1,
      cases: ["z", "a"].map((id) => ({
        id,
        prompt: "x",
        should: [{ name: "b" }, { name: "a" }],
      })),
    });
    const first = resolveEvalCases(dataset, [skill("a"), skill("b")]);
    expect(first.map((item) => item.id)).toEqual(["z", "a"]);
    expect(first[0]?.should.map((item) => item.id)).toEqual(["a", "b"]);
    expect(resolveEvalCases(dataset, [skill("b"), skill("a")])).toEqual(first);
  });
});

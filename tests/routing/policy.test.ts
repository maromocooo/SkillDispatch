import { describe, expect, it } from "vitest";
import { applyPolicy } from "../../src/core/policy.js";
import type { ScoredSkill } from "../../src/core/types.js";

const decision = (
  name: string,
  probability: number,
  skillId = name,
): ScoredSkill => ({ skillId, name, probability });
const names = (values: ScoredSkill[]) => values.map((value) => value.name);

describe("pure routing policy", () => {
  it("selects zero for empty inputs or no score above threshold", () => {
    expect(applyPolicy([]).selected).toEqual([]);
    expect(applyPolicy([decision("a", 0.74)]).selected).toEqual([]);
  });
  it("includes the threshold boundary and retains every probability", () => {
    const result = applyPolicy([decision("a", 0.75), decision("b", 0.749999)]);
    expect(names(result.selected)).toEqual(["a"]);
    expect(result.allDecisions).toEqual([
      { ...decision("a", 0.75), selected: true },
      { ...decision("b", 0.749999), selected: false },
    ]);
  });
  it("selects multiple skills and applies maxSkills after ranking", () => {
    const input = [
      decision("a", 0.88),
      decision("b", 0.95),
      decision("c", 0.91),
      decision("d", 0.04),
    ];
    expect(names(applyPolicy(input).selected)).toEqual(["b", "c", "a"]);
    expect(
      names(applyPolicy(input, { threshold: 0.75, maxSkills: 2 }).selected),
    ).toEqual(["b", "c"]);
  });
  it("breaks ties by name then ID regardless of input order without mutating input", () => {
    const a = Object.freeze(decision("same", 0.9, "a"));
    const b = Object.freeze(decision("same", 0.9, "b"));
    const c = Object.freeze(decision("first", 0.9, "c"));
    const input = Object.freeze([b, a, c]);
    expect(applyPolicy(input)).toEqual(applyPolicy([c, a, b]));
    expect(applyPolicy(input).selected.map((s) => s.skillId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(input[0]).toBe(b);
  });
  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid probability %s",
    (value) => {
      expect(() => applyPolicy([decision("a", value)])).toThrow();
    },
  );
  it.each([
    { threshold: -1, maxSkills: 4 },
    { threshold: Number.NaN, maxSkills: 4 },
    { threshold: 1.1, maxSkills: 4 },
    { threshold: 0.5, maxSkills: 0 },
    { threshold: 0.5, maxSkills: 1.2 },
  ])("rejects invalid policy %j", (policy) => {
    expect(() => applyPolicy([], policy)).toThrow();
  });
  it("allows thresholds 0 and 1 and rejects duplicate decision IDs", () => {
    expect(
      applyPolicy([decision("a", 0)], { threshold: 0, maxSkills: 1 }).selected,
    ).toHaveLength(1);
    expect(
      applyPolicy([decision("a", 1)], { threshold: 1, maxSkills: 1 }).selected,
    ).toHaveLength(1);
    expect(() => applyPolicy([decision("a", 0.9), decision("a", 0.9)])).toThrow(
      "Duplicate",
    );
  });
});

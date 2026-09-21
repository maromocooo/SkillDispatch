import { describe, expect, it } from "vitest";
import { route } from "../../src/core/route.js";
import type { RouteRequest, SkillDescriptor } from "../../src/core/types.js";
import { MockRouterProvider } from "../../src/providers/mock.js";
import type {
  ProviderRouteOutput,
  RouterProvider,
} from "../../src/providers/types.js";

const skills: SkillDescriptor[] = ["A", "B", "C", "D"].map((id) => ({
  id,
  name: id,
  description: `Skill ${id}`,
  path: `/skills/${id}/SKILL.md`,
  directory: `/skills/${id}`,
  agent: "generic",
  scope: "repo",
  enabled: true,
  metadata: {},
  contentHash: "fixture",
}));
const request: RouteRequest = {
  prompt: "Test routing contract",
  cwd: "/project",
  agent: "generic",
  skills,
};
const complete: ProviderRouteOutput = {
  completeness: "complete",
  decisions: [
    { skillId: "A", probability: 0.95 },
    { skillId: "B", probability: 0.82 },
    { skillId: "C", probability: 0.8 },
    { skillId: "D", probability: 0.1 },
  ],
};
const partial: ProviderRouteOutput = {
  completeness: "partial",
  decisions: complete.decisions.filter((decision) => decision.skillId !== "C"),
  failedSkillIds: ["C"],
};
// Unknown deliberately models a runtime response that has not passed validation.
const provider = (output: unknown): RouterProvider => ({
  name: "fixture",
  judge: async () => output as ProviderRouteOutput,
});

describe("provider completeness contract", () => {
  it("accepts complete coverage with exactly one decision per candidate", async () => {
    const result = await route(
      request,
      provider({
        ...complete,
        model: "fixture-model",
        diagnostics: [
          {
            code: "fixture_info",
            level: "info",
            message: "Complete fixture evaluated.",
            skillIds: ["D", "A"],
          },
        ],
      }),
    );
    expect(result.selected.map((decision) => decision.skillId)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(result.allDecisions).toHaveLength(4);
    expect(result.router.model).toBe("fixture-model");
    expect(result.diagnostics).toEqual([
      {
        code: "fixture_info",
        level: "info",
        message: "Complete fixture evaluated.",
        skillIds: ["A", "D"],
      },
    ]);
  });

  it("accepts an explicitly empty failedSkillIds array for complete output", async () => {
    const result = await route(
      request,
      provider({ ...complete, failedSkillIds: [] }),
    );
    expect(result.selected).toHaveLength(3);
    expect(result.diagnostics).toEqual([]);
  });

  it("applies policy to successful partial decisions and identifies unevaluated skills", async () => {
    const result = await route(request, provider(partial));
    expect(result.selected.map((decision) => decision.skillId)).toEqual([
      "A",
      "B",
    ]);
    expect(
      result.allDecisions.map((decision) => [
        decision.skillId,
        decision.probability,
        decision.selected,
      ]),
    ).toEqual([
      ["A", 0.95, true],
      ["B", 0.82, true],
      ["D", 0.1, false],
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: "provider_partial",
        level: "warning",
        message:
          "Provider result is partial; listed skills were not evaluated. Recommendations use successful decisions only.",
        skillIds: ["C"],
      },
    ]);
    expect(JSON.parse(JSON.stringify(result)).diagnostics[0].skillIds).toEqual([
      "C",
    ]);
    const capped = await route(request, provider(partial), {
      threshold: 0.82,
      maxSkills: 1,
    });
    expect(capped.selected.map((decision) => decision.skillId)).toEqual(["A"]);
  });

  it("retains successful below-threshold decisions without fabricating failed scores", async () => {
    const result = await route(request, provider(partial), {
      threshold: 1,
      maxSkills: 4,
    });
    expect(result.selected).toEqual([]);
    expect(result.allDecisions).toHaveLength(3);
    expect(result.diagnostics[0]?.code).toBe("provider_partial");
  });

  it("accepts all candidates failing as a valid partial result", async () => {
    const result = await route(
      request,
      provider({
        completeness: "partial",
        decisions: [],
        failedSkillIds: ["D", "B", "A", "C"],
      }),
    );
    expect(result.selected).toEqual([]);
    expect(result.allDecisions).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "provider_partial",
        skillIds: ["A", "B", "C", "D"],
      }),
    ]);
  });

  const malformed: { name: string; output: unknown }[] = [
    {
      name: "complete with missing candidate",
      output: { ...complete, decisions: partial.decisions },
    },
    {
      name: "complete with unknown decision ID",
      output: {
        ...complete,
        decisions: [
          ...partial.decisions,
          { skillId: "unknown", probability: 0.9 },
        ],
      },
    },
    {
      name: "complete with duplicate decision",
      output: {
        ...complete,
        decisions: [...partial.decisions, { skillId: "A", probability: 0.9 }],
      },
    },
    {
      name: "complete with failed candidate",
      output: { ...partial, completeness: "complete" },
    },
    {
      name: "complete with both full decisions and failures",
      output: { ...complete, failedSkillIds: ["C"] },
    },
    {
      name: "partial with an uncovered candidate",
      output: {
        ...partial,
        decisions: partial.decisions.filter(
          (decision) => decision.skillId !== "D",
        ),
      },
    },
    {
      name: "partial with overlapping success and failure",
      output: { ...partial, failedSkillIds: ["C", "A"] },
    },
    {
      name: "partial with unknown failed ID",
      output: { ...partial, failedSkillIds: ["unknown"] },
    },
    {
      name: "partial with duplicate failed ID",
      output: { ...partial, failedSkillIds: ["C", "C"] },
    },
    {
      name: "partial with duplicate decision",
      output: {
        ...partial,
        decisions: [...partial.decisions, { skillId: "A", probability: 0.9 }],
      },
    },
    {
      name: "partial with unknown decision ID",
      output: {
        ...partial,
        decisions: [
          ...partial.decisions,
          { skillId: "unknown", probability: 0.9 },
        ],
      },
    },
    {
      name: "partial without failures",
      output: { ...complete, completeness: "partial", failedSkillIds: [] },
    },
    {
      name: "partial missing failedSkillIds",
      output: { completeness: "partial", decisions: partial.decisions },
    },
    {
      name: "partial with invalid probability",
      output: {
        ...partial,
        decisions: partial.decisions.map((decision) => ({
          ...decision,
          probability: 2,
        })),
      },
    },
    { name: "missing completeness", output: { decisions: complete.decisions } },
    {
      name: "unknown completeness",
      output: { ...complete, completeness: "maybe" },
    },
    {
      name: "invalid diagnostic level",
      output: {
        ...partial,
        diagnostics: [{ code: "x", level: "fatal", message: "Invalid" }],
      },
    },
    {
      name: "unknown diagnostic skill ID",
      output: {
        ...partial,
        diagnostics: [
          {
            code: "x",
            level: "warning",
            message: "Invalid",
            skillIds: ["unknown"],
          },
        ],
      },
    },
    {
      name: "duplicate diagnostic skill ID",
      output: {
        ...partial,
        diagnostics: [
          {
            code: "x",
            level: "warning",
            message: "Invalid",
            skillIds: ["C", "C"],
          },
        ],
      },
    },
  ];
  it.each(malformed)("fails open for $name", async ({ output }) => {
    const result = await route(request, provider(output));
    expect(result.selected).toEqual([]);
    expect(result.allDecisions).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid_provider_response" }),
    ]);
    expect(result.router.model).toBeUndefined();
  });

  it("does not trust or forward provider diagnostics before validating coverage", async () => {
    const result = await route(
      request,
      provider({
        ...partial,
        failedSkillIds: ["unknown"],
        model: "invalid-model",
        diagnostics: [
          { code: "untrusted", level: "warning", message: "untrusted-message" },
        ],
      }),
    );
    expect(JSON.stringify(result)).not.toContain("untrusted");
    expect(result.router.model).toBeUndefined();
  });

  it("keeps selected order and diagnostics stable across input/result permutations", async () => {
    const output: ProviderRouteOutput = {
      completeness: "partial",
      decisions: [
        { skillId: "B", probability: 0.9 },
        { skillId: "A", probability: 0.9 },
      ],
      failedSkillIds: ["D", "C"],
      diagnostics: [
        {
          code: "fixture_timeout",
          level: "warning",
          message: "Some candidates could not be evaluated.",
          skillIds: ["D", "C"],
        },
        {
          code: "fixture_info",
          level: "info",
          message: "Other candidates evaluated.",
        },
      ],
    };
    const snapshot = structuredClone(output);
    const first = await route(request, provider(output));
    const second = await route(
      { ...request, skills: [...request.skills].reverse() },
      provider({
        ...output,
        decisions: [...output.decisions].reverse(),
        failedSkillIds: [...(output.failedSkillIds ?? [])].reverse(),
        diagnostics: [...(output.diagnostics ?? [])]
          .reverse()
          .map((diagnostic) => ({
            ...diagnostic,
            ...(diagnostic.skillIds
              ? { skillIds: [...diagnostic.skillIds].reverse() }
              : {}),
          })),
      }),
    );
    expect(first.selected.map((decision) => decision.skillId)).toEqual([
      "A",
      "B",
    ]);
    expect(second.selected).toEqual(first.selected);
    expect(second.allDecisions).toEqual(first.allDecisions);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(first.diagnostics[0]?.skillIds).toEqual(["C", "D"]);
    expect(output).toEqual(snapshot);
  });

  it("requires providers to account only for enabled candidates", async () => {
    const input = {
      ...request,
      skills: request.skills.map((skill) => ({
        ...skill,
        enabled: skill.id !== "C",
      })),
    };
    const valid = await route(
      input,
      provider({ completeness: "complete", decisions: partial.decisions }),
    );
    expect(valid.selected.map((decision) => decision.skillId)).toEqual([
      "A",
      "B",
    ]);
    const invalid = await route(input, provider(partial));
    expect(invalid.selected).toEqual([]);
    expect(invalid.diagnostics[0]?.code).toBe("invalid_provider_response");
  });

  it("sorts otherwise identical diagnostics with absent and empty skill IDs deterministically", async () => {
    const diagnostic = {
      code: "fixture_info",
      level: "info" as const,
      message: "Fixture evaluated.",
    };
    const diagnostics = [diagnostic, { ...diagnostic, skillIds: [] }];
    const first = await route(request, provider({ ...complete, diagnostics }));
    const second = await route(
      request,
      provider({ ...complete, diagnostics: [...diagnostics].reverse() }),
    );
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it("updates the mock to report complete results including an empty catalog", async () => {
    const mock = new MockRouterProvider();
    const output = await mock.judge({
      prompt: request.prompt,
      cwd: request.cwd,
      agent: request.agent,
      candidates: skills,
    });
    expect(output.completeness).toBe("complete");
    expect(output.decisions.map((decision) => decision.skillId)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(output.failedSkillIds).toBeUndefined();
    expect(
      await mock.judge({
        prompt: "Empty",
        cwd: "/project",
        agent: "generic",
        candidates: [],
      }),
    ).toEqual({ completeness: "complete", decisions: [] });
  });
});

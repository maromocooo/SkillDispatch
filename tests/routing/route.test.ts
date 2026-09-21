import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { route } from "../../src/core/route.js";
import type { RouteRequest, SkillDescriptor } from "../../src/core/types.js";
import { MockRouterProvider } from "../../src/providers/mock.js";
import type {
  ProviderRouteOutput,
  RouterProvider,
} from "../../src/providers/types.js";

const skill = (name: string, enabled = true): SkillDescriptor => ({
  id: name,
  name,
  description: name.replaceAll("-", " "),
  path: `/skills/${name}/SKILL.md`,
  directory: `/skills/${name}`,
  agent: "generic",
  scope: "repo",
  enabled,
  metadata: { privateBody: "must-not-reach-provider" },
  contentHash: "fixture",
});
const request = (skills: SkillDescriptor[]): RouteRequest => ({
  prompt: "Build a React form and write tests; check keyboard accessibility",
  cwd: "/project",
  agent: "generic",
  skills,
});

describe("routing and mock provider", () => {
  it("passes each candidate's host agent independently of the request agent", async () => {
    const codex: SkillDescriptor = {
      ...skill("security-review"),
      id: "codex-skill",
      agent: "codex",
    };
    const claude: SkillDescriptor = {
      ...skill("security-review"),
      id: "claude-skill",
      agent: "claude-code",
    };
    const judge = vi.fn<RouterProvider["judge"]>(async (input) => ({
      decisions: input.candidates.map((candidate) => ({
        skillId: candidate.id,
        probability: 0.9,
      })),
    }));
    const result = await route(request([codex, claude]), {
      name: "spy",
      judge,
    });
    expect(judge.mock.calls[0]?.[0].agent).toBe("generic");
    expect(judge.mock.calls[0]?.[0].candidates).toEqual([
      {
        id: "claude-skill",
        name: "security-review",
        description: "security review",
        scope: "repo",
        agent: "claude-code",
      },
      {
        id: "codex-skill",
        name: "security-review",
        description: "security review",
        scope: "repo",
        agent: "codex",
      },
    ]);
    expect(result.selected.map((decision) => decision.skillId)).toEqual([
      "claude-skill",
      "codex-skill",
    ]);
  });
  it("uses independent fixture probabilities for zero-to-many selection", async () => {
    const scores = JSON.parse(
      await readFile(
        new URL("../fixtures/routing/scores.json", import.meta.url),
        "utf8",
      ),
    );
    const result = await route(
      request(Object.keys(scores).map((name) => skill(name))),
      new MockRouterProvider({ scores }),
    );
    expect(result.selected.map((s) => [s.name, s.probability])).toEqual([
      ["react-patterns", 0.95],
      ["frontend-testing", 0.91],
      ["accessibility-review", 0.88],
    ]);
    expect(
      result.allDecisions.find((s) => s.name === "deployment")?.selected,
    ).toBe(false);
  });
  it("never passes disabled skills or arbitrary metadata to providers", async () => {
    const judge = vi.fn<RouterProvider["judge"]>(async (input) => ({
      decisions: input.candidates.map((s) => ({
        skillId: s.id,
        probability: 0.9,
      })),
    }));
    const result = await route(
      request([skill("active"), skill("disabled", false)]),
      { name: "spy", judge },
    );
    expect(judge.mock.calls[0]?.[0].candidates).toEqual([
      {
        id: "active",
        name: "active",
        description: "active",
        scope: "repo",
        agent: "generic",
      },
    ]);
    expect(JSON.stringify(judge.mock.calls)).not.toContain(
      "must-not-reach-provider",
    );
    expect(result.selected.map((s) => s.name)).toEqual(["active"]);
  });
  it("returns immediately without calling provider for an empty eligible catalog", async () => {
    const judge = vi.fn();
    expect(
      (await route(request([skill("disabled", false)]), { name: "spy", judge }))
        .selected,
    ).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
  it("fails open without exposing provider errors or prompt text", async () => {
    const result = await route(request([skill("a")]), {
      name: "broken",
      judge: async () => {
        throw new Error("secret-api-key raw-prompt");
      },
    });
    expect(result.selected).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("provider_failed");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("bounds latency and aborts a stalled provider", async () => {
    let signal: AbortSignal | undefined;
    const result = await route(
      request([skill("a")]),
      {
        name: "stalled",
        judge: async (input) => {
          signal = input.signal;
          return new Promise(() => {});
        },
      },
      undefined,
      { timeoutMs: 10 },
    );
    expect(signal?.aborted).toBe(true);
    expect(result.diagnostics[0]?.code).toBe("provider_timeout");
    expect(result.selected).toEqual([]);
  });
  it.each(
    [
      [],
      [{ skillId: "a", probability: 2 }],
      [{ skillId: "unknown", probability: 0.9 }],
      [{ skillId: "a", probability: Number.NaN }],
      [
        { skillId: "a", probability: 0.9 },
        { skillId: "a", probability: 0.8 },
      ],
    ].map((decisions) => ({ decisions })),
  )("fails open on malformed provider output (%j)", async ({ decisions }) => {
    const result = await route(request([skill("a")]), {
      name: "bad",
      judge: async () => ({ decisions }),
    });
    expect(result.selected).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("invalid_provider_response");
  });
  it("fails open on wrong response shape", async () => {
    const result = await route(request([skill("a")]), {
      name: "bad",
      judge: async () => null as unknown as ProviderRouteOutput,
    });
    expect(result.diagnostics[0]?.code).toBe("invalid_provider_response");
  });
  it("supports score-by-ID over name and keeps same-name decisions separate", async () => {
    const one = { ...skill("same"), id: "one" };
    const two = { ...skill("same"), id: "two" };
    const result = await route(
      request([one, two]),
      new MockRouterProvider({ scores: { one: 0.95, same: 0.1 } }),
    );
    expect(result.selected.map((s) => s.skillId)).toEqual(["one"]);
    expect(result.allDecisions).toHaveLength(2);
  });
  it("has reproducible token matching and unrelated prompts select nothing", async () => {
    const provider = new MockRouterProvider();
    const input = request([
      skill("react-patterns"),
      skill("accessibility-review"),
      skill("deployment"),
    ]);
    const first = await route(input, provider);
    const second = await route(
      { ...input, skills: [...input.skills].reverse() },
      provider,
    );
    expect(first.allDecisions).toEqual(second.allDecisions);
    expect(first.selected.map((s) => s.name)).toEqual([
      "accessibility-review",
      "react-patterns",
    ]);
    expect(
      (await route({ ...input, prompt: "Fix the typo in README" }, provider))
        .selected,
    ).toEqual([]);
  });
  it("rejects invalid fixture probabilities and unsafe timing options", async () => {
    expect(() => new MockRouterProvider({ scores: { a: -1 } })).toThrow();
    expect(
      () => new MockRouterProvider({ defaultProbability: Number.NaN }),
    ).toThrow();
    await expect(
      route(request([]), new MockRouterProvider(), undefined, { timeoutMs: 0 }),
    ).rejects.toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import { route } from "../../src/core/route.js";
import type { SkillDescriptor } from "../../src/core/types.js";
import { JevRequestError } from "../../src/providers/jev/client.js";
import {
  type JevCall,
  type JevRequest,
  JevRouterProvider,
} from "../../src/providers/jev.js";
import type {
  ProviderRouteInput,
  RoutingCandidate,
} from "../../src/providers/types.js";

const candidate = (id: string): RoutingCandidate => ({
  id,
  name: `skill-${id}`,
  description: `Workflow ${id}`,
  agent: "codex",
  scope: "repo",
});
const input = (count: number): ProviderRouteInput => ({
  prompt: "Private user request",
  cwd: "/private/local/project",
  agent: "generic",
  candidates: Array.from({ length: count }, (_, i) =>
    candidate(`skill-id-${String(i).padStart(3, "0")}`),
  ),
});
const success = (request: JevRequest, probability = 0.95) => ({
  model: "jev-fixture",
  answers: Object.fromEntries(
    Object.keys(request.questions)
      .reverse()
      .map((key) => [key, { type: "noul", noul: probability }]),
  ),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Jev independent Noul routing", () => {
  it.each([0, 0.5, 1])(
    "maps Noul %s exactly to probability without confidence",
    async (probability) => {
      const provider = new JevRouterProvider(
        {},
        { call: async (request) => success(request, probability) },
      );
      expect((await provider.judge(input(1))).decisions).toEqual([
        { skillId: "skill-id-000", probability },
      ]);
    },
  );

  it("maps local keys back to arbitrary IDs independently of answer order", async () => {
    const request = {
      ...input(0),
      candidates: [
        { ...candidate("A"), id: "/odd/id:Z" },
        { ...candidate("B"), id: "α id" },
      ],
    };
    const call = vi.fn<JevCall>(async () => ({
      model: "jev-fixture",
      answers: {
        q001: { type: "noul", noul: 0.5 },
        q000: { type: "noul", noul: 1 },
      },
    }));
    const result = await new JevRouterProvider({}, { call }).judge(request);
    expect(result.decisions).toEqual([
      { skillId: "/odd/id:Z", probability: 1 },
      { skillId: "α id", probability: 0.5 },
    ]);
    expect(Object.keys(call.mock.calls[0]?.[0].questions ?? {})).toEqual([
      "q000",
      "q001",
    ]);
    expect(JSON.stringify(call.mock.calls[0]?.[0])).not.toContain("/odd/id:Z");
  });

  it("sends only prompt and allowed skill metadata, even when extra runtime fields exist", async () => {
    const extra = {
      ...candidate("private-canonical-id"),
      name: "security-review",
      description: "Review authentication",
      agent: "claude-code" as const,
      scope: "user" as const,
      path: "/secret/SKILL.md",
      directory: "/secret",
      body: "private body sentinel",
      metadata: { secret: "arbitrary metadata sentinel" },
      apiKey: "synthetic-key-sentinel",
    };
    const call = vi.fn<JevCall>(async (request) => success(request));
    await new JevRouterProvider({}, { call }).judge({
      ...input(0),
      candidates: [extra],
    });
    const request = call.mock.calls[0]?.[0];
    expect(request?.state).toEqual({
      prompt: "Private user request",
      requestingAgent: "generic",
    });
    expect(request?.questions.q000?.instructions.skill).toEqual({
      name: "security-review",
      description: "Review authentication",
      agent: "claude-code",
      scope: "user",
    });
    const body = JSON.stringify(request);
    for (const excluded of [
      "private-canonical-id",
      "/secret",
      "private body sentinel",
      "arbitrary metadata sentinel",
      "synthetic-key-sentinel",
      "/private/local/project",
    ])
      expect(body).not.toContain(excluded);
    expect(request?.questions.q000?.criteria.false).toContain("shared keyword");
  });

  it.each([0, 1, 4, 5, 13])(
    "covers %i candidates with deterministic chunk boundaries",
    async (count) => {
      const call = vi.fn<JevCall>(async (request) => success(request));
      const provider = new JevRouterProvider({ chunkSize: 4 }, { call });
      const first = await provider.judge(input(count));
      const requests = call.mock.calls.map(([request]) => request);
      expect(first.completeness).toBe("complete");
      expect(first.decisions).toHaveLength(count);
      expect(first.failedSkillIds).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(Math.ceil(count / 4));
      expect(
        requests.map((request) => Object.keys(request.questions).length),
      ).toEqual(
        Array.from({ length: Math.ceil(count / 4) }, (_, i) =>
          Math.min(4, count - i * 4),
        ),
      );
      call.mockClear();
      const second = await provider.judge({
        ...input(count),
        candidates: [...input(count).candidates].reverse(),
      });
      expect(second).toEqual(first);
      expect(call.mock.calls.map(([request]) => request)).toEqual(requests);
    },
  );

  it.each([1, 2, 8])(
    "bounds in-flight requests to concurrency %i",
    async (concurrency) => {
      const pending: {
        request: JevRequest;
        finish: (result: unknown) => void;
      }[] = [];
      let active = 0;
      let peak = 0;
      const call: JevCall = async (request) => {
        active++;
        peak = Math.max(peak, active);
        const result = deferred<unknown>();
        pending.push({ request, finish: result.resolve });
        try {
          return await result.promise;
        } finally {
          active--;
        }
      };
      const result = new JevRouterProvider(
        { chunkSize: 1, concurrency },
        { call },
      ).judge(input(9));
      await tick();
      expect(pending).toHaveLength(concurrency);
      for (let completed = 0; completed < 9; completed++) {
        const item = pending.shift();
        expect(item).toBeDefined();
        item?.finish(success(item.request));
        await tick();
        expect(active).toBeLessThanOrEqual(concurrency);
      }
      expect((await result).decisions).toHaveLength(9);
      expect(peak).toBe(concurrency);
    },
  );

  it.each([
    { concurrency: 0 },
    { concurrency: 9 },
    { concurrency: -1 },
    { concurrency: 1.5 },
    { concurrency: Number.NaN },
    { chunkSize: 0 },
    { chunkSize: 49 },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 2_147_483_648 },
    { maxRetries: -1 },
    { maxRetries: 3 },
    { model: "bad\nmodel" },
  ])("rejects invalid provider options (%j)", (options) => {
    expect(
      () =>
        new JevRouterProvider(options, {
          call: async (request) => success(request),
        }),
    ).toThrow("Invalid Jev provider options.");
  });

  it("retains successful decisions on chunk failure and applies existing policy", async () => {
    let calls = 0;
    const provider = new JevRouterProvider(
      { chunkSize: 2, concurrency: 1 },
      {
        call: async (request) => {
          if (++calls === 2) throw new Error("private-key private-prompt");
          return success(request);
        },
      },
    );
    const request = input(5);
    const result = await provider.judge(request);
    expect(result.completeness).toBe("partial");
    expect(result.decisions.map((decision) => decision.skillId)).toEqual([
      "skill-id-000",
      "skill-id-001",
      "skill-id-004",
    ]);
    expect(result.failedSkillIds).toEqual(["skill-id-002", "skill-id-003"]);
    expect(JSON.stringify(result)).not.toMatch(/private-key|private-prompt/);
    const skills: SkillDescriptor[] = request.candidates.map((skill) => ({
      ...skill,
      enabled: true,
      path: "/local/SKILL.md",
      directory: "/local",
      contentHash: "hash",
      metadata: {},
    }));
    const routed = await route(
      {
        prompt: request.prompt,
        cwd: request.cwd,
        agent: request.agent,
        skills,
      },
      { name: "jev", judge: async () => result },
    );
    expect(routed.selected).toHaveLength(3);
    expect(routed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "provider_partial",
    );
  });

  it("accounts for all candidates when every chunk fails, without leaking SDK errors", async () => {
    const result = await new JevRouterProvider(
      { chunkSize: 2 },
      {
        call: async () => {
          throw new Error(
            "TYPESAFE_API_KEY=synthetic-test-only Private user request secret-looking-token",
          );
        },
      },
    ).judge(input(7));
    expect(result.completeness).toBe("partial");
    expect(result.decisions).toEqual([]);
    expect(result.failedSkillIds).toEqual(
      input(7).candidates.map((skill) => skill.id),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-test-only|Private user request|secret-looking-token|TYPESAFE_API_KEY/,
    );
  });

  it.each([
    {},
    { model: "jev-fixture", answers: {} },
    { model: "jev-fixture", answers: { unknown: { type: "noul", noul: 1 } } },
    {
      model: "jev-fixture",
      answers: { q000: { type: "choice", confidence: 1 } },
    },
    { model: "jev-fixture", answers: { q000: { type: "noul", noul: -0.1 } } },
    { model: "jev-fixture", answers: { q000: { type: "noul", noul: 1.1 } } },
    {
      model: "jev-fixture",
      answers: { q000: { type: "noul", noul: Number.NaN } },
    },
    { model: "jev-fixture", answers: { q000: { type: "noul", noul: "0.5" } } },
    {
      model: "jev-fixture",
      answers: {
        q000: { type: "noul", noul: 1 },
        extra: { type: "noul", noul: 1 },
      },
    },
    { model: "bad\nmodel", answers: { q000: { type: "noul", noul: 1 } } },
  ])(
    "turns malformed chunk responses into valid partial provider results (%#)",
    async (response) => {
      const result = await new JevRouterProvider(
        {},
        { call: async () => response },
      ).judge(input(1));
      expect(result.decisions).toEqual([]);
      expect(result.failedSkillIds).toEqual(["skill-id-000"]);
      expect(result.diagnostics?.[0]?.code).toBe("jev_invalid_response");
    },
  );

  it("stops new chunks after per-request timeout and retains earlier success", async () => {
    let calls = 0;
    const call = vi.fn<JevCall>(async (request) => {
      if (++calls === 2) throw new JevRequestError("jev_request_timeout");
      return success(request);
    });
    const result = await new JevRouterProvider(
      { chunkSize: 1, concurrency: 1 },
      { call },
    ).judge(input(4));
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.decisions).toHaveLength(1);
    expect(result.failedSkillIds).toHaveLength(3);
    expect(result.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual([
      "jev_request_timeout",
      "jev_not_evaluated",
      "jev_not_evaluated",
    ]);
  });

  it("does not schedule work for an already aborted input", async () => {
    const call = vi.fn<JevCall>();
    const result = await new JevRouterProvider({}, { call }).judge({
      ...input(3),
      signal: AbortSignal.abort(),
    });
    expect(call).not.toHaveBeenCalled();
    expect(result.failedSkillIds).toHaveLength(3);
    expect(result.completeness).toBe("partial");
  });

  it("stops scheduling on abort without discarding completed chunks", async () => {
    const controller = new AbortController();
    let calls = 0;
    const call = vi.fn<JevCall>(async (request) => {
      if (++calls === 2) {
        controller.abort();
        throw new Error("unsafe-abort-reason");
      }
      return success(request);
    });
    const result = await new JevRouterProvider(
      { chunkSize: 1, concurrency: 1 },
      { call },
    ).judge({ ...input(4), signal: controller.signal });
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.decisions).toHaveLength(1);
    expect(result.failedSkillIds).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("unsafe-abort-reason");
  });

  it("keeps outer route timeout fail-open and observes late rejection", async () => {
    const call = vi.fn<JevCall>(
      (_, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("late-secret")),
            { once: true },
          ),
        ),
    );
    const skills: SkillDescriptor[] = input(3).candidates.map((skill) => ({
      ...skill,
      path: "/local/SKILL.md",
      directory: "/local",
      enabled: true,
      metadata: {},
      contentHash: "hash",
    }));
    const result = await route(
      { prompt: "private", cwd: "/local", agent: "generic", skills },
      new JevRouterProvider({ chunkSize: 1, concurrency: 1 }, { call }),
      undefined,
      { timeoutMs: 10 },
    );
    expect(result.selected).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("provider_timeout");
    await tick();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("produces stable results/diagnostics regardless of chunk completion order", async () => {
    const run = async (reverse: boolean) => {
      const pending: {
        request: JevRequest;
        result: ReturnType<typeof deferred<unknown>>;
      }[] = [];
      const call: JevCall = (request) => {
        const result = deferred<unknown>();
        pending.push({ request, result });
        return result.promise;
      };
      const result = new JevRouterProvider(
        { chunkSize: 1, concurrency: 3 },
        { call },
      ).judge(input(3));
      for (const item of reverse ? pending.reverse() : pending)
        item.result.resolve(
          item.request.questions.q000?.instructions.skill.name.endsWith("001")
            ? {}
            : success(item.request),
        );
      return result;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it("does not claim one actual model when chunks report different models", async () => {
    let call = 0;
    const result = await new JevRouterProvider(
      { chunkSize: 1 },
      {
        call: async (request) => ({
          ...success(request),
          model: `jev-fixture-${++call}`,
        }),
      },
    ).judge(input(2));
    expect(result.completeness).toBe("complete");
    expect(result.model).toBeUndefined();
    expect(result.diagnostics?.[0]?.code).toBe("jev_model_mismatch");
  });
});

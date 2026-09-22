import { describe, expect, it } from "vitest";
import {
  AdvisoryFunnel,
  readInvocationIndex,
  traceInvocations,
} from "../../src/observability/invocation-analytics.js";
import type { SkillInvocationEvent } from "../../src/observability/invocation-types.js";
import type { RouteTrace } from "../../src/telemetry/types.js";
import { digest, traceFixture } from "../telemetry/helpers.js";
import { eventFixture } from "./helpers.js";

const event = (
  name = "A",
  phase: SkillInvocationEvent["phase"] = "attempted",
  extra: Partial<SkillInvocationEvent> = {},
): SkillInvocationEvent => ({
  ...eventFixture(),
  phase,
  skill: {
    nativeInvocationName: name,
    resolved: true,
    name,
    origin: "local-user",
    catalogIdentity: digest(`id:${name}`),
    contentHash: digest(`body:${name}`),
  },
  ...extra,
});
const reader = (events: SkillInvocationEvent[]) => ({
  async *read() {
    for (const trace of events)
      yield { kind: "valid" as const, line: 1, trace };
  },
});
const route = (injected = ["A", "B"]): RouteTrace => ({
  ...traceFixture(),
  agent: "claude-code",
  mode: "advisory",
  capabilities: { skillInvocationTelemetry: true },
  host: {
    event: "UserPromptSubmit",
    sessionKey: event().sessionKey,
    promptKey: event().promptKey as string,
  },
  decisions: ["A", "B"].map((name) => ({
    skillId: digest(name),
    name,
    agent: "claude-code",
    scope: "user",
    catalogIdentity: digest(`id:${name}`),
    contentHash: digest(`body:${name}`),
    probability: 0.9,
    selected: true,
  })),
  delivery: { kind: "claude-advisory", injectedSkillIds: injected.map(digest) },
});
async function summary(events: SkillInvocationEvent[], traces = [route()]) {
  const index = await readInvocationIndex(reader(events));
  const funnel = new AdvisoryFunnel(index);
  for (const trace of traces) funnel.add(trace);
  return { index, funnel: funnel.result() };
}
describe("invocation lifecycle and same-prompt advisory funnel", () => {
  it("counts recommended A,B and injected A,B with model adoption of only A", async () => {
    const { funnel } = await summary([event()]);
    expect(funnel).toMatchObject({
      recommended: 2,
      injected: 2,
      modelInvoked: 1,
      succeeded: 0,
      injectedToModelInvoked: 0.5,
      modelInvokedToSucceeded: 0,
    });
  });
  it("counts only injected A in injection conversion", async () => {
    expect((await summary([event()], [route(["A"])])).funnel).toMatchObject({
      recommended: 2,
      injected: 1,
      modelInvoked: 1,
      injectedToModelInvoked: 1,
    });
  });
  it("does not inflate injected conversion when only a non-injected recommendation is invoked", async () => {
    expect((await summary([event("B")], [route(["A"])])).funnel).toMatchObject({
      modelInvoked: 1,
      injectedToModelInvoked: 0,
    });
  });
  it.each(["succeeded", "failed"] as const)(
    "joins attempted plus %s regardless of append order",
    async (phase) => {
      const pre = event(),
        post = event("A", phase);
      const first = await summary([pre, post]);
      const reversed = await summary([post, pre]);
      expect(first.funnel).toEqual(reversed.funnel);
      expect(first.funnel.succeeded).toBe(phase === "succeeded" ? 1 : 0);
      expect(traceInvocations(route(), first.index).calls[0]?.outcome).toBe(
        phase,
      );
    },
  );
  it("attempted-only is unknown, not failed", async () => {
    const { index } = await summary([event()]);
    expect(index.health).toMatchObject({
      attempted: 1,
      failed: 0,
      attemptedOnly: 1,
    });
    expect(traceInvocations(route(), index).calls[0]?.outcome).toBe("unknown");
  });
  it("post-only has observed success but no model-attempt funnel credit", async () => {
    const { funnel, index } = await summary([event("A", "succeeded")]);
    expect(funnel.modelInvoked).toBe(0);
    expect(funnel.succeeded).toBe(0);
    expect(index.health.terminalWithoutAttempt).toBe(1);
  });
  it("dedupes tool+phase events deterministically and counts repeated invocation once per pair", async () => {
    const pre = event(),
      post = event("A", "succeeded");
    const many = [
      pre,
      pre,
      post,
      post,
      event("A", "attempted", { toolUseKey: digest("second") }),
      event("A", "succeeded", { toolUseKey: digest("second") }),
    ];
    const { funnel, index } = await summary(many);
    expect(funnel).toMatchObject({ modelInvoked: 1, succeeded: 1 });
    expect(index.health).toMatchObject({
      duplicates: 2,
      attempted: 2,
      succeeded: 2,
    });
    expect((await summary([...many].reverse())).funnel).toEqual(funnel);
  });
  it("multiple skills in one prompt remain separate", async () =>
    expect(
      (
        await summary([
          event(),
          event("B", "attempted", { toolUseKey: digest("B") }),
        ])
      ).funnel.modelInvoked,
    ).toBe(2));
  it.each([
    { promptKey: digest("other") },
    { sessionKey: digest("other") },
    { executionContext: { kind: "subagent" as const } },
  ])("does not credit another prompt/session/subagent %#", async (extra) => {
    expect(
      (await summary([event("A", "attempted", extra)])).funnel.modelInvoked,
    ).toBe(0);
  });
  it("uses tool lifecycle correlation when only the terminal event lacks prompt ID", async () => {
    const post = event("A", "succeeded");
    delete post.promptKey;
    expect((await summary([post, event()])).funnel).toMatchObject({
      modelInvoked: 1,
      succeeded: 1,
    });
    const pre = event();
    delete pre.promptKey;
    expect(
      (await summary([pre, event("A", "succeeded")])).funnel.modelInvoked,
    ).toBe(0);
  });
  it("missing invocation prompt ID cannot join even within the same session", async () => {
    const noPrompt = event();
    delete noPrompt.promptKey;
    const { index, funnel } = await summary([noPrompt]);
    expect(funnel.modelInvoked).toBe(0);
    expect(traceInvocations(route(), index).calls).toEqual([]);
  });
  it("unresolved invocation remains visible without credit", async () => {
    const unresolved = eventFixture();
    const { index, funnel } = await summary([unresolved]);
    expect(index.health.unresolved).toBe(1);
    expect(funnel.modelInvoked).toBe(0);
    expect(traceInvocations(route(), index).calls[0]?.resolved).toBe(false);
  });
  it("a changed content version does not match an earlier recommendation", async () => {
    const changed = event();
    if (changed.skill.resolved) changed.skill.contentHash = digest("new");
    expect((await summary([changed])).funnel.modelInvoked).toBe(0);
  });
  it("contradictory terminal events are unknown and get no conversion credit", async () => {
    const { index, funnel } = await summary([
      event(),
      event("A", "failed"),
      event("A", "succeeded"),
    ]);
    expect(index.health.conflicting).toBe(1);
    expect(funnel.modelInvoked).toBe(0);
    expect(traceInvocations(route(), index).calls[0]?.outcome).toBe("unknown");
  });
  it("conflicting duplicate identifiers do not join", async () => {
    const { index, funnel } = await summary([event(), event("B")]);
    expect(index.health.conflicting).toBe(1);
    expect(funnel.modelInvoked).toBe(0);
  });
  it("old traces, absent correlation and unreadable storage are unavailable with null ratios", async () => {
    const old = route();
    delete old.capabilities;
    const noPrompt = route();
    delete noPrompt.host.promptKey;
    const { index, funnel } = await summary([event()], [old, noPrompt]);
    expect(funnel).toMatchObject({
      availableTraces: 0,
      unavailableTraces: 2,
      recommended: 0,
      injectedToModelInvoked: null,
      modelInvokedToSucceeded: null,
    });
    expect(traceInvocations(old, index).availability).toBe("unavailable");
    const broken = await readInvocationIndex({
      async *read() {
        yield { kind: "valid" as const, line: 1, trace: event() };
        throw new Error("PRIVATE_ERROR");
      },
    });
    const f = new AdvisoryFunnel(broken);
    f.add(route());
    expect(f.result().unavailableTraces).toBe(1);
  });
  it("dedupes repeated logical identity within a route, preserving injected state", async () => {
    const r = route([]);
    const a = r.decisions[0];
    if (!a) throw new Error();
    r.decisions.push({ ...a, skillId: digest("copy") });
    r.delivery = {
      kind: "claude-advisory",
      injectedSkillIds: [digest("copy")],
    };
    expect((await summary([event()], [r])).funnel).toMatchObject({
      recommended: 2,
      injected: 1,
    });
  });
  it("safe show projection contains no HMAC identifiers", async () => {
    const { index } = await summary([event()]);
    const out = JSON.stringify(traceInvocations(route(), index));
    for (const s of [
      "promptKey",
      "sessionKey",
      "toolUseKey",
      event().promptKey,
      event().sessionKey,
      event().toolUseKey,
    ])
      if (s) expect(out).not.toContain(s);
  });
  it("ignores corrupt lines without losing valid lifecycle data", async () => {
    const index = await readInvocationIndex({
      async *read() {
        yield {
          kind: "invalid" as const,
          line: 1,
          code: "invalid_json" as const,
        };
        yield { kind: "valid" as const, line: 2, trace: event() };
      },
    });
    expect(index.health).toMatchObject({
      validEvents: 1,
      invalidLines: 1,
      attempted: 1,
    });
  });
});

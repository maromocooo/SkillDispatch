import { compareText } from "../core/order.js";
import type { JsonlReadResult } from "../telemetry/reader.js";
import type { RouteTrace } from "../telemetry/types.js";
import type { SkillInvocationEvent } from "./invocation-types.js";

type Event = SkillInvocationEvent;
export interface InvocationEventReader {
  read(): AsyncIterable<JsonlReadResult<Event>>;
}
interface Lifecycle {
  phases: Partial<Record<Event["phase"], Event>>;
  conflict: boolean;
}
const eventIdentity = (event: Event) =>
  JSON.stringify([
    event.skill.nativeInvocationName,
    event.executionContext.kind,
  ]);
const earlier = (a: Event, b: Event) =>
  compareText(a.timestamp, b.timestamp) ||
  compareText(a.eventId, b.eventId) ||
  compareText(JSON.stringify(a), JSON.stringify(b));
const promptIdentity = (session: string, prompt: string) =>
  JSON.stringify([session, prompt]);

/** Streaming input; retains only lifecycle state, never routing prompts or tool payloads. */
export async function readInvocationIndex(reader: InvocationEventReader) {
  const calls = new Map<string, Lifecycle>();
  let validEvents = 0,
    invalidLines = 0,
    duplicates = 0,
    available = true;
  try {
    for await (const item of reader.read()) {
      if (item.kind === "invalid") {
        invalidLines++;
        continue;
      }
      validEvents++;
      const event = item.trace,
        key = JSON.stringify([event.sessionKey, event.toolUseKey]);
      const lifecycle = calls.get(key) ?? { phases: {}, conflict: false };
      const existing = lifecycle.phases[event.phase];
      if (existing) {
        duplicates++;
        if (
          eventIdentity(existing) !== eventIdentity(event) ||
          (existing.promptKey !== undefined &&
            event.promptKey !== undefined &&
            existing.promptKey !== event.promptKey)
        )
          lifecycle.conflict = true;
      }
      if (!existing || earlier(event, existing) < 0)
        lifecycle.phases[event.phase] = event;
      calls.set(key, lifecycle);
    }
  } catch {
    available = false;
    calls.clear();
  }
  const prompts = new Map<string, Lifecycle[]>();
  let attempted = 0,
    succeeded = 0,
    failed = 0,
    attemptedOnly = 0,
    unresolved = 0,
    conflicting = 0,
    terminalWithoutAttempt = 0;
  for (const lifecycle of calls.values()) {
    const { phases } = lifecycle;
    const events = Object.values(phases);
    const first = events.find((event) => event.promptKey !== undefined);
    lifecycle.conflict ||=
      new Set(events.map(eventIdentity)).size > 1 ||
      new Set(
        events.flatMap((event) =>
          event.promptKey === undefined ? [] : [event.promptKey],
        ),
      ).size > 1 ||
      !!(phases.succeeded && phases.failed);
    if (lifecycle.conflict) conflicting++;
    if (phases.attempted) {
      attempted++;
      if (!phases.attempted.skill.resolved) unresolved++;
      if (!phases.succeeded && !phases.failed) attemptedOnly++;
    } else terminalWithoutAttempt++;
    if (phases.succeeded) succeeded++;
    if (phases.failed) failed++;
    if (first?.promptKey) {
      const key = promptIdentity(first.sessionKey, first.promptKey);
      const list = prompts.get(key) ?? [];
      list.push(lifecycle);
      prompts.set(key, list);
    }
  }
  return {
    available,
    prompts,
    health: {
      available,
      validEvents,
      invalidLines,
      duplicates,
      attempted,
      succeeded,
      failed,
      attemptedOnly,
      unresolved,
      conflicting,
      terminalWithoutAttempt,
    },
  };
}
export type InvocationIndex = Awaited<ReturnType<typeof readInvocationIndex>>;
export function traceInvocationAvailability(
  trace: RouteTrace,
  index: InvocationIndex,
): boolean {
  return (
    index.available &&
    trace.agent === "claude-code" &&
    trace.capabilities?.skillInvocationTelemetry === true &&
    !!trace.host.sessionKey &&
    !!trace.host.promptKey
  );
}
function matchingCalls(trace: RouteTrace, index: InvocationIndex): Lifecycle[] {
  if (
    !trace.host.sessionKey ||
    !trace.host.promptKey ||
    trace.agent !== "claude-code"
  )
    return [];
  return (
    index.prompts.get(
      promptIdentity(trace.host.sessionKey, trace.host.promptKey),
    ) ?? []
  );
}
/** Privacy-safe display: no HMACs, arguments, response or error text. */
export function traceInvocations(trace: RouteTrace, index: InvocationIndex) {
  const available = traceInvocationAvailability(trace, index);
  const calls = matchingCalls(trace, index)
    .map(({ phases, conflict }) => {
      const first = phases.attempted ?? phases.succeeded ?? phases.failed;
      if (!first) throw new Error("Invalid lifecycle.");
      return {
        nativeInvocationName: first.skill.nativeInvocationName,
        resolved: first.skill.resolved,
        executionContext: first.executionContext.kind,
        timestamp: first.timestamp,
        attempted: !!phases.attempted,
        outcome: conflict
          ? "unknown"
          : phases.succeeded
            ? "succeeded"
            : phases.failed
              ? "failed"
              : "unknown",
        ...(conflict
          ? { diagnosticCode: "conflicting_invocation_events" }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        compareText(a.nativeInvocationName, b.nativeInvocationName) ||
        compareText(a.timestamp, b.timestamp) ||
        compareText(JSON.stringify(a), JSON.stringify(b)),
    );
  return {
    availability: available ? ("available" as const) : ("unavailable" as const),
    calls,
  };
}
export interface PairCounts {
  recommended: number;
  injected: number;
  modelInvoked: number;
  succeeded: number;
  injectedModelInvoked: number;
}
const empty = (): PairCounts => ({
  recommended: 0,
  injected: 0,
  modelInvoked: 0,
  succeeded: 0,
  injectedModelInvoked: 0,
});
const rate = (a: number, b: number) => (b ? a / b : null);
/** Each routing record contributes at most one pair per logical catalog/content identity. */
export class AdvisoryFunnel {
  private counts = empty();
  private availableTraces = 0;
  private unavailableTraces = 0;
  private uncorrelatablePairs = 0;
  private skills = new Map<
    string,
    PairCounts & { name: string; catalogIdentity: string; contentHash: string }
  >();
  constructor(private readonly index: InvocationIndex) {}
  add(trace: RouteTrace): void {
    if (trace.agent !== "claude-code" || trace.mode !== "advisory") return;
    if (!traceInvocationAvailability(trace, this.index)) {
      this.unavailableTraces++;
      return;
    }
    this.availableTraces++;
    const calls = matchingCalls(trace, this.index).filter(
      (call) =>
        !call.conflict &&
        call.phases.attempted?.executionContext.kind === "main" &&
        call.phases.attempted.promptKey === trace.host.promptKey,
    );
    const pairs = new Map<
      string,
      { decision: RouteTrace["decisions"][number]; injected: boolean }
    >();
    for (const d of trace.decisions) {
      if (!d.selected || d.agent !== "claude-code") continue;
      if (!d.catalogIdentity) {
        this.uncorrelatablePairs++;
        continue;
      }
      const key = JSON.stringify([d.catalogIdentity, d.contentHash]);
      const previous = pairs.get(key);
      pairs.set(key, {
        decision:
          previous && compareText(previous.decision.name, d.name) < 0
            ? previous.decision
            : d,
        injected:
          previous?.injected === true ||
          trace.delivery?.injectedSkillIds.includes(d.skillId) === true,
      });
    }
    for (const [key, { decision: d, injected }] of pairs) {
      const matched = calls.filter((call) => {
        const s = call.phases.attempted?.skill;
        return (
          s?.resolved &&
          s.catalogIdentity === d.catalogIdentity &&
          s.contentHash === d.contentHash
        );
      });
      const invoked = matched.length > 0;
      // A success belongs to this exact tool lifecycle, not just another call of the skill.
      const succeeded = matched.some((call) => !!call.phases.succeeded);
      const delta = {
        recommended: 1,
        injected: Number(injected),
        modelInvoked: Number(invoked),
        succeeded: Number(succeeded),
        injectedModelInvoked: Number(injected && invoked),
      };
      const skill = this.skills.get(key) ?? {
        ...empty(),
        name: d.name,
        catalogIdentity: d.catalogIdentity as string,
        contentHash: d.contentHash,
      };
      if (compareText(d.name, skill.name) < 0) skill.name = d.name;
      for (const field of Object.keys(delta) as (keyof PairCounts)[]) {
        this.counts[field] += delta[field];
        skill[field] += delta[field];
      }
      this.skills.set(key, skill);
    }
  }
  result() {
    return {
      ...this.counts,
      availableTraces: this.availableTraces,
      unavailableTraces: this.unavailableTraces,
      uncorrelatablePairs: this.uncorrelatablePairs,
      injectedToModelInvoked: rate(
        this.counts.injectedModelInvoked,
        this.counts.injected,
      ),
      modelInvokedToSucceeded: rate(
        this.counts.succeeded,
        this.counts.modelInvoked,
      ),
      skills: [...this.skills.values()].sort(
        (a, b) =>
          b.recommended - a.recommended ||
          compareText(a.name, b.name) ||
          compareText(a.catalogIdentity, b.catalogIdentity) ||
          compareText(a.contentHash, b.contentHash),
      ),
    };
  }
}

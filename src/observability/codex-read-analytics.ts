import type { JsonlReadResult } from "../telemetry/reader.js";
import type { RouteTrace } from "../telemetry/types.js";
import type { CodexReadEvent } from "./codex-read-types.js";
export interface CodexReadEventReader {
  read(): AsyncIterable<JsonlReadResult<CodexReadEvent>>;
}
interface Lifecycle {
  attempt?: CodexReadEvent;
  terminal?: CodexReadEvent;
  conflict: boolean;
}
const promptKey = (session: string, prompt: string) =>
  JSON.stringify(["codex", session, prompt]);
const identity = (e: CodexReadEvent) =>
  JSON.stringify([e.skill, e.executionContext]);
export async function readCodexReadIndex(reader: CodexReadEventReader) {
  const calls = new Map<string, Lifecycle>();
  const health = {
    streamReadable: true,
    validEvents: 0,
    invalidLines: 0,
    unsupportedVersions: 0,
    duplicates: 0,
    attempted: 0,
    terminalObserved: 0,
    attemptedOnly: 0,
    terminalWithoutAttempt: 0,
    unresolved: 0,
    conflicting: 0,
  };
  try {
    for await (const item of reader.read()) {
      if (item.kind === "unsupported") {
        health.unsupportedVersions++;
        continue;
      }
      if (item.kind === "invalid") {
        health.invalidLines++;
        continue;
      }
      health.validEvents++;
      const e = item.trace;
      const key = JSON.stringify([
        e.agent,
        e.sessionKey,
        e.promptKey ?? null,
        e.toolUseKey,
      ]);
      const call = calls.get(key) ?? { conflict: false };
      const phase = e.phase === "attempted" ? "attempt" : "terminal";
      const old = call[phase];
      if (old) {
        health.duplicates++;
        call.conflict ||= identity(old) !== identity(e);
      }
      if (
        !old ||
        `${e.timestamp}${e.eventId}` < `${old.timestamp}${old.eventId}`
      )
        call[phase] = e;
      calls.set(key, call);
    }
  } catch {
    health.streamReadable = false;
    calls.clear();
  }
  const prompts = new Map<string, Lifecycle[]>();
  for (const call of calls.values()) {
    if (call.attempt && call.terminal)
      call.conflict ||= identity(call.attempt) !== identity(call.terminal);
    if (call.conflict) health.conflicting++;
    if (call.attempt) health.attempted++;
    if (call.terminal) health.terminalObserved++;
    if (call.attempt && !call.terminal) health.attemptedOnly++;
    if (!call.attempt) health.terminalWithoutAttempt++;
    const e = call.attempt ?? call.terminal;
    if (!e) continue;
    if (!e.skill.resolved) health.unresolved++;
    if (e.promptKey) {
      const key = promptKey(e.sessionKey, e.promptKey),
        list = prompts.get(key) ?? [];
      list.push(call);
      prompts.set(key, list);
    }
  }
  return { health, prompts };
}
export type CodexReadIndex = Awaited<ReturnType<typeof readCodexReadIndex>>;
export function codexObserverConfigured(trace: RouteTrace) {
  return (
    trace.schemaVersion === "2.0" &&
    trace.agent === "codex" &&
    trace.capabilities?.skillInstructionReadTelemetry === true
  );
}
export function traceInstructionReads(
  trace: RouteTrace,
  index: CodexReadIndex,
) {
  const correlationAvailable =
    trace.agent === "codex" &&
    !!trace.host.sessionKey &&
    !!trace.host.promptKey &&
    index.health.streamReadable;
  const calls = correlationAvailable
    ? (index.prompts.get(
        promptKey(trace.host.sessionKey ?? "", trace.host.promptKey ?? ""),
      ) ?? [])
    : [];
  return {
    evidence: "skill-instructions-read" as const,
    observerConfigured: codexObserverConfigured(trace),
    streamReadable: index.health.streamReadable,
    correlationAvailable,
    calls: calls
      .map((c) => {
        const e = c.attempt ?? c.terminal;
        return {
          name: e?.skill.resolved ? e.skill.name : "unresolved",
          resolved: e?.skill.resolved ?? false,
          attemptObserved: !!c.attempt,
          terminalObserved: !!c.terminal,
          outcome: c.conflict ? "conflicting" : "unknown",
          terminalWithoutAttempt: !c.attempt,
          executionContext: e?.executionContext.kind ?? "unknown",
        };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}
export class CodexReadSummary {
  private counts = {
    recommended: 0,
    emitted: 0,
    observedInstructionReadAttemptPairs: 0,
    observedTerminalEventPairs: 0,
    observerConfiguredTraces: 0,
    observerUnavailableTraces: 0,
  };
  constructor(private readonly index: CodexReadIndex) {}
  add(trace: RouteTrace) {
    if (trace.agent !== "codex") return;
    const configured = codexObserverConfigured(trace);
    this.counts[
      configured ? "observerConfiguredTraces" : "observerUnavailableTraces"
    ]++;
    const calls =
      trace.host.sessionKey &&
      trace.host.promptKey &&
      this.index.health.streamReadable
        ? (this.index.prompts.get(
            promptKey(trace.host.sessionKey, trace.host.promptKey),
          ) ?? [])
        : [];
    const seen = new Set<string>();
    for (const d of trace.decisions.filter(
      (d) => d.selected && d.agent === "codex",
    )) {
      const key = JSON.stringify([
        d.catalogIdentity ?? d.skillId,
        d.contentHash,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      this.counts.recommended++;
      if (trace.delivery?.injectedSkillIds.includes(d.skillId))
        this.counts.emitted++;
      if (!configured || !d.catalogIdentity) continue;
      const matching = calls.filter(
        (c) =>
          !c.conflict &&
          c.attempt?.executionContext.kind === "main" &&
          c.attempt.skill.resolved &&
          c.attempt.skill.catalogIdentity === d.catalogIdentity &&
          c.attempt.skill.contentHash === d.contentHash,
      );
      if (matching.length) this.counts.observedInstructionReadAttemptPairs++;
      if (matching.some((c) => c.terminal))
        this.counts.observedTerminalEventPairs++;
    }
  }
  result() {
    return {
      evidence: "skill-instructions-read" as const,
      ...this.counts,
      terminalSuccess: "unsupported" as const,
      completeLoad: "unconfirmed" as const,
    };
  }
}

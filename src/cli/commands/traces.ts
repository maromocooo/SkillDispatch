import { readInvocationIndex } from "../../observability/invocation-analytics.js";
import { loadOperations } from "../../ops/context.js";
import {
  listTraces,
  parseSince,
  showTrace,
  summarizeTraces,
  type TraceFilter,
  type TraceSummary,
} from "../../telemetry/analytics.js";
import type { TraceDetailView, TraceListView } from "../../telemetry/views.js";
import type { CliEnvironment } from "../context.js";
import { type CliIO, terminalText } from "../output.js";

interface TraceOptions {
  json?: boolean;
  agent?: "codex" | "claude-code";
  outcome?: "complete" | "partial" | "failed";
  since?: string;
  limit?: string;
}
export async function tracesCommand(
  command: "summary" | "list" | "show",
  id: string | undefined,
  options: TraceOptions,
  environment: CliEnvironment,
  io: CliIO,
) {
  let context: Awaited<ReturnType<typeof loadOperations>>;
  try {
    context = await loadOperations(environment);
  } catch {
    throw new Error("Cannot load trusted operational configuration.");
  }
  const nowMs = Date.now();
  const filter: TraceFilter = {
    nowMs,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.since === undefined
      ? {}
      : { sinceMs: parseSince(options.since, nowMs) }),
  };
  if (command === "summary") {
    const result = await summarizeTraces(
      context.reader,
      filter,
      await readInvocationIndex(context.invocationReader),
    );
    if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else printSummary(result, io);
  } else if (command === "list") {
    const result = await listTraces(
      context.reader,
      filter,
      options.limit === undefined
        ? 20
        : /^\d+$/.test(options.limit)
          ? Number(options.limit)
          : Number.NaN,
    );
    if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else {
      io.stdout(
        "Trace ID\tTimestamp\tAgent\tOutcome\tMode\tSelected\tLatency ms\n",
      );
      for (const trace of result.traces) printListItem(trace, io);
      io.stdout(
        `Showing ${result.traces.length} of ${result.matchedTraces} matching traces; invalid lines: ${result.invalidLines}\n`,
      );
    }
  } else {
    const result = await showTrace(
      context.reader,
      id ?? "",
      context.invocationReader,
    );
    if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else {
      printDetail(result.trace, io);
      if (result.modelInvocations) {
        io.stdout(
          `Invocation observer: ${result.modelInvocations.observerConfigured ? "configured / best-effort" : "not configured / telemetry unavailable"}\nInvocation stream: ${result.modelInvocations.streamReadable ? "readable" : "unavailable"}; correlation: ${result.modelInvocations.correlationAvailable ? "possible" : "unavailable"}\nModel skill invocations observed:${result.modelInvocations.calls.length ? "" : " none"}\n`,
        );
        io.stdout("Missing events do not prove non-invocation or failure.\n");
        for (const call of result.modelInvocations.calls)
          io.stdout(
            `  ${terminalText(call.nativeInvocationName)} ${call.attempted ? "attempted" : "attempt not observed"} -> ${call.outcome} (${call.executionContext}; ${call.resolved ? "resolved" : "unresolved"})\n`,
          );
      }
    }
  }
}
const number = (value: number | null) =>
  value === null ? "n/a" : value.toFixed(2);
function printSummary(s: TraceSummary, io: CliIO) {
  io.stdout(
    `Total lines: ${s.totalLines}\nValid traces: ${s.validTraces}\nInvalid lines: ${s.invalidLines}\nMatching traces: ${s.matchedTraces}\n`,
  );
  io.stdout(
    `Agents: Codex ${s.agents.codex}; Claude Code ${s.agents["claude-code"]}\nOutcomes: Complete ${s.outcomes.complete}; Partial ${s.outcomes.partial}; Failed ${s.outcomes.failed}\n`,
  );
  io.stdout(
    `Modes: shadow ${s.modes.shadow}; advisory ${s.modes.advisory}\nAdvisory recommendations: ${s.advisory.recommendedCount}; injected: ${s.advisory.injectedCount}\n`,
  );
  if (s.advisoryFunnel) {
    const f = s.advisoryFunnel;
    io.stdout(
      `Advisory / invocation telemetry (observer-configured route-skill pairs):\n  Recommended: ${f.recommended}\n  Injected: ${f.injected}\n  Observed model-invoked: ${f.observedModelInvoked}\n  Observed succeeded: ${f.observedSucceeded}\n  Observer-configured traces: ${f.telemetryConfiguredTraces}\n  Observer-unavailable traces (not configured): ${f.telemetryUnconfiguredTraces}\n  Configured traces without usable correlation: ${f.uncorrelatableTraces}\n  Injected pairs with no observed model invocation: ${f.injectedPairsWithoutObservedInvocation}\n  Async observers provide positive evidence only; missing events remain unknown. Exact conversion rates are not reported.\n`,
    );
    const h = s.invocationHealth;
    if (h)
      io.stdout(
        `Invocation stream: ${h.available ? "readable" : "unavailable"}; valid ${h.validEvents}; invalid ${h.invalidLines}; attempted-only (unknown) ${h.attemptedOnly}; unresolved model invocations ${h.unresolved}\n`,
      );
  }
  io.stdout(
    `Average selected skills: ${number(s.averageSelectedSkills)}\nP50 latency ms: ${number(s.p50LatencyMs)}\nP95 latency ms: ${number(s.p95LatencyMs)}\nProviders:\n`,
  );
  for (const p of s.providers)
    io.stdout(`  ${terminalText(p.provider)}: ${p.count}\n`);
  io.stdout(
    `Distinct catalog fingerprints: ${s.distinctCatalogFingerprints}\nSkills seen: ${s.skillsSeen}\nSkills ever selected: ${s.skillsEverSelected}\nSkills never selected: ${s.skillsNeverSelected}\nTop selected skill versions (up to 20):\nName\tAgent\tScope\tVersion\tSeen\tSelected\tRate\n`,
  );
  for (const skill of s.skillStatistics.slice(0, 20))
    io.stdout(
      `${terminalText(skill.name)}\t${skill.agent}\t${skill.scope}\t${skill.contentHash.slice(0, 12)}\t${skill.seen}\t${skill.selected}\t${(skill.selectionRate * 100).toFixed(1)}%\n`,
    );
  io.stdout(
    "Selected means a SkillDispatch recommendation, not host invocation. Never selected refers only to observed skill versions.\n",
  );
}
function printListItem(t: TraceListView, io: CliIO) {
  io.stdout(
    `${t.traceId}\t${t.timestamp}\t${t.agent}\t${t.outcome}\t${t.mode}\t${t.selectedCount}\t${number(t.latencyMs)}\n`,
  );
}
function printDetail(t: TraceDetailView, io: CliIO) {
  io.stdout(
    `Trace: ${t.traceId}\nTimestamp: ${t.timestamp}\nAgent: ${t.agent}\nOutcome: ${t.outcome}\nMode: ${t.mode}\nProvider: ${terminalText(t.provider)}\n`,
  );
  if (t.model) io.stdout(`Model: ${terminalText(t.model)}\n`);
  io.stdout(
    `Latency ms: ${number(t.latencyMs)}\nPolicy: threshold ${t.policy.threshold}, maxSkills ${t.policy.maxSkills}\nCatalog fingerprint: ${t.catalog.fingerprint.slice(0, 12)}\n`,
  );
  for (const selected of [true, false]) {
    io.stdout(
      selected ? "Selected skills (recommendations):\n" : "Other decisions:\n",
    );
    for (const d of t.decisions.filter((d) => d.selected === selected))
      io.stdout(
        `  ${terminalText(d.name)}\t${d.agent}\t${d.scope}\t${d.probability.toFixed(4)}\n`,
      );
  }
  if (t.mode === "advisory") {
    io.stdout("Injected recommendations (not observed invocations):\n");
    for (const d of t.decisions.filter((d) => d.injected))
      io.stdout(`  ${terminalText(d.name)}\t${d.agent}\t${d.scope}\n`);
  }
  io.stdout("Diagnostics:\n");
  for (const d of t.diagnostics) io.stdout(`  ${d.code}\t${d.level}\n`);
}

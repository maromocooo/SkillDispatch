import { compareText } from "../core/order.js";
import {
  AdvisoryFunnel,
  type InvocationEventReader,
  type InvocationIndex,
  readInvocationIndex,
  traceInvocations,
} from "../observability/invocation-analytics.js";
import type { TraceReader } from "./reader.js";
import { type RouteTrace, routeTraceV1Schema } from "./types.js";
import {
  type TraceDetailView,
  type TraceListView,
  traceDetailView,
  traceListView,
} from "./views.js";

export interface TraceFilter {
  agent?: RouteTrace["agent"];
  outcome?: RouteTrace["outcome"];
  sinceMs?: number;
  nowMs?: number;
}
export function parseSince(value: string, nowMs: number): number {
  const match = /^([1-9][0-9]*)(h|d)$/.exec(value);
  const duration =
    Number(match?.[1]) * (match?.[2] === "h" ? 3_600_000 : 86_400_000);
  if (
    !match ||
    !Number.isSafeInteger(duration) ||
    !Number.isFinite(nowMs - duration)
  )
    throw new Error(
      "--since must be a positive duration such as 1h, 24h, 7d or 30d.",
    );
  return nowMs - duration;
}
export function matchesTrace(trace: RouteTrace, filter: TraceFilter): boolean {
  const timestamp = Date.parse(trace.timestamp);
  return (
    (!filter.agent || filter.agent === trace.agent) &&
    (!filter.outcome || filter.outcome === trace.outcome) &&
    (filter.sinceMs === undefined ||
      (timestamp >= filter.sinceMs &&
        timestamp <= (filter.nowMs ?? Date.now())))
  );
}
interface Counts {
  totalLines: number;
  validTraces: number;
  invalidLines: number;
  matchedTraces: number;
}
const emptyCounts = (): Counts => ({
  totalLines: 0,
  validTraces: 0,
  invalidLines: 0,
  matchedTraces: 0,
});
async function* matching(
  reader: TraceReader,
  counts: Counts,
  filter: TraceFilter,
) {
  const fixed = { ...filter, nowMs: filter.nowMs ?? Date.now() };
  for await (const item of reader.read()) {
    counts.totalLines++;
    if (item.kind === "invalid") {
      counts.invalidLines++;
      continue;
    }
    counts.validTraces++;
    if (!matchesTrace(item.trace, fixed)) continue;
    counts.matchedTraces++;
    yield item.trace;
  }
}
interface SkillStatistic {
  name: string;
  agent: RouteTrace["decisions"][number]["agent"];
  scope: RouteTrace["decisions"][number]["scope"];
  contentHash: string;
  seen: number;
  selected: number;
  selectionRate: number;
}
export function compareSkillStatistics(
  a: SkillStatistic,
  b: SkillStatistic,
): number {
  return (
    b.selected - a.selected ||
    compareText(a.agent, b.agent) ||
    compareText(a.name, b.name) ||
    compareText(a.scope, b.scope) ||
    compareText(a.contentHash, b.contentHash)
  );
}
/** Exact nearest-rank quantiles over frequency counts; no trace bodies retained. */
function percentile(
  histogram: Map<number, number>,
  count: number,
  p: number,
): number | null {
  if (!count) return null;
  const rank = Math.ceil(p * count);
  let cumulative = 0;
  for (const [value, frequency] of [...histogram].sort(([a], [b]) => a - b)) {
    cumulative += frequency;
    if (cumulative >= rank) return value;
  }
  return null;
}
export async function summarizeTraces(
  reader: TraceReader,
  filter: TraceFilter = {},
  invocationIndex?: InvocationIndex,
) {
  const counts = emptyCounts();
  const funnel = invocationIndex
    ? new AdvisoryFunnel(invocationIndex)
    : undefined;
  const agents = { codex: 0, "claude-code": 0 };
  const modes = { shadow: 0, advisory: 0 };
  const advisory = { recommendedCount: 0, injectedCount: 0 };
  const outcomes = { complete: 0, partial: 0, failed: 0 };
  const providers = new Map<string, number>();
  const fingerprints = new Set<string>();
  const latencies = new Map<number, number>();
  const skills = new Map<string, SkillStatistic>();
  let totalSelected = 0;
  for await (const trace of matching(reader, counts, filter)) {
    funnel?.add(trace);
    agents[trace.agent]++;
    modes[trace.mode]++;
    if (trace.mode === "advisory") {
      advisory.recommendedCount += trace.decisions.filter(
        (d) => d.selected,
      ).length;
      advisory.injectedCount += trace.delivery?.injectedSkillIds.length ?? 0;
    }
    outcomes[trace.outcome]++;
    providers.set(
      trace.router.provider,
      (providers.get(trace.router.provider) ?? 0) + 1,
    );
    fingerprints.add(trace.catalog.fingerprint);
    latencies.set(
      trace.router.latencyMs,
      (latencies.get(trace.router.latencyMs) ?? 0) + 1,
    );
    totalSelected += trace.decisions.filter((d) => d.selected).length;
    const seen = new Map<string, RouteTrace["decisions"][number]>();
    for (const decision of trace.decisions) {
      const key = JSON.stringify([
        decision.name,
        decision.agent,
        decision.scope,
        decision.contentHash,
      ]);
      if (!seen.has(key) || decision.selected) seen.set(key, decision);
    }
    for (const [key, d] of seen) {
      const item = skills.get(key) ?? {
        name: d.name,
        agent: d.agent,
        scope: d.scope,
        contentHash: d.contentHash,
        seen: 0,
        selected: 0,
        selectionRate: 0,
      };
      item.seen++;
      item.selected += Number(d.selected);
      item.selectionRate = item.selected / item.seen;
      skills.set(key, item);
    }
  }
  const skillStatistics = [...skills.values()].sort(compareSkillStatistics);
  const skillsEverSelected = skillStatistics.filter(
    (s) => s.selected > 0,
  ).length;
  return {
    version: 1 as const,
    ...counts,
    agents,
    outcomes,
    modes,
    advisory,
    ...(funnel
      ? {
          advisoryFunnel: funnel.result(),
          invocationHealth: invocationIndex?.health,
        }
      : {}),
    providers: [...providers]
      .sort(([a], [b]) => compareText(a, b))
      .map(([provider, count]) => ({ provider, count })),
    averageSelectedSkills: counts.matchedTraces
      ? totalSelected / counts.matchedTraces
      : null,
    p50LatencyMs: percentile(latencies, counts.matchedTraces, 0.5),
    p95LatencyMs: percentile(latencies, counts.matchedTraces, 0.95),
    distinctCatalogFingerprints: fingerprints.size,
    skillsSeen: skills.size,
    skillsEverSelected,
    skillsNeverSelected: skills.size - skillsEverSelected,
    skillStatistics,
  };
}
export type TraceSummary = Awaited<ReturnType<typeof summarizeTraces>>;
function newestFirst(a: TraceListView, b: TraceListView): number {
  return (
    Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
    compareText(a.traceId, b.traceId)
  );
}
export const MAX_TRACE_LIST_LIMIT = 1000;
export async function listTraces(
  reader: TraceReader,
  filter: TraceFilter = {},
  limit = 20,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRACE_LIST_LIMIT)
    throw new Error("--limit must be an integer from 1 to 1000.");
  const counts = emptyCounts();
  const traces: TraceListView[] = [];
  for await (const trace of matching(reader, counts, filter)) {
    const view = traceListView(trace);
    // Bounded top-N, keeping later file records first when timestamp and ID tie.
    const index = traces.findIndex((item) => newestFirst(view, item) <= 0);
    traces.splice(index < 0 ? traces.length : index, 0, view);
    if (traces.length > limit) traces.pop();
  }
  return { version: 1 as const, ...counts, traces };
}
export async function showTrace(
  reader: TraceReader,
  id: string,
  invocationReader?: InvocationEventReader,
) {
  if (!routeTraceV1Schema.shape.traceId.safeParse(id).success)
    throw new Error("Trace ID must be a complete UUID.");
  let found: TraceDetailView | undefined;
  let correlation: RouteTrace | undefined;
  const counts = emptyCounts();
  for await (const trace of matching(reader, counts, {})) {
    if (trace.traceId.toLowerCase() !== id.toLowerCase()) continue;
    if (found) throw new Error("Duplicate trace ID: dataset is corrupt.");
    found = traceDetailView(trace);
    correlation = trace;
  }
  if (!found) throw new Error("Trace not found.");
  const invocations =
    invocationReader && correlation
      ? traceInvocations(
          correlation,
          await readInvocationIndex(invocationReader),
        )
      : undefined;
  return {
    version: 1 as const,
    ...counts,
    trace: found,
    ...(invocations ? { modelInvocations: invocations } : {}),
  };
}

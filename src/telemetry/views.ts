import type { RouteTrace } from "./types.js";

/** CLI allowlist: prompt data and host correlation identifiers never cross this boundary. */
export function traceListView(trace: RouteTrace) {
  return {
    traceId: trace.traceId,
    timestamp: trace.timestamp,
    agent: trace.agent,
    outcome: trace.outcome,
    mode: trace.mode,
    injectedCount: trace.delivery?.injectedSkillIds.length ?? 0,
    provider: trace.router.provider,
    ...(trace.router.model === undefined ? {} : { model: trace.router.model }),
    selectedCount: trace.decisions.filter((d) => d.selected).length,
    latencyMs: trace.router.latencyMs,
  };
}
export type TraceListView = ReturnType<typeof traceListView>;
export function traceDetailView(trace: RouteTrace) {
  return {
    ...traceListView(trace),
    schemaVersion: trace.schemaVersion,
    mode: trace.mode,
    promptStorage: trace.prompt.storage,
    policy: {
      threshold: trace.policy.threshold,
      maxSkills: trace.policy.maxSkills,
    },
    catalog: {
      fingerprint: trace.catalog.fingerprint,
      skillCount: trace.catalog.skillCount,
      enabledSkillCount: trace.catalog.enabledSkillCount,
    },
    decisions: trace.decisions.map((d) => ({
      name: d.name,
      agent: d.agent,
      scope: d.scope,
      contentHash: d.contentHash,
      probability: d.probability,
      selected: d.selected,
      injected: trace.delivery?.injectedSkillIds.includes(d.skillId) ?? false,
    })),
    diagnostics: trace.diagnostics.map((d) => ({
      code: d.code,
      level: d.level,
    })),
  };
}
export type TraceDetailView = ReturnType<typeof traceDetailView>;

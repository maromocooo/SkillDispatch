import { describe, expect, it } from "vitest";
import {
  listTraces,
  parseSince,
  showTrace,
  summarizeTraces,
} from "../../src/telemetry/analytics.js";
import type {
  RouteTraceReadResult,
  TraceReader,
} from "../../src/telemetry/reader.js";
import type { RouteTrace } from "../../src/telemetry/types.js";
import { digest, traceFixture } from "./helpers.js";

function dataset(traces: RouteTrace[], invalid = false): TraceReader {
  return {
    async *read() {
      if (invalid)
        yield {
          kind: "invalid",
          line: 1,
          code: "invalid_json",
        } as RouteTraceReadResult;
      for (const [i, trace] of traces.entries())
        yield { kind: "valid", line: i + 1, trace } as RouteTraceReadResult;
    },
  };
}
function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
const trace = (index = 0): RouteTrace => ({
  ...traceFixture(),
  timestamp: new Date(Date.UTC(2026, 8, 22, 0, index)).toISOString(),
  traceId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
});
describe("trace analytics", () => {
  it("aggregates counts, exact nearest-rank latency and observed skill versions", async () => {
    const a = trace();
    const b = trace(1);
    const c = trace(2);
    a.router.latencyMs = 10;
    b.router.latencyMs = 30;
    c.router.latencyMs = 20;
    b.agent = "claude-code";
    b.outcome = "partial";
    b.router.provider = "jev";
    c.outcome = "failed";
    c.catalog.fingerprint = digest("other");
    b.decisions = [
      { ...at(a.decisions, 0), agent: "claude-code", selected: false },
    ];
    c.decisions = [
      { ...at(a.decisions, 0), contentHash: digest("v2"), selected: false },
    ];
    a.decisions.push({
      ...at(a.decisions, 0),
      skillId: digest("alias"),
      selected: false,
    });
    const summary = await summarizeTraces(dataset([a, b, c], true));
    expect(summary).toMatchObject({
      version: 1,
      totalLines: 4,
      validTraces: 3,
      invalidLines: 1,
      matchedTraces: 3,
      agents: { codex: 2, "claude-code": 1 },
      outcomes: { complete: 1, partial: 1, failed: 1 },
      providers: [
        { provider: "jev", count: 1 },
        { provider: "mock", count: 2 },
      ],
      averageSelectedSkills: 1 / 3,
      p50LatencyMs: 20,
      p95LatencyMs: 30,
      distinctCatalogFingerprints: 2,
      skillsSeen: 3,
      skillsEverSelected: 1,
      skillsNeverSelected: 2,
    });
    expect(
      summary.skillStatistics.map((s) => [s.agent, s.seen, s.selected]),
    ).toEqual([
      ["codex", 1, 1],
      ["claude-code", 1, 0],
      ["codex", 1, 0],
    ]);
    expect(await summarizeTraces(dataset([c, a, b], true))).toEqual(summary);
  });
  it("counts each skill version once per trace and reports selection frequency", async () => {
    const a = trace();
    const b = trace(1);
    const c = trace(2);
    at(b.decisions, 0).selected = false;
    a.decisions.push({ ...at(a.decisions, 0), skillId: digest("duplicate") });
    const s = await summarizeTraces(dataset([a, b, c]));
    expect(s.skillStatistics[0]).toMatchObject({
      seen: 3,
      selected: 2,
      selectionRate: 2 / 3,
    });
    expect(s.averageSelectedSkills).toBe(1);
  });
  it("separates scope/name/version and orders ties without localeCompare", async () => {
    const a = trace();
    a.decisions = ["z", "a", "A"].flatMap((name) =>
      ["user", "repo"].map((scope) => ({
        ...at(a.decisions, 0),
        name,
        scope: scope as "repo" | "user",
        selected: false,
      })),
    );
    const s = await summarizeTraces(dataset([a]));
    expect(s.skillStatistics.map((s) => `${s.name}:${s.scope}`)).toEqual([
      "A:repo",
      "A:user",
      "a:repo",
      "a:user",
      "z:repo",
      "z:user",
    ]);
  });
  it("returns null averages/percentiles for empty and filtered-out datasets", async () => {
    const s = await summarizeTraces(dataset([]));
    expect(s).toMatchObject({
      validTraces: 0,
      averageSelectedSkills: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      skillsSeen: 0,
      skillStatistics: [],
    });
    expect(JSON.stringify(s)).not.toMatch(/NaN|Infinity/);
    expect(
      (await summarizeTraces(dataset([trace()]), { agent: "claude-code" }))
        .matchedTraces,
    ).toBe(0);
  });
  it("lists the latest 20 by timestamp, limit and host/outcome filters", async () => {
    const traces = Array.from({ length: 25 }, (_, i) => trace(i));
    at(traces, 24).agent = "claude-code";
    at(traces, 24).outcome = "partial";
    const result = await listTraces(dataset(traces));
    expect(result.traces).toHaveLength(20);
    expect(result.traces[0]?.traceId).toBe(traces[24]?.traceId);
    expect((await listTraces(dataset(traces), {}, 1)).traces).toHaveLength(1);
    expect(
      (
        await listTraces(dataset(traces), {
          agent: "claude-code",
          outcome: "partial",
        })
      ).traces,
    ).toHaveLength(1);
    expect(
      (await listTraces(dataset(traces), { outcome: "failed" })).traces,
    ).toHaveLength(0);
  });
  it("uses stable UUID ordering for timestamp ties", async () => {
    const a = trace(1),
      b = trace(2);
    b.timestamp = a.timestamp;
    expect(
      (await listTraces(dataset([b, a]))).traces.map((t) => t.traceId),
    ).toEqual([a.traceId, b.traceId]);
  });
  it.each([0, -1, 1.1, 1001, Number.NaN])(
    "rejects invalid list limit %s",
    async (limit) => {
      await expect(listTraces(dataset([]), {}, limit)).rejects.toThrow();
    },
  );
  it("filters inclusive since-through-now and excludes future only for time windows", async () => {
    const traces = [trace(0), trace(1), trace(2), trace(3)];
    const filter = {
      sinceMs: Date.parse(at(traces, 1).timestamp),
      nowMs: Date.parse(at(traces, 2).timestamp),
    };
    expect((await summarizeTraces(dataset(traces), filter)).matchedTraces).toBe(
      2,
    );
    expect(
      (await listTraces(dataset(traces), filter)).traces.map((t) => t.traceId),
    ).toEqual([at(traces, 2).traceId, at(traces, 1).traceId]);
    expect((await summarizeTraces(dataset(traces))).matchedTraces).toBe(4);
  });
  it.each(["1h", "24h", "7d", "30d"])("accepts duration %s", (value) => {
    expect(parseSince(value, 0)).toBeLessThan(0);
  });
  it.each(["0h", "-1d", "2m", "1.5h", "yesterday", "99999999999999999d"])(
    "rejects duration %s",
    (value) => {
      expect(() => parseSince(value, 0)).toThrow();
    },
  );
  it("shows an exact UUID and omits every correlation/prompt field", async () => {
    const a = trace();
    a.prompt = { storage: "raw", raw: "PRIVATE_RAW_PROMPT_SENTINEL" };
    const result = await showTrace(dataset([a]), a.traceId);
    expect(result.trace).toMatchObject({
      traceId: a.traceId,
      promptStorage: "raw",
      policy: a.policy,
      catalog: a.catalog,
    });
    expect(Object.keys(result.trace)).toEqual([
      "traceId",
      "timestamp",
      "agent",
      "outcome",
      "provider",
      "model",
      "selectedCount",
      "latencyMs",
      "schemaVersion",
      "mode",
      "promptStorage",
      "policy",
      "catalog",
      "decisions",
      "diagnostics",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_RAW|sessionKey|promptKey|skillId|"host"|"prompt"/,
    );
    expect(result.trace.diagnostics).toEqual([
      { code: "fixture_warning", level: "warning" },
    ]);
  });
  it("rejects prefix/unknown IDs and duplicate UUIDs as corruption", async () => {
    const a = trace();
    await expect(
      showTrace(dataset([a]), a.traceId.slice(0, 8)),
    ).rejects.toThrow("complete UUID");
    await expect(showTrace(dataset([a]), trace(1).traceId)).rejects.toThrow(
      "not found",
    );
    await expect(showTrace(dataset([a, a]), a.traceId)).rejects.toThrow(
      "Duplicate",
    );
  });
});

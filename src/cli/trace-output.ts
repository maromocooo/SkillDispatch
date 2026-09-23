import type {
  listTraces,
  showTrace,
  TraceSummary,
} from "../telemetry/analytics.js";
import type { TerminalContext } from "./output.js";
import { TextRenderer } from "./table.js";

type TraceList = Awaited<ReturnType<typeof listTraces>>;
type TraceDetail = Awaited<ReturnType<typeof showTrace>>;
const number = (value: number | null) =>
  value === null ? "n/a" : value.toFixed(2);
const latency = (value: number | null) =>
  value === null ? "n/a" : `${number(value)} ms`;
const utc = (timestamp: string) =>
  new Date(timestamp).toISOString().replace("T", " ").replace(/Z$/, "");
const yes = (value: boolean) => (value ? "yes" : "no");

/** These inputs are existing privacy-safe views, never raw traces/events. */
export function renderTraceList(
  result: TraceList,
  terminal?: TerminalContext,
): string {
  const out = new TextRenderer(terminal);
  out.section("Traces");
  if (!result.traces.length) out.text("No matching traces.");
  out.table(
    [
      { label: "Trace ID" },
      { label: "Time (UTC)" },
      { label: "Agent" },
      { label: "Outcome" },
      { label: "Mode" },
      { label: "Selected", numeric: true },
      { label: "Latency", numeric: true },
    ],
    result.traces.map((t) => [
      t.traceId,
      utc(t.timestamp),
      t.agent,
      t.outcome.toUpperCase(),
      t.mode,
      t.selectedCount,
      latency(t.latencyMs),
    ]),
    "Trace",
  );
  out.text("");
  out.text(
    `Showing ${result.traces.length} of ${result.matchedTraces} matching traces; invalid lines: ${result.invalidLines}`,
  );
  return out.finish();
}

export function renderTraceDetail(
  result: TraceDetail,
  terminal?: TerminalContext,
): string {
  const t = result.trace,
    out = new TextRenderer(terminal);
  out.section(`Trace ${t.traceId}`, true);
  out.facts([["Time (UTC)", utc(t.timestamp)]]);
  out.facts([
    ["Agent", t.agent],
    ["Mode", t.mode],
    ["Outcome", t.outcome.toUpperCase()],
  ]);
  out.facts([
    ["Provider", t.provider],
    ...(t.model ? [["Model", t.model] as const] : []),
  ]);
  out.facts([
    ["Router latency", latency(t.latencyMs)],
    ["Threshold", t.policy.threshold],
    ["Max skills", t.policy.maxSkills],
  ]);
  out.facts([["Catalog fingerprint", t.catalog.fingerprint.slice(0, 12)]]);

  out.section("Recommendation summary");
  out.facts([
    ["Recommended", t.selectedCount],
    ["Injected", t.injectedCount],
  ]);
  if (!t.selectedCount) out.text("No skill recommendation selected.");
  out.text(
    "Recommendation, injection and observed invocation are separate events.",
  );
  out.section("Skill decisions");
  if (!t.decisions.length) out.text("No skill decisions recorded.");
  out.table(
    [
      { label: "Skill" },
      { label: "Agent" },
      { label: "Scope" },
      { label: "Score", numeric: true },
      { label: "Recommended" },
      { label: "Injected" },
    ],
    t.decisions.map((d) => [
      d.name,
      d.agent,
      d.scope,
      d.probability.toFixed(4),
      yes(d.selected),
      yes(d.injected),
    ]),
  );

  if (result.instructionReads) {
    const reads = result.instructionReads;
    out.section("Codex instruction-read evidence");
    out.facts([
      [
        "Observer",
        reads.observerConfigured ? "configured / best-effort" : "unavailable",
      ],
      ["Stream", reads.streamReadable ? "readable" : "unavailable"],
      ["Correlation", reads.correlationAvailable ? "possible" : "unavailable"],
    ]);
    if (!reads.calls.length)
      out.text("No skill instruction-read event observed.");
    out.table(
      [
        { label: "Skill" },
        { label: "Read attempt" },
        { label: "Terminal event" },
        { label: "Outcome" },
        { label: "Context" },
      ],
      reads.calls.map((c) => [
        c.name,
        yes(c.attemptObserved),
        c.terminalWithoutAttempt ? "without attempt" : yes(c.terminalObserved),
        c.outcome,
        c.executionContext,
      ]),
    );
    out.text(
      "Read requests are not native invocation or proof of loading. Terminal success and task quality are unknown.",
    );
  }
  if (t.agent === "claude-code") {
    out.section("Model skill invocations observed:");
    const inv = result.modelInvocations;
    out.facts([
      [
        "Invocation observer",
        inv
          ? inv.observerConfigured
            ? "configured / best-effort"
            : "not configured / telemetry unavailable"
          : "unavailable",
      ],
    ]);
    out.facts([
      ["Invocation stream", inv?.streamReadable ? "readable" : "unavailable"],
      ["Correlation", inv?.correlationAvailable ? "possible" : "unavailable"],
    ]);
    if (!inv?.calls.length)
      out.text("No model skill invocation event observed.");
    else
      out.table(
        [
          { label: "Skill" },
          { label: "Attempt observed" },
          { label: "Terminal outcome" },
          { label: "Context" },
          { label: "Resolution" },
        ],
        inv.calls.map((call) => [
          call.nativeInvocationName,
          yes(call.attempted),
          call.diagnosticCode
            ? `${call.outcome} (${call.diagnosticCode})`
            : call.outcome,
          call.executionContext,
          call.resolved ? "resolved" : "unresolved",
        ]),
      );
    out.text("Missing events do not prove non-invocation or failure.");
  }
  if (!t.diagnostics.length) {
    out.section("Diagnostics: none");
  } else {
    out.section("Diagnostics");
    out.table(
      [{ label: "Code" }, { label: "Level" }],
      t.diagnostics.map((d) => [d.code, d.level]),
    );
  }
  return out.finish();
}

export function renderTraceSummary(
  s: TraceSummary,
  terminal?: TerminalContext,
): string {
  const out = new TextRenderer(terminal);
  out.section("Overview");
  out.facts([["Matching traces", s.matchedTraces]]);
  out.text("Trace file (all records, before filters):");
  out.facts([
    ["Total lines", s.totalLines],
    ["Valid traces", s.validTraces],
    ["Invalid lines", s.invalidLines],
  ]);
  if (!s.matchedTraces) out.text("No matching traces.");

  out.section("Routing outcomes and latency (matching traces)");
  out.facts([
    ["Complete", s.outcomes.complete],
    ["Partial", s.outcomes.partial],
    ["Failed", s.outcomes.failed],
  ]);
  out.facts([
    ["Average selected skills", number(s.averageSelectedSkills)],
    ["P50 latency", latency(s.p50LatencyMs)],
    ["P95 latency", latency(s.p95LatencyMs)],
  ]);
  out.facts([
    ["Codex", s.agents.codex],
    ["Claude Code", s.agents["claude-code"]],
  ]);
  out.facts([
    ["Shadow", s.modes.shadow],
    ["Advisory", s.modes.advisory],
  ]);
  out.facts([
    ["Advisory recommendations", s.advisory.recommendedCount],
    ["Injected", s.advisory.injectedCount],
  ]);
  out.table(
    [{ label: "Provider" }, { label: "Traces", numeric: true }],
    s.providers.map((p) => [p.provider, p.count]),
  );
  out.facts([["Distinct catalog fingerprints", s.distinctCatalogFingerprints]]);

  const f = s.advisoryFunnel;
  if (f) {
    out.section("Observed adoption (matching Claude advisory traces)");
    out.text("Route-skill pairs from observer-configured traces:");
    out.facts([
      ["Recommended", f.recommended],
      ["Injected", f.injected],
    ]);
    out.facts([
      ["Observed model-invoked", f.observedModelInvoked],
      ["Observed succeeded", f.observedSucceeded],
    ]);
    out.facts([["Observer-configured traces", f.telemetryConfiguredTraces]]);
    out.facts([
      [
        "Observer-unavailable traces (not configured)",
        f.telemetryUnconfiguredTraces,
      ],
    ]);
    out.facts([
      ["Configured traces without usable correlation", f.uncorrelatableTraces],
    ]);
    out.facts([
      [
        "Injected pairs with no observed model invocation",
        f.injectedPairsWithoutObservedInvocation,
      ],
    ]);
  }

  if (s.instructionReads) {
    const r = s.instructionReads;
    out.section("Codex instruction-read evidence (matching route-skill pairs)");
    out.facts([
      ["Recommended", r.recommended],
      ["Emitted", r.emitted],
      ["Observed read attempts", r.observedInstructionReadAttemptPairs],
      ["Observed terminal events", r.observedTerminalEventPairs],
    ]);
    out.facts([
      ["Observer-configured traces", r.observerConfiguredTraces],
      ["Observer-unavailable traces", r.observerUnavailableTraces],
    ]);
    out.text(
      "No native invocation inferred. Terminal success and complete loading are unconfirmed; missing events remain unknown.",
    );
  }
  out.section("Skill versions (matching trace decisions)");
  out.facts([
    ["Skills seen", s.skillsSeen],
    ["Ever selected", s.skillsEverSelected],
    ["Never selected", s.skillsNeverSelected],
  ]);
  if (!s.skillStatistics.length) out.text("No skill versions observed.");
  else {
    out.text("Top selected skill versions (up to 20):");
    out.table(
      [
        { label: "Name" },
        { label: "Agent" },
        { label: "Scope" },
        { label: "Version" },
        { label: "Seen", numeric: true },
        { label: "Selected", numeric: true },
        { label: "Selection rate", numeric: true },
      ],
      s.skillStatistics
        .slice(0, 20)
        .map((skill) => [
          skill.name,
          skill.agent,
          skill.scope,
          skill.contentHash.slice(0, 12),
          skill.seen,
          skill.selected,
          `${(skill.selectionRate * 100).toFixed(1)}%`,
        ]),
    );
  }

  out.section("Stream health / limitations");
  const h = s.invocationHealth;
  if (h) {
    out.text("Invocation stream (all events, not filtered by route query):");
    out.facts([
      ["Stream", h.available ? "readable" : "unavailable"],
      ["Valid events", h.validEvents],
      ["Invalid lines", h.invalidLines],
    ]);
    out.facts([
      ["Attempted-only (unknown)", h.attemptedOnly],
      ["Unresolved model invocations", h.unresolved],
    ]);
  }
  out.text(
    "Selection rate = recommendations / observed decisions for a skill version.",
  );
  out.text("Never selected refers only to observed skill versions.");
  out.text(
    "Async observers provide positive evidence only; missing events remain unknown.",
  );
  out.text("Exact conversion percentages are not reported.");
  if (s.instructionReadHealth) {
    const h = s.instructionReadHealth;
    out.section("Codex instruction stream health (whole file)");
    out.facts([
      ["Valid events", h.validEvents],
      ["Invalid lines", h.invalidLines],
      ["Unsupported versions", h.unsupportedVersions],
      ["Duplicates", h.duplicates],
      ["Attempted only", h.attemptedOnly],
      ["Terminal without attempt", h.terminalWithoutAttempt],
      ["Unresolved", h.unresolved],
      ["Conflicting", h.conflicting],
    ]);
  }
  if (s.unsupportedVersions)
    out.facts([["Unsupported route versions", s.unsupportedVersions]]);
  return out.finish();
}

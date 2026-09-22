import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import type { TerminalContext } from "../../src/cli/output.js";
import { terminalText } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import { TextRenderer } from "../../src/cli/table.js";
import {
  renderTraceDetail,
  renderTraceList,
  renderTraceSummary,
} from "../../src/cli/trace-output.js";
import { invocationSchema } from "../../src/observability/invocation-types.js";
import { routeTraceSchema } from "../../src/telemetry/types.js";
import { workspace } from "../helpers.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/trace-display/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
// Golden JSON captured from the unmodified release CLI using this synthetic dataset.
const list = fixture("expected-list") as Parameters<typeof renderTraceList>[0];
const detail = fixture("expected-show") as Parameters<
  typeof renderTraceDetail
>[0];
const zero = fixture("expected-zero") as Parameters<
  typeof renderTraceDetail
>[0];
const summary = fixture("expected-summary") as Parameters<
  typeof renderTraceSummary
>[0];
const dataset = fixture("dataset");
const terminal = (columns: number): TerminalContext => ({
  isTTY: true,
  columns,
});
const lines = (text: string) => text.trimEnd().split("\n");
const separators = (line: string) =>
  [...line.matchAll(/\|/g)].map((m) => stringWidth(line.slice(0, m.index)));
function bounded(text: string, width: number) {
  expect(text.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  for (const line of lines(text))
    expect(stringWidth(line), line).toBeLessThanOrEqual(width);
}

describe("responsive trace presentation", () => {
  it("does not insert newlines inside copyable UUIDs on very small terminals", () => {
    for (const width of [20, 40]) {
      for (const t of list.traces)
        expect(renderTraceList(list, terminal(width))).toContain(t.traceId);
      expect(renderTraceDetail(detail, terminal(width))).toContain(
        detail.trace.traceId,
      );
    }
  });
  it.each([80, 100, 120, 160])(
    "keeps every field and full UUID within %i columns",
    (width) => {
      const output = renderTraceList(list, terminal(width));
      bounded(output, width);
      for (const t of list.traces) {
        expect(output).toContain(t.traceId);
        expect(output).toContain(t.outcome.toUpperCase());
        expect(output).toContain(t.latencyMs.toFixed(2));
      }
      for (const field of [
        "UTC",
        "Agent",
        "Outcome",
        "Mode",
        "Selected",
        "Latency",
        "ms",
        "Showing 4 of 4 matching traces; invalid lines: 1",
      ])
        expect(output).toContain(field);
      expect(output.indexOf(list.traces[0]?.traceId ?? "")).toBeLessThan(
        output.indexOf(list.traces[3]?.traceId ?? ""),
      );
      if (width === 160) {
        const table = lines(output).filter((line) => line.includes(" | "));
        expect(table).toHaveLength(5);
        for (const row of table.slice(1))
          expect(separators(row)).toEqual(separators(table[0] ?? ""));
        expect(table[4]).toMatch(/\|\s+2\s+\|\s+842\.48 ms$/);
      } else expect(output).toContain(`Trace ${list.traces[0]?.traceId}`);
    },
  );
  it("right aligns numbers and measures CJK/combining text after sanitization", () => {
    const out = new TextRenderer(terminal(80));
    out.table(
      [
        { label: "Skill" },
        { label: "Count", numeric: true },
        { label: "Score", numeric: true },
      ],
      [
        ["日本語", 1, "0.9000"],
        ["cafe\u0301", 100, "0.8200"],
        ["a\u001b[2J", 2, "0.7500"],
      ],
    );
    const text = out.finish(),
      table = lines(text).filter((l) => l.includes(" | "));
    for (const row of table)
      expect(separators(row)).toEqual(separators(table[0] ?? ""));
    expect(table[1]).toMatch(/\|\s+1\s+\|/);
    expect(text).toContain("cafe\u0301");
    expect(text).toContain("a\\u001b[2J");
    bounded(text, 80);
  });
  it("preserves long identifiers and graphemes in hanging-indent cards", () => {
    const name = "日本語e\u0301".repeat(35);
    const view = structuredClone(detail);
    required(view.trace.decisions[0]).name = name;
    const text = renderTraceDetail(view, terminal(80));
    const block =
      text
        .split("Skill decisions\n")[1]
        ?.split("Model skill invocations observed:")[0] ?? "";
    const parts =
      block.slice(block.indexOf("Skill") + 5).split(/\n\s*Agent\s*:/)[0] ?? "";
    expect(
      parts
        .replace(/^\s*:\s*/, "")
        .split("\n")
        .map((s) => s.trim())
        .join(""),
    ).toBe(name);
    for (const line of lines(text))
      expect(line.trimStart()).not.toMatch(/^\p{M}/u);
    bounded(text, 80);
  });
  it.each([undefined, Number.NaN, 0, -1, 19, 501, 100.5])(
    "uses deterministic fallback for invalid width %s",
    (columns) => {
      expect(new TextRenderer({ isTTY: true, columns }).width).toBe(100);
    },
  );
  it.each([
    { isTTY: false, columns: 160 },
    { isTTY: true, columns: 160, noColor: true },
    { isTTY: true, columns: 160, term: "dumb" },
  ])("supports terminal context %j without ANSI or raw tabs", (context) => {
    const text = renderTraceList(list, context);
    bounded(text, context.isTTY ? 160 : 100);
    if (!context.isTTY || context.term === "dumb")
      expect(text).toContain("Trace 00000000");
    if (context.term === "dumb") expect(text).not.toMatch(/^-+$/m);
  });
  it("has a clear empty list and retains counts", () => {
    const text = renderTraceList(
      { ...list, traces: [], matchedTraces: 0 },
      terminal(160),
    );
    expect(text).toContain("No matching traces.");
    expect(text).toContain("Showing 0 of 0 matching traces; invalid lines: 1");
  });
  it.each([80, 100, 120, 160])(
    "organizes details and summary at %i columns",
    (width) => {
      const text = renderTraceDetail(detail, terminal(width));
      bounded(text, width);
      const sections = [
        "Trace ",
        "Recommendation summary",
        "Skill decisions",
        "Model skill invocations observed:",
        "Diagnostics: none",
      ];
      const positions = sections.map((s) => text.indexOf(s));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      for (const value of [
        "Recommended: 2",
        "Injected: 1",
        "0.9400",
        "0.8200",
        "0.2200",
        "succeeded",
        "resolved",
        "842.48 ms",
        "Threshold: 0.75",
        "Max skills: 4",
      ])
        expect(text).toContain(value);
      const decisions = lines(text).filter(
        (l) =>
          l.includes(" | ") &&
          ["react-review", "cafe\u0301-testing", "日本語レビュー"].some((s) =>
            l.includes(s),
          ),
      );
      if (decisions.length) {
        expect(decisions[0]).toMatch(/yes\s+\| yes/);
        expect(decisions[1]).toMatch(/yes\s+\| no/);
        expect(decisions[2]).toMatch(/no\s+\| no/);
      }
      const stats = renderTraceSummary(summary, terminal(width));
      bounded(stats, width);
      for (const title of [
        "Overview",
        "Routing outcomes and latency",
        "Observed adoption",
        "Skill versions",
        "Stream health / limitations",
      ])
        expect(stats).toContain(title);
      expect(stats).toContain("Matching traces: 4");
      expect(stats).toContain("Total lines: 5");
      expect(stats).toContain("Valid traces: 4");
      expect(stats).toContain("Valid events: 2");
      expect(stats).toContain("Selection rate");
      expect(stats).toContain("Observed model-invoked: 1");
      expect(stats).toContain("Observed succeeded: 1");
    },
  );
  it("explains zero recommendation without inferring failure or absence of relevant skills", () => {
    const text = renderTraceDetail(zero, terminal(100));
    for (const value of [
      "COMPLETE",
      "Recommended: 0",
      "Injected: 0",
      "No skill recommendation selected.",
      "No model skill invocation event observed.",
    ])
      expect(text).toContain(value);
    expect(text).not.toMatch(
      /not invoked|catalog is empty|no relevant skills|router fail/i,
    );
  });
  it.each(["partial", "failed"] as const)(
    "retains %s outcome and safe diagnostic code/level",
    (outcome) => {
      const view = structuredClone(zero);
      view.trace.outcome = outcome;
      view.trace.diagnostics = [{ code: "provider_partial", level: "warning" }];
      const text = renderTraceDetail(view, terminal(100));
      expect(text).toContain(outcome.toUpperCase());
      expect(text).toContain("provider_partial");
      expect(text).toContain("warning");
    },
  );
  it("keeps attempted-only, failed, terminal-without-attempt and conflict facts separate", () => {
    const view = structuredClone(detail);
    const inv = required(view.modelInvocations);
    const call = required(inv.calls[0]);
    inv.calls = [
      { ...call, outcome: "unknown" },
      { ...call, outcome: "failed" },
      { ...call, attempted: false, outcome: "succeeded", resolved: false },
      {
        ...call,
        outcome: "unknown",
        diagnosticCode: "conflicting_invocation_events",
      },
    ];
    const text = renderTraceDetail(view, terminal(160));
    expect(text).toContain("unknown");
    expect(text).toContain("failed");
    expect(text).toContain("unresolved");
    expect(text).toContain("conflicting_invocation_events");
    expect(text).toMatch(/no\s+\| succeeded/);
    expect(text).not.toMatch(/success rate|not invoked/i);
  });
  it.each([false, true])(
    "reports observer configured=%s independently of unavailable stream/correlation",
    (configured) => {
      const view = structuredClone(zero);
      view.modelInvocations = {
        observerConfigured: configured,
        streamReadable: false,
        correlationAvailable: false,
        calls: [],
      };
      const text = renderTraceDetail(view, terminal(100));
      expect(text).toContain(
        configured
          ? "configured / best-effort"
          : "not configured / telemetry unavailable",
      );
      expect(text).toContain("Invocation stream: unavailable");
      expect(text).toContain("Correlation: unavailable");
      expect(text).toContain("No model skill invocation event observed.");
    },
  );
  it("preserves top-20 order and null latency values without conversion estimates", () => {
    const s = structuredClone(summary);
    s.skillStatistics = Array.from({ length: 21 }, (_, i) => ({
      ...required(s.skillStatistics[0]),
      name: `skill-${String(i).padStart(2, "0")}`,
    }));
    s.averageSelectedSkills = null;
    s.p50LatencyMs = null;
    s.p95LatencyMs = null;
    const text = renderTraceSummary(s, terminal(160));
    expect(text).toContain("P50 latency: n/a");
    expect(text).toContain("Average selected skills: n/a");
    expect(text).toContain("skill-19");
    expect(text).not.toContain("skill-20");
    expect(text.indexOf("skill-00")).toBeLessThan(text.indexOf("skill-19"));
  });
  it("escapes untrusted control/format characters before computing width", () => {
    const bad = "危険\u001b[2J\n\r\t\u009b31m\u202eX";
    const view = structuredClone(detail);
    required(view.trace.decisions[0]).name = bad;
    view.trace.provider = bad;
    view.trace.model = bad;
    required(required(view.modelInvocations).calls[0]).nativeInvocationName =
      bad;
    const text = renderTraceDetail(view, terminal(160));
    expect(text).toContain(terminalText(bad));
    expect(text).not.toContain("\u202e");
    bounded(text, 160);
  });
});

describe("trace CLI protocol isolation", () => {
  async function setup() {
    const ctx = await workspace(),
      data = join(ctx.root, "data");
    await mkdir(data, { mode: 0o700 });
    const records = dataset.traces.map((t: unknown) =>
      routeTraceSchema.parse(t),
    );
    const events = dataset.events.map((e: unknown) =>
      invocationSchema.parse(e),
    );
    const traceText =
      records.map((t: unknown) => `${JSON.stringify(t)}\n`).join("") +
      "invalid synthetic line\n";
    await writeFile(join(data, "traces.jsonl"), traceText, { mode: 0o600 });
    await writeFile(
      join(data, "invocations.jsonl"),
      events.map((e: unknown) => `${JSON.stringify(e)}\n`).join(""),
      { mode: 0o600 },
    );
    return {
      ctx: {
        ...ctx,
        env: {
          SKILLDISPATCH_DATA_DIR: data,
          TYPESAFE_API_KEY: "PRIVATE_API_KEY_SENTINEL",
        },
      },
      data,
      traceText,
    };
  }
  it.each([80, 100, 120, 160])(
    "keeps JSON byte-for-byte equivalent to the baseline at %i columns",
    async (width) => {
      const f = await setup();
      for (const [name, args] of [
        ["list", ["list"]],
        ["summary", ["summary"]],
        ["show", ["show", detail.trace.traceId]],
        ["zero", ["show", zero.trace.traceId]],
      ] as const) {
        let stdout = "",
          stderr = "";
        await createProgram(f.ctx, {
          terminal: { ...terminal(width), noColor: true },
          stdout: (t) => {
            stdout += t;
          },
          stderr: (t) => {
            stderr += t;
          },
        }).parseAsync(["traces", ...args, "--json"], { from: "user" });
        expect(stderr).toBe("");
        expect(stdout).toBe(
          `${JSON.stringify(fixture(`expected-${name}`), null, 2)}\n`,
        );
      }
      expect(await readFile(join(f.data, "traces.jsonl"), "utf8")).toBe(
        f.traceText,
      );
    },
  );
  it("retains filtered counts separately from file totals and full invocation stream health", async () => {
    const f = await setup();
    let text = "";
    await createProgram(f.ctx, {
      terminal: terminal(100),
      stdout: (t) => {
        text += t;
      },
      stderr: () => {},
    }).parseAsync(["traces", "summary", "--agent", "codex"], { from: "user" });
    for (const fact of [
      "Matching traces: 0",
      "Total lines: 5",
      "Valid traces: 4",
      "Invalid lines: 1",
      "Valid events: 2",
      "Observed model-invoked: 0",
    ])
      expect(text).toContain(fact);
    expect(text).toContain("before filters");
    expect(text).toContain("all events, not filtered");
  });
  it.each([80, 160])(
    "does not leak private fields from traces/events at %i columns",
    async (width) => {
      const f = await setup();
      for (const args of [
        ["list"],
        ["summary"],
        ["show", detail.trace.traceId],
      ]) {
        let text = "";
        await createProgram(f.ctx, {
          terminal: terminal(width),
          stdout: (t) => {
            text += t;
          },
          stderr: () => {},
        }).parseAsync(["traces", ...args], { from: "user" });
        for (const secret of [
          "PRIVATE_",
          "sessionKey",
          "promptKey",
          "toolUseKey",
          ...dataset.traces.map(
            (t: { host: { promptKey: string } }) => t.host.promptKey,
          ),
          dataset.events[0].sessionKey,
          dataset.events[0].toolUseKey,
        ])
          expect(text).not.toContain(secret);
      }
    },
  );
});

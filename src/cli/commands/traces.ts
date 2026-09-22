import { readInvocationIndex } from "../../observability/invocation-analytics.js";
import { loadOperations } from "../../ops/context.js";
import {
  listTraces,
  parseSince,
  showTrace,
  summarizeTraces,
  type TraceFilter,
} from "../../telemetry/analytics.js";
import type { CliEnvironment } from "../context.js";
import type { CliIO } from "../output.js";

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
    else {
      const { renderTraceSummary } = await import("../trace-output.js");
      io.stdout(renderTraceSummary(result, io.terminal));
    }
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
      const { renderTraceList } = await import("../trace-output.js");
      io.stdout(renderTraceList(result, io.terminal));
    }
  } else {
    const result = await showTrace(
      context.reader,
      id ?? "",
      context.invocationReader,
    );
    if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const { renderTraceDetail } = await import("../trace-output.js");
      io.stdout(renderTraceDetail(result, io.terminal));
    }
  }
}

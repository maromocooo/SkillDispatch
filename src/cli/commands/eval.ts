import { resolve } from "node:path";
import { CommanderError } from "commander";
import { probabilitySchema } from "../../config/schema.js";
import { runEvaluation } from "../../eval/runner.js";
import { type EvalGates, loadEvalFile } from "../../eval/schema.js";
import type { EvalDiagnostic, EvalResult } from "../../eval/types.js";
import {
  type CliEnvironment,
  type CliOptions,
  routingForCommand,
} from "../context.js";
import { type CliIO, terminalText } from "../output.js";

interface EvalCliOptions extends CliOptions {
  minPrecision?: string;
  minRecall?: string;
}

export async function evalCommand(
  file: string,
  options: EvalCliOptions,
  environment: CliEnvironment,
  io: CliIO,
): Promise<void> {
  const gates: EvalGates = {};
  for (const [value, key, flag] of [
    [options.minPrecision, "min_precision", "--min-precision"],
    [options.minRecall, "min_recall", "--min-recall"],
  ] as const) {
    if (value === undefined) continue;
    const parsed = probabilitySchema.safeParse(
      value.trim() ? Number(value) : Number.NaN,
    );
    if (!parsed.success) throw new Error(`${flag} must be between 0 and 1.`);
    gates[key] = parsed.data;
  }
  const dataset = await loadEvalFile(resolve(environment.cwd, file));
  const { cwd, config, agent, catalog, provider } = await routingForCommand(
    options,
    environment,
  );
  const result = await runEvaluation(dataset, {
    cwd,
    agent,
    skills: catalog.skills,
    provider,
    policy: config.policy,
    timeoutMs: config.router.timeoutMs,
    gates,
    diagnostics: catalog.diagnostics,
  });
  if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else printEvaluation(result, io);
  if (!result.passed) {
    io.stderr("Evaluation quality gates were not met.\n");
    throw new CommanderError(
      2,
      "eval_gate_failed",
      "Evaluation quality gates were not met.",
    );
  }
}

const metric = (value: number | null) =>
  value === null ? "n/a" : value.toFixed(4);

function printEvaluation(result: EvalResult, io: CliIO): void {
  io.stdout(`Evaluation completed: ${result.metrics.caseCount} cases\n`);
  for (const item of result.cases) {
    io.stdout(
      `Case: ${terminalText(item.id)}\nProvider: ${terminalText(item.routing.provider)}${item.routing.provider === "mock" ? " (offline mock; not routing accuracy evidence)" : ""}\n`,
    );
    if (item.routing.model !== undefined)
      io.stdout(`Model: ${terminalText(item.routing.model)}\n`);
    for (const skill of item.selected)
      io.stdout(
        `  ${terminalText(skill.name)}\t${skill.agent}\t${skill.scope}\t${skill.probability.toFixed(4)}\n`,
      );
    if (!item.selected.length) io.stdout("  No skills selected.\n");
    io.stdout(
      `  TP ${item.truePositives.length} / FP ${item.falsePositives.length} / FN ${item.falseNegatives.length}; unlabeled ${item.unlabeledSelected.length}; exact ${item.exactMatch === null ? "n/a" : item.exactMatch}; ${item.latencyMs.toFixed(2)} ms\n`,
    );
    for (const [label, skills] of [
      ["FP", item.falsePositives],
      ["FN", item.falseNegatives],
    ] as const)
      for (const skill of skills)
        io.stdout(
          `  ${label}: ${terminalText(skill.name)} (${skill.agent}/${skill.scope})\n`,
        );
    printCodes(item.diagnostics, io);
  }
  const m = result.metrics;
  io.stdout(
    `Precision (labeled, micro): ${metric(m.precision)}\nRecall (micro): ${metric(m.recall)}\nF1 (micro): ${metric(m.f1)}\nFalse positives: ${m.falsePositives}\nFalse negatives: ${m.falseNegatives}\nExact-set accuracy (fully labeled only, ${m.fullyLabeledCaseCount} cases): ${metric(m.exactSetAccuracy)}\nAverage selected skills: ${metric(m.averageSelectedSkills)}\nP50 latency ms: ${metric(m.p50LatencyMs)}\nP95 latency ms: ${metric(m.p95LatencyMs)}\nProvider partial count: ${m.providerPartialCount}\nProvider failure count: ${m.providerFailureCount}\n`,
  );
  for (const gate of result.gates)
    io.stdout(
      `Gate ${gate.metric} >= ${gate.minimum}: ${gate.passed ? "PASS" : "FAIL"} (${metric(gate.actual)})\n`,
    );
  printCodes(result.diagnostics, io);
}

function printCodes(diagnostics: readonly EvalDiagnostic[], io: CliIO): void {
  for (const diagnostic of diagnostics)
    io.stderr(`${terminalText(diagnostic.code)}\n`);
}

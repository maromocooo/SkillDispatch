import { DEFAULT_POLICY, validatePolicy } from "../core/policy.js";
import { route } from "../core/route.js";
import type {
  AgentKind,
  Diagnostic,
  RoutingPolicy,
  SkillDescriptor,
} from "../core/types.js";
import type { RouterProvider } from "../providers/types.js";
import {
  aggregateMetrics,
  evalDiagnostics,
  evaluateGates,
  scoreCase,
} from "./metrics.js";
import { resolveEvalCases } from "./resolve.js";
import {
  type EvalDataset,
  type EvalGates,
  EvalInputError,
  evalGatesSchema,
  validateEvalDataset,
} from "./schema.js";
import type { EvalCaseResult, EvalResult } from "./types.js";

export interface EvaluationOptions {
  skills: readonly SkillDescriptor[];
  provider: RouterProvider;
  cwd: string;
  agent: AgentKind;
  policy?: RoutingPolicy;
  timeoutMs?: number;
  /** Overrides dataset gates field by field. */
  gates?: EvalGates;
  diagnostics?: readonly Diagnostic[];
}

/** One catalog snapshot, preflight all labels, then route cases in file order. */
export async function runEvaluation(
  dataset: EvalDataset,
  options: EvaluationOptions,
): Promise<EvalResult> {
  const validated = validateEvalDataset(dataset);
  // Freeze the evaluated catalog's routing fields against caller mutation between cases.
  const skills = options.skills.map((skill) => ({ ...skill }));
  const resolved = resolveEvalCases(validated, skills);
  const parsedGates = evalGatesSchema.safeParse({
    ...validated.gates,
    ...options.gates,
  });
  if (!parsedGates.success) throw new EvalInputError("invalid_eval_input");
  const policy = { ...(options.policy ?? DEFAULT_POLICY) };
  validatePolicy(policy);
  const cases: EvalCaseResult[] = [];
  for (const item of resolved) {
    const result = await route(
      {
        prompt: item.prompt,
        cwd: options.cwd,
        agent: options.agent,
        skills,
      },
      options.provider,
      policy,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
    cases.push(scoreCase(item, result, skills));
  }
  const metrics = aggregateMetrics(cases);
  const gates = evaluateGates(metrics, parsedGates.data);
  return {
    version: 1,
    policy,
    cases,
    metrics,
    gates,
    passed: gates.every((gate) => gate.passed),
    diagnostics: evalDiagnostics(options.diagnostics ?? []),
  };
}

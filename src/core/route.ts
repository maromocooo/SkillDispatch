import { z } from "zod";
import type {
  ProviderRouteOutput,
  RouterProvider,
} from "../providers/types.js";
import { compareText } from "./order.js";
import { applyPolicy, DEFAULT_POLICY, validatePolicy } from "./policy.js";
import type {
  Diagnostic,
  RouteRequest,
  RouteResult,
  RoutingPolicy,
} from "./types.js";

const outputSchema = z.object({
  completeness: z.enum(["complete", "partial"]),
  failedSkillIds: z.array(z.string()).optional(),
  diagnostics: z
    .array(
      z.object({
        code: z.string().min(1),
        level: z.enum(["info", "warning", "error"]),
        message: z.string().min(1),
        skillIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  decisions: z.array(
    z.object({
      skillId: z.string(),
      probability: z.number().min(0).max(1),
      reasonCode: z.string().optional(),
    }),
  ),
  model: z.string().optional(),
});

export async function route(
  request: RouteRequest,
  provider: RouterProvider,
  policy: RoutingPolicy = DEFAULT_POLICY,
  options: { timeoutMs?: number } = {},
): Promise<RouteResult> {
  validatePolicy(policy);
  const timeoutMs = options.timeoutMs ?? 2500;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    throw new RangeError("timeoutMs must be a positive 32-bit integer.");
  const started = performance.now();
  const result: RouteResult = {
    selected: [],
    allDecisions: [],
    router: { provider: provider.name, latencyMs: 0 },
    policy: { ...policy },
    diagnostics: [],
  };
  const candidates = request.skills
    .filter((skill) => skill.enabled)
    .map(({ id, name, description, scope, agent }) => ({
      id,
      name,
      description,
      scope,
      agent,
    }))
    .sort((a, b) => compareText(a.id, b.id));
  if (!candidates.length) return result;
  const names = new Map(
    candidates.map((candidate) => [candidate.id, candidate.name]),
  );
  if (names.size !== candidates.length)
    throw new Error("Route catalog contains duplicate skill IDs.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    let output: ProviderRouteOutput;
    try {
      output = await Promise.race([
        Promise.resolve().then(() =>
          provider.judge({
            prompt: request.prompt,
            cwd: request.cwd,
            agent: request.agent,
            candidates,
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("Timeout"));
          }, timeoutMs);
        }),
      ]);
    } catch {
      result.diagnostics.push({
        code: timedOut ? "provider_timeout" : "provider_failed",
        level: "warning",
        message: "Routing unavailable; continue without recommendations.",
      });
      return result;
    }
    const parsed = outputSchema.safeParse(output);
    if (!parsed.success || !hasValidCoverage(parsed.data, names)) {
      result.diagnostics.push({
        code: "invalid_provider_response",
        level: "warning",
        message:
          "Provider result violates the routing contract; continue without recommendations.",
      });
      return result;
    }
    const scored = parsed.data.decisions.map((decision) => ({
      skillId: decision.skillId,
      name: names.get(decision.skillId) ?? "",
      probability: decision.probability,
      ...(decision.reasonCode === undefined
        ? {}
        : { reasonCode: decision.reasonCode }),
    }));
    Object.assign(result, applyPolicy(scored, policy));
    if (parsed.data.completeness === "partial") {
      result.diagnostics.push({
        code: "provider_partial",
        level: "warning",
        message:
          "Provider result is partial; listed skills were not evaluated. Recommendations use successful decisions only.",
        skillIds: [...(parsed.data.failedSkillIds ?? [])].sort(compareText),
      });
    }
    const providerDiagnostics: Diagnostic[] = (
      parsed.data.diagnostics ?? []
    ).map((diagnostic) => ({
      code: diagnostic.code,
      level: diagnostic.level,
      message: diagnostic.message,
      ...(diagnostic.skillIds === undefined
        ? {}
        : { skillIds: [...diagnostic.skillIds].sort(compareText) }),
    }));
    const diagnosticKey = (diagnostic: Diagnostic) =>
      JSON.stringify([
        diagnostic.code,
        diagnostic.level,
        diagnostic.message,
        diagnostic.skillIds ?? null,
      ]);
    providerDiagnostics.sort((a, b) =>
      compareText(diagnosticKey(a), diagnosticKey(b)),
    );
    result.diagnostics.push(...providerDiagnostics);
    if (parsed.data.model !== undefined)
      result.router.model = parsed.data.model;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    result.router.latencyMs = Math.max(0, performance.now() - started);
  }
}

/** Successful and failed IDs must partition the eligible input catalog exactly. */
function hasValidCoverage(
  output: z.infer<typeof outputSchema>,
  candidates: ReadonlyMap<string, string>,
): boolean {
  const failedIds = output.failedSkillIds ?? [];
  if (
    output.completeness === "complete"
      ? failedIds.length !== 0
      : failedIds.length === 0
  )
    return false;
  const accountedFor = new Set<string>();
  for (const id of [
    ...output.decisions.map((decision) => decision.skillId),
    ...failedIds,
  ]) {
    if (!candidates.has(id) || accountedFor.has(id)) return false;
    accountedFor.add(id);
  }
  if (accountedFor.size !== candidates.size) return false;
  return (output.diagnostics ?? []).every((diagnostic) => {
    const ids = diagnostic.skillIds ?? [];
    return (
      new Set(ids).size === ids.length && ids.every((id) => candidates.has(id))
    );
  });
}

import { z } from "zod";
import type {
  ProviderRouteOutput,
  RouterProvider,
} from "../providers/types.js";
import { compareText } from "./order.js";
import { applyPolicy, DEFAULT_POLICY, validatePolicy } from "./policy.js";
import type { RouteRequest, RouteResult, RoutingPolicy } from "./types.js";

const outputSchema = z.object({
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
    .map(({ id, name, description, scope }) => ({
      id,
      name,
      description,
      scope,
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
    if (
      !parsed.success ||
      parsed.data.decisions.length !== candidates.length ||
      new Set(parsed.data.decisions.map((d) => d.skillId)).size !==
        candidates.length ||
      parsed.data.decisions.some((d) => !names.has(d.skillId))
    ) {
      result.diagnostics.push({
        code: "invalid_provider_response",
        level: "warning",
        message:
          "Provider must return one valid probability per candidate; continue without recommendations.",
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
    if (parsed.data.model !== undefined)
      result.router.model = parsed.data.model;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    result.router.latencyMs = Math.max(0, performance.now() - started);
  }
}

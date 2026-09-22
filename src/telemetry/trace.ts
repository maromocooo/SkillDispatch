import { randomUUID } from "node:crypto";
import { compareText } from "../core/order.js";
import type {
  Diagnostic,
  RouteResult,
  SkillDescriptor,
} from "../core/types.js";
import { catalogFingerprint } from "./fingerprint.js";
import { keyedHash, privatePrompt } from "./privacy.js";
import {
  diagnosticCodeSchema,
  digestSchema,
  type PromptStorage,
  type RouteTrace,
  routeTraceSchema,
  safeModelSchema,
} from "./types.js";

export interface TraceInput {
  agent: RouteTrace["agent"];
  mode?: RouteTrace["mode"];
  delivery?: RouteTrace["delivery"];
  prompt: string;
  sessionId: string;
  promptCorrelationId?: string;
  hostModel?: string;
  skills: readonly SkillDescriptor[];
  result: RouteResult;
  diagnostics?: readonly Diagnostic[];
  promptStorage?: PromptStorage;
  key: Uint8Array;
}

/** Explicit allowlist projection. Never spread a host payload or domain diagnostic. */
export function createRouteTrace(input: TraceInput): RouteTrace {
  const { result, skills, agent, key } = input;
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const diagnostics = [...(input.diagnostics ?? []), ...result.diagnostics]
    .map((item) => ({
      code: diagnosticCodeSchema.safeParse(item.code).success
        ? item.code
        : "invalid_diagnostic_code",
      level: item.level,
      ...(item.skillIds === undefined
        ? {}
        : {
            skillIds: [
              ...new Set(
                item.skillIds.filter(
                  (id) => byId.has(id) && digestSchema.safeParse(id).success,
                ),
              ),
            ].sort(compareText),
          }),
    }))
    .sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  const hostModel = safeModelSchema.safeParse(input.hostModel);
  const routerModel = safeModelSchema.safeParse(result.router.model);
  return routeTraceSchema.parse({
    schemaVersion: "1.0",
    traceId: randomUUID(),
    timestamp: new Date().toISOString(),
    agent,
    mode: input.mode ?? "shadow",
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    prompt: privatePrompt(input.prompt, input.promptStorage ?? "hash", key),
    host: {
      event: "UserPromptSubmit",
      sessionKey: keyedHash(key, "session", `${agent}\0${input.sessionId}`),
      ...(input.promptCorrelationId === undefined
        ? {}
        : {
            promptKey: keyedHash(
              key,
              "host-prompt",
              `${agent}\0${input.promptCorrelationId}`,
            ),
          }),
      ...(hostModel.success ? { model: hostModel.data } : {}),
    },
    catalog: {
      fingerprint: catalogFingerprint(skills),
      skillCount: skills.length,
      enabledSkillCount: skills.filter((skill) => skill.enabled).length,
    },
    router: {
      provider: result.router.provider,
      latencyMs: result.router.latencyMs,
      ...(routerModel.success ? { model: routerModel.data } : {}),
    },
    policy: {
      threshold: result.policy.threshold,
      maxSkills: result.policy.maxSkills,
    },
    outcome: routingOutcome(result),
    decisions: result.allDecisions.map((decision) => {
      const skill = byId.get(decision.skillId);
      if (!skill) throw new Error("Invalid trace catalog.");
      return {
        skillId: skill.id,
        name: skill.name,
        agent: skill.agent,
        scope: skill.scope,
        contentHash: skill.contentHash,
        probability: decision.probability,
        selected: decision.selected,
      };
    }),
    diagnostics,
  });
}

/** Outcome is based on routing, independently of recommendation delivery. */
export function routingOutcome(result: RouteResult): RouteTrace["outcome"] {
  const codes = new Set(result.diagnostics.map((d) => d.code));
  if (
    [
      "provider_failed",
      "provider_timeout",
      "invalid_provider_response",
      "provider_setup_failed",
      "hook_runtime_failed",
    ].some((code) => codes.has(code))
  )
    return "failed";
  return codes.has("provider_partial") ? "partial" : "complete";
}

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
  prompt: string;
  sessionId: string;
  turnId?: string;
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
  const codes = new Set(diagnostics.map((item) => item.code));
  const failed = [
    "provider_failed",
    "provider_timeout",
    "invalid_provider_response",
    "provider_setup_failed",
    "hook_runtime_failed",
  ].some((code) => codes.has(code));
  const hostModel = safeModelSchema.safeParse(input.hostModel);
  const routerModel = safeModelSchema.safeParse(result.router.model);
  return routeTraceSchema.parse({
    schemaVersion: "1.0",
    traceId: randomUUID(),
    timestamp: new Date().toISOString(),
    agent,
    mode: "shadow",
    prompt: privatePrompt(input.prompt, input.promptStorage ?? "hash", key),
    host: {
      event: "UserPromptSubmit",
      sessionKey: keyedHash(key, "session", `${agent}\0${input.sessionId}`),
      ...(input.turnId === undefined
        ? {}
        : { turnKey: keyedHash(key, "turn", `${agent}\0${input.turnId}`) }),
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
    outcome: failed
      ? "failed"
      : codes.has("provider_partial")
        ? "partial"
        : "complete",
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

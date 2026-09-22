import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { route } from "../core/route.js";
import type { RouteResult } from "../core/types.js";
import { invocationPath } from "../observability/invocation-storage.js";
import type { RouterProvider } from "../providers/types.js";
import {
  createProvider,
  loadRuntimeContext,
  type RuntimeEnvironment,
} from "../runtime/context.js";
import { JsonlTraceSink } from "../telemetry/jsonl.js";
import { assertTraceDestination } from "../telemetry/reader.js";
import {
  dataDirectory,
  installationKey,
  tracePath,
} from "../telemetry/storage.js";
import { createRouteTrace, routingOutcome } from "../telemetry/trace.js";
import type { TraceSink } from "../telemetry/types.js";
import { buildClaudeAdvisory } from "./advisory.js";
import type { HookInput } from "./types.js";

interface HookServices {
  loadContext: typeof loadRuntimeContext;
  createProvider: typeof createProvider;
  getKey: typeof installationKey;
  makeSink: (path: string) => TraceSink;
  canAdvise: () => Promise<boolean>;
  invocationObserverConfigured: () => Promise<boolean>;
  buildAdvisory: typeof buildClaudeAdvisory;
}

/** Shared fail-open runtime. Only explicit, safely registered Claude advisory may return JSON. */
export async function runHook(
  input: HookInput,
  environment: RuntimeEnvironment,
  overrides: Partial<HookServices> = {},
): Promise<string | undefined> {
  try {
    if (!input.prompt.trim()) return; // No text available, including attachment-only turns.
    const services: HookServices = {
      loadContext: loadRuntimeContext,
      createProvider,
      getKey: installationKey,
      makeSink: (path) => new JsonlTraceSink(path),
      canAdvise: async () => false,
      invocationObserverConfigured: async () => false,
      buildAdvisory: buildClaudeAdvisory,
      ...overrides,
    };
    const context = await services.loadContext(
      { ...environment, cwd: input.cwd },
      { agent: input.agent, configMode: "hook" },
    );
    const { config, catalog, cwd } = context;
    if (!config.telemetry.enabled) return;
    const mode =
      input.agent === "claude-code" ? config.hook.modes.claude : "shadow";
    const path = tracePath(environment, config.telemetry.tracePath);
    const directory = dataDirectory(environment);
    // A configured trace destination must never append JSON into the installation key.
    if (path === join(directory, "install.key")) return;
    await assertTraceDestination(path, [invocationPath(environment)]);
    const key = await services.getKey(directory);
    // Parent aliases (for example /tmp and /private/tmp) can name the same key.
    const keyPath = await realpath(join(directory, "install.key"));
    if ((await realpath(path).catch(() => undefined)) === keyPath) return;
    const sink = services.makeSink(path);
    const failed = (code: string): RouteResult => ({
      selected: [],
      allDecisions: [],
      router: { provider: config.router.provider, latencyMs: 0 },
      policy: { ...config.policy },
      diagnostics: [
        { code, level: "warning", message: "Hook routing unavailable." },
      ],
    });
    let result = failed("provider_setup_failed");
    let provider: RouterProvider | undefined;
    try {
      provider = services.createProvider(config, environment);
    } catch {
      /* Keep the sanitized setup failure result. */
    }
    if (provider) {
      try {
        result = await route(
          {
            prompt: input.prompt,
            cwd,
            agent: input.agent,
            skills: catalog.skills,
          },
          provider,
          config.policy,
          { timeoutMs: config.router.timeoutMs },
        );
      } catch {
        result = failed("hook_runtime_failed");
      }
    }
    let advisory: ReturnType<typeof buildClaudeAdvisory> = {
      output: undefined,
      injectedSkillIds: [],
      diagnostics: [],
    };
    if (
      mode === "advisory" &&
      routingOutcome(result) === "complete" &&
      result.selected.length
    ) {
      try {
        if (await services.canAdvise())
          advisory = services.buildAdvisory(result.selected, catalog.skills);
        else
          advisory.diagnostics.push({
            code: "advisory_registration_not_ready",
            level: "warning",
            message:
              "Synchronous Claude registration must be reconciled before advisory delivery.",
          });
      } catch {
        advisory = {
          output: undefined,
          injectedSkillIds: [],
          diagnostics: [
            {
              code: "advisory_output_failed",
              level: "warning",
              message: "Advisory output unavailable.",
            },
          ],
        };
      }
    }
    let invocationObserverConfigured = false;
    if (
      input.agent === "claude-code" &&
      input.promptCorrelationId !== undefined
    ) {
      try {
        invocationObserverConfigured =
          await services.invocationObserverConfigured();
      } catch {
        /* Local observer configuration could not be confirmed. */
      }
    }
    const trace = createRouteTrace({
      ...(invocationObserverConfigured
        ? { capabilities: { skillInvocationTelemetry: true as const } }
        : {}),
      agent: input.agent,
      mode,
      delivery: {
        kind: advisory.output ? "claude-advisory" : "none",
        injectedSkillIds: advisory.injectedSkillIds,
      },
      prompt: input.prompt,
      sessionId: input.sessionId,
      ...(input.promptCorrelationId === undefined
        ? {}
        : { promptCorrelationId: input.promptCorrelationId }),
      ...(input.model === undefined ? {} : { hostModel: input.model }),
      skills: catalog.skills,
      result,
      diagnostics: [...catalog.diagnostics, ...advisory.diagnostics],
      promptStorage: config.telemetry.prompt,
      key,
    });
    try {
      await sink.write(trace);
    } catch {
      /* Storage is best effort; an otherwise safe advisory remains usable. */
    }
    return advisory.output;
  } catch {
    /* Parsing/config/discovery/keys/telemetry must all fail open silently. */
  }
}

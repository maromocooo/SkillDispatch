import { route } from "../core/route.js";
import type { RouteResult } from "../core/types.js";
import type { RouterProvider } from "../providers/types.js";
import {
  createProvider,
  loadRuntimeContext,
  type RuntimeEnvironment,
} from "../runtime/context.js";
import { JsonlTraceSink } from "../telemetry/jsonl.js";
import {
  dataDirectory,
  installationKey,
  tracePath,
} from "../telemetry/storage.js";
import { createRouteTrace } from "../telemetry/trace.js";
import type { TraceSink } from "../telemetry/types.js";
import type { HookInput } from "./types.js";

interface HookServices {
  loadContext: typeof loadRuntimeContext;
  createProvider: typeof createProvider;
  getKey: typeof installationKey;
  makeSink: (path: string) => TraceSink;
}

/** Shadow only: no output, host instructions, invocation or propagated exception. */
export async function runShadowHook(
  input: HookInput,
  environment: RuntimeEnvironment,
  overrides: Partial<HookServices> = {},
): Promise<void> {
  try {
    if (!input.prompt.trim()) return; // No text available, including attachment-only turns.
    const services: HookServices = {
      loadContext: loadRuntimeContext,
      createProvider,
      getKey: installationKey,
      makeSink: (path) => new JsonlTraceSink(path),
      ...overrides,
    };
    const context = await services.loadContext(
      { ...environment, cwd: input.cwd },
      { agent: input.agent },
    );
    const { config, catalog, cwd } = context;
    if (!config.telemetry.enabled) return;
    const path = tracePath(environment, config.telemetry.tracePath);
    const key = await services.getKey(dataDirectory(environment));
    const sink = services.makeSink(path);
    const failed = (code: string): RouteResult => ({
      selected: [],
      allDecisions: [],
      router: { provider: config.router.provider, latencyMs: 0 },
      policy: { ...config.policy },
      diagnostics: [
        { code, level: "warning", message: "Shadow routing unavailable." },
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
    const trace = createRouteTrace({
      agent: input.agent,
      prompt: input.prompt,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.model === undefined ? {} : { hostModel: input.model }),
      skills: catalog.skills,
      result,
      diagnostics: catalog.diagnostics,
      promptStorage: config.telemetry.prompt,
      key,
    });
    await sink.write(trace);
  } catch {
    /* Parsing/config/discovery/keys/telemetry must all fail open silently. */
  }
}

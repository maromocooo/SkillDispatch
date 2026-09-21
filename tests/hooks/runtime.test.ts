import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseClaudeInput } from "../../src/hooks/claude.js";
import { parseCodexInput } from "../../src/hooks/codex.js";
import { runShadowHook } from "../../src/hooks/runtime.js";
import type { RouterProvider } from "../../src/providers/types.js";
import type { RouteTrace } from "../../src/telemetry/types.js";
import { workspace, write } from "../helpers.js";
import { schemaValidator } from "../telemetry/helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("PRIVATE_SDK_ERROR synthetic-api-key"),
  );
  vi.mocked(readFile).mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function setup(
  host: "codex" | "claude" = "codex",
  config = "router:\n  provider: mock\n  timeoutMs: 10\n  mock:\n    defaultProbability: 0.95\n",
) {
  const ctx = await workspace();
  await write(join(ctx.cwd, ".skilldispatch.yaml"), config);
  const wire = JSON.parse(
    await readFile(
      new URL(`../fixtures/hooks/${host}.json`, import.meta.url),
      "utf8",
    ),
  );
  wire.cwd = ctx.cwd;
  const input = (host === "codex" ? parseCodexInput : parseClaudeInput)(wire);
  if (!input) throw new Error("Invalid fixture");
  const data = join(ctx.root, "private-data");
  return {
    ctx,
    input,
    wire,
    data,
    environment: {
      ...ctx,
      cwd: ctx.root,
      env: { SKILLDISPATCH_DATA_DIR: data },
    },
    traces: async (): Promise<RouteTrace[]> =>
      (await readFile(join(data, "traces.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

describe("shared silent shadow runtime", () => {
  it.each(["codex", "claude"] as const)(
    "routes only %s using the hook cwd and drops transcript fields",
    async (host) => {
      const f = await setup(host);
      const seen: string[] = [];
      const provider: RouterProvider = {
        name: "fixture",
        judge: vi.fn<RouterProvider["judge"]>(async (input) => {
          expect(input.agent).toBe(f.input.agent);
          expect(input.cwd).toBe(f.ctx.cwd);
          expect(
            input.candidates.every((skill) => skill.agent === f.input.agent),
          ).toBe(true);
          seen.push(...input.candidates.map((skill) => skill.name));
          return {
            completeness: "complete",
            model: "fixture-model",
            decisions: input.candidates.map((skill) => ({
              skillId: skill.id,
              probability: 0.9,
            })),
          };
        }),
      };
      await expect(
        runShadowHook(f.input, f.environment, {
          createProvider: () => provider,
        }),
      ).resolves.toBeUndefined();
      expect(seen).toContain(
        host === "codex" ? "frontend-testing" : "accessibility-review",
      );
      const [trace] = await f.traces();
      expect(trace).toMatchObject({
        agent: f.input.agent,
        mode: "shadow",
        outcome: "complete",
        router: { provider: "fixture", model: "fixture-model" },
        prompt: { storage: "hash" },
      });
      expect(trace?.decisions.length).toBeGreaterThan(0);
      expect(
        trace?.decisions.every((skill) => skill.agent === f.input.agent),
      ).toBe(true);
      expect((await schemaValidator())(trace)).toBe(true);
      const text = JSON.stringify(trace);
      for (const sentinel of [
        f.input.prompt,
        f.input.sessionId,
        f.ctx.cwd,
        f.ctx.home,
        f.wire.transcript_path,
        "PRIVATE_SDK_ERROR",
        "synthetic-api-key",
        "description",
        "directory",
        '"path"',
        '"message"',
        '"stack"',
      ])
        expect(text).not.toContain(sentinel);
      expect(
        vi
          .mocked(readFile)
          .mock.calls.some(([path]) => String(path) === f.wire.transcript_path),
      ).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      if (host === "claude") {
        expect(trace?.host).not.toHaveProperty("turnKey");
        expect(trace?.host).not.toHaveProperty("model");
        expect(text).not.toContain(f.wire.prompt_id);
      }
    },
  );

  it.each([false, true])(
    "retains successful partial decisions (all failed=%s)",
    async (allFailed) => {
      const f = await setup();
      await runShadowHook(f.input, f.environment, {
        createProvider: () => ({
          name: "fixture",
          judge: async ({ candidates }) => ({
            completeness: "partial",
            decisions: allFailed
              ? []
              : candidates
                  .slice(1)
                  .map((skill) => ({ skillId: skill.id, probability: 0.9 })),
            failedSkillIds: (allFailed
              ? candidates
              : candidates.slice(0, 1)
            ).map((skill) => skill.id),
            diagnostics: [
              {
                code: "fixture_chunk_failed",
                level: "warning",
                message: "PRIVATE_SDK_ERROR synthetic-api-key",
              },
            ],
          }),
        }),
      });
      const [trace] = await f.traces();
      expect(trace?.outcome).toBe("partial");
      expect(
        trace?.diagnostics.find((item) => item.code === "provider_partial")
          ?.skillIds?.length,
      ).toBe(allFailed ? trace?.catalog.enabledSkillCount : 1);
      expect(trace?.decisions.length).toBe(
        allFailed ? 0 : (trace?.catalog.enabledSkillCount ?? 0) - 1,
      );
      expect(trace?.decisions.every((item) => item.selected)).toBe(true);
      expect(JSON.stringify(trace)).not.toMatch(
        /PRIVATE_SDK_ERROR|synthetic-api-key/,
      );
    },
  );

  it.each(["provider_failed", "provider_timeout", "invalid_provider_response"])(
    "persists %s as failed",
    async (code) => {
      const f = await setup();
      await runShadowHook(f.input, f.environment, {
        createProvider: () => ({
          name: "fixture",
          judge: async () => {
            if (code === "provider_failed")
              throw new Error("PRIVATE_SDK_ERROR synthetic-api-key");
            if (code === "provider_timeout") return new Promise(() => {});
            return { completeness: "complete", decisions: [] };
          },
        }),
      });
      const [trace] = await f.traces();
      expect(trace).toMatchObject({
        outcome: "failed",
        decisions: [],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]),
      });
      expect(JSON.stringify(trace)).not.toMatch(
        /PRIVATE_SDK_ERROR|synthetic-api-key/,
      );
    },
  );

  it.each(["codex", "claude"] as const)(
    "traces missing credentials without a network request (%s)",
    async (host) => {
      const f = await setup(host, "router:\n  provider: jev\n");
      await runShadowHook(f.input, f.environment);
      expect((await f.traces())[0]).toMatchObject({
        outcome: "failed",
        router: { provider: "jev" },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "provider_setup_failed" }),
        ]),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["none", "raw"])(
    "honors explicit prompt storage %s",
    async (mode) => {
      const f = await setup(
        "codex",
        `router:\n  provider: mock\ntelemetry:\n  prompt: ${mode}\n`,
      );
      await runShadowHook(f.input, f.environment);
      expect((await f.traces())[0]?.prompt).toEqual(
        mode === "none"
          ? { storage: "none" }
          : { storage: "raw", raw: f.input.prompt },
      );
    },
  );

  it("correlates events with the same installation key, but gives each a fresh trace ID", async () => {
    const f = await setup();
    await runShadowHook(f.input, f.environment);
    await runShadowHook(f.input, f.environment);
    const [a, b] = await f.traces();
    expect(a?.prompt).toEqual(b?.prompt);
    expect(a?.host).toEqual(b?.host);
    expect(a?.traceId).not.toBe(b?.traceId);
  });

  it.each([
    "invalid_config",
    "discovery",
    "key",
    "writer",
    "sink_setup",
    "blank_prompt",
    "disabled",
  ])("fails open silently for %s", async (failure) => {
    const f = await setup();
    const fail = () => {
      throw new Error("PRIVATE_FAILURE");
    };
    const overrides: Parameters<typeof runShadowHook>[2] = {};
    if (failure === "invalid_config")
      await write(
        join(f.ctx.cwd, ".skilldispatch.yaml"),
        "router: {provider: unsupported}",
      );
    if (failure === "discovery") overrides.loadContext = fail;
    if (failure === "key") overrides.getKey = fail;
    if (failure === "writer") overrides.makeSink = () => ({ write: fail });
    if (failure === "sink_setup") overrides.makeSink = fail;
    if (failure === "blank_prompt") f.input.prompt = "  ";
    if (failure === "disabled")
      await write(
        join(f.ctx.cwd, ".skilldispatch.yaml"),
        "telemetry: {enabled: false}",
      );
    await expect(
      runShadowHook(f.input, f.environment, overrides),
    ).resolves.toBeUndefined();
    await expect(f.traces()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records a complete empty catalog without judging", async () => {
    const f = await setup();
    const { loadRuntimeContext } = await import("../../src/runtime/context.js");
    const context = await loadRuntimeContext(
      { ...f.environment, cwd: f.input.cwd },
      { agent: f.input.agent },
    );
    const judge = vi.fn();
    await runShadowHook(f.input, f.environment, {
      loadContext: async () => ({
        ...context,
        catalog: { skills: [], diagnostics: [] },
      }),
      createProvider: () => ({ name: "fixture", judge }),
    });
    expect(judge).not.toHaveBeenCalled();
    expect((await f.traces())[0]).toMatchObject({
      outcome: "complete",
      decisions: [],
      catalog: { skillCount: 0, enabledSkillCount: 0 },
    });
  });
});

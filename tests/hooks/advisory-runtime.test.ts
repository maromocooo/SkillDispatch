import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHook } from "../../src/hooks/runtime.js";
import type { HookInput } from "../../src/hooks/types.js";
import { loadRuntimeContext } from "../../src/runtime/context.js";
import type { RouteTrace } from "../../src/telemetry/types.js";
import { workspace, write } from "../helpers.js";
import { schemaValidator } from "../telemetry/helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("EXTERNAL_NETWORK_FORBIDDEN"),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
async function fixture(mode = "advisory") {
  const ctx = await workspace();
  const configPath = join(ctx.home, ".config/skilldispatch/config.yaml");
  await write(
    configPath,
    `hook: {modes: {claude: ${mode}}}\nrouter:\n  provider: mock\n  timeoutMs: 20\n  mock:\n    scores: {display-swift: 0.95}\n`,
  );
  await write(
    join(ctx.repo, ".claude/skills/swift-concurrency-expert/SKILL.md"),
    "---\nname: display-swift\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY",
  );
  const input: HookInput = {
    agent: "claude-code",
    cwd: ctx.cwd,
    prompt: 'PRIVATE_PROMPT "quoted" \\ 日本語 —',
    sessionId: "PRIVATE_SESSION",
    promptCorrelationId: "PRIVATE_SUBMISSION",
  };
  const data = join(ctx.root, "data");
  const environment = { ...ctx, env: { SKILLDISPATCH_DATA_DIR: data } };
  return {
    ctx,
    configPath,
    input,
    environment,
    run: (overrides: Parameters<typeof runHook>[2] = {}) =>
      runHook(input, environment, {
        canAdvise: async () => true,
        ...overrides,
      }),
    traces: async (): Promise<RouteTrace[]> =>
      (await readFile(join(data, "traces.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
describe("mode-aware shared runtime", () => {
  it.each([true, false])(
    "records invocation capability only when confirmed: %s",
    async (available) => {
      const f = await fixture();
      await f.run({ invocationAvailable: async () => available });
      const trace = (await f.traces())[0];
      expect(trace?.capabilities).toEqual(
        available ? { skillInvocationTelemetry: true } : undefined,
      );
      expect(
        trace?.decisions
          .filter((d) => d.agent === "claude-code")
          .every((d) => /^[a-f0-9]{64}$/.test(d.catalogIdentity ?? "")),
      ).toBe(true);
      expect((await schemaValidator())(trace)).toBe(true);
    },
  );
  it("omits capability when prompt correlation is unavailable", async () => {
    const f = await fixture();
    delete f.input.promptCorrelationId;
    await f.run({ invocationAvailable: async () => true });
    expect((await f.traces())[0]?.capabilities).toBeUndefined();
  });
  it("keeps advisory usable when observer availability check fails", async () => {
    const f = await fixture();
    expect(
      await f.run({
        invocationAvailable: async () => {
          throw new Error("PRIVATE");
        },
      }),
    ).toBeDefined();
    expect((await f.traces())[0]?.capabilities).toBeUndefined();
  });

  it("keeps positive shadow routing silent and records no injections", async () => {
    const f = await fixture("shadow");
    const check = vi.fn();
    expect(await f.run({ canAdvise: check })).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect((await f.traces())[0]).toMatchObject({
      mode: "shadow",
      outcome: "complete",
      delivery: { kind: "none", injectedSkillIds: [] },
      decisions: expect.arrayContaining([
        expect.objectContaining({ selected: true }),
      ]),
    });
  });
  it("delivers complete positive routing as native-invocation JSON and private trace", async () => {
    const f = await fixture();
    const output = await f.run();
    const json = JSON.parse(output ?? "");
    expect(Object.keys(json)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(json.hookSpecificOutput)).toEqual([
      "hookEventName",
      "additionalContext",
    ]);
    expect(json.hookSpecificOutput).toMatchObject({
      hookEventName: "UserPromptSubmit",
      additionalContext: expect.stringContaining(
        "- swift-concurrency-expert\n",
      ),
    });
    const trace = (await f.traces())[0];
    expect(trace).toMatchObject({
      mode: "advisory",
      outcome: "complete",
      delivery: {
        kind: "claude-advisory",
        injectedSkillIds: trace?.decisions
          .filter((d) => d.selected)
          .map((d) => d.skillId),
      },
    });
    expect((await schemaValidator())(trace)).toBe(true);
    expect(output).not.toMatch(
      /PRIVATE_|display-swift|0\.95|probability|path|additionalContext.*Skill\.md/,
    );
    expect(JSON.stringify(trace)).not.toMatch(
      /PRIVATE_|additionalContext|description|transcript/,
    );
  });
  it("withholds advisory when registration cannot be confirmed synchronous", async () => {
    const f = await fixture();
    expect(await f.run({ canAdvise: async () => false })).toBeUndefined();
    expect((await f.traces())[0]).toMatchObject({
      delivery: { kind: "none", injectedSkillIds: [] },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "advisory_registration_not_ready" }),
      ]),
    });
  });
  it("withholds a zero-selection result", async () => {
    const f = await fixture();
    expect(
      await f.run({
        createProvider: () => ({
          name: "fake",
          judge: async ({ candidates }) => ({
            completeness: "complete",
            decisions: candidates.map((c) => ({
              skillId: c.id,
              probability: 0,
            })),
          }),
        }),
      }),
    ).toBeUndefined();
    expect((await f.traces())[0]?.delivery?.injectedSkillIds).toEqual([]);
  });
  it("retains partial recommendations in trace but never injects them", async () => {
    const f = await fixture();
    expect(
      await f.run({
        createProvider: () => ({
          name: "fake",
          judge: async ({ candidates }) => ({
            completeness: "partial",
            decisions: candidates
              .slice(1)
              .map((c) => ({ skillId: c.id, probability: 1 })),
            failedSkillIds: candidates.slice(0, 1).map((c) => c.id),
          }),
        }),
      }),
    ).toBeUndefined();
    expect((await f.traces())[0]).toMatchObject({
      outcome: "partial",
      delivery: { kind: "none", injectedSkillIds: [] },
      decisions: expect.arrayContaining([
        expect.objectContaining({ selected: true }),
      ]),
    });
  });
  it.each(["provider_failed", "provider_timeout", "invalid_provider_response"])(
    "never injects %s",
    async (code) => {
      const f = await fixture();
      expect(
        await f.run({
          createProvider: () => ({
            name: "fake",
            judge: async () => {
              if (code === "provider_failed")
                throw new Error("PRIVATE_SDK_ERROR");
              if (code === "provider_timeout") return new Promise(() => {});
              return { completeness: "complete", decisions: [] };
            },
          }),
        }),
      ).toBeUndefined();
      expect((await f.traces())[0]).toMatchObject({
        outcome: "failed",
        delivery: { kind: "none", injectedSkillIds: [] },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code }),
        ]),
      });
    },
  );
  it("traces missing Jev credentials with no output/network", async () => {
    const f = await fixture();
    await write(
      f.configPath,
      "hook: {modes: {claude: advisory}}\nrouter: {provider: jev}",
    );
    expect(await f.run()).toBeUndefined();
    expect((await f.traces())[0]?.outcome).toBe("failed");
  });
  it("handles context serialization/resolution exceptions without losing routing trace", async () => {
    const f = await fixture();
    expect(
      await f.run({
        buildAdvisory: () => {
          throw new Error("PRIVATE_ERROR");
        },
      }),
    ).toBeUndefined();
    expect((await f.traces())[0]).toMatchObject({
      outcome: "complete",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "advisory_output_failed" }),
      ]),
    });
  });
  it("trace write failure does not block otherwise safe context delivery", async () => {
    const f = await fixture();
    expect(
      JSON.parse(
        (await f.run({
          makeSink: () => ({
            write: async () => {
              throw new Error("PRIVATE_WRITE_ERROR");
            },
          }),
        })) ?? "",
      ).hookSpecificOutput.additionalContext,
    ).toContain("swift-concurrency-expert");
  });
  it("all ambiguous recommendations produce no output but record omission", async () => {
    const f = await fixture();
    await write(
      join(f.ctx.home, ".claude/skills/swift-concurrency-expert/SKILL.md"),
      "---\nname: other\ndescription: Other version\n---",
    );
    expect(await f.run()).toBeUndefined();
    expect((await f.traces())[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "advisory_ambiguous_skill_invocation",
        }),
      ]),
    );
  });
  it.each([false, true])(
    "project cannot promote shadow even when trusted=%s",
    async (trusted) => {
      const f = await fixture("shadow");
      await write(
        f.configPath,
        `hook: {trustProjectConfig: ${trusted}}\nrouter: {provider: mock, mock: {defaultProbability: 1}}`,
      );
      await write(
        join(f.ctx.cwd, ".skilldispatch.yaml"),
        "hook: {modes: {claude: advisory}}",
      );
      expect(await f.run()).toBeUndefined();
      expect((await f.traces())[0]?.mode).toBe("shadow");
    },
  );
  it("Codex remains silent shadow when Claude is advisory", async () => {
    const f = await fixture();
    f.input.agent = "codex";
    const check = vi.fn();
    expect(await f.run({ canAdvise: check })).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect((await f.traces())[0]?.mode).toBe("shadow");
  });
  it.each(["invalid_config", "discovery", "key", "disabled"])(
    "silently fails open for %s",
    async (failure) => {
      const f = await fixture();
      const fail = () => {
        throw new Error("PRIVATE_FAILURE");
      };
      if (failure === "invalid_config")
        await write(f.configPath, "hook: {modes: {codex: advisory}}");
      if (failure === "disabled")
        await write(
          f.configPath,
          "hook: {modes: {claude: advisory}}\ntelemetry: {enabled: false}",
        );
      expect(
        await f.run({
          ...(failure === "discovery" ? { loadContext: fail } : {}),
          ...(failure === "key" ? { getKey: fail } : {}),
        }),
      ).toBeUndefined();
    },
  );
  it("builder checks manual-only policy even if a supplied catalog mistakenly enables it", async () => {
    const f = await fixture();
    const context = await loadRuntimeContext(f.environment, {
      agent: "claude-code",
      configMode: "hook",
    });
    const swift = context.catalog.skills.find(
      (s) => s.name === "display-swift",
    );
    if (!swift) throw new Error("Missing fixture");
    swift.metadata["disable-model-invocation"] = true;
    expect(await f.run({ loadContext: async () => context })).toBeUndefined();
    expect((await f.traces())[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "advisory_invocation_disabled" }),
      ]),
    );
  });
});

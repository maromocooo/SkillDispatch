import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliEnvironment } from "../../src/cli/context.js";
import { createProgram } from "../../src/cli/program.js";
import { workspace, write } from "../helpers.js";
import { eventFixture } from "../observability/helpers.js";
import { digest, traceFixture } from "../telemetry/helpers.js";

async function run(args: string[], ctx: CliEnvironment) {
  let stdout = "",
    stderr = "";
  let error: unknown;
  try {
    await createProgram(ctx, {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
    }).parseAsync(args, { from: "user" });
  } catch (caught) {
    error = caught;
  }
  return { stdout, stderr, error };
}
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const ctx = await workspace();
  const dir = join(ctx.root, "data");
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, "traces.jsonl");
  const raw = traceFixture();
  raw.prompt = { storage: "raw", raw: "PRIVATE_RAW_PROMPT_SENTINEL" };
  const hashed = traceFixture();
  await writeFile(
    path,
    `${JSON.stringify(raw)}\n${JSON.stringify(hashed)}\ninvalid PRIVATE_RAW_PROMPT_SENTINEL`,
    { mode: 0o600 },
  );
  return {
    ctx: {
      ...ctx,
      env: {
        SKILLDISPATCH_DATA_DIR: dir,
        TYPESAFE_API_KEY: "PRIVATE_API_KEY_SENTINEL",
      },
    },
    path,
    raw,
    hashed,
  };
}
describe("operational trace CLI", () => {
  it.each(["summary", "list", "show"] as const)(
    "%s text/JSON are private, offline and read-only",
    async (command) => {
      const { ctx, path, raw, hashed } = await fixture();
      const fetch = vi.fn(() => {
        throw new Error("PRIVATE_API_KEY_SENTINEL");
      });
      vi.stubGlobal("fetch", fetch);
      const before = await readFile(path);
      const beforeStat = await stat(path);
      for (const flag of [[], ["--json"]]) {
        const result = await run(
          [
            "traces",
            command,
            ...(command === "show" ? [raw.traceId] : []),
            ...flag,
          ],
          ctx,
        );
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        for (const forbidden of [
          "PRIVATE_RAW_PROMPT_SENTINEL",
          "PRIVATE_API_KEY_SENTINEL",
          "sessionKey",
          "promptKey",
          hashed.prompt.storage === "hash" ? hashed.prompt.hash : "UNREACHABLE",
          raw.host.sessionKey ?? "UNREACHABLE",
          raw.host.promptKey ?? "UNREACHABLE",
          "PRIVATE_SKILL_PATH",
          "PRIVATE_SDK_ERROR",
        ])
          expect(result.stdout).not.toContain(forbidden);
        if (flag.length) expect(JSON.parse(result.stdout).version).toBe(1);
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(path)).toEqual(before);
      expect((await stat(path)).mtimeMs).toBe(beforeStat.mtimeMs);
    },
  );
  it.each(["none", "attempted", "succeeded", "failed"] as const)(
    "reports only observed evidence for %s without claiming exact conversion",
    async (phase) => {
      const { ctx, path, raw } = await fixture();
      const pre = eventFixture({ tool_input: { skill: "react" } });
      raw.agent = "claude-code";
      raw.mode = "advisory";
      raw.capabilities = { skillInvocationTelemetry: true };
      raw.host = {
        event: "UserPromptSubmit",
        sessionKey: pre.sessionKey,
        promptKey: pre.promptKey as string,
      };
      const decision = raw.decisions[0];
      if (!decision) throw new Error("Missing fixture decision");
      decision.agent = "claude-code";
      decision.catalogIdentity = digest("react-identity");
      pre.skill = {
        nativeInvocationName: "react",
        resolved: true,
        name: decision.name,
        origin: "local-user",
        catalogIdentity: decision.catalogIdentity,
        contentHash: decision.contentHash,
      };
      raw.delivery = {
        kind: "claude-advisory",
        injectedSkillIds: [decision.skillId],
      };
      await writeFile(path, `${JSON.stringify(raw)}\n`);
      const events =
        phase === "none"
          ? []
          : phase === "attempted"
            ? [pre]
            : [
                // Terminal physically precedes attempt; phase still determines observed outcome.
                { ...pre, phase },
                pre,
              ];
      await writeFile(
        join(ctx.env.SKILLDISPATCH_DATA_DIR as string, "invocations.jsonl"),
        events.map((event) => `${JSON.stringify(event)}\n`).join(""),
        { mode: 0o600 },
      );
      const fetch = vi.fn(() => {
        throw new Error("Network forbidden");
      });
      vi.stubGlobal("fetch", fetch);
      for (const json of [false, true]) {
        const flags = json ? ["--json"] : [];
        const summary = await run(["traces", "summary", ...flags], ctx);
        const show = await run(["traces", "show", raw.traceId, ...flags], ctx);
        expect(summary.error ?? show.error).toBeUndefined();
        expect(summary.stderr + show.stderr).toBe("");
        const output = summary.stdout + show.stdout;
        for (const forbidden of [
          "injectedToModelInvoked",
          "modelInvokedToSucceeded",
          "notInvoked",
          "Injected -> Model invoked",
          "Model invoked -> Succeeded",
          "success rate",
          "Claude did not invoke",
          "PRIVATE_",
          pre.sessionKey,
          pre.promptKey as string,
          pre.toolUseKey,
        ])
          expect(output).not.toContain(forbidden);
        if (json) {
          const funnel = JSON.parse(summary.stdout).advisoryFunnel;
          expect(funnel).toMatchObject({
            recommended: 1,
            injected: 1,
            observedModelInvoked: phase === "none" ? 0 : 1,
            observedSucceeded: phase === "succeeded" ? 1 : 0,
            injectedPairsWithoutObservedInvocation: phase === "none" ? 1 : 0,
            telemetryConfiguredTraces: 1,
            telemetryUnconfiguredTraces: 0,
          });
          const invocations = JSON.parse(show.stdout).modelInvocations;
          expect(invocations.observerConfigured).toBe(true);
          expect(invocations.calls).toHaveLength(phase === "none" ? 0 : 1);
          if (phase !== "none")
            expect(invocations.calls[0].outcome).toBe(
              phase === "attempted" ? "unknown" : phase,
            );
        } else {
          expect(summary.stdout).toContain("Observed model-invoked:");
          expect(summary.stdout).toContain("Observed succeeded:");
          expect(summary.stdout).toContain("Observer-configured traces: 1");
          expect(summary.stdout).toContain("missing events remain unknown");
          expect(show.stdout).toContain(
            "Invocation observer: configured / best-effort",
          );
          expect(show.stdout).toContain("Model skill invocations observed:");
          if (phase === "none")
            expect(show.stdout).toContain(
              "No model skill invocation event observed.",
            );
          else
            expect(show.stdout).toMatch(
              new RegExp(
                `react\\s+\\| yes\\s+\\| ${phase === "attempted" ? "unknown" : phase}`,
              ),
            );
        }
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("reports invalid lines but continues, with stable JSON shapes", async () => {
    const { ctx } = await fixture();
    const s = JSON.parse(
      (await run(["traces", "summary", "--json"], ctx)).stdout,
    );
    expect(s).toMatchObject({
      validTraces: 2,
      invalidLines: 1,
      matchedTraces: 2,
      skillsSeen: 1,
    });
    const l = JSON.parse(
      (await run(["traces", "list", "--limit", "1", "--json"], ctx)).stdout,
    );
    expect(Object.keys(l)).toEqual([
      "version",
      "totalLines",
      "validTraces",
      "invalidLines",
      "matchedTraces",
      "traces",
    ]);
    expect(l.traces).toHaveLength(1);
    expect(Object.keys(l.traces[0])).toEqual([
      "traceId",
      "timestamp",
      "agent",
      "outcome",
      "mode",
      "injectedCount",
      "provider",
      "model",
      "selectedCount",
      "latencyMs",
    ]);
    expect(
      JSON.parse(
        (
          await run(
            [
              "traces",
              "list",
              "--agent",
              "claude-code",
              "--outcome",
              "partial",
              "--since",
              "24h",
              "--json",
            ],
            ctx,
          )
        ).stdout,
      ).traces,
    ).toEqual([]);
  });
  it.each([
    ["list", "--limit", "0"],
    ["list", "--limit", "1e2"],
    ["summary", "--since", "bad"],
    ["show", "prefix"],
    ["show", "00000000-0000-4000-8000-000000000000"],
  ])("rejects invalid/unknown queries %j", async (...args) => {
    expect(
      (await run(["traces", ...args], (await fixture()).ctx)).error,
    ).toBeInstanceOf(Error);
  });
  it("show scans the whole file and rejects duplicate UUIDs", async () => {
    const { ctx, path, raw } = await fixture();
    await writeFile(path, `${JSON.stringify(raw)}\n${JSON.stringify(raw)}\n`);
    const result = await run(["traces", "show", raw.traceId, "--json"], ctx);
    expect(result.error).toMatchObject({
      message: "Duplicate trace ID: dataset is corrupt.",
    });
    expect(result.stdout).toBe("");
  });
  it("uses hook config trust, ignoring project trace redirection and self-trust", async () => {
    const { ctx } = await fixture();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "hook:\n  trustProjectConfig: true\ntelemetry:\n  tracePath: /PRIVATE_SECRET_PATH\n",
    );
    expect(
      JSON.parse((await run(["traces", "summary", "--json"], ctx)).stdout)
        .validTraces,
    ).toBe(2);
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "telemetry: [PRIVATE_SECRET_CONFIG]",
    );
    const result = await run(["traces", "summary"], ctx);
    expect(result.error).toMatchObject({
      message: "Cannot load trusted operational configuration.",
    });
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_SECRET");
  });
  it("escapes terminal controls in skill metadata", async () => {
    const { ctx, path, raw } = await fixture();
    for (const d of raw.decisions) d.name = "name\u001b[2J";
    await writeFile(path, `${JSON.stringify(raw)}\n`);
    const result = await run(["traces", "show", raw.traceId], ctx);
    expect(result.stdout).toContain("name\\u001b[2J");
    expect(result.stdout).not.toContain("\u001b");
  });
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliEnvironment } from "../../src/cli/context.js";
import { createProgram } from "../../src/cli/program.js";
import { manageRegistration } from "../../src/registration/manage.js";
import { workspace, write } from "../helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("NO_EXTERNAL_NETWORK"),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
async function run(ctx: CliEnvironment, args: string[], input = "") {
  let stdout = "",
    stderr = "",
    exit = 0;
  try {
    await createProgram(
      ctx,
      {
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
      },
      Readable.from([input]),
    ).parseAsync(args, { from: "user" });
  } catch (error) {
    exit = (error as { exitCode?: number }).exitCode ?? 1;
  }
  return { stdout, stderr, exit };
}
async function fixture() {
  const ctx = await workspace();
  const cliPath = join(ctx.root, "skilldispatch/cli.js");
  await write(cliPath, "// fixture installed identity");
  await write(
    join(ctx.repo, ".claude/skills/swift-concurrency-expert/SKILL.md"),
    "---\nname: display-swift\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY",
  );
  const environment = {
    ...ctx,
    env: { SKILLDISPATCH_DATA_DIR: join(ctx.root, "data") },
    execution: {
      nodePath: process.execPath,
      cliPath,
      platform: process.platform,
    },
  };
  const setMode = (mode: string) =>
    write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      `hook: {modes: {claude: ${mode}}}\nrouter: {provider: mock, mock: {scores: {display-swift: 0.95}}}`,
    );
  const wire = JSON.stringify({
    session_id: "PRIVATE_SESSION",
    prompt_id: "PRIVATE_SUBMISSION",
    hook_event_name: "UserPromptSubmit",
    cwd: ctx.cwd,
    prompt: 'PRIVATE_PROMPT "quote" \\ 日本語 —',
    transcript_path: "/PRIVATE_TRANSCRIPT",
    permission_mode: "default",
  });
  return { ...ctx, environment, setMode, wire };
}
describe("Claude advisory CLI", () => {
  it("reports mismatch, refuses async output, reconciles, returns only JSON, and reverses to silent shadow", async () => {
    const f = await fixture();
    const ctx = f.environment;
    await f.setMode("shadow");
    expect((await run(ctx, ["hooks", "install", "claude"])).exit).toBe(0);
    expect(await run(ctx, ["hook", "claude"], f.wire)).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
    await f.setMode("advisory");
    const status = await run(ctx, ["hooks", "status", "claude"]);
    expect(status.stdout).toContain("hook_execution_mismatch");
    expect(status.stdout).toContain(
      "Re-run: skilldispatch hooks install claude",
    );
    expect(await run(ctx, ["hook", "claude"], f.wire)).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
    expect(
      (await run(ctx, ["hooks", "install", "claude", "--dry-run"])).stdout,
    ).toContain("update (sync)");
    expect((await run(ctx, ["hooks", "install", "claude"])).exit).toBe(0);
    const positive = await run(ctx, ["hook", "claude"], f.wire);
    expect(positive.exit).toBe(0);
    expect(positive.stderr).toBe("");
    expect(
      JSON.parse(positive.stdout).hookSpecificOutput.additionalContext,
    ).toContain("swift-concurrency-expert");
    expect(positive.stdout).not.toMatch(
      /PRIVATE_|display-swift|0\.95|decision|reason|systemMessage/,
    );
    const records = (await readFile(join(f.root, "data/traces.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(records.map((t) => t.delivery.injectedSkillIds.length)).toEqual([
      0, 0, 1,
    ]);
    for (const args of [["summary"], ["list"], ["show", records[2].traceId]]) {
      for (const flags of [[], ["--json"]]) {
        const output = await run(ctx, ["traces", ...args, ...flags]);
        expect(output.exit).toBe(0);
        expect(output.stdout).not.toMatch(
          /PRIVATE_|sessionKey|promptKey|additionalContext/,
        );
        expect(output.stdout).toContain("advisory");
      }
    }
    const shown = await run(ctx, ["traces", "show", records[2].traceId]);
    expect(shown.stdout).toContain("Injected recommendations");
    const detail = JSON.parse(
      (await run(ctx, ["traces", "show", records[2].traceId, "--json"])).stdout,
    );
    expect(
      detail.trace.decisions.find((d: { selected: boolean }) => d.selected)
        .injected,
    ).toBe(true);
    await f.setMode("shadow");
    await run(ctx, ["hooks", "install", "claude"]);
    expect(await run(ctx, ["hook", "claude"], f.wire)).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  });
  it("withholds output when host registration is absent or disabled", async () => {
    const f = await fixture();
    await f.setMode("advisory");
    expect(await run(f.environment, ["hook", "claude"], f.wire)).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
    await write(
      join(f.home, ".claude/settings.json"),
      '{"disableAllHooks":true}',
    );
    await manageRegistration(
      "claude",
      "install",
      f.environment,
      f.environment.execution,
    );
    expect(await run(f.environment, ["hook", "claude"], f.wire)).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  });
  it.each(["{bad", "{}", " ".repeat(1_048_577)])(
    "invalid input remains silent success",
    async (input) => {
      const f = await fixture();
      await f.setMode("advisory");
      expect(await run(f.environment, ["hook", "claude"], input)).toEqual({
        stdout: "",
        stderr: "",
        exit: 0,
      });
    },
  );
});

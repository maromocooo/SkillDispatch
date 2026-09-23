import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliEnvironment } from "../../src/cli/context.js";
import { createProgram } from "../../src/cli/program.js";
import { workspace, write } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());
async function run(args: string[], ctx: CliEnvironment) {
  let stdout = "",
    stderr = "",
    exit = 0;
  try {
    await createProgram(ctx, {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
    }).parseAsync(args, { from: "user" });
  } catch (error) {
    exit = (error as { exitCode?: number }).exitCode ?? 1;
    if (!("exitCode" in (error as object))) stderr += (error as Error).message;
  }
  return { stdout, stderr, exit };
}
async function fixture() {
  const ctx = await workspace();
  const cliPath = join(ctx.root, "skilldispatch", "cli.js");
  await write(cliPath, "// installed fixture\n");
  return {
    ...ctx,
    execution: {
      nodePath: process.execPath,
      cliPath,
      platform: process.platform,
    },
  };
}
describe("hooks CLI", () => {
  it("status JSON has stable shape, only owned commands and no config secrets", async () => {
    const ctx = await fixture();
    await write(
      join(ctx.home, ".claude/settings.json"),
      '{"env":{"SECRET":"PRIVATE_ENV"},"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"PRIVATE_OTHER_COMMAND"}]}]}}',
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const absent = await run(["hooks", "status", "--json"], ctx);
    expect(absent.exit).toBe(0);
    expect(JSON.parse(absent.stdout)).toEqual({
      version: 1,
      hosts: [
        {
          host: "codex",
          mode: "shadow",
          expectedExecution: "async",
          registration: "not-installed",
          execution: null,
          command: null,
          configSource: "~/.codex/hooks.json",
          issues: [
            "codex_contract_unverified",
            "skill_instruction_telemetry_incomplete",
          ],
          codexContract: "unverified",
          instructionObservers: {
            ready: false,
            events: ["PreToolUse", "PostToolUse"].map((event) => ({
              event,
              matcher: "Bash",
              registration: "not-installed",
              execution: null,
              registrations: 0,
            })),
          },
          registrations: 0,
        },
        {
          host: "claude",
          mode: "shadow",
          expectedExecution: "async",
          registration: "not-installed",
          execution: null,
          command: null,
          configSource: "~/.claude/settings.json",
          issues: ["skill_invocation_telemetry_incomplete"],
          skillObservers: {
            ready: false,
            events: ["PreToolUse", "PostToolUse", "PostToolUseFailure"].map(
              (event) => ({
                event,
                matcher: "Skill",
                registration: "not-installed",
                execution: null,
                registrations: 0,
              }),
            ),
          },
          registrations: 0,
        },
      ],
    });
    expect((await run(["hooks", "install", "claude"], ctx)).exit).toBe(0);
    for (const flags of [[], ["--json"]]) {
      const status = await run(["hooks", "status", "claude", ...flags], ctx);
      expect(status.exit).toBe(0);
      expect(status.stdout).toContain("installed");
      expect(status.stdout + status.stderr).not.toMatch(/PRIVATE_/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["codex", "claude"])(
    "supports %s install, --sync, dry-run and targeted uninstall",
    async (host) => {
      const ctx = await fixture();
      expect(
        (await run(["hooks", "install", host, "--dry-run"], ctx)).stdout,
      ).toContain("Dry run");
      expect(
        JSON.parse((await run(["hooks", "status", host, "--json"], ctx)).stdout)
          .hosts[0].registration,
      ).toBe("not-installed");
      if (host === "codex")
        expect(
          (await run(["hooks", "install", host, "--sync"], ctx)).exit,
        ).toBe(1);
      expect(
        (
          await run(
            [
              "hooks",
              "install",
              host,
              ...(host === "claude" ? ["--sync"] : []),
            ],
            ctx,
          )
        ).stdout,
      ).toContain(host === "claude" ? "(sync)" : "(async)");
      expect(
        JSON.parse((await run(["hooks", "status", host, "--json"], ctx)).stdout)
          .hosts[0].execution,
      ).toBe(host === "claude" ? "sync" : "async");
      expect(
        (await run(["hooks", "uninstall", host, "--dry-run"], ctx)).stdout,
      ).toContain("Dry run");
      expect((await run(["hooks", "uninstall", host], ctx)).exit).toBe(0);
    },
  );
  it("inline conflict returns exit 1 with safe reason, without mutation", async () => {
    const ctx = await fixture();
    const path = join(ctx.home, ".codex/config.toml");
    const text = "[hooks]\n# PRIVATE_TOML_SECRET\n";
    await write(path, text);
    const status = await run(["hooks", "status", "codex", "--json"], ctx);
    expect(status.exit).toBe(1);
    expect(JSON.parse(status.stdout).hosts[0].issues).toEqual([
      "codex_inline_hooks_manual_action_required",
    ]);
    const install = await run(["hooks", "install", "codex"], ctx);
    expect(install.exit).toBe(1);
    expect(install.stderr).toContain("Inline hooks exist");
    expect(install.stdout + install.stderr + status.stdout).not.toContain(
      "PRIVATE_TOML_SECRET",
    );
    expect(await readFile(path, "utf8")).toBe(text);
  });
  it("rejects invalid host and unknown unsafe options", async () => {
    const ctx = await fixture();
    for (const args of [
      ["hooks", "install", "../repo"],
      ["hooks", "install", "codex", "--project"],
      ["hooks", "install", "claude", "--advisory"],
    ])
      expect((await run(args, ctx)).exit).toBe(1);
  });
});

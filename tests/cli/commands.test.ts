import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliEnvironment } from "../../src/cli/context.js";
import { terminalText } from "../../src/cli/output.js";
import { createProgram } from "../../src/cli/program.js";
import { skillText, workspace, write } from "../helpers.js";

async function run(args: string[], environment: CliEnvironment) {
  let stdout = "";
  let stderr = "";
  const program = createProgram(environment, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  await program.parseAsync(args, { from: "user" });
  return { stdout, stderr };
}

describe("skilldispatch CLI", () => {
  it("discovers both agent catalogs as a single valid JSON document", async () => {
    const ctx = await workspace();
    const output = await run(["discover", "--json"], ctx);
    const catalog = JSON.parse(output.stdout);
    expect(
      new Set(catalog.skills.map((s: { agent: string }) => s.agent)),
    ).toEqual(new Set(["codex", "claude-code"]));
    expect(
      catalog.diagnostics.some(
        (d: { code: string }) => d.code === "invalid_yaml",
      ),
    ).toBe(true);
    expect(output.stderr).toBe("");
    expect((await run(["discover", "--json"], ctx)).stdout).toBe(output.stdout);
  });
  it.each(["codex", "claude-code"])("filters --agent %s", async (agent) => {
    const result = JSON.parse(
      (await run(["discover", "--agent", agent, "--json"], await workspace()))
        .stdout,
    );
    expect(result.skills.length).toBeGreaterThan(0);
    expect(
      result.skills.every((s: { agent: string }) => s.agent === agent),
    ).toBe(true);
  });
  it("prints paths and enabled states in text, diagnostics on stderr", async () => {
    const { stdout, stderr } = await run(
      ["discover", "--agent", "codex"],
      await workspace(),
    );
    expect(stdout).toContain("react-patterns\tcodex\trepo\tenabled");
    expect(stdout).toContain("manual-only\tcodex\tuser\tdisabled");
    expect(stderr).toContain("invalid_yaml");
  });
  it("routes to multiple skills, returns all decisions and never echoes the prompt", async () => {
    const ctx = await workspace();
    const prompt =
      "Build a React form and write tests; check keyboard accessibility -- private request";
    const { stdout, stderr } = await run(["route", prompt, "--json"], ctx);
    const result = JSON.parse(stdout);
    expect(result.selected.map((s: { name: string }) => s.name).sort()).toEqual(
      ["accessibility-review", "frontend-testing", "react-patterns"],
    );
    expect(
      result.selected.every((s: { path: string }) =>
        s.path.endsWith("SKILL.md"),
      ),
    ).toBe(true);
    expect(result.router.provider).toBe("mock");
    expect(
      result.allDecisions.some(
        (s: { name: string }) => s.name === "manual-only",
      ),
    ).toBe(false);
    expect(stdout).not.toContain("private request");
    expect(stderr).toBe("");
  });
  it("selects nothing for unrelated prompts and explains the mock in text mode", async () => {
    const output = await run(
      ["route", "Fix the typo in README"],
      await workspace(),
    );
    expect(output.stdout).toContain("No skills selected.");
    expect(output.stdout).toContain("offline mock");
  });
  it("applies CLI flags after file policy and supports fixture scores", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, "custom.yaml"),
      "router:\n  mock:\n    defaultProbability: 0.04\n    scores:\n      react-patterns: 0.95\n      frontend-testing: 0.91\npolicy:\n  threshold: 1\n",
    );
    const result = JSON.parse(
      (
        await run(
          [
            "route",
            "Any prompt",
            "--config",
            "custom.yaml",
            "--threshold",
            "0.9",
            "--max-skills",
            "1",
            "--json",
          ],
          ctx,
        )
      ).stdout,
    );
    expect(result.selected.map((s: { name: string }) => s.name)).toEqual([
      "react-patterns",
    ]);
    expect(result.policy).toEqual({ threshold: 0.9, maxSkills: 1 });
  });
  it("resolves --cwd before project config and discovery", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.repo, ".skilldispatch.yaml"),
      "discovery:\n  agents: [claude-code]\n",
    );
    const result = JSON.parse(
      (await run(["discover", "--cwd", "../..", "--json"], ctx)).stdout,
    );
    expect(
      result.skills.every((s: { agent: string }) => s.agent === "claude-code"),
    ).toBe(true);
    expect(
      result.skills.some(
        (s: { name: string }) => s.name === "accessibility-review",
      ),
    ).toBe(false);
  });
  it.each([
    ["discover", "--agent", "nope"],
    ["route"],
    ["route", " "],
    ["route", "test", "--threshold", "nan"],
    ["route", "test", "--max-skills", "1.5"],
    ["hook", "codex"],
  ])("rejects invalid arguments %j", async (...args) => {
    await expect(run(args, await workspace())).rejects.toThrow();
  });
  it("escapes terminal controls in metadata", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.repo, ".claude/skills/controls/SKILL.md"),
      skillText('"escape\\e[2J"'),
    );
    const result = await run(["discover", "--agent", "claude-code"], ctx);
    expect(result.stdout).not.toContain("\u001b");
    expect(terminalText("\u001b[2J")).toBe("\\u001b[2J");
  });
});

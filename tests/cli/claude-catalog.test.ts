import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { runHook } from "../../src/hooks/runtime.js";
import { skillText, workspace, write } from "../helpers.js";
import { schemaValidator } from "../telemetry/helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("NETWORK_FORBIDDEN"),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
async function fixture() {
  const ctx = await workspace();
  const config = join(ctx.root, "config");
  const installed = join(config, "plugins/cache/market/foo/v1");
  const data = join(ctx.root, "data");
  await write(
    join(config, "skills/synced/ACCOUNT_SENTINEL/pdf/SKILL.md"),
    skillText("pdf", "PRIVATE_DESCRIPTION"),
  );
  await write(
    join(installed, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "plugin" }),
  );
  await write(
    join(installed, "skills/review/SKILL.md"),
    skillText("review", "PRIVATE_DESCRIPTION"),
  );
  await write(
    join(config, "plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "foo@market": [
          { scope: "user", version: "v1", installPath: installed },
        ],
      },
    }),
  );
  await write(
    join(ctx.home, ".config/skilldispatch/config.yaml"),
    "hook: {modes: {claude: advisory}}\nrouter: {provider: mock, mock: {scores: {pdf: 0.96, review: 0.94}}}\n",
  );
  const env = {
    ...ctx,
    env: { CLAUDE_CONFIG_DIR: config, SKILLDISPATCH_DATA_DIR: data },
  };
  const cli = async (args: string[]) => {
    let stdout = "",
      stderr = "";
    await createProgram(env, {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
    }).parseAsync(args, { from: "user" });
    return { stdout, stderr };
  };
  return { ctx, env, data, cli, config };
}
describe("native Claude catalog public composition", () => {
  it("adds origin counts to discover JSON without removing existing fields", async () => {
    const f = await fixture();
    const value = JSON.parse(
      (await f.cli(["discover", "--agent", "claude-code", "--json"])).stdout,
    );
    expect(value).toMatchObject({
      skills: expect.any(Array),
      diagnostics: expect.any(Array),
      summary: {
        claudeOrigins: {
          synced: { discovered: 1, modelRoutable: 1 },
          plugin: { discovered: 1, modelRoutable: 1 },
        },
      },
    });
  });
  it("text discovery shows origins and model eligibility", async () => {
    const f = await fixture();
    const result = await f.cli(["discover", "--agent", "claude-code"]);
    expect(result.stdout).toContain(
      "Origin synced: 1 discovered, 1 model-routable",
    );
    expect(result.stdout).toContain(
      "Origin plugin: 1 discovered, 1 model-routable",
    );
  });
  it("doctor reports safe origin counts without paths or source contents", async () => {
    const f = await fixture();
    const output = (await f.cli(["doctor", "--json"])).stdout;
    expect(JSON.parse(output).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "claude_origin_synced", value: 1 }),
        expect.objectContaining({ code: "claude_origin_plugin", value: 1 }),
      ]),
    );
    expect(output).not.toMatch(
      /ACCOUNT_SENTINEL|PRIVATE_DESCRIPTION|installPath/,
    );
  });
  it("emits complete synced+plugin advisory and backward-compatible private trace", async () => {
    const f = await fixture();
    const output = await runHook(
      {
        agent: "claude-code",
        cwd: f.ctx.cwd,
        prompt: "PRIVATE_PROMPT",
        sessionId: "PRIVATE_SESSION",
      },
      f.env,
      { canAdvise: async () => true },
    );
    const value = JSON.parse(output ?? "");
    expect(value.hookSpecificOutput.additionalContext).toContain(
      "- anthropic-skills:pdf\n- plugin:review\n",
    );
    expect(output).not.toMatch(/PRIVATE_|ACCOUNT_SENTINEL|0\.96|0\.94/);
    expect(output).not.toContain(f.config);
    const trace = JSON.parse(
      (await readFile(join(f.data, "traces.jsonl"), "utf8")).trim(),
    );
    expect((await schemaValidator())(trace)).toBe(true);
    expect(trace.delivery.injectedSkillIds).toHaveLength(2);
    expect(JSON.stringify(trace)).not.toMatch(
      /PRIVATE_|ACCOUNT_SENTINEL|installPath|description/,
    );
  });
});

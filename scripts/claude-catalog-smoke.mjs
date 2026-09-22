// Explicit offline package E2E. Never uses real HOME or a live TypeSafe request.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/claude-catalog-smoke.mjs <installed CLI>",
  );
const executable = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "skilldispatch-catalog-smoke-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    data = join(root, "data");
  const config = join(home, ".claude"),
    plugins = join(root, "plugin-parent");
  const installed = join(plugins, "cache/market/tool/1.0");
  const write = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await mkdir(join(cwd, ".git"), { recursive: true });
  const skill = (name, manual = false) =>
    `---\nname: ${name}\ndescription: PRIVATE_DESCRIPTION\ndisable-model-invocation: ${manual}\n---\nPRIVATE_BODY`;
  await write(join(config, "skills/local/SKILL.md"), skill("local-display"));
  await write(
    join(cwd, ".claude/skills/project/SKILL.md"),
    skill("project-display"),
  );
  await write(
    join(config, "skills/synced/ACCOUNT_SENTINEL/pdf/SKILL.md"),
    skill("pdf"),
  );
  await write(
    join(config, "skills/synced/ACCOUNT_SENTINEL/manual/SKILL.md"),
    skill("manual", true),
  );
  await write(
    join(installed, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "codex", defaultEnabled: false }),
  );
  await write(
    join(installed, "skills/directory/SKILL.md"),
    skill("native-review"),
  );
  await write(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "tool@market": [
          { scope: "user", version: "1.0", installPath: installed },
        ],
      },
    }),
  );
  await write(
    join(
      plugins,
      "marketplaces/foo/plugins/not-installed/skills/secret/SKILL.md",
    ),
    skill("NEVER_MARKETPLACE"),
  );
  const settings = join(config, "settings.json");
  await write(
    settings,
    JSON.stringify({
      enabledPlugins: { "tool@market": true },
      env: { PRIVATE_FIELD: "PRIVATE_VALUE" },
    }),
  );
  await write(
    join(home, ".config/skilldispatch/config.yaml"),
    "hook: {modes: {claude: advisory}}\nrouter: {provider: mock, mock: {scores: {pdf: 0.98, native-review: 0.96, local-display: 0.94, project-display: 0.92}}}\n",
  );
  const preload = join(root, "isolate.mjs");
  await write(
    preload,
    `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; import {writeFileSync} from 'node:fs'; os.homedir=()=>${JSON.stringify(home)}; syncBuiltinESMExports(); globalThis.fetch=()=>{writeFileSync(${JSON.stringify(join(root, "NETWORK_ATTEMPT"))},'blocked');throw new Error('NETWORK_FORBIDDEN');};`,
  );
  const env = {
    ...process.env,
    SKILLDISPATCH_DATA_DIR: data,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins,
    NODE_OPTIONS: `--import=${preload}`,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  delete env.TYPESAFE_API_KEY;
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const invoke = (command, args, input) => {
    const result = spawnSync(command, args, {
      cwd,
      env,
      input,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const run = (args) => invoke(executable, args);
  assert.ok(run(["--help"]).includes("discover"));
  const discovered = JSON.parse(
    run(["discover", "--agent", "claude-code", "--json"]),
  );
  assert.equal(discovered.summary.discovered, 5);
  assert.equal(discovered.summary.modelRoutable, 4);
  assert.deepEqual(discovered.summary.claudeOrigins.plugin, {
    discovered: 1,
    modelRoutable: 1,
  });
  assert.deepEqual(discovered.summary.claudeOrigins.synced, {
    discovered: 2,
    modelRoutable: 1,
  });
  assert.ok(!JSON.stringify(discovered).includes("NEVER_MARKETPLACE"));
  const routed = JSON.parse(
    run(["route", "harmless fixture", "--agent", "claude-code", "--json"]),
  );
  assert.equal(routed.selected.length, 4);
  const instructionsBefore = await readFile(
    join(installed, "skills/directory/SKILL.md"),
    "utf8",
  );
  run(["hooks", "install", "claude"]);
  const status = JSON.parse(run(["hooks", "status", "claude", "--json"]))
    .hosts[0];
  assert.equal(status.execution, "sync");
  const hostSettings = JSON.parse(await readFile(settings, "utf8"));
  const handler = hostSettings.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hostSettings.enabledPlugins["tool@market"], true);
  const output = invoke(
    handler.command,
    handler.args,
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd,
      session_id: "PRIVATE_SESSION",
      prompt_id: "PRIVATE_ID",
      prompt: "PRIVATE_PROMPT",
      transcript_path: "/PRIVATE_TRANSCRIPT",
      permission_mode: "default",
    }),
  );
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.ok(
    context.includes(
      "- anthropic-skills:pdf\n- codex:native-review\n- local\n- project\n",
    ),
  );
  assert.ok(
    !output.match(
      /PRIVATE_|ACCOUNT_SENTINEL|installPath|0\.98|NEVER_MARKETPLACE/,
    ),
  );
  const traceText = await readFile(join(data, "traces.jsonl"), "utf8");
  assert.ok(
    !traceText.match(/PRIVATE_|ACCOUNT_SENTINEL|installPath|NEVER_MARKETPLACE/),
  );
  const trace = JSON.parse(traceText.trim());
  assert.equal(trace.delivery.injectedSkillIds.length, 4);
  const doctor = JSON.parse(run(["doctor", "--json"]));
  assert.ok(
    doctor.checks.some(
      (c) => c.code === "claude_origin_plugin" && c.value === 1,
    ),
  );
  assert.equal(JSON.parse(run(["traces", "summary", "--json"])).validTraces, 1);
  assert.equal(
    JSON.parse(run(["traces", "show", trace.traceId, "--json"])).trace.mode,
    "advisory",
  );
  assert.equal(
    await readFile(join(installed, "skills/directory/SKILL.md"), "utf8"),
    instructionsBefore,
  );
  assert.ok(!(await readdir(root)).includes("NETWORK_ATTEMPT"));
  console.log(
    `PASS ${process.version}: installed mixed local/project/synced/plugin discovery -> mock routing -> native advisory -> private trace/doctor/analytics; marketplace excluded, no external fetch`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

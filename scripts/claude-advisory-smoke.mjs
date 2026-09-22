// Opt-in installed-package check. Isolated user files + mock; never a live provider request.
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
    "Usage: node scripts/claude-advisory-smoke.mjs <installed .bin/skilldispatch>",
  );
const executable = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "skilldispatch-advisory-smoke-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    data = join(root, "data");
  const write = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(join(cwd, ".git"));
  const config = join(home, ".config/skilldispatch/config.yaml");
  const settings = join(home, ".claude/settings.json");
  const mode = (value) =>
    write(
      config,
      `hook: {modes: {claude: ${value}}}\nrouter: {provider: mock, mock: {scores: {display-swift: 0.95}}}`,
    );
  await mode("shadow");
  await write(
    join(cwd, ".claude/skills/swift-concurrency-expert/SKILL.md"),
    "---\nname: display-swift\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY",
  );
  await write(
    join(cwd, ".claude/settings.json"),
    '{"fixtureSentinel":"PROJECT_SENTINEL"}',
  );
  await write(
    join(cwd, ".skilldispatch.yaml"),
    "hook: {modes: {claude: advisory}}",
  );
  const initial =
    '{"env":{"SECRET":"PRIVATE_SENTINEL"},"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"unrelated-command"}]}]}}';
  await write(settings, initial);
  const preload = join(root, "isolate.mjs");
  await write(
    preload,
    `import os from 'node:os';\nimport {writeFileSync} from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nos.homedir=()=>${JSON.stringify(home)};\nsyncBuiltinESMExports();\nglobalThis.fetch=()=>{writeFileSync(${JSON.stringify(join(root, "NETWORK_ATTEMPT"))},'blocked');throw new Error('NO_NETWORK');};`,
  );
  const env = {
    ...process.env,
    SKILLDISPATCH_DATA_DIR: data,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${preload}`,
  };
  delete env.TYPESAFE_API_KEY;
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
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
    assert.ok(!result.stdout.includes("PRIVATE_"));
    return result.stdout;
  };
  const run = (args) => invoke(executable, args);
  const status = () =>
    JSON.parse(run(["hooks", "status", "claude", "--json"])).hosts[0];
  const handler = async () =>
    JSON.parse(await readFile(settings, "utf8")).hooks.UserPromptSubmit[1]
      .hooks[0];
  const wire = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    cwd,
    session_id: "PRIVATE_SESSION",
    prompt_id: "PRIVATE_ID",
    prompt: 'PRIVATE_PROMPT: Swift concurrency "quotes" \\ 日本語 —',
    transcript_path: "/PRIVATE_TRANSCRIPT",
    permission_mode: "default",
  });
  assert.ok(run(["--help"]).includes("hooks"));
  run(["hooks", "install", "claude"]);
  assert.equal(status().execution, "async");
  const shadow = await handler();
  assert.equal(invoke(shadow.command, shadow.args, wire), "");
  await mode("advisory");
  assert.equal(status().mode, "advisory");
  assert.ok(status().issues.includes("hook_execution_mismatch"));
  // Changing config alone must not deliver a late advisory from an async registration.
  assert.equal(invoke(shadow.command, shadow.args, wire), "");
  const before = await readFile(settings, "utf8");
  assert.ok(
    run(["hooks", "install", "claude", "--dry-run"]).includes("update (sync)"),
  );
  assert.equal(await readFile(settings, "utf8"), before);
  run(["hooks", "install", "claude"]);
  run(["hooks", "install", "claude"]);
  assert.equal(status().execution, "sync");
  assert.equal(status().registrations, 1);
  const advisory = await handler();
  assert.equal(advisory.async, false);
  assert.equal(advisory.timeout, 5);
  const output = JSON.parse(invoke(advisory.command, advisory.args, wire));
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(
    output.hookSpecificOutput.additionalContext.includes(
      "- swift-concurrency-expert\n",
    ),
  );
  assert.ok(
    !JSON.stringify(output).match(/display-swift|0\.95|PRIVATE_|Skill\.md/),
  );
  assert.ok(
    Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 4096,
  );
  const doctor = JSON.parse(run(["doctor", "--json"]));
  assert.equal(
    doctor.checks.find((c) => c.code === "advisory_ready").value,
    true,
  );
  const raw = await readFile(join(data, "traces.jsonl"), "utf8");
  assert.ok(!raw.includes("PRIVATE_"));
  const traces = raw
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.deepEqual(
    traces.map((t) => t.mode),
    ["shadow", "advisory", "advisory"],
  );
  assert.deepEqual(
    traces.map((t) => t.delivery.injectedSkillIds.length),
    [0, 0, 1],
  );
  const summary = JSON.parse(run(["traces", "summary", "--json"]));
  assert.equal(summary.validTraces, 3);
  assert.equal(summary.invalidLines, 0);
  assert.deepEqual(summary.advisory, { recommendedCount: 2, injectedCount: 1 });
  const show = JSON.parse(run(["traces", "show", traces[2].traceId, "--json"]));
  assert.equal(show.trace.decisions[0].injected, true);
  await mode("shadow");
  run(["hooks", "install", "claude"]);
  assert.equal(status().execution, "async");
  const restored = await handler();
  assert.equal(invoke(restored.command, restored.args, wire), "");
  assert.equal(
    await readFile(`${settings}.skilldispatch.bak`, "utf8"),
    initial,
  );
  const final = JSON.parse(await readFile(settings, "utf8"));
  assert.deepEqual(final.env, JSON.parse(initial).env);
  assert.deepEqual(
    final.hooks.UserPromptSubmit[0],
    JSON.parse(initial).hooks.UserPromptSubmit[0],
  );
  assert.equal(
    await readFile(join(cwd, ".claude/settings.json"), "utf8"),
    '{"fixtureSentinel":"PROJECT_SENTINEL"}',
  );
  assert.ok(!(await readdir(root)).includes("NETWORK_ATTEMPT"));
  console.log(
    `PASS ${process.version}: installed shadow -> advisory mismatch/no output -> sync JSON + private trace -> shadow; doctor/analytics/backup/idempotency; no external fetch or real user config mutation`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

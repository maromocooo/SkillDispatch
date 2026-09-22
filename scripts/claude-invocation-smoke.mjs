// Opt-in package E2E: generated exec-form commands, isolated HOME, no API access.
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
    "Usage: node scripts/claude-invocation-smoke.mjs <installed CLI>",
  );
const executable = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "skilldispatch-invocation-e2e-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    data = join(root, "data");
  const write = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd);
  await mkdir(join(cwd, ".git"));
  await write(
    join(home, ".config/skilldispatch/config.yaml"),
    "hook: {modes: {claude: advisory}}\nrouter: {provider: mock, mock: {scores: {jira-ticket: 0.94}}}\n",
  );
  await write(
    join(home, ".claude/skills/jira-ticket/SKILL.md"),
    "---\nname: jira-ticket\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY\n",
  );
  const settings = join(home, ".claude/settings.json");
  const original =
    '{"env":{"SECRET":"PRIVATE_ENV"},"hooks":{"PostToolUse":[{"matcher":"Skill","hooks":[{"type":"command","command":"unrelated"}]}]}}';
  await write(settings, original);
  await write(join(cwd, ".claude/settings.json"), "{}");
  const preload = join(root, "isolate.mjs");
  await write(
    preload,
    `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();globalThis.fetch=()=>{writeFileSync(${JSON.stringify(join(root, "NETWORK_ATTEMPT"))},'blocked');throw new Error('NO_NETWORK');};`,
  );
  const env = {
    ...process.env,
    SKILLDISPATCH_DATA_DIR: data,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${preload}`,
  };
  for (const key of [
    "TYPESAFE_API_KEY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  ])
    delete env[key];
  const invoke = (command, args, input) => {
    const r = spawnSync(command, args, {
      cwd,
      env,
      input,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.ok(!r.stdout.includes("PRIVATE_"));
    return r.stdout;
  };
  const run = (args) => invoke(executable, args);
  run(["hooks", "install", "claude"]);
  run(["hooks", "install", "claude"]);
  const status = JSON.parse(run(["hooks", "status", "claude", "--json"]))
    .hosts[0];
  assert.equal(status.execution, "sync");
  assert.equal(status.skillObservers.ready, true);
  const installed = JSON.parse(await readFile(settings, "utf8"));
  const handler = (event) => installed.hooks[event].at(-1).hooks[0];
  const base = {
    cwd,
    session_id: "PRIVATE_SESSION",
    prompt_id: "PRIVATE_PROMPT_ID",
    transcript_path: "/PRIVATE_TRANSCRIPT",
    permission_mode: "default",
  };
  const routing = handler("UserPromptSubmit");
  const output = JSON.parse(
    invoke(
      routing.command,
      routing.args,
      JSON.stringify({
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt: "PRIVATE_PROMPT: Help with a harmless Jira fixture.",
      }),
    ),
  );
  assert.ok(
    output.hookSpecificOutput.additionalContext.includes("- jira-ticket\n"),
  );
  const tracePath = join(data, "traces.jsonl");
  const traceText = await readFile(tracePath, "utf8");
  const trace = JSON.parse(traceText.trim());
  assert.equal(trace.capabilities.skillInvocationTelemetry, true);
  // Local registration readiness cannot prove that async hooks ran or delivered anything.
  const unobserved = JSON.parse(
    run(["traces", "summary", "--json"]),
  ).advisoryFunnel;
  assert.equal(unobserved.telemetryConfiguredTraces, 1);
  assert.equal(unobserved.recommended, 1);
  assert.equal(unobserved.injected, 1);
  assert.equal(unobserved.observedModelInvoked, 0);
  assert.equal(unobserved.observedSucceeded, 0);
  assert.equal(unobserved.injectedPairsWithoutObservedInvocation, 1);
  for (const removed of [
    "notInvoked",
    "injectedToModelInvoked",
    "modelInvokedToSucceeded",
  ])
    assert.ok(!Object.hasOwn(unobserved, removed));
  const unobservedShow = run(["traces", "show", trace.traceId]);
  assert.ok(
    unobservedShow.includes("Invocation observer: configured / best-effort"),
  );
  assert.ok(
    unobservedShow.includes("No model skill invocation event observed."),
  );
  for (const event of ["PostToolUse", "PreToolUse"]) {
    // physical completion-before-attempt regression
    const h = handler(event);
    assert.equal(h.async, true);
    assert.equal(
      invoke(
        h.command,
        h.args,
        JSON.stringify({
          ...base,
          hook_event_name: event,
          tool_name: "Skill",
          tool_use_id: "PRIVATE_TOOL",
          tool_input: { skill: "jira-ticket", args: "PRIVATE_ARGS" },
          tool_response: { text: "PRIVATE_RESPONSE" },
          error: "PRIVATE_ERROR",
          duration_ms: 17,
        }),
      ),
      "",
    );
  }
  const observer = handler("PreToolUse");
  for (const input of ["{", "x".repeat(1024 * 1024 + 1)])
    assert.equal(invoke(observer.command, observer.args, input), "");
  const raw = await readFile(join(data, "invocations.jsonl"), "utf8");
  assert.ok(!raw.includes("PRIVATE_"));
  const records = raw.trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  for (const event of records) {
    assert.equal(event.promptKey, trace.host.promptKey);
    assert.equal(event.sessionKey, trace.host.sessionKey);
    assert.equal(event.skill.resolved, true);
    assert.equal(event.skill.nativeInvocationName, "jira-ticket");
  }
  const forbidden = [
    "PRIVATE_",
    trace.host.promptKey,
    trace.host.sessionKey,
    records[0].toolUseKey,
  ];
  for (const args of [
    ["traces", "summary"],
    ["traces", "summary", "--json"],
    ["traces", "show", trace.traceId],
    ["traces", "show", trace.traceId, "--json"],
  ]) {
    const text = run(args);
    for (const item of forbidden) assert.ok(!text.includes(item));
  }
  const summary = JSON.parse(run(["traces", "summary", "--json"]));
  for (const key of [
    "recommended",
    "injected",
    "observedModelInvoked",
    "observedSucceeded",
  ])
    assert.equal(summary.advisoryFunnel[key], 1);
  assert.equal(
    summary.advisoryFunnel.injectedPairsWithoutObservedInvocation,
    0,
  );
  assert.ok(!Object.hasOwn(summary.advisoryFunnel, "injectedToModelInvoked"));
  assert.ok(!Object.hasOwn(summary.advisoryFunnel, "modelInvokedToSucceeded"));
  const show = JSON.parse(run(["traces", "show", trace.traceId, "--json"]));
  assert.equal(show.modelInvocations.calls[0].outcome, "succeeded");
  const doctor = JSON.parse(run(["doctor", "--json"]));
  assert.equal(
    doctor.checks.find((c) => c.code === "skill_invocation_telemetry_ready")
      .value,
    true,
  );
  assert.equal(await readFile(tracePath, "utf8"), traceText);
  run(["hooks", "uninstall", "claude"]);
  const after = JSON.parse(await readFile(settings, "utf8"));
  assert.deepEqual(
    after.hooks.PostToolUse,
    JSON.parse(original).hooks.PostToolUse,
  );
  assert.deepEqual(after.env, JSON.parse(original).env);
  assert.equal(
    await readFile(join(cwd, ".claude/settings.json"), "utf8"),
    "{}",
  );
  assert.ok(!(await readdir(root)).includes("NETWORK_ATTEMPT"));
  console.log(
    `PASS ${process.version}: installed advisory -> route -> reversed Skill lifecycle -> exact private correlation -> funnel/show/doctor; observers silent; no external network or real user settings mutation`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

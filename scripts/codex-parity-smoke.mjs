// Explicit package smoke: synthetic Codex wire fixtures, never a live host/model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const cli = resolve(process.argv[2]);
const contract = process.argv[3] ?? "0.155.1";
assert.ok(
  ["0.155.1", "0.156.1"].includes(contract),
  "Verified CLI fixture contract required",
);
const root = await mkdtemp(join(tmpdir(), "skilldispatch-codex-smoke-"));
let stage = "setup";
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    codex = join(root, "codex"),
    data = join(root, "data");
  const write = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await mkdir(join(cwd, ".git"), { recursive: true });
  const text = (name) =>
    `---\nname: ${name}\ndescription: Synthetic skill for local package smoke.\n---\n`;
  const local = join(cwd, ".agents/skills/review/SKILL.md");
  await write(local, text("review"));
  await write(
    join(codex, "skills/.system/system/SKILL.md"),
    text("system-demo"),
  );
  await write(join(codex, "skills/manual/SKILL.md"), text("manual"));
  await write(
    join(codex, "skills/manual/agents/openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n",
  );
  const plugin = join(codex, "plugins/cache/fixture/demo/1.0.0");
  await write(
    join(plugin, ".codex-plugin/plugin.json"),
    '{"name":"demo","skills":"./skills"}',
  );
  await write(join(plugin, "skills/check/SKILL.md"), text("check"));
  await write(
    join(
      codex,
      "plugins/cache/fixture/unconfigured/1.0.0/skills/secret/SKILL.md",
    ),
    text("not-active"),
  );
  await write(
    join(codex, "config.toml"),
    '[plugins."demo@fixture"]\nenabled=true\n',
  );
  const original = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "unrelated" }] },
      ],
    },
  };
  const settings = join(codex, "hooks.json");
  await write(settings, JSON.stringify(original));
  const claude = join(home, ".claude/settings.json");
  await write(claude, '{"fixture":"untouched"}');
  const userConfig = join(home, ".config/skilldispatch/config.yaml");
  const configure = (mode) =>
    write(
      userConfig,
      `hook:\n  codexContract: "${contract}"\n  modes: {codex: ${mode}}\nrouter: {provider: mock, mock: {defaultProbability: 0.95}}\n`,
    );
  await configure("shadow");
  const preload = join(root, "isolate.mjs");
  await write(
    preload,
    `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();globalThis.fetch=()=>{writeFileSync(${JSON.stringify(join(root, "network-attempt"))},'blocked');throw Error('NETWORK_FORBIDDEN');};`,
  );
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    SKILLDISPATCH_DATA_DIR: data,
    NODE_OPTIONS: `--import=${preload}`,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  delete env.TYPESAFE_API_KEY;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const invoke = (command, args, input) => {
    const r = spawnSync(command, args, {
      cwd,
      env,
      input,
      encoding: "utf8",
      timeout: 12000,
    });
    assert.equal(r.status, 0, `${stage}: process exit`);
    assert.equal(r.stderr, "", `${stage}: stderr`);
    return r.stdout;
  };
  const run = (...args) => invoke(cli, args);
  const wire = {
    session_id: "synthetic-session",
    turn_id: "synthetic-turn",
    cwd,
    model: "fixture",
    permission_mode: "default",
    transcript_path: null,
    hook_event_name: "UserPromptSubmit",
    prompt: "Review this synthetic task",
  };
  const status = () =>
    JSON.parse(run("hooks", "status", "codex", "--json")).hosts[0];
  const hook = (host, input) =>
    invoke(cli, ["hook", host], JSON.stringify(input));
  stage = "mixed catalog";
  const catalog = JSON.parse(run("discover", "--agent", "codex", "--json"));
  assert.equal(catalog.summary.discovered, 4);
  assert.equal(catalog.summary.modelRoutable, 3);
  assert.ok(!catalog.skills.some((s) => s.name === "not-active"));
  stage = "shadow registration";
  run("hooks", "install", "codex");
  assert.equal(status().execution, "async");
  assert.equal(hook("codex", { ...wire, turn_id: "shadow-turn" }), "");
  const routing = () =>
    readFile(join(data, "traces.jsonl"), "utf8").then((text) =>
      text.trim().split("\n").map(JSON.parse),
    );
  assert.equal((await routing())[0].mode, "shadow");
  stage = "opt-in and mismatch";
  await configure("advisory");
  assert.ok(status().issues.includes("hook_execution_mismatch"));
  assert.equal(hook("codex", { ...wire, turn_id: "mismatch-turn" }), "");
  stage = "reconcile sync";
  run("hooks", "install", "codex");
  assert.equal(status().execution, "sync");
  assert.equal(status().instructionObservers.ready, true);
  const registrations = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(registrations.hooks.PostToolUseFailure, undefined);
  for (const name of ["PreToolUse", "PostToolUse"]) {
    assert.equal(registrations.hooks[name][0].matcher, "Bash");
    assert.equal(registrations.hooks[name][0].hooks[0].async, true);
  }
  stage = "user trust metadata leaves registration ready";
  const hostConfig = join(codex, "config.toml");
  const configBeforeTrust = await readFile(hostConfig, "utf8");
  // Simulate only Codex's state write; do not compute or verify a real trust hash.
  const trustedConfig =
    configBeforeTrust +
    [
      ["UserPromptSubmit", "user_prompt_submit", 1],
      ["PreToolUse", "pre_tool_use", 0],
      ["PostToolUse", "post_tool_use", 0],
    ]
      .map(
        ([, label, group]) =>
          `\n[hooks.state.${JSON.stringify(`${settings}:${label}:${group}:0`)}]\ntrusted_hash="sha256:synthetic"\nenabled=true\n`,
      )
      .join("");
  await write(hostConfig, trustedConfig);
  assert.equal(status().registration, "installed");
  assert.equal(status().execution, "sync");
  assert.equal(status().instructionObservers.ready, true);
  assert.deepEqual(status().issues, ["codex_host_trust_not_verified"]);
  const doctorAfterTrust = JSON.parse(run("doctor", "--json"));
  for (const code of [
    "codex_advisory_ready",
    "codex_instruction_read_telemetry_ready",
  ])
    assert.equal(
      doctorAfterTrust.checks.find((c) => c.code === code).value,
      true,
    );
  run("hooks", "install", "codex");
  assert.equal(await readFile(hostConfig, "utf8"), trustedConfig);
  stage = "same-turn advisory";
  const output = hook("codex", wire),
    context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.ok(
    context.includes("review") &&
      context.includes("demo:check") &&
      context.includes("Continue the original task"),
  );
  assert.ok(Buffer.byteLength(context) <= 4096);
  assert.ok(!context.includes(root));
  const trace = (await routing()).at(-1);
  assert.equal(trace.schemaVersion, "2.0");
  assert.equal(trace.delivery.kind, "codex-advisory");
  stage = "synthetic read lifecycle";
  const tool = {
    ...wire,
    hook_event_name: "PreToolUse",
    tool_use_id: "synthetic-tool",
    tool_name: "Bash",
    tool_input: { command: `cat '${local}'` },
  };
  for (const event of ["PostToolUse", "PreToolUse"]) {
    const registration = registrations.hooks[event][0].hooks[0];
    assert.equal(
      invoke(
        "/bin/sh",
        ["-c", registration.command],
        JSON.stringify({
          ...tool,
          hook_event_name: event,
          tool_response: "PRIVATE_OUTPUT",
        }),
      ),
      "",
    );
  }
  const observed = await readFile(
    join(data, "codex-instruction-reads.jsonl"),
    "utf8",
  );
  assert.ok(
    !observed.includes(root) &&
      !observed.includes("PRIVATE_OUTPUT") &&
      !observed.includes("synthetic-tool"),
  );
  const events = observed.trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.sessionKey, trace.host.sessionKey);
    assert.equal(e.promptKey, trace.host.promptKey);
    assert.equal(e.outcome, "unknown");
  }
  stage = "trace JSON/text evidence separation";
  const shown = JSON.parse(run("traces", "show", trace.traceId, "--json"));
  assert.equal(shown.version, 2);
  assert.equal(shown.instructionReads.calls[0].attemptObserved, true);
  assert.equal(shown.instructionReads.calls[0].terminalObserved, true);
  assert.equal(shown.instructionReads.calls[0].outcome, "unknown");
  const display = run("traces", "show", trace.traceId);
  assert.ok(display.includes("Codex instruction-read evidence"));
  assert.ok(!display.includes("Model skill invocations observed:"));
  const summary = JSON.parse(
    run("traces", "summary", "--agent", "codex", "--json"),
  );
  assert.equal(summary.instructionReads.observedInstructionReadAttemptPairs, 1);
  assert.equal(summary.instructionReads.observedTerminalEventPairs, 1);
  assert.equal(summary.advisoryFunnel.observedModelInvoked, 0);
  assert.ok(
    run("traces", "summary", "--agent", "codex").includes(
      "Observed read attempts",
    ),
  );
  assert.ok(run("traces", "list", "--agent", "codex").includes(trace.traceId));
  stage = "host disablement blocks advisory without changing state";
  const disabledRouting = trustedConfig.replace(
    `${JSON.stringify(`${settings}:user_prompt_submit:1:0`)}]\ntrusted_hash="sha256:synthetic"\nenabled=true`,
    `${JSON.stringify(`${settings}:user_prompt_submit:1:0`)}]\ntrusted_hash="sha256:synthetic"\nenabled=false`,
  );
  assert.notEqual(disabledRouting, trustedConfig);
  await write(hostConfig, disabledRouting);
  assert.ok(status().issues.includes("codex_hook_disabled_by_host"));
  assert.equal(
    JSON.parse(run("doctor", "--json")).checks.find(
      (c) => c.code === "codex_advisory_ready",
    ).value,
    false,
  );
  assert.equal(hook("codex", { ...wire, turn_id: "host-disabled" }), "");
  assert.equal(await readFile(hostConfig, "utf8"), disabledRouting);
  await write(hostConfig, trustedConfig);
  stage = "host observer disablement remains separate from routing";
  const disabledObserver = trustedConfig.replace(
    `${JSON.stringify(`${settings}:pre_tool_use:0:0`)}]\ntrusted_hash="sha256:synthetic"\nenabled=true`,
    `${JSON.stringify(`${settings}:pre_tool_use:0:0`)}]\ntrusted_hash="sha256:synthetic"\nenabled=false`,
  );
  assert.notEqual(disabledObserver, trustedConfig);
  await write(hostConfig, disabledObserver);
  assert.equal(status().instructionObservers.ready, false);
  assert.ok(status().issues.includes("codex_pre_tool_use_disabled_by_host"));
  const disabledDoctor = JSON.parse(run("doctor", "--json"));
  assert.equal(
    disabledDoctor.checks.find(
      (c) => c.code === "codex_instruction_read_telemetry_ready",
    ).value,
    false,
  );
  assert.equal(
    disabledDoctor.checks.find((c) => c.code === "codex_advisory_ready").value,
    true,
  );
  assert.ok(
    JSON.parse(hook("codex", { ...wire, turn_id: "observer-disabled" }))
      .hookSpecificOutput.additionalContext,
  );
  assert.notEqual(
    (await routing()).at(-1).capabilities?.skillInstructionReadTelemetry,
    true,
  );
  await write(hostConfig, trustedConfig);
  stage = "rollback and uninstall";
  await configure("shadow");
  run("hooks", "install", "codex");
  assert.equal(status().execution, "async");
  assert.equal(hook("codex", { ...wire, turn_id: "rollback" }), "");
  run("hooks", "uninstall", "codex");
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), original);
  assert.equal(await readFile(hostConfig, "utf8"), trustedConfig);
  assert.equal(await readFile(claude, "utf8"), '{"fixture":"untouched"}');
  await assert.rejects(access(join(root, "network-attempt")));
  console.log(
    `PASS ${process.version}: installed Codex ${contract} catalog/shadow/advisory/trust-state/disablement/read-evidence/correlation/JSON/text/rollback; synthetic fixtures only; no model API`,
  );
} catch (error) {
  console.error(
    `Codex package smoke failed at ${stage}: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : "local operation failed"}`,
  );
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

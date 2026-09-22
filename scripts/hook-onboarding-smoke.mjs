// Explicit installed-package smoke. Isolated home, no real host settings or provider requests.
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
    "Usage: node scripts/hook-onboarding-smoke.mjs <installed .bin/skilldispatch>",
  );
const executable = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "skilldispatch-onboarding-smoke-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    data = join(root, "data");
  for (const path of [home, cwd]) await mkdir(path, { mode: 0o700 });
  const write = async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await mkdir(join(cwd, ".git"));
  const projectPaths = [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".claude/settings.json",
  ].map((path) => join(cwd, path));
  for (const path of projectPaths) await write(path, "PROJECT_SENTINEL");
  await write(
    join(home, ".config/skilldispatch/config.yaml"),
    "router:\n  provider: mock\n",
  );
  for (const host of [".agents", ".claude"])
    await write(
      join(cwd, host, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n",
    );
  const preload = join(root, "isolate.mjs");
  await writeFile(
    preload,
    `import os from 'node:os';\nimport {writeFileSync} from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nos.homedir = () => ${JSON.stringify(home)};\nsyncBuiltinESMExports();\nglobalThis.fetch = () => {writeFileSync(${JSON.stringify(join(root, "network-attempt"))}, 'blocked'); throw new Error('NETWORK_FORBIDDEN');};\n`,
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
  const invoke = (command, args, input) => {
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      input,
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.ok(!(result.stdout + result.stderr).includes("PRIVATE_SENTINEL"));
    assert.equal(
      result.status,
      0,
      `Unexpected command failure: ${result.stderr}`,
    );
    return result.stdout;
  };
  const run = (args) => invoke(executable, args);
  assert.ok(run(["--help"]).includes("hooks"));
  assert.equal(JSON.parse(run(["hooks", "status", "--json"])).hosts.length, 2);
  assert.equal(
    JSON.parse(run(["doctor", "--json"])).checks.find(
      (c) => c.code === "routing_ready",
    ).value,
    true,
  );
  const emptyHome = await readdir(home);
  for (const host of ["codex", "claude"]) {
    run(["hooks", "install", host, "--dry-run"]);
    assert.deepEqual(await readdir(home), emptyHome);
  }
  for (const host of ["codex", "claude"]) {
    const path = join(
      home,
      host === "codex" ? ".codex/hooks.json" : ".claude/settings.json",
    );
    const initial = JSON.stringify({
      model: "kept",
      env: { SECRET: "PRIVATE_SENTINEL" },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "PRIVATE_SENTINEL" }] }],
      },
    });
    await write(path, initial);
    run(["hooks", "install", host]);
    const installed = await readFile(path, "utf8");
    run(["hooks", "install", host]);
    assert.equal(await readFile(path, "utf8"), installed);
    assert.equal(await readFile(`${path}.skilldispatch.bak`, "utf8"), initial);
    const status = JSON.parse(run(["hooks", "status", host, "--json"]))
      .hosts[0];
    assert.equal(status.registration, "installed");
    assert.equal(status.execution, "async");
    const handler = JSON.parse(installed).hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(handler.async, true);
    assert.equal(handler.timeout, 5);
    const payload = JSON.stringify({
      cwd,
      hook_event_name: "UserPromptSubmit",
      session_id: "PRIVATE_SENTINEL_SESSION",
      prompt: "Review code PRIVATE_SENTINEL",
      transcript_path: "/NEVER_READ_PRIVATE_SENTINEL",
      permission_mode: "default",
      ...(host === "codex"
        ? { turn_id: "PRIVATE_SENTINEL_TURN", model: "fixture" }
        : { prompt_id: "PRIVATE_SENTINEL_PROMPT" }),
    });
    // Execute exactly the host registration. This does not simulate the host async lifecycle.
    const output =
      host === "claude"
        ? invoke(handler.command, handler.args, payload)
        : invoke("/bin/sh", ["-c", handler.command], payload);
    assert.equal(output, "");
    run(["hooks", "install", host, "--sync"]);
    assert.equal(
      JSON.parse(run(["hooks", "status", host, "--json"])).hosts[0].execution,
      "sync",
    );
    const sync = await readFile(path, "utf8");
    run(["hooks", "uninstall", host, "--dry-run"]);
    assert.equal(await readFile(path, "utf8"), sync);
    run(["hooks", "uninstall", host]);
    run(["hooks", "uninstall", host]);
    const removed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(removed.hooks.Stop, JSON.parse(initial).hooks.Stop);
    assert.deepEqual(removed.env, JSON.parse(initial).env);
    assert.equal(removed.model, "kept");
    assert.deepEqual(removed.hooks.UserPromptSubmit, []);
    assert.equal(await readFile(`${path}.skilldispatch.bak`, "utf8"), initial);
    assert.equal(
      JSON.parse(run(["hooks", "status", host, "--json"])).hosts[0]
        .registration,
      "not-installed",
    );
  }
  const raw = await readFile(join(data, "traces.jsonl"), "utf8");
  assert.ok(!raw.includes("PRIVATE_SENTINEL"));
  const traces = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(traces.length, 2);
  assert.deepEqual(
    traces.map((t) => t.agent),
    ["codex", "claude-code"],
  );
  for (const trace of traces) {
    assert.equal(trace.router.provider, "mock");
    assert.equal(trace.outcome, "complete");
    assert.equal(trace.mode, "shadow");
    assert.equal(trace.prompt.storage, "hash");
    assert.ok(trace.decisions.length > 0);
  }
  assert.equal(JSON.parse(run(["traces", "summary", "--json"])).validTraces, 2);
  for (const path of projectPaths)
    assert.equal(await readFile(path, "utf8"), "PROJECT_SENTINEL");
  assert.ok(!(await readdir(root)).includes("network-attempt"));
  console.log(
    `PASS ${process.version}: installed registration status/install/uninstall/dry-run/sync; generated Codex and Claude commands -> silent exit 0 + two mock traces; backup/settings preserved; no project/real-user mutation or external fetch`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

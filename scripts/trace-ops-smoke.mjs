// Explicit, offline smoke for an already installed package. Never run by test/prepack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

const cli = process.argv[2];
if (!cli)
  throw new Error(
    "Usage: node scripts/trace-ops-smoke.mjs <installed node_modules/.bin/skilldispatch>",
  );
const executable = resolve(cli);
const root = await mkdtemp(join(tmpdir(), "skilldispatch-ops-smoke-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    data = join(root, "data");
  for (const p of [home, cwd, data]) await mkdir(p, { mode: 0o700 });
  const write = async (p, text) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
  };
  await mkdir(join(cwd, ".git"));
  await write(
    join(home, ".config/skilldispatch/config.yaml"),
    "router:\n  provider: mock\n",
  );
  for (const host of [".agents", ".claude"])
    await write(
      join(cwd, host, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n",
    );
  // Test-only homedir override; never alter HOME or real user config files.
  const preload = join(root, "isolate.mjs");
  await writeFile(
    preload,
    `import os from 'node:os';\nimport {writeFileSync} from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nos.homedir = () => ${JSON.stringify(home)};\nsyncBuiltinESMExports();\nglobalThis.fetch = () => {writeFileSync(${JSON.stringify(join(root, "network-attempt"))}, 'blocked'); throw new Error('NETWORK_FORBIDDEN');};\n`,
  );
  const env = {
    ...process.env,
    SKILLDISPATCH_DATA_DIR: data,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${preload}`,
  };
  delete env.TYPESAFE_API_KEY;
  delete env.CODEX_HOME;
  const run = (args, input) => {
    const result = spawnSync(executable, args, {
      cwd,
      env,
      encoding: "utf8",
      input,
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    for (const secret of [
      "PRIVATE_RAW_PROMPT_SENTINEL",
      "PRIVATE_API_KEY_SENTINEL",
      "sessionKey",
      "promptKey",
    ])
      assert.ok(!(result.stdout + result.stderr).includes(secret));
    return result;
  };
  assert.equal(run(["--help"]).status, 0);
  const doctor = run(["doctor", "--json"]);
  assert.equal(doctor.status, 0);
  const health = JSON.parse(doctor.stdout);
  assert.equal(health.usable, true);
  assert.equal(
    health.checks.find((c) => c.code === "trace_schema").status,
    "PASS",
  );
  assert.deepEqual(await readdir(data), []);
  const fixture = {
    schemaVersion: "1.0",
    traceId: randomUUID(),
    timestamp: new Date().toISOString(),
    agent: "codex",
    mode: "shadow",
    prompt: { storage: "raw", raw: "PRIVATE_RAW_PROMPT_SENTINEL" },
    host: {
      event: "UserPromptSubmit",
      sessionKey: "a".repeat(64),
      promptKey: "b".repeat(64),
    },
    catalog: {
      fingerprint: "c".repeat(64),
      skillCount: 1,
      enabledSkillCount: 1,
    },
    router: { provider: "mock", model: "fixture", latencyMs: 12 },
    policy: { threshold: 0.75, maxSkills: 4 },
    outcome: "complete",
    decisions: [
      {
        skillId: "d".repeat(64),
        name: "review",
        agent: "codex",
        scope: "repo",
        contentHash: "e".repeat(64),
        probability: 0.9,
        selected: true,
      },
    ],
    diagnostics: [],
  };
  const path = join(data, "traces.jsonl");
  const source = `${JSON.stringify(fixture)}\ninvalid\n`;
  await writeFile(path, source, { mode: 0o600 });
  for (const command of [
    ["doctor"],
    ["traces", "summary"],
    ["traces", "list"],
    ["traces", "show", fixture.traceId],
  ]) {
    for (const suffix of [[], ["--json"]]) {
      const result = run([...command, ...suffix]);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      if (suffix.length) assert.equal(JSON.parse(result.stdout).version, 1);
    }
  }
  assert.equal(
    JSON.parse(run(["traces", "summary", "--json"]).stdout).invalidLines,
    1,
  );
  assert.equal(run(["traces", "show", randomUUID()]).status, 1);
  assert.equal(run(["traces", "list", "--limit", "0"]).status, 1);
  assert.equal(run(["traces", "summary", "--since", "wrong"]).status, 1);
  assert.equal(await readFile(path, "utf8"), source);
  await writeFile(
    path,
    `${JSON.stringify(fixture)}\n${JSON.stringify(fixture)}\n`,
  );
  assert.equal(run(["traces", "show", fixture.traceId]).status, 1);
  await writeFile(path, source);
  // Existing commands continue working and never persist traces.
  assert.equal(run(["discover", "--json"]).status, 0);
  assert.equal(run(["route", "Review code", "--json"]).status, 0);
  await write(
    join(cwd, "eval.yaml"),
    "version: 1\ncases:\n  - id: smoke\n    prompt: Review code\n",
  );
  assert.equal(run(["eval", "eval.yaml", "--json"]).status, 0);
  assert.equal(await readFile(path, "utf8"), source);
  // Both hook entry points remain silent and append valid traces.
  for (const host of ["codex", "claude"]) {
    const payload = {
      cwd,
      session_id: "private-session",
      hook_event_name: "UserPromptSubmit",
      prompt: "Review code",
      transcript_path: "/NEVER_READ",
      permission_mode: "default",
      ...(host === "codex"
        ? { turn_id: "private-turn", model: "fixture" }
        : { prompt_id: "private-submission" }),
    };
    const result = run(["hook", host], JSON.stringify(payload));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.equal(
    JSON.parse(run(["traces", "summary", "--json"]).stdout).validTraces,
    3,
  );
  await write(
    join(home, ".config/skilldispatch/config.yaml"),
    "router: [PRIVATE_API_KEY_SENTINEL",
  );
  assert.equal(run(["doctor", "--json"]).status, 1);
  assert.ok(!(await readdir(root)).includes("network-attempt"));
  console.log(
    `PASS ${process.version}: installed doctor/traces, privacy, safe exits, no writes/network, discover/route/eval and silent hooks`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

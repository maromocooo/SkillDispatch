// Fixture-only regression. Uses real HOME resolution; never monkey-patches os.homedir.
// Optional second CLI argument compares the already-installed 0.1.0 package offline.
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

const candidate = resolve(process.argv[2]);
const legacy = process.argv[3] && resolve(process.argv[3]);
const root = await mkdtemp(join(tmpdir(), "sd-profile-isolation-"));
let stage = "setup";
try {
  const write = async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600 });
  };
  const cwd = join(root, "synthetic-repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await write(
    join(cwd, ".agents/skills/sample/SKILL.md"),
    "---\nname: sample\ndescription: Summarize a synthetic memo.\n---\nUse a synthetic format.\n",
  );
  const oldEntry = join(root, "review-checkout/dist/cli/index.js");
  await write(
    oldEntry,
    "// Registration-only legacy checkout fixture; never executed.\n",
  );
  const oldHandler = {
    type: "command",
    command: `'/usr/bin/env' 'node' '${oldEntry}' 'hook' 'codex'`,
    async: true,
  };
  assert.ok(!oldHandler.command.toLowerCase().includes("skilldispatch"));
  const hooks = JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [oldHandler] }] },
  });
  const config = (mode) =>
    `hook:\n  trustProjectConfig: false\n  codexContract: "0.155.1"\n  modes: {claude: shadow, codex: ${mode}}\ntelemetry: {enabled: true, prompt: hash}\nrouter: {provider: mock, mock: {defaultProbability: 0.95}}\n`;
  const guard = join(root, "deny-network.mjs");
  await write(
    guard,
    `import {writeFileSync} from 'node:fs';globalThis.fetch=()=>{writeFileSync(${JSON.stringify(join(root, "network-attempt"))},'blocked');throw Error('NETWORK_FORBIDDEN');};`,
  );
  const profile = async (name, mode) => {
    const base = join(root, name),
      home = join(base, "home"),
      codex = join(base, "codex"),
      data = join(base, "data");
    for (const path of [home, codex, data])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const userConfig = join(home, ".config/skilldispatch/config.yaml");
    await write(userConfig, config(mode));
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: codex,
      SKILLDISPATCH_DATA_DIR: data,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CLAUDE_CODE_PLUGIN_CACHE_DIR: join(home, ".claude/plugins"),
      NODE_OPTIONS: `--import=${guard}`,
    };
    return { base, home, codex, data, userConfig, env };
  };
  const old = await profile("stable", "shadow");
  const isolated = await profile("candidate", "advisory");
  const mixed = await profile("unsafe-shared-fixture", "shadow");
  await write(join(old.codex, "hooks.json"), hooks);
  await write(join(mixed.codex, "hooks.json"), hooks);
  const protectedFiles = [
    old.userConfig,
    join(old.codex, "hooks.json"),
    join(old.home, ".claude/settings.json"),
    join(old.data, "traces.jsonl"),
    join(old.data, "install.key"),
  ];
  await write(protectedFiles[2], '{"fixture":"old-claude"}');
  await write(protectedFiles[3], "");
  await write(protectedFiles[4], Buffer.alloc(32, 17));
  const before = await Promise.all(protectedFiles.map((p) => readFile(p)));
  const invoke = (exe, args, p, input, expected = 0) => {
    const r = spawnSync(exe, args, {
      env: p.env,
      cwd,
      input,
      encoding: "utf8",
      timeout: 12000,
    });
    assert.equal(r.status, expected, `${stage}: exit`);
    if (expected === 0) assert.equal(r.stderr, "", `${stage}: stderr`);
    return r.stdout;
  };
  const run = (p, ...args) => invoke(candidate, args, p);
  for (const p of [old, isolated, mixed]) {
    stage = "real HOME resolution";
    assert.equal(
      invoke(
        process.execPath,
        ["-p", "require('node:os').homedir()"],
        p,
      ).trim(),
      p.home,
    );
  }
  stage = "unrecognized legacy registration does not migrate";
  assert.notEqual(candidate, oldEntry);
  run(mixed, "hooks", "install", "codex");
  const both = JSON.parse(
    await readFile(join(mixed.codex, "hooks.json"), "utf8"),
  ).hooks.UserPromptSubmit;
  assert.equal(both.length, 2);
  assert.deepEqual(both[0].hooks[0], oldHandler);
  stage = "isolated profile paths";
  const doctor = JSON.parse(run(isolated, "doctor", "--json"));
  const check = (code) => doctor.checks.find((c) => c.code === code);
  assert.equal(check("user_config").value, isolated.userConfig);
  assert.equal(check("data_directory").value, isolated.data);
  assert.equal(
    check("trace_destination").value,
    join(isolated.data, "traces.jsonl"),
  );
  let status = JSON.parse(run(isolated, "hooks", "status", "codex", "--json"))
    .hosts[0];
  // Status uses a generic default-root display label; inspect the actual mutation plan.
  const dryRun = run(isolated, "hooks", "install", "codex", "--dry-run");
  assert.ok(dryRun.includes(`Config: ${join(isolated.codex, "hooks.json")}`));
  assert.deepEqual(await readdir(isolated.codex), []);
  run(isolated, "hooks", "install", "codex");
  status = JSON.parse(run(isolated, "hooks", "status", "codex", "--json"))
    .hosts[0];
  assert.equal(status.registrations, 1);
  assert.equal(status.execution, "sync");
  stage = "fixture plumbing writes only isolated data";
  const wire = {
    cwd,
    session_id: "fixture-session",
    transcript_path: join(root, "never-read"),
    permission_mode: "default",
    turn_id: "fixture-turn",
    model: "fixture",
    hook_event_name: "UserPromptSubmit",
    prompt: "Summarize a synthetic memo",
  };
  assert.ok(
    JSON.parse(
      invoke(candidate, ["hook", "codex"], isolated, JSON.stringify(wire)),
    ).hookSpecificOutput.additionalContext,
  );
  assert.equal(
    JSON.parse(
      (await readFile(join(isolated.data, "traces.jsonl"), "utf8")).trim(),
    ).schemaVersion,
    "2.0",
  );
  assert.notDeepEqual(
    await readFile(join(isolated.data, "install.key")),
    before[4],
  );
  if (legacy) {
    stage =
      "real 0.1.0 rejects new config without breaking its separate profile";
    assert.equal(invoke(legacy, ["--version"], old).trim(), "0.1.0");
    assert.notEqual(legacy, candidate);
    assert.equal(
      JSON.parse(invoke(legacy, ["doctor", "--json"], old)).usable,
      true,
    );
    const rejected = JSON.parse(
      invoke(legacy, ["doctor", "--json"], isolated, undefined, 1),
    );
    assert.ok(
      rejected.checks.some((c) => c.code === "config" && c.status === "FAIL"),
    );
    // Old Claude entrypoint sees the invalid shared config too: silent fail-open, no trace.
    const snapshot = await readFile(join(isolated.data, "traces.jsonl"));
    assert.equal(
      invoke(
        legacy,
        ["hook", "claude"],
        isolated,
        JSON.stringify({ ...wire, prompt_id: "fixture-prompt" }),
      ),
      "",
    );
    assert.deepEqual(
      await readFile(join(isolated.data, "traces.jsonl")),
      snapshot,
    );
    assert.equal(
      JSON.parse(invoke(legacy, ["doctor", "--json"], old)).usable,
      true,
    );
  }
  stage = "stable profile unchanged";
  for (let i = 0; i < protectedFiles.length; i++)
    assert.deepEqual(await readFile(protectedFiles[i]), before[i]);
  assert.ok(!(await readdir(root)).includes("network-attempt"));
  console.log(
    `PASS ${process.version}: real HOME/config/host/data isolation; neutral-path duplicate risk retained; ${legacy ? "real 0.1.0 compatibility compared" : "legacy registration fixture only"}; fixture plumbing, no live host/API`,
  );
} catch {
  console.error(
    `Profile isolation smoke failed at ${stage}; raw configuration/output withheld.`,
  );
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

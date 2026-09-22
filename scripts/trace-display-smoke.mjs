// Synthetic, isolated installed-CLI checks. --pty requires Python 3 on POSIX.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(process.argv[2]);
const ptyMode = process.argv.includes("--pty");
const examplesIndex = process.argv.indexOf("--examples");
const examples =
  examplesIndex < 0 ? undefined : resolve(process.argv[examplesIndex + 1]);
const fixtures = new URL("../tests/fixtures/trace-display/", import.meta.url);
const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`${name}.json`, fixtures), "utf8"));
const dataset = await fixture("dataset");
const root = await mkdtemp(join(tmpdir(), "skilldispatch-display-smoke-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "repo"),
    data = join(root, "data");
  for (const dir of [home, cwd, data]) await mkdir(dir, { mode: 0o700 });
  const traces =
    dataset.traces.map((t) => `${JSON.stringify(t)}\n`).join("") +
    "invalid synthetic line\n";
  const events = dataset.events.map((e) => `${JSON.stringify(e)}\n`).join("");
  await writeFile(join(data, "traces.jsonl"), traces, { mode: 0o600 });
  await writeFile(join(data, "invocations.jsonl"), events, { mode: 0o600 });
  const terminalState = join(root, "terminal.json"),
    preload = join(root, "isolate.mjs");
  await writeFile(
    preload,
    `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {writeFileSync} from 'node:fs';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();writeFileSync(${JSON.stringify(terminalState)},JSON.stringify({isTTY:process.stdout.isTTY===true,columns:process.stdout.columns}));globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};`,
  );
  const env = {
    ...process.env,
    SKILLDISPATCH_DATA_DIR: data,
    NODE_OPTIONS: `--import=${preload}`,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  for (const key of [
    "TYPESAFE_API_KEY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_PLUGIN_CACHE_DIR",
    "NO_COLOR",
  ])
    delete env[key];
  const forbidden = [
    "PRIVATE_",
    "sessionKey",
    "promptKey",
    "toolUseKey",
    ...dataset.traces.map((t) => t.host.promptKey),
    dataset.events[0].toolUseKey,
    dataset.events[0].sessionKey,
  ];
  const run = async (args, columns, overrides = {}) => {
    const options = {
      cwd,
      env: { ...env, TERM: "xterm-256color", ...overrides },
      encoding: "utf8",
      timeout: 15000,
    };
    const result =
      columns === undefined
        ? spawnSync(cli, ["traces", ...args], options)
        : spawnSync(
            "python3",
            [fileURLToPath(new URL("./pty-command.py", import.meta.url))],
            {
              ...options,
              input: JSON.stringify({
                argv: [cli, "traces", ...args],
                columns,
              }),
            },
          );
    assert.equal(result.status, 0, "Trace display smoke command failed");
    assert.equal(result.stderr, "");
    for (const secret of forbidden)
      assert.ok(!result.stdout.includes(secret), "Privacy sentinel leaked");
    assert.ok(
      !/[\p{Cc}\p{Cf}]/u.test(result.stdout.replaceAll("\n", "")),
      `Terminal control/tab leaked: ${JSON.stringify([...result.stdout.replaceAll("\n", "")].filter((c) => /[\p{Cc}\p{Cf}]/u.test(c)).map((c) => c.codePointAt(0)))}`,
    );
    const state = JSON.parse(await readFile(terminalState, "utf8"));
    assert.equal(state.isTTY, columns !== undefined);
    if (columns !== undefined) assert.equal(state.columns, columns);
    return result.stdout;
  };
  const cases = [
    ["list", ["list"]],
    ["summary", ["summary"]],
    ["show", ["show", dataset.traces[0].traceId]],
    ["zero", ["show", dataset.traces[1].traceId]],
  ];
  for (const [name, args] of cases) {
    const json = await run([...args, "--json"]);
    assert.deepEqual(JSON.parse(json), await fixture(`expected-${name}`));
    const text = await run(args);
    assert.ok(text.length > 0);
    if (name === "list") {
      assert.ok(text.includes(`Trace ${dataset.traces[0].traceId}`));
      assert.ok(text.includes("842.48 ms"));
    }
    if (name === "show") {
      assert.ok(text.includes("Recommended: 2"));
      assert.ok(text.includes("Injected: 1"));
      assert.ok(text.includes("succeeded"));
      assert.ok(text.includes("0.9400"));
    }
    if (name === "zero")
      assert.ok(text.includes("No skill recommendation selected."));
    if (name === "summary")
      assert.ok(text.includes("Observed model-invoked: 1"));
  }
  if (ptyMode) {
    assert.notEqual(process.platform, "win32", "PTY smoke requires POSIX");
    if (examples) await mkdir(examples, { recursive: true });
    for (const columns of [80, 100, 120, 160]) {
      for (const [name, args] of cases) {
        const text = await run(args, columns);
        if (name === "list") {
          for (const t of dataset.traces) assert.ok(text.includes(t.traceId));
          assert.equal(text.includes("Trace ID"), columns === 160);
        }
        assert.deepEqual(
          JSON.parse(await run([...args, "--json"], columns)),
          await fixture(`expected-${name}`),
        );
        if (examples)
          await writeFile(join(examples, `${name}-${columns}.txt`), text);
      }
    }
    assert.ok(
      (await run(["list"], 160, { NO_COLOR: "1" })).includes("Trace ID"),
    );
    const dumb = await run(["list"], 160, { TERM: "dumb" });
    assert.ok(dumb.includes(`Trace ${dataset.traces[0].traceId}`));
    assert.ok(!/^-+$/m.test(dumb));
  }
  assert.equal(await readFile(join(data, "traces.jsonl"), "utf8"), traces);
  assert.equal(await readFile(join(data, "invocations.jsonl"), "utf8"), events);
  console.log(
    `PASS ${process.version}: trace display / baseline JSON / privacy / read-only; pipe${ptyMode ? "; real PTY 80/100/120/160, NO_COLOR, TERM=dumb, open stdin" : "; PTY not run"}`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

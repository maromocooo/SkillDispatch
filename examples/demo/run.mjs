// Explicit mock CLI demo in an isolated temporary installation; no API key needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "skilldispatch-public-demo-"));
try {
  const home = join(root, "home"),
    cwd = join(root, "project");
  await mkdir(join(home, ".config/skilldispatch"), { recursive: true });
  await mkdir(join(cwd, ".git"), { recursive: true });
  await cp(new URL("./skills/", import.meta.url), join(cwd, ".claude/skills"), {
    recursive: true,
  });
  await writeFile(
    join(home, ".config/skilldispatch/config.yaml"),
    "router:\n  provider: mock\n  mock:\n    defaultProbability: 0\n    scores:\n      react-components: 0.96\n      frontend-testing: 0.91\n      accessibility-review: 0.87\n",
  );
  const preload = join(root, "isolate.mjs");
  await writeFile(
    preload,
    `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>${JSON.stringify(home)}; syncBuiltinESMExports(); globalThis.fetch=()=>{throw new Error('Mock demo is offline');};`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)),
      "route",
      "Build a React form, add tests and check keyboard access.",
      "--agent",
      "claude-code",
      "--json",
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        SKILLDISPATCH_DATA_DIR: join(root, "data"),
      },
    },
  );
  assert.equal(result.status, 0, "Mock demo failed");
  const routed = JSON.parse(result.stdout);
  process.stdout.write(
    "Mock demo: fixed scores, not Jev accuracy.\nProvider: mock\n",
  );
  for (const decision of routed.selected)
    process.stdout.write(
      `${decision.name}\t${decision.probability.toFixed(2)}\tselected\n`,
    );
} finally {
  await rm(root, { recursive: true, force: true });
}

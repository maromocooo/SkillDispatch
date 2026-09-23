// Installs a tarball; all application smoke commands use isolated homes and mock routing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTarball } from "./audit-tarball.mjs";

const root = await mkdtemp(join(tmpdir(), "skilldispatch-release-install-"));
let stage = "tarball audit";
try {
  const tarball = resolve(process.argv[2]);
  const files = auditTarball(tarball);
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.NODE_OPTIONS;
  stage = "temporary package installation";
  const install = spawnSync(
    "pnpm",
    [
      "--dir",
      root,
      "add",
      tarball,
      "--ignore-scripts",
      ...(process.argv.includes("--offline") ? ["--offline"] : []),
    ],
    { env, encoding: "utf8", timeout: 120000 },
  );
  if (install.status !== 0) {
    const codes = new Set(
      `${install.stdout ?? ""}\n${install.stderr ?? ""}`.match(
        /\bERR_PNPM_[A-Z_]+\b/g,
      ) ?? [],
    );
    for (const code of codes) console.error(`Package manager code: ${code}`);
  }
  assert.equal(install.status, 0, "Temporary package installation failed");
  const cli = join(root, "node_modules/.bin/skilldispatch");
  for (const script of [
    "trace-ops-smoke",
    "hook-onboarding-smoke",
    "claude-advisory-smoke",
    "claude-catalog-smoke",
    "claude-invocation-smoke",
    "trace-display-smoke",
    "codex-parity-smoke",
  ]) {
    stage = script;
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL(`./${script}.mjs`, import.meta.url)),
        cli,
        ...(script === "trace-display-smoke" && process.argv.includes("--pty")
          ? ["--pty"]
          : []),
        ...(script === "trace-display-smoke" &&
        process.argv.includes("--examples")
          ? [
              "--examples",
              resolve(process.argv[process.argv.indexOf("--examples") + 1]),
            ]
          : []),
      ],
      { env, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(run.status, 0, `Installed ${script} failed`);
    process.stdout.write(run.stdout);
  }
  stage = "installed public mock demo";
  const demo = spawnSync(
    process.execPath,
    [join(root, "node_modules/skilldispatch/examples/demo/run.mjs")],
    { env, encoding: "utf8", timeout: 20000 },
  );
  assert.equal(demo.status, 0, "Installed public mock demo failed");
  assert.ok(
    demo.stdout.includes("Mock demo") &&
      demo.stdout.includes("react-components"),
  );
  assert.ok(!demo.stdout.includes(root) && !demo.stdout.includes("SKILL.md"));
  stage = "installed CLI version";
  const version = spawnSync(cli, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(version.stdout.trim(), "0.2.0");
  stage = "installed public ESM API";
  const api = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { VERSION, route, MockRouterProvider } from "skilldispatch"; if(VERSION !== "0.2.0" || typeof route !== "function" || typeof MockRouterProvider !== "function") process.exit(1);',
    ],
    { cwd: root, env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(api.status, 0, "Installed public ESM API failed");
  console.log(
    `PASS ${process.version}: release tarball ${files.length} allowed files; installed CLI/public API/demo; isolated homes; no external model API`,
  );
} catch {
  console.error(
    `Release package smoke failed at ${stage}; no raw child output is exposed.`,
  );
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

# PR6 validation — Safe Hook Onboarding & Registration Management

Date: 2026-09-22. Scope: offline, user-scope shadow hook registration and readiness.
No advisory, additionalContext, project hooks, invocation tracking or cloud service.

## Baseline and Git

- Started clean and synchronized on PR5 at `e2af122`.
- Verified `origin/main..origin/feat/pr5-trace-ops` contained exactly `773f069`,
  `3631d9d`, `5cbc23b`, `756175d`, `e2af122`; main was an ancestor.
- Fast-forwarded main from `a39855d` to
  `e2af122b2ac79e50aed8b1bdfdce508da09dc28d`, without a merge commit.
- Integration checks: 487 tests, typecheck, lint and build passed.
- Normally pushed main, fetched, verified local/remote equality, then deleted PR5
  remotely and locally with `git branch -d`.
- Created `feat/pr6-hook-onboarding` from that main. Implementation commits only
  on PR6; no force push, rebase, amend, reset or main implementation commit.

## Official host references reviewed

Reviewed before implementation, rechecked during final validation:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): user hooks.json and inline
  config.toml hooks both load, with a same-layer warning. Async command hooks,
  second-based timeout and explicit host trust review are supported. Session end
  cancels unfinished background work. Installer does not alter trust state.
- [Claude hooks reference](https://code.claude.com/docs/en/hooks): user settings.json,
  UserPromptSubmit, async command hooks, and direct exec via `command` + `args`.
  Ordinary async hooks do not enforce timeout once running; short non-interactive
  sessions can cancel unfinished hooks. This differs from treating every host's
  5-second timeout as a universal deadline. SkillDispatch's own cutoff remains.
- [PowerShell command arguments](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1):
  encoded command payload uses UTF-16LE Base64.
- [Microsoft jsonc-parser](https://github.com/microsoft/node-jsonc-parser): pinned
  `3.3.1` for syntax-tree edits preserving unrelated JSON values/number lexemes.
  Strict JSON only is accepted; this dependency does not enable JSONC input.

Current official behavior takes precedence over older manual examples. No exact
minimum host release is inferred. Older hosts without current async/exec support
need manual/version review. No host binary was required or automatically upgraded.

## Registration and safety model

- Commands: `hooks status [codex|claude] [--json]`, `hooks install <host> [--sync]
  [--dry-run]`, `hooks uninstall <host> [--dry-run]`.
- Fixed destinations: user `~/.codex/hooks.json` and `~/.claude/settings.json`.
  Codex `~/.codex/config.toml` is read-only. No project/managed/system/plugin edits.
  Non-default CODEX_HOME/CLAUDE_CONFIG_DIR overrides require manual handling.
- Default handler: UserPromptSubmit, command, async true, timeout 5 seconds. Sync
  changes only the execution mode; hook runtime stays silent/shadow/fail-open.
- Real absolute running Node and CLI entrypoint are pinned. POSIX Codex quotes
  literal argv. Windows Codex wraps a quoted PowerShell script in encoded command;
  Windows PowerShell availability is required. Claude uses executable plus literal
  args directly. No shell interpolation of user input, no PATH-only package command.
- Ownership is exact event/type/canonical command/args, excluding Windows overrides.
  Duplicates or recognizable legacy/different installs require manual action;
  heuristics never authorize deletion. Arbitrary wrappers are not recognized.
- Install twice is byte-identical after the first edit. Sync updates only owned
  execution/timeout fields. Uninstall removes owned handlers only, preserves other
  hooks/settings, does not restore backups or delete the config, and can be repeated.
- Strict UTF-8/JSON, root/hook structure and duplicate keys validated. Existing and
  proposed files are at most 1 MiB. Regular file, no symlink, one hard link, same
  descriptor device/inode; POSIX current owner and no group/world write permissions.
  Leaf host directory is also validated. Existing file modes (including 0644) remain.
- Same-directory unique temporary file + file fsync + rename, directory fsync where
  supported. Cooperative exclusive lock; reread/replan and external-edit checks.
  New configs are 0600; new host directories 0700 where supported. Failed rename
  leaves the original intact and cleans the temporary file/lock.
- Before first actual edit to an existing config, publish a private `.skilldispatch.bak`
  exclusively in the same directory. Never overwrite an existing safe backup;
  refuse unsafe/symlink/hardlinked backups. Backup may remain after failed rename.
- Dry-run reads/plans only: no config/backup/directory/lock creation. Missing uninstall
  is also a no-op. No backup text, unrelated commands, settings values or raw errors
  are emitted. Own command/config paths are intentionally visible in registration
  output and can reveal a home path; redact before sharing.

## Doctor and exits

Doctor reuses the read-only inspector. Installed Claude registrations are PASS unless
an issue such as user disableAllHooks is found. Codex installed registrations carry
trust-not-verified WARN. Missing/malformed/unsafe/conflicting registrations are WARN,
not installation FAIL. Status reports a conflict with exit 1; absent alone is exit 0.
Install errors are safe exit 1. Ordinary doctor FAIL/usable semantics are unchanged.

`routing_ready` independently reports boolean local prerequisites: enabled shadow
telemetry and mock, or valid-shaped Jev credentials. Missing/invalid credentials,
disabled telemetry or invalid routing config give false/WARN. Invalid credential
format still also has the existing api_key FAIL; missing credentials remain WARN.
No online authentication, host trust, host lifecycle or delivery is certified.
Doctor creates no file/key, changes no settings and writes no trace.

## Validation results

macOS, pnpm 10.17.1. TypeSafe SDK unchanged at exactly 0.6.0.

| Check | Node 20.20.2 | Node 24.12.0 |
| --- | --- | --- |
| `pnpm test` | 583 passed / 40 files | 583 passed / 40 files |
| `pnpm typecheck` | PASS | PASS |
| `pnpm lint` | PASS | PASS |
| `pnpm build` | PASS | PASS |
| `pnpm pack` | PASS | PASS |
| Installed registration E2E | PASS | PASS |
| Existing installed ops/CLI smoke | PASS | PASS |

All existing 487 tests remain. Added 96: command generation 11, registration
inspection 30, mutation 42, CLI 5, doctor readiness 8. Existing standalone shadow
child-process bundle includes jsonc-parser so it can still run outside the checkout.
Each validation runtime was put on PATH for test runners and their subprocesses.
The sandbox initially denied the existing loopback server; the full suite then
passed with localhost access enabled. No external provider network was used.

Coverage includes both hosts' fresh/idempotent/async/sync installs, unrelated
UserPromptSubmit and other events/settings, large integer preservation, exact
uninstall, malformed/duplicate JSON, symlink/hardlink/directory refusal, private
backup preservation/refusal, dry-run, lock refusal, failed atomic replacement,
external edits, Codex inline conflict/valid TOML, no project changes, offline
status/doctor, key/host-setting privacy and old commands' regressions.

## Installed package execution

Packed separately under `/tmp/skilldispatch-pr6-node20` and
`/tmp/skilldispatch-pr6-node24`; installed each tarball into a separate temporary
project using the pnpm offline store. Explicit development scripts:

```sh
node scripts/hook-onboarding-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
node scripts/trace-ops-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
```

The first verifies help/status/install/uninstall, idempotency, dry-run and sync,
private first backup, unrelated settings and project sentinels, doctor readiness,
and executes **the command actually read from each generated host config** with
fixture stdin. Both commands exit 0 with empty stdout/stderr, create two valid mock
shadow traces, and persist no raw prompt/session/turn sentinel. Trace summary then
validates both records against the shipped runtime schema. This covers generated
registration -> installed package -> hook runtime -> JSONL, not host async scheduling.

The second checks existing doctor/traces/discover/route/eval and silent hook package
behavior. Test-only Node preloads isolate os.homedir without changing HOME and
block/count fetch attempts. All test config edits are inside disposable temporary
homes; **real user ~/.codex and ~/.claude were not changed**. Scripts are not invoked
by tests, prepack or CI. No live Jev call was performed. Git operations, official
documentation access and dependency metadata/download were the intentional network
operations; all new operational commands and tests are offline (existing HTTP
fixtures are loopback only).

## Limitations / next boundary

No known PR6 implementation blocker remains. Async lifecycle/delivery, real host
trust interactions, old host versions and native Windows execution/ACL durability
are not certified by these fixtures. Absolute paths depend on the Node/package
installation remaining present; uninstall before moving and reinstall afterward.
Codex inline TOML and custom host roots are manual workflows. A crashed installer
may leave a lock requiring manual inspection/removal; no lock stealing or config
migration is implemented. Atomic rename and identity checks do not eliminate the
last-instant race with a malicious/noncooperating same-user editor. Local-filesystem
semantics are assumed; network filesystem guarantees are not asserted.

PR7 advisory needs separate authorization, host-specific placement/privacy review
and shadow evidence. No advisory/context injection, skill execution, native
invocation detection, project installation or delivery guarantee was added here.

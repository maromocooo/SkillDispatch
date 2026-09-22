# PR7 validation — Claude Code Advisory Mode

Date: 2026-09-22. Scope: explicit Claude same-turn recommendations through native
Skill invocation. Codex remains shadow-only. No subagent routing, Studio, skill-body
injection, new routing algorithm or actual invocation tracking.

## Baseline and Git

- Base main: `a0837dd0fed15700344194fdf7c10ba7c4430259` (PR6 complete).
- Fetched/pruned and verified main == origin/main. The user explicitly authorized
  reverting the listed temporary tracked changes and removing the untracked
  public-api test. No other user changes were discarded; no separate worktree.
- Started `feat/pr7-claude-advisory` from clean main. All new commits are on this
  branch. No main implementation commit, merge, amend, rebase or force push.
- TypeSafe SDK remains exactly `0.6.0`; no new dependency.

## Current official Claude behavior reviewed

Reviewed before implementation and rechecked during validation:

- [Hooks reference](https://code.claude.com/docs/en/hooks): synchronous
  UserPromptSubmit supports JSON `hookSpecificOutput.additionalContext` alongside
  the submitted prompt. Async output is delivered on a later conversation turn,
  so it cannot supply this same-turn behavior. Command timeout is in seconds;
  synchronous timeouts discard output. Ordinary async lifecycle remains host-owned.
- [Skills reference](https://code.claude.com/docs/en/skills): personal/project
  invocation commands derive from directory names; frontmatter name is a display
  label. Native Skill invocation loads the body. `disable-model-invocation` opts
  out of automatic invocation. Same-name precedence and nested/plugin naming
  differ by source. Current `skillOverrides` can further restrict availability.

The prompt's same-turn/async assumptions match these docs. No exact minimum host
version is inferred. Directory-name derivation corrects the unsafe assumption that
frontmatter display names are invocation identifiers. We deliberately omit known
ambiguous mappings instead of approximating host precedence. Unsupported sources
and full session/managed skillOverrides are not claimed as implemented.

## Config ownership and registration

- Defaults: `hook.modes.claude: shadow`, `hook.modes.codex: shadow`.
- Only user `~/.config/skilldispatch/config.yaml` can enable Claude advisory.
  Project/explicit layers cannot change modes, even when trustProjectConfig is true.
  Codex advisory and malformed mode values reject config. Normal route/eval/discover
  routing and telemetry layering otherwise remains intact.
- Default registrations: Claude shadow async, Claude advisory sync, Codex shadow async.
  Claude retains optional synchronous shadow debugging; PR7 rejects Codex `--sync`.
- Editing mode config alone never changes host settings. `hooks status` exposes mode,
  expectedExecution, actual execution and `hook_execution_mismatch`, with reinstall
  guidance in text. A mismatch is an installed registration with an issue (exit 0);
  an actual registration conflict retains exit 1.
- Reinstall reconciles owned handler execution/timeout in either direction,
  idempotently. Unrelated hooks/settings, private first backup, atomic writes,
  symlink/hardlink protections, read-only dry-run and targeted uninstall remain.
  Invalid user mode config blocks install; targeted uninstall remains available.
- Doctor adds hook_mode_claude, hook_execution_claude and advisory_ready. Advisory
  readiness requires explicit advisory, one sync registration without issues and
  existing local routing_ready. Missing/mismatch is WARN; shadow advisory_ready is
  false/PASS (disabled). This does not certify native availability, online auth or
  host reload. No config mutation, provider request or trace append by status/doctor.

## Runtime and context safety

The shared runtime still loads one host catalog and uses existing route()/policy.
Only Claude advisory + complete result + safe selections + confirmed owned sync
registration can return JSON. Unknown/conflicting/async/disabled registration yields
advisory_registration_not_ready. Partial recommendations stay in traces but never
reach host context. Failures/timeouts/invalid results/zero selection stay silent.

The adapter helper uses direct personal/project source provenance and directory
basename, preserving a local symlink command name. It accepts only 1–128 Unicode
letters/numbers/marks, underscore and ASCII hyphen, starting with letter/number or
underscore. Controls, whitespace, quoting, separators, namespaces and bidi controls
are omitted. Unsupported/missing provenance is omitted. Disabled and manual-only
skills are rechecked in the builder; invocation collisions across the full catalog
(including disabled entries) are omitted with advisory_ambiguous_skill_invocation.

The exact static strategy is: user's request takes priority; consider listed skills
with the native Skill tool only if available, permitted and applicable; use native
invocation rather than reproducing/guessing instructions; continue normally if a
recommendation cannot be invoked. Only native identifiers vary. No prompt,
description, body, path, CWD, probability, content hash or provider diagnostic enters
context. JSON.stringify builds the official hookSpecificOutput envelope, with no
plain stdout prose or decision/reason/systemMessage.

Context budget is **4096 UTF-8 bytes**, including framing. Whole identifiers fit in
policy order; a deterministic suffix is omitted with advisory_context_limit IDs.
Serialization/resolution exceptions produce safe diagnostics and empty output. A
trace append failure is swallowed and otherwise safe advisory may still be returned;
config/discovery/key setup failure can suppress output and trace. Telemetry disabled
continues to disable the entire hook, including advisory.

No timeout/retry expansion: route default 2500 ms, SDK maxRetries 0, process 4 seconds,
installed host timeout 5 seconds. Advisory adds user-facing routing latency. Stdout
is flushed before process termination; the process deadline remains armed during a
stalled flush, and closed stdout fails open. All supported hook errors exit 0.

## Trace and analytics compatibility

Schema version remains 1.0 with additive shadow/advisory mode and optional
`delivery: {kind: none | claude-advisory, injectedSkillIds: [...]}`. Old shadow
records without delivery remain valid in Zod and shipped JSON Schema. The drift
test compares both schemas. Mixed datasets stream through the existing safe reader.

Selected means router policy recommendation. Injected means included in emitted hook
JSON, not host acknowledgement or native invocation. Trace append precedes stdout;
a subsequent stdout failure/crash can prevent receipt. Summary separates mode counts
and advisory recommended/injected totals; list adds mode/count and show identifies
injected recommendations separately. Context text is never traced. Existing prompt
HMAC defaults, private key/storage, allowlist diagnostics and CLI redaction remain.

## Validation results

macOS; pnpm 10.17.1; Node versions are placed on PATH for all runners and subprocesses.

| Check | Node 20.20.2 | Node 24.12.0 |
| --- | --- | --- |
| `pnpm test` | 653 passed / 46 files | 653 passed / 46 files |
| `pnpm typecheck` | PASS | PASS |
| `pnpm lint` | PASS | PASS |
| `pnpm build` | PASS | PASS |
| `pnpm pack` | PASS | PASS |
| Installed advisory E2E | PASS | PASS |
| Existing onboarding/ops package smoke | PASS | PASS |

All previous 583 test cases are retained, with expectations updated for additive
JSON fields and the explicit Codex sync prohibition. Added 70: mode config 13,
advisory builder 24, trace compatibility 3, registration mode/doctor 4, shared runtime
20, CLI 5, bounded stdout child process 1. Total 653 across 46 files.

Coverage includes user-only opt-in under trusted/untrusted project config, manual-only
and disabled defense, directory/display name distinction, ambiguous commands,
malicious metadata, Unicode/quotes/backslashes/dash handling, UTF-8 size bound,
complete/zero/partial/failure/timeout, missing key, serialization/key/writer failures,
async output suppression, both reconciliation directions, privacy projections and
all preexisting discovery/route/eval/hook/operations regressions. Fixture Swift scores
are mock data, not evidence of Jev routing accuracy.

The initial sandbox denied localhost listeners in five existing SDK tests; reruns
with localhost permission passed. Tests use fake calls/mock providers or loopback
HTTP only. No external TypeSafe request occurs in tests, prepack or package smoke.

## Installed package E2E

Final tarballs installed separately under `/tmp/skilldispatch-pr7-final20` and
`/tmp/skilldispatch-pr7-final24` using the offline pnpm store. Scripts:

```sh
node scripts/claude-advisory-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
node scripts/hook-onboarding-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
node scripts/trace-ops-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
```

The new E2E uses an isolated home, mock Swift skill and fetch trap. It installs
shadow async, verifies silent output, changes user mode to advisory without host
mutation, observes mismatch and still-empty output, dry-runs/reconciles to sync,
reinstalls idempotently, then executes **the actual generated command/args** with
fixture stdin. It asserts official JSON, safe identifier only, a hash-only trace,
delivery IDs, doctor readiness and mixed trace analytics. Returning to shadow and
reinstalling restores async/empty stdout. Unrelated settings, backup and project
sentinels remain intact. Existing scripts also exercise Codex silent shadow,
uninstall, help, discover/route/eval, doctor and trace commands.

These tests validate package command execution, not a real host's context placement,
async lifecycle or Skill tool invocation. No real user ~/.claude or ~/.codex was
changed. Live Jev advisory smoke was skipped (optional; no external request made).
Git remote operations and official docs browsing are separate network activities.

## Known limitations / next boundary

No known PR7 implementation blocker. User opt-in, reconciliation and host reload are
required for real advisory dogfood. On-disk registration inspection cannot prove a
running host reloaded settings or acknowledged output. Absolute installed paths must
remain present. The existing safety protections assume a local filesystem and do
not eliminate malicious same-user last-instant races.

Full native skillOverrides/managed/session state, plugin/synced/bundled/legacy/add-dir
skills and nested lazy sources below session cwd are not supported by this advisory
mapping. Some valid but non-allowlisted command names are conservatively omitted.
Context omissions do not alter selected routing statistics. No invocation telemetry
or stronger accuracy claim follows from this implementation. Review actual Claude
behavior and advisory latency before expanding scope; Codex advisory, subagent
routing and Studio remain unimplemented.

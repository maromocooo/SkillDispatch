# PR9 validation — Claude native Skill invocation telemetry

## Base and Git integration

Base main: `507057c2d17baad5a6629a3390f8b815e9c827fa` (reviewed PR8 plus
restrictive synced-skill/managed-policy hardening). The requested 11 PR8 commits
were the entire main-to-feature diff. Main was fast-forwarded from `1ad089b`,
788 existing tests/typecheck/lint/build passed, main was normally pushed and
verified equal to origin/main. Remote/local PR8 branches were normally deleted.
PR9 work is isolated on `feat/pr9-claude-skill-invocation-telemetry`.
No rebase, amend, force push, reset or merge commit was used.

## Official contract review (2026-09-22)

Reviewed [Claude hooks reference](https://code.claude.com/docs/en/hooks), particularly
[common input](https://code.claude.com/docs/en/hooks#common-input-fields),
[PreToolUse](https://code.claude.com/docs/en/hooks#pretooluse),
[PostToolUse](https://code.claude.com/docs/en/hooks#posttooluse),
[PostToolUseFailure](https://code.claude.com/docs/en/hooks#posttoolusefailure),
[UserPromptExpansion](https://code.claude.com/docs/en/hooks#userpromptexpansion),
and [async hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background).
These establish event/tool matching, session/prompt/tool-use correlation, optional
agent context, optional tool duration and interruption information, and the
model-vs-direct-user distinction. Prompt ID is documented for v2.1.196+; old hosts
without it still produce standalone events but cannot support exact adoption joins.
Pre alone does not prove execution; permission denial may have no failure hook.

The hooks reference does **not** enumerate a complete Skill-specific input schema.
The current official SDK `@anthropic-ai/claude-agent-sdk@0.3.278` public
`sdk-tools.d.ts` was inspected read-only and does not export SkillInput either.
The required Skill identifier field was verified in Anthropic's current
[skill-creator evaluator source](https://github.com/anthropics/skills/blob/main/skills/skill-creator/scripts/run_eval.py)
(the model tool-use input is accessed with the `skill` key), also mirrored in
[official plugin source](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/skill-creator/skills/skill-creator/scripts/run_eval.py).
PR9 accepts only a safe string `tool_input.skill`; it does not guess `name` or
`command`, and ignores `args` entirely. This is a deliberately narrow parser,
not a claim to implement a published full Skill input type. The SDK was not added
as a dependency, executed, or used by production code. TypeSafe SDK remains 0.6.0.

Current docs say async command hooks receive the same input but host `timeout`
is not enforced after backgrounding; noninteractive host teardown can kill them.
Observer registrations carry the existing 5-second setting for consistency, but
our dedicated process independently exits after at most 4 seconds. No background
delivery guarantee, real-host lifecycle simulation, or detached worker is claimed.
Observers emit no stdout, decisions or context; UserPromptSubmit advisory behavior
and its existing 2500 ms route budget are unchanged.

## Implementation and privacy

- Three user-level Claude `Skill` matchers: PreToolUse (attempted), PostToolUse
  (succeeded), PostToolUseFailure (failed), all async. Installer reconciles these
  and the existing routing registration in one atomic replacement. Unrelated
  settings/hooks and first backup are retained. No real-user settings were edited.
- Separate local observer runtime; 1 MiB/time-bounded stdin, required-field
  validation, future fields ignored, all failures silent/exit 0. No provider calls.
- New strict `schemas/skill-invocation.schema.json`, version 1.0. Storage:
  `<dataDirectory>/invocations.jsonl`, default
  `~/.local/share/skilldispatch/invocations.jsonl`; data-directory env overrides
  retained. No new project-controlled observer settings or storage path.
- User telemetry opt-out wins even when project routing config is trusted.
- Private 0700/0600 storage where supported; no symlink/hardlink destinations,
  key/route alias collisions, raw errors or unbounded event appends. Each append
  is one write, ≤16 KiB. Reader uses existing safe streaming checks and 2 MiB lines.
- Raw prompt/args/tool response/error/cwd/transcript/API keys/raw host IDs are
  omitted. Session and prompt HMAC domains match routing exactly. Tool HMAC is
  domain-separated over a JSON tuple containing host, session and tool-use ID.
- Exact native identifier resolution only. Unresolved/ambiguous identifiers remain
  events with fixed diagnostics. Resolved data is name/origin/catalogIdentity/
  contentHash, without local paths. No alias/native-precedence approximation.
- `agent_id` presence produces `subagent`, never a stored ID or routing action.
- RouteTrace v1's optional capability marker and decision catalogIdentity are
  additive. Existing PR4–PR8 shadow/advisory records remain valid/readable.

## Funnel semantics

Recommended and injected counts use route-skill-version pairs. Model-invoked
requires a resolved attempted call with exact session/prompt/catalog/content;
succeeded requires a success for that attempted tool lifecycle. Repeated calls
count once per route pair. Injection conversion uses injected-and-invoked pairs
as numerator; success conversion uses successful/invoked pairs. Zero denominators
are null/N/A. Only main-context events credit main-turn recommendations.

Lifecycle matching is independent of append order. Duplicates are deterministic;
contradictory lifecycles are unknown. Attempted-only is not failed. Missing prompt
ID on an attempt cannot receive funnel credit; a terminal event can join by tool
ID when its attempt supplies the exact prompt correlation. Old traces without
observer capability are telemetry unavailable and excluded from denominators.
Separate stream health reports raw/deduplicated attempts, terminal events,
unresolved calls, corrupt lines and duplicates; `--since` filters routing cohorts,
not global stream health. `show` exposes lifecycle labels, never HMAC keys.

## Validation

Final verification on Node **20.20.2** and **24.12.0** (pnpm 10.17.1):

| Check | Node 20 | Node 24 |
|---|---|---|
| `pnpm test` | 860 / 56 files PASS | 860 / 56 files PASS |
| `pnpm typecheck` | PASS | PASS |
| `pnpm lint` | PASS | PASS |
| `pnpm build` (including declarations) | PASS | PASS |
| `pnpm pack` | PASS | PASS |
| Offline tarball installation | PASS | PASS |
| All five installed-package smoke scripts | PASS | PASS |

The original 788 tests remain, with 72 added cases: observer/parser/storage/privacy
(36), lifecycle/funnel (22), registration/readiness (10), routing capability marker
(4). Schema tests validate emitted invocation events with AJV and compare shipped
JSON Schema to Zod output. Existing route schema drift/legacy compatibility tests
remain. Coverage includes exact namespaces, ambiguity, missing IDs, unsafe names,
subagent projection, control-byte-safe tuple correlation, private storage and
corrupt lines, partial/unavailable observability, cross-session/prompt isolation,
physical order reversal, duplicates and unknown attempted-only outcomes.

Tarballs were installed into separate temporary directories using the offline pnpm
store. Both Node versions ran:

- `scripts/claude-invocation-smoke.mjs`: generated installed advisory command →
  immutable route trace → Post before Pre Skill events → exact HMAC match →
  show/summary funnel (1 recommended/injected/model-invoked/succeeded), observer
  status/doctor, targeted uninstall, privacy, malformed/oversized silent hooks.
- `scripts/claude-advisory-smoke.mjs`: shadow/advisory reconciliation and bounded
  output, unchanged routing behavior.
- `scripts/claude-catalog-smoke.mjs`: mixed local/project/synced/plugin catalog,
  namespace advisory and marketplace exclusion.
- `scripts/hook-onboarding-smoke.mjs`: both hosts' generated commands, private
  backup, idempotency, dry-run and unrelated settings preservation.
- `scripts/trace-ops-smoke.mjs`: doctor/traces privacy, read-only behavior, existing
  discover/route/eval and silent shadow command regression.

Tests and observers made **no external API calls**. Existing SDK transport tests
used loopback HTTP only; package fixtures used mock routing and a failing fetch
sentinel. Git, official-document and public SDK-type downloads were development
research only. No live Jev or real Claude session was run. Package tests override
homedir into isolated temporary fixtures; real-user host/project settings,
plugins, synced skills and existing traces were not changed.

## Known limitations

- Observers are async/best effort. A short-lived host or slow filesystem/discovery
  can lose events; marker/readiness confirms local prerequisites, not delivery.
  Missing invocation records mean not observed, not proof of non-invocation.
- User-scope registration inspection does not prove active host reload, trust,
  managed policy or per-session `--settings` behavior. Restart/reload Claude after
  `skilldispatch hooks install claude`; check status and doctor separately.
- Native names are exact only. Bundled/unsupported/aliased calls remain unresolved;
  catalog/content changes between routing and invocation conservatively do not join.
- The current hook payload is not authenticated against fabricated local input;
  telemetry is local diagnostics, not an audit/security authority.
- Streaming avoids whole-file reads, but the join index grows with unique tool
  lifecycles. File rotation, retention, cloud upload and persistent indexes are absent.
- Direct user `/skillname`, Codex telemetry/advisory, subagent routing and Studio
  remain out of scope. Success means native tool completion, not task quality.

# PR8 validation — Claude Native Skill Catalog Discovery

Date: 2026-09-22. Read-only catalog expansion for local/project, cached synced,
active installed plugins and file-managed skills. No settings/plugin mutation,
Codex advisory, invocation telemetry, subagent routing, Studio or Jev tuning.

## Baseline and Git

PR7 was verified as a descendant of main with exactly the seven reviewed commits
`a02c3b1`, `12becfa`, `89e9200`, `6475a1a`, `dc52f67`, `fda409a`, `1ad089b`.
Main fast-forwarded to **1ad089b43d5f401e3f61c6ad52faa1b670bb42d6**. The baseline
653 tests, typecheck, lint and build passed before pushing main. Local/origin main
matched, then the remote and local PR7 branch were normally deleted. New work is
only on `feat/pr8-claude-native-catalog`; no merge commit, rebase, amend, force push
or history rewrite. SDK remains exactly `@typesafe-ai/sdk@0.6.0`; no new dependency.

## Official references and implementation assumptions

Reviewed current official docs before implementing and rechecked component rules:

- [Skills](https://code.claude.com/docs/en/skills): local directory invocation,
  synced qualification/collisions, manual-only policy, enterprise paths, nested and
  bundled sources. Personal/project discovery is retained; synced commands use
  `anthropic-skills:<name>`, not an account-directory prefix.
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference): manifest,
  skill components, namespace, default enablement and installation scopes.
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces):
  entry defaults, strict versus entry-owned definitions, component paths and
  marketplace-root subsets. Only a registered marketplace manifest is consulted
  by exact installed plugin ID; no marketplace Skill tree is enumerated.
- [Settings](https://code.claude.com/docs/en/settings) and
  [managed settings](https://code.claude.com/docs/en/managed-settings): precedence,
  owned repository local configuration, per-skill overrides, sync and strict-plugin
  restrictions, file-based managed configuration and fragments.
- [Environment variables](https://code.claude.com/docs/en/env-vars): config root and
  plugin parent overrides. The plugin cache variable changes the **plugins parent**,
  not just its `cache/` child.

These are current web documentation, not a pinned Claude runtime API. The docs
reference host versions newer than older handoffs; this implementation does not
claim one minimum host version or complete parity with a running host.

The local registry shape is observed upstream implementation state, not a public
versioned SDK contract. Version 2 uses `plugins["name@marketplace"]` arrays of
`scope`, `installPath`, `version`, optional `projectPath` records. Relevant reports:
[registry state](https://github.com/anthropics/claude-code/issues/75392),
[scope selection](https://github.com/anthropics/claude-code/issues/54310),
[project applicability](https://github.com/anthropics/claude-code/issues/39548),
[marketplace registry](https://github.com/anthropics/claude-code/issues/36575).
Unknown/corrupt formats are diagnosed rather than replaced with heuristic scanning.

Differences from the request's proposed assumptions:

- Current plugin native names use **plugin manifest name + frontmatter skill name**,
  with directory fallback and an already-qualified prefix kept once. They do not
  always use the skill directory as local personal/project commands do. For an
  entry-owned `strict: false` plugin, the entry supplies the plugin namespace.
- A valid entry-owned definition need not have `plugin.json`. A second manifest
  declaring components is a conflict; metadata-only manifests are permitted.
- `defaultEnabled` resolves from marketplace entry before installed manifest; an
  explicit scoped `enabledPlugins` value wins. Absent defaults mean true only after
  validating an installed, applicable definition, not from registry presence alone.
- The host can broaden a marketplace-root scan when every declared component path
  is missing. SkillDispatch deliberately does **not** broaden it: it returns no
  skills from that subset. Marketplace-root entries without a subset are unsupported.
- The two-level synced cache layout is an observed filesystem format. No authoritative
  local active-account or stale-directory winner API was found. Collisions therefore
  become non-routable, instead of guessing by path order, timestamps or account UUID.

## Sources, eligibility and identity

`CLAUDE_CONFIG_DIR` defaults to `~/.claude` and resolves skills, synced cache,
settings and the default plugin parent. `CLAUDE_CODE_PLUGIN_CACHE_DIR` overrides
that parent for `installed_plugins.json` and `known_marketplaces.json`. Actual skill
files always come from applicable registry `installPath`, not a guessed cache version.
Registered marketplace locations are used solely for targeted definition metadata.

Settings read order is user → CWD `.claude/settings.json` → CWD legacy
`.claude/settings.local.json` → owned repository-root local settings on macOS/Linux
→ file-managed base → sorted non-hidden managed JSON fragments. Per-plugin keys
merge. Project/local installation `projectPath` must match a directory in this
CWD-to-repository context. User and managed installation scopes are global. Multiple
applicable versions are ambiguous and excluded. Exact duplicate records collapse;
equivalent same-version physical copies collapse after content comparison. Divergent
copies are excluded, not chosen by lexical version or registry order.

File-managed roots use `/Library/Application Support/ClaudeCode` on macOS,
`/etc/claude-code` on Linux and `C:\Program Files\ClaudeCode` on Windows. Enterprise
skills use `.claude/skills` beneath that root. No policy is modified. Session/SDK/CLI
sources, MDM, server-managed policy and worktree main-checkout local settings are not
fully resolved; native host permissions remain authoritative.

`metadata.claude` owns origin (`local-user`, `local-project`, `synced`, `plugin`,
`managed`, `unknown`), native invocation name and model eligibility. Plugin metadata
also records ID/name/version/installation scope. Core scope is unchanged: plugin
project/local maps to repo, managed maps to admin, user maps to user. Source origin
is not a scope. Frontmatter cannot forge adapter-owned metadata.

`enabled` retains its existing meaning, automatic model routing eligibility.
`disable-model-invocation` makes all source types non-routable and remains checked
again by advisory. Explicit non-plugin `skillOverrides` off/user-invocable-only
restrict routing; plugin enablement is handled separately. A disabled plugin is
excluded, while a manual-only skill from an active source is discoverable. Malformed
relevant Claude settings conservatively disable candidates and emit safe diagnostics.

Different plugin namespaces do not produce duplicate-name diagnostics merely for
sharing a display label. Synced qualification allows local/synced names to coexist.
Distinct local paths remain in the catalog; advisory still refuses ambiguous native
invocation rather than partially reproducing host precedence. Synced duplicate names
across account directories are all non-routable; identical versions collapse and
different content stays visible. New logical IDs omit physical cache/account paths.

Fingerprinting adds an adapter-owned digest of origin/native name/plugin ID/version/
installation scope/model eligibility to the existing sorted semantic tuple. Account
UUID or cache relocation alone is stable; content, version, namespace and eligibility
changes affect it. Multiplicity and locale-independent ordering remain. Trace v1 is
unchanged and old shadow/advisory records remain valid; no migration or trace rewrite.

## Safety, payloads and bounded work

- JSON state is regular, single-link, no-follow, bounded to 1 MiB and validated as
  strict UTF-8/JSON with duplicate-key/depth checks. Unsafe symlink/invalid state is
  diagnosed; no shell expansion, includes, commands or skill scripts are evaluated.
- Registry caps: 1024 plugin IDs, 256 records each. Known account/managed-directory
  enumeration caps at 256 entries. Existing skill traversal caps and 1 MiB reads
  remain. New synced/plugin traversal rejects symlinks; no marketplace/cache walk.
- New diagnostics expose fixed codes/messages, never raw JSON, SDK errors, account
  IDs or source paths. Existing `discover` descriptors still contain local paths and
  descriptions; this is not the privacy-safe trace/doctor view.
- Jev still receives prompt plus existing candidate name/description/agent/scope;
  no arbitrary metadata, plugin/version/path/account/settings payload. No SDK change.
- Advisory reuses complete-only routing, native identifiers only, existing policy
  order, manual-only defense and 4096-byte bound. Partial/failed results remain
  silent. Selected/injected are not proof of actual invocation.
- Hook project `.skilldispatch.yaml` trust and user-only advisory modes are unchanged.
  Reading Claude project catalog settings cannot change SkillDispatch provider,
  telemetry destination or execution mode. Discovery can use custom Claude roots;
  registration management retains its existing custom-root refusal boundary.

Discover JSON adds `summary` without removing `skills`/`diagnostics`; text adds
Claude origins and counts. Doctor reports per-origin model-routable counts. Catalog
source diagnostics produce WARN, while preexisting installation/storage FAIL rules
are unchanged. Neither command invokes Claude or TypeSafe, installs plugins, edits
settings or appends a trace.

## Validation results

macOS, pnpm 10.17.1. Node is explicitly on PATH for each test runner and subprocess.

| Check | Node 20.20.2 | Node 24.12.0 |
| --- | --- | --- |
| `pnpm test` | 750 passed / 52 files | 750 passed / 52 files |
| `pnpm typecheck` | PASS | PASS |
| `pnpm lint` | PASS | PASS |
| `pnpm build` | PASS | PASS |
| `pnpm pack` | PASS | PASS |
| Installed mixed catalog/advisory E2E | PASS | PASS |
| PR7 advisory, PR6 onboarding, trace-ops package smoke | PASS | PASS |

All 653 previous tests remain. Added 97: synced 10, plugin state/settings 36,
native mixed catalog 32, safety 10, fingerprint 5, CLI/doctor/runtime 4. Tests cover
all source types, malformed/missing state, namespace/directory distinctions, manual
policy, scope mismatch, defaults/overrides, managed files, strict:false definitions,
marketplace exclusion, physical duplicates, relocation, bounded/symlink reads,
minimal provider payload, complete advisory and backward trace behavior. PR7's
existing complete/partial/failure/timeout/privacy cases remain green.

One initial pack invocation lacked pnpm on the lifecycle PATH; rerunning with an
explicit Node/pnpm PATH passed. New component tests initially included preexisting
local fixture skills in plugin-only assertions; assertions were corrected to project
plugin origin. Installed-package testing also found and fixed macOS `/var` versus
`/private/var` config-root aliasing, with a regression test. No failing checks remain.

Final tarballs were separately installed offline under `/tmp/skilldispatch-pr8-final20`
and `/tmp/skilldispatch-pr8-final24`. Reproduce with an isolated installation:

```sh
node scripts/claude-catalog-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
node scripts/claude-advisory-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
node scripts/hook-onboarding-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
node scripts/trace-ops-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
```

The new E2E creates isolated personal/project/synced/plugin roots, a manual-only skill,
a marketplace-only decoy, custom plugin parent and explicit mock scores. It verifies
catalog counts, routing, the installed command generated for synchronous Claude
advisory, correct namespaced JSON output, private traces, doctor and analytics.
Existing E2Es cover help/discover/route/eval, both host hooks, registration lifecycle,
mode reconciliation, private backup and operational CLI. Project sentinels stay intact;
Claude settings sentinels are valid JSON now that catalog discovery reads them.
No production home or settings are mutated. Mock scores are not Jev accuracy evidence.

Tests use isolated homes, fake fetch and existing localhost SDK fixtures. No external
TypeSafe API call in tests, build, prepack or smoke. A fetch trap enforces this for the
new integrations. Live Jev smoke was not run. Git operations and official documentation
browsing use network separately. Performance is bounded by source enumeration; no
company-PC per-turn latency benchmark is claimed.

## Read-only dogfood and remaining limits

After tests, current built CLI discover/doctor were run read-only against this Mac.
Only safe counts and diagnostic/check codes were retained:

| Origin | Discovered | Model-routable |
| --- | ---: | ---: |
| local-user | 11 | 11 |
| local-project | 0 | 0 |
| synced | 0 | 0 |
| plugin | 0 | 0 |
| managed / unknown | 0 | 0 |

One installed plugin has a strict:false component-definition conflict and is
conservatively omitted (`plugin_manifest_conflict`). Plugins with no Skill components
correctly add zero skills. Doctor returned 1 in this execution environment:
`data_directory` and `trace_destination` FAIL, `routing_ready` false/WARN. No repair,
chmod, hook modification or settings change was attempted. These are real-environment
readiness observations, not a claim that PR8 makes that installation ready.

This is **not** the company-PC catalog described in the request. Its approximate
18 discovered/17 routable expectation remains to be checked there, without hardcoded
counts, using `skilldispatch discover --agent claude-code --json` and `doctor --json`.
The deterministic package fixture proves source composition and safety, not exact UI
parity or actual native invocation on that machine.

Still unsupported: a live native catalog API, authenticated active-account selection,
bundled/runtime skill catalog extraction, legacy command files, additional-directory
session loads, nested lazy skills below CWD, skills-directory plugin activation/trust,
plugin seed/cloud state, full MDM/server/session settings and host-specific worktree
local fallback. Unsafe/non-allowlisted identifiers and ambiguous installations stay
out of advisory. Current file formats may change; unknown forms are conservative.
Historical trace skill statistics still group by name/agent/scope/contentHash, so
identical display/content versions from distinct namespaces can share an analytics row.

No known PR8 implementation blocker remains after these checks. Company-PC catalog
comparison and native availability remain dogfood follow-up; real storage/routing
readiness must be addressed separately before interpreting missing traces. No PR9
invocation telemetry, Codex advisory or subagent work was started.

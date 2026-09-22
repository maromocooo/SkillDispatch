# PR10 validation — public release readiness

## Base and Git integration

Base main: `c451683d628ea343fd11982654d4eb814711d38b` (reviewed PR9,
including positive-evidence invocation analytics). The eight requested PR9 commits
were the complete main-to-feature diff. A clean main was fast-forwarded from
`507057c`; 868 tests, typecheck, lint and build passed before pushing main.
After fetching, local main equaled origin/main. Both PR9 branches were deleted
normally. PR10 uses `feat/pr10-public-release-readiness`; main remains unchanged.
No merge commit, rebase, amend, force push or destructive branch deletion was used.

## Package and public API

- Package: **skilldispatch 0.1.0**, replacing unpublished `0.1.0-dev.1`.
  The CLI version and package metadata agree. No existing release tag was found.
- On 2026-09-22, `npm view skilldispatch name version versions license --json`
  against the public npm registry returned **E404 Not Found**. No public package
  history was returned; this is not a name reservation or ownership guarantee.
- Added homepage, issue URL, discoverability keywords, main/types fallbacks and
  explicit public registry/access metadata. The existing ESM root export and all
  17 runtime public exports remain unchanged; no internal module export was added.
- No routing algorithm, config schema, trace schema or dependency version changed.
  CLI changes are the version and top-level help/examples only.
- The source repository does not track `dist`; `prepack` builds JS/declarations.
  `files` is the package allowlist. There is no consumer postinstall/build hook.
- The existing **MIT** license is retained consistently. Direct runtime dependency
  license files were inspected; see [the audit](THIRD_PARTY.md). Dependencies stay
  external and retain their licenses in their own packages. No additional NOTICE
  obligation was identified. No third-party skill source was copied.

## Public onboarding and policies

README now leads with observable multi-skill routing, a compact Mermaid diagram,
agent support matrix and commands for doctor, shadow installation, explicit Claude
advisory opt-in, traces and uninstall. It distinguishes unpublished candidate/source
installation from the future npm installation command. Detailed operational
reference remains in [OPERATIONS.md](OPERATIONS.md).

Added SECURITY, CONTRIBUTING, CHANGELOG, a security model, release checklist and
launch drafts (Reddit, Show HN and Product Hunt). Examples use synthetic data;
the reported one-pair PR9 dogfood observation is an anecdote, not an accuracy or
conversion claim. Public README relative links have a regression check. A formal
Code of Conduct is deferred until a private enforcement contact is established.

Read-only GitHub checks found this repository **already public** and private
vulnerability reporting **disabled**. Neither setting was changed. SECURITY does
not claim that the currently disabled private channel is available; enabling it
is a maintainer launch action.

## Benchmark and demo

`benchmarks/public-routing-v1/` contains 24 original generic skill definitions and
100 fixed YAML cases: 24 explicit, 24 paraphrase, 16 multi-skill, 8 no-skill,
8 negative, 8 Japanese, 8 mixed-language and 4 ambiguous. There are 88 fully labeled
and 12 partially labeled cases. Labels are fixed AI-assisted synthetic drafts,
**not independently human-reviewed ground truth**. Maintainer human review is
still needed before publishing accuracy claims; no provider generates the labels.

The isolated benchmark script uses the existing public library API, only this
catalog, default policy and SDK 0.6.0. It reports dataset/catalog hashes, date,
requested/returned models and runtime metadata without raw prompts. The ordinary
`eval` command is documented for a separately prepared disposable catalog; it does
not automatically load skills adjacent to the eval YAML. No new discovery option
or router feature was introduced for the benchmark.

Mock validation passed for all 100 cases with zero provider failures/partials.
These scores are plumbing checks, not Jev accuracy. `TYPESAFE_API_KEY` was **missing**,
so no live benchmark was performed and no live result was committed. This optional
measurement is not an implementation blocker. `--live` is explicitly manual and
is never invoked by tests, CI or prepack.

The four-skill `examples/demo/` runs the actual CLI with fixed mock scores in an
isolated home/project, blocks fetch, and prints only skill names/scores/selections.
It works from the checkout and installed package without a key or real-home reads.

## CI and release engineering

- `ci.yml`: PRs, main/feature pushes and manual runs; Ubuntu Node 20/24, frozen
  installation, tests, typecheck, lint, build, mock benchmark, pack, isolated
  package smoke and artifact upload. Package installation can fetch npm dependencies;
  application smoke remains offline. No TypeSafe credentials or live API calls.
- `release.yml`: `v*` tags/manual validation, Node 24, package/tag version check,
  complete verification and artifact upload. It does not publish npm or GitHub
  Releases. No tag or release run was created for this task.
- `publish.yml`: separate manual dispatch; confirmation, explicit
  `NPM_PUBLISH_ENABLED=true`, main-only dispatch, `npm-release` environment, reviewed
  tag ancestry/version and a fresh verified build. It uses OIDC/provenance rather
  than a committed or long-lived npm token. It was **not dispatched**.
- Maintainers must configure npm ownership/first-publication bootstrap, the trusted
  publisher and required environment reviewers before enabling publication. The
  workflow alone cannot establish those external safeguards. See the
  [release checklist and official references](RELEASE_CHECKLIST.md).
- Actions are pinned to full commit SHAs. Dependabot checks npm and Actions weekly.
  Bug/feature templates and the PR template include privacy and validation guidance.
- `actionlint` **1.7.12**, downloaded from the official release with its SHA-256
  verified against the release checksum file, passed all workflow files.
- Initial Ubuntu CI passed tests/typecheck/lint/build/pack, but separate offline
  consumer installation reported `ERR_PNPM_NO_OFFLINE_META`. Frozen root installation
  does not seed every registry metadata cache entry. Workflows now allow npm
  registry access for the temporary package install, with all application smoke
  still using isolated mock fixtures.
- [GitHub Actions CI run 35723584600](https://github.com/maromocooo/SkillDispatch/actions/runs/35723584600)
  passed both Ubuntu Node 20 and Node 24 jobs on `c59f72d`, including all 874 tests,
  typecheck/lint/build, 100-case mock benchmark, pack, consumer installation, every
  package smoke and artifact upload. This evidence update changes documentation
  only; the final pushed revision is also checked in CI before handoff.

## Validation results

Local verification used pnpm **10.17.1**, Node **20.20.2** and **24.12.0**.
Frozen/offline installation confirmed the existing lockfile was current.

| Check | Node 20 | Node 24 |
|---|---|---|
| `pnpm test` | 874 tests / 57 files PASS | 874 tests / 57 files PASS |
| `pnpm typecheck` | PASS | PASS |
| `pnpm lint` | PASS | PASS |
| `pnpm build` | PASS | PASS |
| `pnpm pack` | PASS | PASS |
| Isolated offline tarball install and smoke | PASS | PASS |

The original 868 tests are retained. Six release tests cover package version/public
API, benchmark schema/labels, offline evaluation, CLI help, workflow guards and
relative README links. No tests assert synthetic mock scores as semantic accuracy.

Both installed tarballs passed all five existing smoke suites: trace operations,
hook onboarding, Claude advisory, native catalog and invocation lifecycle telemetry.
The new release wrapper additionally checks the installed public demo, CLI version
and ESM public import. This covers help, doctor, discover, mock route/eval, hooks
status/install/uninstall, trace summary/list/show and generated hook execution.
Homes/settings/data are isolated temporary fixtures, with fetch blocked. It does
not simulate real Claude/Codex host lifecycle or claim host registration/trust on
the developer's machine. Real-user settings and runtime data were not modified.

## Tarball inventory

The audited tarball contains **23 files** (paths below are relative to `package/`):

```text
CHANGELOG.md
LICENSE
README.md
package.json
dist/chunk-2BTLFRIX.js
dist/chunk-2BTLFRIX.js.map
dist/cli/index.d.ts
dist/cli/index.js
dist/cli/index.js.map
dist/index.d.ts
dist/index.js
dist/index.js.map
evals/example.yaml
examples/demo/README.md
examples/demo/run.mjs
examples/demo/skills/accessibility-review/SKILL.md
examples/demo/skills/frontend-testing/SKILL.md
examples/demo/skills/react-components/SKILL.md
examples/demo/skills/security-review/SKILL.md
examples/skilldispatch.config.yaml
examples/skilldispatch.mock.yaml
schemas/route-trace.schema.json
schemas/skill-invocation.schema.json
```

No tests, validation logs, local traces/invocations, private fixtures, keys, `.env`,
screenshots or node_modules are included. Source maps contain repository source,
not real-home paths. The public benchmark and maintenance scripts stay in GitHub,
outside the CLI tarball. `scripts/audit-tarball.mjs` enforces the allowlist and
checks required assets, metadata and obvious private-path/credential patterns.

## Privacy and repository scans

Tracked/unignored text was searched for key/token patterns, private-key headers,
real home paths, email/internal domain names, company/Jira identifiers and raw
prompt references. No real credential, company-specific data or runtime trace was
identified across 246 text files. API-key references and sentinel prompts are intentional
documentation, implementation or test fixtures, not secret values. Existing tests'
`/home/.agents/...` and `/home/test/...` paths are synthetic, not real home paths. No tracked
JSONL runtime data, `.env` or `dist` artifacts were found. The tarball scan passed
independently. This is a scoped source/artifact check, not a guarantee that every
possible secret format can be detected automatically.

Tests/application smokes made **no external TypeSafe/Jev calls**. Existing SDK
transport tests use loopback only. Development network access was for Git/GitHub,
official npm/GitHub documentation, npm name metadata and actionlint. Local package
smoke used the offline dependency store; CI also permits npm installation downloads.
SkillDispatch still uploads neither traces nor
invocation events; normal Jev routing sends only its documented request data.

## Remaining launch actions

The candidate is mechanically validated but is **not yet an unconditional go-live**:

1. Review/merge PR10 and verify CI on the exact release commit.
2. Enable a working private vulnerability reporting channel.
3. Confirm npm name ownership/bootstrap, trusted publishing and required human
   approval settings; these account/repository changes were not performed.
4. Have a human review the synthetic benchmark labels before accuracy claims.
5. Repeat final-candidate real Claude advisory and Codex shadow smoke with synthetic
   data. Prior PR9 host dogfood was supplied by the user; PR10 tests use fixtures.

Actual publication, tags, GitHub Releases, repo visibility changes, launch posts and
new routing features are deliberately not performed. Known runtime limitations
(best-effort async observation, unsupported catalog sources and Codex shadow-only)
remain documented; there is no new compatibility migration.

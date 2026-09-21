# PR3 validation — Routing evaluation

Validated locally on 2026-09-21, macOS. PR3 base main is
`70dee27db49ecd928a2d027db038e068df6618fe`; implementation branch is
`feat/pr3-routing-eval`. SDK remains exactly `@typesafe-ai/sdk@0.6.0` and the
lockfile is unchanged.

## PR2 integration

Fetched/pruned origin and checked a clean, synchronized working tree. The entire
`origin/main..origin/feat/pr2-jev-provider` difference was the five reviewed commits
`14e78f2`, `536c80f`, `9438653`, `e5e1d98`, `70dee27`. The main tip `a86a634` was
an ancestor of the PR2 tip. Main was updated with `git merge --ff-only` after
`git pull --ff-only origin main`; no merge commit was created. The existing 199
tests, typecheck, lint and build passed on that integrated main before pushing.

After ordinary push and fetch, local main and origin/main both resolved to
`70dee27db49ecd928a2d027db038e068df6618fe`. The remote PR2 branch was deleted with
ordinary `git push origin --delete`, and its local branch with `git branch -d`.
PR3 was created from that main. No PR3 implementation was committed on main;
no force push, reset, rebase, amend or historical commit rewrite was used.

## Checks

All 199 PR2 tests are retained, with **84 additional tests: 283 total in 20 files**.

| Check | Node 20.20.2 / Undici 6.24.1 | Node 24.12.0 / Undici 7.16.0 |
| --- | --- | --- |
| `pnpm test` | 283 passed | 283 passed |
| `pnpm typecheck` | passed | passed |
| `pnpm lint` | passed, no warnings | passed, no warnings |
| `pnpm build` | passed | passed |
| `pnpm pack` with build lifecycle | passed | passed |
| SDK strict child-process runtime regression | 5 cases passed | 5 cases passed |
| Installed public CLI/library smoke | passed | passed |

pnpm version: 10.17.1. `pnpm pack --pack-destination /tmp/skilldispatch-pr3-package`
passed with its build lifecycle on both runtimes. The tarball includes `evals/example.yaml`.
It was installed offline into `/tmp/skilldispatch-pr3-install`, independently
of the source checkout, using cached dependencies. Both runtimes exercised the
installed executable from `node_modules/.bin/skilldispatch` against temporary
project skills and explicit mock config, with the API key removed from the child
environment and an isolated Claude personal-skill directory.

Installed checks covered:

- `--help` exposing eval; `discover --json` with the expected catalog.
- `route` text/JSON and two expected selected skills.
- `eval` text/JSON, selected metadata and complete metric output.
- Inclusive passing precision/recall gates: exit 0.
- Separate failing precision and recall gates: exit 2 with valid JSON results.
- Malformed YAML, out-of-range gates and missing Jev credentials: exit 1.
- No prompt sentinel in stdout/stderr, including invalid YAML.
- Public `parseEvalYaml`, `runEvaluation`, discovery and mock provider exports.
- The packaged nine-case example parses correctly.

These package smoke scores are synthetic fixture values, not Jev accuracy results.

## New coverage

- **Input/resolution:** strict versioned YAML, defaults, duplicate case IDs,
  malformed selectors, blank prompts, invalid thresholds, same/resolved label
  overlaps, duplicate resolved labels, unknown/ambiguous matches, cross-agent and
  repo/user qualification, disabled expectations and duplicate catalog IDs.
  Malformed YAML, cyclic aliases, unknown tags, oversized input, missing files
  and directories fail with fixed errors and no source excerpts.
- **Metrics:** perfect, false-positive, false-negative, multi-skill and no-positive
  cases; unlabeled predictions excluded from labeled precision; fully labeled
  negatives/exact matching; empty exact matches; null denominators and count-based
  F1; micro aggregation; nearest-rank P50/P95; inclusive/undefined gate behavior.
- **Routing integration:** zero/one/multiple skills, empty expectations on a
  nonempty catalog, real policy flags and disabled positives, retained successes
  and all-failed partials, exceptions, timeout and malformed provider results.
  Failed/partial cases remain in metrics. Preflight covers all labels before any
  provider call. Catalog routing fields are snapshotted against caller mutation.
- **CLI:** text/JSON, file/CLI gates and overrides, common config/provider/policy
  behavior, cwd/config/agent filtering, input/setup failures, Jev model mapping
  and partial failure through fake fetch, never the external API.
- **Privacy/determinism:** `PRIVATE_EVAL_PROMPT_SENTINEL` in requests, malformed
  YAML and fake provider exceptions/messages does not reach default text/JSON
  or diagnostics. No diagnostic message, path, arbitrary reason code, prompt or
  full skill is copied into eval results. Fixed-clock runs and reordered catalogs
  produce identical results; measured real latency is intentionally variable.
- **Example expressiveness:** nine cases cover explicit, paraphrased, multiple,
  unrelated, overlapping, negated, Japanese/mixed-language requests. An additional
  broad-versus-specific fixture verifies explicit negatives can expose overlap
  false positives without claiming semantic correctness from mock scores.

Normal `pnpm test` uses fake calls/fetch and the existing local loopback server,
not external TypeSafe requests. Loopback tests were run with local socket access;
no process-wide rejection handler or SDK workaround change was introduced.

## Concurrency hardening

`MAX_JEV_CONCURRENCY = 8` bounds provider options and config to integers 1–8.
Default concurrency stays 2. Tests accept 8, reject 9 in both config/provider
paths, and measure bounded in-flight requests at 1, 2 and 8 workers.
This is a **SkillDispatch local burst/cost safety ceiling**, not an official
TypeSafe limit. No other PR2 provider architecture or SDK version changed.

## Usage and live evaluation

Adapt the dataset selectors to your local discovered skills before running:

```sh
skilldispatch eval evals/example.yaml
skilldispatch eval evals/example.yaml --json
skilldispatch eval evals/example.yaml --min-recall 0.90 --min-precision 0.90
skilldispatch eval evals/example.yaml --config examples/skilldispatch.mock.yaml
```

The first three use the configured provider (Jev by default); the last explicitly
uses prompt-independent fixture scores. Missing/ambiguous skill labels are input
errors rather than silently omitted expectations. Undefined metrics are null and
cannot pass an explicitly requested gate. Without gates, recorded provider
failures/partials do not themselves force a nonzero exit.

**Live Jev evaluation was skipped:** `TYPESAFE_API_KEY` was unavailable, checked
without printing any value. No real Jev API request was made. Manual eval with
credentials is available through the normal command and is never invoked by
tests, CI or prepack. This is not a PR3 completion blocker.

## Known limitations / next-stage readiness

- No implementation blocker remains for review of PR3. Authenticated live eval
  and a curated, reviewed dataset remain quality-validation work, not evidence
  supplied by passing these unit tests.
- Independent Noul may score broad/overlapping skills highly together. Neither
  thresholds nor precision across arbitrary catalogs are calibrated or proven.
  Partial-label precision ignores unlabeled selections; interpret it alongside
  coverage and fully labeled cases rather than as a global accuracy claim.
- Reliability is reported, but only precision/recall gates are implemented. A
  failed provider can still match an empty expected set; always inspect failure
  and partial counts. An all-failed partial counts as partial, not core failure.
- Dataset names must resolve uniquely. Agent/scope cannot distinguish two skills
  with the same name, agent and scope; such input is deliberately rejected.
  Disabled positive labels count as false negatives.
- Results contain local stable IDs and measured latency; moving skill paths,
  editing descriptions/catalogs or changing a live model can change results.
  Keep dataset/catalog/config/model versions when comparing runs. There is no
  stored run registry, automatic threshold search, or uncertainty estimate.
- Existing Jev token/context limitations and SDK runtime caveats documented in
  [PR2 validation](PR2_VALIDATION.md) remain; Node 22 is not separately tested.
- No hooks, shadow/advisory modes, persistent telemetry, JSONL traces, Studio,
  embeddings, reranking or description optimization were implemented.

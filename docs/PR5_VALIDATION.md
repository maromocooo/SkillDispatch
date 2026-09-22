# PR5 validation — Operational UX + Local Trace Analytics

Date: 2026-09-22. Scope: offline doctor and privacy-safe local trace inspection.
No advisory/context injection, cloud service, invocation tracking or trace mutation.

## Baseline and Git

- Started on clean, synchronized `feat/pr4-shadow-hooks-traces` at `a39855d`.
- Reviewed `origin/main..origin/feat/pr4-shadow-hooks-traces`: only the eleven PR4
  commits, including `a22053d`, `6b8b284`, `a39855d`; main was their ancestor.
- Fast-forwarded main from `0ffbd9c` to
  `a39855dab362450ba3054c15d1f38a8ca7db3d08`; no merge commit.
- Main integration checks passed: 414 tests, typecheck, lint, build.
- Normally pushed main, fetched and confirmed local/remote equality.
- Deleted remote PR4 branch normally and local branch with `git branch -d`.
- PR5 branch `feat/pr5-trace-ops` starts from that main commit. No main implementation
  commits, amend, rebase, reset, force push or unrelated refactoring.

## Runtime / checks

macOS, pnpm 10.17.1; TypeSafe SDK remains exactly 0.6.0.

| Check | Node 20.20.2 | Node 24.12.0 |
| --- | --- | --- |
| `pnpm test` | 487 passed / 35 files | 487 passed / 35 files |
| `pnpm typecheck` | PASS | PASS |
| `pnpm lint` | PASS | PASS |
| `pnpm build` | PASS | PASS |
| `pnpm pack` | PASS | PASS |
| Installed public CLI smoke | PASS | PASS |

The existing 414 tests remain; PR5 adds 73 (reader 17, analytics 24, trace CLI 12,
doctor library 17, doctor CLI 3). Checks ran with each Node runtime on PATH so
Vitest and its strict SDK/hook child processes use that runtime. Tests use
fixtures, fake fetch, and the existing loopback HTTP regression server only.
No external TypeSafe API requests, real user prompts, live Jev evaluation or host
settings edits were made. Dependency installation used the local pnpm offline
store; Git fetch/push are the intentional remote operations.

## Reader safety

- Async iterator; 64 KiB read blocks; 2 MiB maximum bytes per line excluding LF.
- Opened-file size bounds the scan. Concurrent appends are deferred until a later
  command; this is not a transactional snapshot against in-place edits/truncation.
- Strict UTF-8, JSON and Route Trace v1 Zod validation per line. Invalid lines,
  blank lines, schema-invalid records, truncated tails and oversized lines are
  counted/skipped independently. Complete final JSON without LF is accepted.
- Regular files only, nlink exactly 1, POSIX current owner/private permissions,
  private nonsymlink leaf parent directory. lstat/no-follow/nonblocking open and
  descriptor device/inode comparison; symlink loops and hard links rejected.
- Missing files are empty datasets without directory/file/key creation.
- Installation-key and user-config destinations are reserved, including canonical
  parent aliases. API keys are environment-only; no API-key file mode exists.
- Tests cover multibyte text crossing chunks, CRLF, size boundary, symlink/hardlink,
  unsafe permissions/ownership, directories, early iterator return and append
  snapshot behavior. File/parse error text is not copied into CLI output.

## Analytics semantics

- File counts `totalLines`, `validTraces`, `invalidLines` always describe the whole
  scan. `matchedTraces`, host/provider/outcome counts and statistics use filtered
  valid records only; invalid data cannot reliably be filtered by host/time.
- Average selected counts actual selected decisions, including complete/partial/
  failed traces. P50/P95 use exact nearest rank, matching eval. Empty averages/
  percentiles are null, never NaN. No inference of routing accuracy or invocation.
- Distinct catalog fingerprints are counted, not reconstructed or diffed.
- Skill version = exact name + agent + scope + contentHash. Seen/selected are per
  trace, with equal versions counted once (selected if any equal-version decision
  was selected). Never selected = observed version with zero selections, excluding
  all unobserved skills. Cross-agent names and different hashes/scopes stay distinct.
- Skill ordering: selected count descending, agent/name/scope/contentHash ascending
  with locale-independent compareText. Text shows top 20; JSON all observed versions.
- List: latest timestamp first, UUID ascending for ties, later line first for an
  exact timestamp/UUID tie. Limit 20 by default, validated 1–1000. Agent/outcome/
  since filters tested. Summary supports agent/since.
- Positive integer hour/day windows: inclusive since..now, future excluded only
  when `--since` is used. Otherwise future timestamps remain visible.
- Show: full UUID only, case-insensitive UUID equality; no prefix matching.
  Missing/duplicate valid IDs exit 1 and emit no partial detail. Summary/list count
  duplicate valid records; they do not maintain a global duplicate-ID index.
- Summary keeps frequency maps/sets, not trace bodies. Memory grows with unique
  latency values, skill versions and fingerprints. List retains O(limit) views;
  show retains one safe detail. All operations scan the file; no index exists.

## Privacy / JSON contracts

`telemetry/views.ts` projects explicit fields rather than serializing RouteTrace.
All eight CLI combinations (summary/list/show/doctor × text/JSON) were tested with
raw prompt and key sentinels. Raw prompt, prompt hash, sessionKey, promptKey,
credential value, absolute skill path, transcript path, diagnostic message and
SDK raw error are not printed. Show exposes prompt storage mode only. No raw-display
flag exists. JSON envelopes are version 1 and their shape is tested. Text control
characters are escaped. Metadata names/models/codes are not a general secret
redaction mechanism; upstream contracts must continue to provide safe metadata.

Operational commands use hook config trust, ignoring project config by default.
Only user `hook.trustProjectConfig: true` permits project overrides. The tests cover
self-trusting/malicious project paths and malformed trusted config without source
excerpts. Regular discover/route/eval config layering is unchanged.

## Doctor

Offline checks: Node >=20, config validity/path, user hook project trust, telemetry
state, both host skill catalogs/counts, provider, API-key presence/format only,
data directory, existing key size/permissions, destination safety/readability/
writability, packaged schema readability and valid/invalid line counts.

- Exit 0 when no FAIL; warnings do not fail the command.
- WARN: missing/blank Jev key, not-yet-created data/key/trace, corrupt lines,
  disabled telemetry, empty catalogs or discovery/config diagnostics.
- FAIL: malformed config, invalid credential format, unsafe/unreadable/unwritable
  storage, corrupt-size installation key, unavailable schema or thrown discovery.
- Mock requires no credentials. Missing Jev credentials still prevent Jev routing;
  a usable offline installation report is not successful provider authentication.
- Hook commands are reported available, never inferred to be registered in a host.
- No provider creation/call, key creation, probe file, trace append, chmod, repair,
  hook registration or config mutation. Writability probes cannot guarantee free
  space, filesystem durability, or later permission stability.
- User config/data/trace paths are intentionally shown; skill paths are not.

## Installed package smoke

Tarballs were generated under `/tmp/skilldispatch-pr5-node20` and
`/tmp/skilldispatch-pr5-node24` and installed into a separate temporary directory
using `pnpm add --offline` with the existing store. The explicit development script
uses the installed `.bin/skilldispatch`, not source imports:

```sh
node scripts/trace-ops-smoke.mjs /tmp/skilldispatch-pr5-install/node_modules/.bin/skilldispatch
```

The script isolates the fixture home with a Node test preload (without changing
HOME), supplies temporary runtime paths and blocks/counts fetch attempts. It tests:

- `--help`, doctor text/JSON, first-run no side effects and packaged schema found;
- summary/list/show text/JSON, raw prompt redaction and corrupted-line accounting;
- unknown/duplicate UUID and bad-option exit 1;
- read-only file content before/after operational commands;
- installed discover/route/eval regression and no automatic trace persistence;
- both installed shadow hooks, silent exit 0 and additional valid traces;
- malformed user config doctor exit 1, without secret excerpts;
- no network attempts and cleanup of only its own temporary fixtures.

No installed actual Codex/Claude session is required. This explicit script is not
called by pnpm test, prepack or CI. Real hook registration and live routing quality
remain unmeasured here.

## Limitations and next boundary

No new PR5 implementation blocker is known. Windows ACL behavior and network
filesystem safety are not certified; current checks follow PR4's POSIX/local-file
model. Reads may update OS access metadata, but never write trace content.
Large high-cardinality summaries can consume aggregate-map memory; scanning is
linear in file size and list/show have no persistent index. No retention/repair/
rotation, trace upload or catalog reconstruction is added.

PR6 advisory requires separate authorization and host-specific review, especially
context placement and injection privacy. PR5 statistics measure SkillDispatch
recommendations/reliability, not actual host invocation or output quality. Existing
Codex/Claude text-only hook visibility limits and uncalibrated independent Noul
quality remain unchanged. No advisory or additionalContext implementation started.

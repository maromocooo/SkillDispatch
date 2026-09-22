# v0.1.0 release checklist

Nothing in this checklist authorizes an agent to publish, tag, change visibility or
post launch material. The release candidate PR prepares artifacts for a maintainer.

## Review the candidate

- [ ] Merge reviewed PR10 normally; check a clean main and reviewed commit SHA.
- [ ] `pnpm install --frozen-lockfile`; tests, typecheck, lint, build on Node 20 and 24.
- [ ] GitHub CI green on the exact release commit (not merely local equivalents).
- [ ] `pnpm pack --pack-destination artifacts` and
  `node scripts/package-smoke.mjs artifacts/skilldispatch-0.1.0.tgz --offline`.
- [ ] Inspect `node scripts/audit-tarball.mjs artifacts/skilldispatch-0.1.0.tgz`.
  No tests, secrets, private fixtures, logs, local config or runtime data.
- [ ] Review README links, source/npm quick start, public API, schemas, MIT license,
  dependency license files, SECURITY, contributing guide and changelog.
- [ ] Verify `package.json`, `src/version.ts`, workflows and artifact names agree.
  The candidate is 0.1.0, replacing unpublished 0.1.0-dev.1; no version/tag published.
- [ ] Recheck `npm view skilldispatch name versions --json`. Registry 404 means no
  package metadata was found, not a reservation or guarantee of ownership.
  If unavailable, agree a scoped name before modifying install instructions.
- [ ] Review all synthetic benchmark labels by a human. Record reviewer/date before
  claiming ground-truth accuracy. Run mock validation; live Jev is separate opt-in.
- [ ] If committing a live result, retain model/date/SDK/policy/runtime/dataset hash
  and reliability counts; never label mock scores as measured quality.
- [ ] Repeat secret/private path scan on tracked files and the final tarball.
- [ ] Real Claude advisory + Skill attempted/succeeded smoke on synthetic data.
- [ ] Real Codex shadow smoke and hook trust/reload check. Async delivery is not guaranteed.
- [ ] Ensure private vulnerability reporting is enabled (currently disabled at review).

## CI and publication safeguards

`ci.yml` runs Node 20/24 on PRs and main/feature pushes: frozen install, offline
application tests, typecheck, lint, build, mock benchmark, pack and isolated smoke.
`release.yml` validates `v*` tags and uploads a candidate artifact only. It does not
create a GitHub Release or publish a package. `publish.yml` is separate/manual,
disabled unless repository variable `NPM_PUBLISH_ENABLED` is exactly `true`.

Before enabling that variable:

- [ ] Configure GitHub `npm-release` environment with required human reviewers,
  prevent self-review, and restrict deployment to reviewed main.
- [ ] Restrict release tag creation and protect main; verify exact tag ancestry.
- [ ] Configure npm trusted publisher for owner `maromocooo`, repo `SkillDispatch`,
  workflow **`publish.yml`**, environment **`npm-release`**, GitHub-hosted runner.
- [ ] Ensure npm permits the intended direct publish action. Current npm also
  supports staged publishing; consider stage-only with a separate 2FA approval.
- [ ] Confirm first-publication bootstrap/ownership in npm's account UI. Trusted
  publisher setup requires a package settings entry; do not invent a placeholder
  publication or rely on an untested first-publish flow. A maintainer may need the
  first authenticated interactive publication before configuring later OIDC releases.
- [ ] Do not create/store a long-lived `NPM_TOKEN`. Subsequent OIDC publishing uses
  short-lived workflow identity with `id-token: write`.

Official references reviewed for this candidate:
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
[GitHub private reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
Current OIDC needs npm ≥11.5.1 / Node ≥22.14; the publish job uses Node 24 and
npm 11.19.1. Public repo + public package + trusted publishing permits automatic
provenance; the job additionally requests `--provenance`. Release builds do not
restore dependency caches. Settings/permissions and authentication are not tested
by merely validating workflow syntax.

## Explicit maintainer release actions (not performed by PR10)

1. Approve the checklist and final clean main; deliberately create/push `v0.1.0`.
2. Review successful tag validation and unpacked candidate contents.
3. After ownership/OIDC/environment setup, enable the guarded variable and manually
   dispatch `publish.yml` from main with the reviewed tag and confirmation. Review
   the environment approval; never publish from a fork/PR.
4. Verify installed npm package/version/provenance in a fresh environment.
5. Deliberately publish a GitHub Release with changelog and limitations; no workflow
   in this PR does that automatically.
6. Update README publication status, changelog date and optional npm badge only after
   the registry version exists. Use sanitized synthetic demo material for launch.

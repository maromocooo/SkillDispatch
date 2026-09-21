# PR1 validation

Validated locally on 2026-09-21, macOS, with Node.js 20.20.2 and 24.12.0.

- `pnpm test`: 87 tests across parser, discovery, routing, configuration and CLI.
- `pnpm typecheck`: strict TypeScript, including tests and CLI entry points.
- `pnpm lint`: Biome checks source/configuration; deliberately invalid skill
  fixtures are excluded from formatting.
- `pnpm build`: ESM CLI, library, declarations and source maps.
- `pnpm pack`: installable package with the `skilldispatch` executable.
- Installed the tarball into a separate temporary directory and checked the CLI
  help/version and public library imports under Node 20.
- Built CLI discovery against local skills returned structured JSON successfully.
- Built CLI with the committed discovery/score fixtures selected `react-patterns`
  (0.95), `frontend-testing` (0.91), and `accessibility-review` (0.88) together.
- An empty recommendation set returned successfully as JSON.

Tests create temporary fixture homes/repos, exercise `.git` directory/file
boundaries, symlink aliases/cycles, invalid YAML, fallback metadata, disabled
skills, provider timeouts and malformed responses. No real model API is used.
The offline mock is a plumbing fixture, not an evaluated relevance model.

PR2 readiness: the provider boundary, pure multi-label policy and fail-open
coordinator are implemented. Next work is official Jev SDK verification,
independent judgments, chunking/concurrency, response/probability mapping and
SDK-boundary tests. Host settings/plugin parity and native invocation telemetry
remain explicitly outside PR1.

## PR1.1 provider contract validation

The existing 87 tests are retained, with 34 additional cases (121 total):

- Candidate-level Codex/Claude agent identity at the provider boundary.
- Agent-scoped duplicate diagnostics, distinct stable IDs and deterministic catalogs.
- Complete and partial coverage, all-failed partial output, malformed ID sets,
  invalid completeness/probabilities/diagnostics, disabled-candidate exclusion,
  policy application, diagnostic serialization and stable ordering.
- The mock's complete-output contract, including an empty catalog.

`pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass under Node 20.20.2;
tests also pass under Node 24.12.0. Package validation uses `pnpm pack`, an offline
installation into a separate temporary directory, CLI help/version checks and
the installed library's cross-agent catalog and partial-result routing behavior.

No dependencies or runtime network calls were added. PR2 can implement
`RouterProvider.judge` using this SDK-independent contract; SDK verification and
chunking/concurrency remain future work, with no PR1.1 contract blocker identified.

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

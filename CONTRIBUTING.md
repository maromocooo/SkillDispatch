# Contributing

Use Node.js 20+ (CI tests 20 and 24) and pnpm 10.17.1.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm pack
```

Start a focused feature branch from current main and open a PR with the problem,
behavior change and relevant validation. Preserve existing user configuration,
trace compatibility and unrelated host settings. Include documentation for public
behavior changes. Do not commit `dist`; package builds run during `prepack`.

Normal tests and CI must not call TypeSafe or any external model API. Use injected
providers/fetch, synthetic filesystem fixtures and isolated homes. Existing SDK
transport regression tests use loopback HTTP. Live benchmarks require a separate
explicit `--live` command and a key; never use them as test or prepack hooks.

Keep prompts, API keys, absolute user paths and company skills out of fixtures,
logs and issues. Hooks must remain bounded and fail-open. Do not bypass project
config trust, file ownership/link checks or sanitized diagnostics. Read
[SECURITY](SECURITY.md) before reporting a vulnerability.

To add a provider, implement the SDK-independent `RouterProvider` boundary and test
complete/partial/failed coverage, mapping, privacy, deadlines and deterministic
policy behavior. To add an agent, implement a discovery adapter and host wire
adapter without importing host details into core. Verify official host contracts;
do not infer actual invocation from routing selection. Keep public exports small.
See [architecture](docs/ARCHITECTURE.md) for existing contracts.

Benchmark labels are versioned reviewable data. Discuss ambiguous cases explicitly,
do not fit labels to model outputs, and keep mock validation separate from accuracy.
Dataset drafts need human review before publication of quality claims.

Please be respectful, assume good intent and keep technical disagreements focused
on behavior and evidence. Harassment and disclosure of private information are not
welcome. A formal Code of Conduct may follow when a private enforcement contact is
established; this document does not pretend to adopt an incomplete standard policy.

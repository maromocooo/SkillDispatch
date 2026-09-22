# Coding-agent contribution guide

SkillDispatch is an observable skill-routing runtime for Claude Code and Codex.
It discovers a host-aware catalog, routes a prompt to zero or more skills, delivers
optional recommendations, and records local routing and observed invocation data.
Read [README](README.md), [architecture](docs/ARCHITECTURE.md),
[operations](docs/OPERATIONS.md), [security model](docs/SECURITY_MODEL.md) and
[contributing](CONTRIBUTING.md) before changing public behavior.

## Product and dependency boundaries

- Use TypeScript on Node.js 20+ and pnpm. CI covers Node 20 and 24.
- Core domain/policy code must not import host adapters or provider SDKs.
  Keep host wire formats in adapters and SDK types inside provider implementations.
- Preserve the `RouterProvider` abstraction. Jev is the first real provider;
  multi-skill selection is first-class, including an empty selection.
- Discovery is read-only and adapter-based. A file on disk is not automatically
  model-routable. Respect native identity, eligibility and documented scope limits.
- Codex is shadow-only. Claude advisory requires explicit user-owned configuration
  and a synchronous registration. Do not expand runtime modes without an agreed scope.

## Safety and privacy

- Shadow and invocation observers are silent, bounded and fail-open. A provider,
  parser or storage failure must not block the host's task.
- Claude advisory emits only safe, unambiguous native identifiers after complete
  routing, within the existing context bound. Do not inject skill bodies, paths,
  descriptions, prompt text or probabilities. Native invocation remains the host's
  decision; manual-only skills are excluded.
- Preserve the user/project configuration trust boundary. Project configuration
  cannot enable advisory, even when project routing configuration is trusted.
- Preserve default prompt HMAC storage, keyed host correlation, explicit raw opt-in
  and privacy-safe CLI projections. Jev sends raw prompt text and minimal metadata
  to TypeSafe; do not describe local hashing as request redaction.
- Treat async invocation events as positive evidence. Missing events are unknown,
  not proof of non-use or failure. Do not infer exact conversion rates.
- Keep file ownership, private permissions, symlink/hardlink and collision checks.
  Persist no raw SDK errors, environment dumps, tool arguments or responses.
- Never commit credentials, real user configuration, private skills or real traces.
  Do not modify actual host settings while developing or testing; use isolated
  fixture homes. An explicit user request is required for real-environment setup.

## Validation expectations

Run the relevant tests while iterating, then the standard checks before delivery:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm pack
```

Normal tests and CI must never call TypeSafe or another external model API. Use
mock providers/fetch and synthetic fixtures; SDK transport tests may use loopback.
Manual live evaluation is separate opt-in and must not be wired into normal tests.

- Provider changes: verify candidate coverage, partial/failure behavior, aborts,
  request bounds, deterministic selection and the network privacy boundary.
- Discovery changes: verify scopes, settings precedence, identity, collisions,
  manual-only filtering, bounded traversal and exclusion of inactive sources.
- Hook/observer changes: verify parsing, silent fail-open, correlation, async event
  loss/ordering, storage safety and absence of private payloads in outputs.
- Public schemas: keep JSON Schema/runtime validation aligned and retain old valid
  trace fixtures. Preserve user config, CLI and existing public exports.
- Packaging/onboarding changes: run the isolated tarball smoke and hygiene checks
  described in CONTRIBUTING. Never use actual home settings for smoke tests.

Update public documentation alongside behavior changes, using present-tense
contracts and explicit limitations. Keep changes focused; do not add dependencies,
exports or runtime features solely to simplify a documentation task. Record test
results in the change report, not new per-change validation documents in the repo.

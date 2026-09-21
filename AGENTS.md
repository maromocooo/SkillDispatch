# AGENTS.md — SkillDispatch implementation instructions

You are implementing **SkillDispatch**, an open-source universal skill-routing runtime for coding agents.

Read these files before changing code:

1. `IMPLEMENTATION_BRIEF.md`
2. `docs/ARCHITECTURE.md`
3. `schemas/route-trace.schema.json`
4. `examples/skilldispatch.config.yaml`
5. `evals/example.yaml`

## Product intent

Do **not** build “a Jev demo that chooses one skill”.

Build a small, production-shaped routing runtime with:

- cross-agent skill discovery,
- multi-skill routing,
- Jev as the first routing provider but not hard-wired into the domain layer,
- `shadow`, `advisory`, and later `enforce` modes,
- deterministic JSON/JSONL traces for Agent Skill Studio,
- an eval runner,
- Codex and Claude Code hook adapters.

The OSS runtime must be useful without Agent Skill Studio.

## Technology

Use TypeScript on Node.js 20+.

Preferred defaults:
- package manager: `pnpm`
- CLI: `commander` or similarly small library
- schema validation: `zod`
- YAML: `yaml`
- tests: `vitest`
- TypeSafe/Jev: official `@typesafe-ai/sdk`
- build: `tsdown` or `tsup`
- lint/format: Biome

Avoid adding a database in v0.1. Write JSONL traces locally.

## Design constraints

1. Core routing logic must not import Codex- or Claude-specific code.
2. Core domain types must not depend on Jev types.
3. Skill discovery must be adapter-based.
4. Jev is the default router provider; provider interface must permit future embedding/LLM/hybrid implementations.
5. Multi-skill selection is first-class. Do not reduce routing to a single `Choice`.
6. `shadow` mode must never modify agent context.
7. `advisory` mode may inject selected skill paths/names and a concise instruction to load/follow them.
8. Do not inject complete SKILL.md bodies in the default path.
9. Trace writing is best effort and must not break the coding-agent prompt path.
10. Do not store raw user prompts in traces by default. Store a salted hash; raw prompt storage is opt-in.
11. Never log API keys or environment values.
12. When the router fails or times out, fail open: the host agent should continue normally.

## Work style

Implement vertical slices. After each phase:
- run unit tests,
- run typecheck,
- run lint,
- update the README with commands that actually work.

Prefer a working narrow path over broad stubs.

## Required implementation order

### Phase 0 — repository bootstrap
Create the package layout described in `docs/ARCHITECTURE.md`.

### Phase 1 — skill discovery
Implement generic `SkillDescriptor` and:
- Codex discovery adapter,
- Claude Code discovery adapter,
- fixture-based tests for scopes, duplicate names, invalid frontmatter, disabled skills where discoverable.

### Phase 2 — router domain + mock provider
Implement routing policy and provider interface using a deterministic fake provider first.

### Phase 3 — Jev provider
Implement batched multi-label judgments using Jev.
- One independent binary judgment per skill/candidate.
- Chunk requests; do not assume unlimited questions per API call.
- Preserve per-skill probability.
- Support threshold and max selected skills.
- Support optional coarse prefilter interface, but do not implement embeddings yet.

### Phase 4 — CLI
Implement:
- `skilldispatch discover`
- `skilldispatch route "<prompt>"`
- `skilldispatch hook codex`
- `skilldispatch hook claude`
- `skilldispatch eval <file>`
- `skilldispatch doctor`

### Phase 5 — hooks
Implement Codex `UserPromptSubmit` adapter and Claude Code `UserPromptSubmit` adapter.
Start with `shadow` and `advisory`.
Do not claim portable “actual skill invocation” telemetry unless the host exposes it reliably.

### Phase 6 — trace contract
Write JSONL traces conforming to `schemas/route-trace.schema.json`.

### Phase 7 — eval runner
Implement precision, recall, F1, exact-set match, false positives, false negatives, latency summary.
Support positive and negative expectations.

## Definition of done for v0.1

A fresh user can:
1. install the CLI,
2. set `TYPESAFE_API_KEY`,
3. run `skilldispatch doctor`,
4. see discovered Codex/Claude skills,
5. route a natural-language prompt to zero or multiple skills,
6. enable a `UserPromptSubmit` hook in shadow mode,
7. switch to advisory mode,
8. inspect local JSONL traces,
9. run an eval YAML file and see routing metrics.

No Studio UI is required in this repository.

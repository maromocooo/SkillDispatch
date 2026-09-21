# Initial prompt for local Codex

Implement the SkillDispatch OSS project described by the attached/current-repository handoff files.

Read, in order:
1. `AGENTS.md`
2. `IMPLEMENTATION_BRIEF.md`
3. `docs/ARCHITECTURE.md`
4. `schemas/route-trace.schema.json`
5. `examples/skilldispatch.config.yaml`
6. `evals/example.yaml`

Start with **PR 1 only**:
- TypeScript/Node 20+ project bootstrap using pnpm
- core domain types
- SKILL.md frontmatter parser
- Codex skill discovery adapter
- Claude Code skill discovery adapter
- deterministic mock routing provider
- pure routing policy
- `skilldispatch discover`
- `skilldispatch route`
- unit/fixture tests

Do not implement Jev, hooks, telemetry, or the eval runner yet.

Before coding:
- inspect the current official Codex and Claude Code documentation available to you for local skill discovery paths;
- if current behavior differs from the handoff, follow current official behavior and document the deviation in README.

Constraints:
- core must not depend on Jev or agent-specific hook types;
- duplicate skill names remain distinct by canonical path;
- invalid skills produce diagnostics rather than crashing;
- symlink traversal must not loop;
- deterministic output ordering;
- no network calls in PR 1.

Then implement the code, run tests/typecheck/lint, fix failures, and summarize:
- files added,
- architecture decisions,
- commands to run,
- known gaps before PR 2.

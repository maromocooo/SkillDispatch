# Implementation references verified on 2026-09-21

These are integration facts that were checked while preparing the handoff.
Re-check official docs while implementing because these interfaces can change.

- OpenAI Developers — Codex Hooks: `UserPromptSubmit`, its input/output fields, and `additionalContext`.
- OpenAI Developers — Build Skills: current Codex local skill discovery paths and implicit invocation behavior.
- Anthropic Claude Code Docs — `.claude` directory / skills and hook lifecycle.
- TypeSafe official JS/TS SDK repository — `@typesafe-ai/sdk`, Node.js 20+.

Key facts captured in `IMPLEMENTATION_BRIEF.md`:
- Codex currently accepts `UserPromptSubmit` additional developer context.
- Codex scans `.agents/skills` in repository scopes and `$HOME/.agents/skills` for user skills.
- Claude Code supports project/global skill directories and a pre-processing `UserPromptSubmit`.
- TypeSafe provides an official TypeScript SDK suitable for the first Jev provider.

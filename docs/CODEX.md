# Codex integration contract

SkillDispatch distinguishes a locally eligible catalog, emitted recommendations,
and observed instruction reads. None proves that a live session offered a skill,
that the model followed its instructions, or that its task succeeded.

## Verified host contracts

The reference CLI is Codex **0.155.1**, upstream commit
[`be2951ea34f0d295ed0becf97079f92fa5f6950e`](https://github.com/openai/codex/tree/be2951ea34f0d295ed0becf97079f92fa5f6950e).
The inspected Desktop application **26.915.31945** embeds **0.155.0-alpha.9.2**,
commit [`4607249e430dac1c961df4dc615beae88e33cec8`](https://github.com/openai/codex/tree/4607249e430dac1c961df4dc615beae88e33cec8).
These versions share the relevant hook schema and plugin store selection code.
Source verification and fixture tests are separate from real-session validation.

| Surface | Verified contract | Boundary |
|---|---|---|
| Discovery | `.agents/skills`, configuration-directory `skills/`, `.system`, admin roots, configured installed plugins | Disk state cannot confirm Desktop session/account availability |
| Advisory | Synchronous `UserPromptSubmit` JSON `hookSpecificOutput.additionalContext` | Developer context supplements the user request; `$name` text is not structured skill input |
| Observation | `PreToolUse` / `PostToolUse`, matcher `Bash`, `tool_input.command` | No public native Skill-call lifecycle contract; narrow literal file-read evidence only |
| Terminal state | Unified exec Post response is output text, possibly truncated | Post is not exit-code evidence; success and complete load remain unknown |
| Correlation | `session_id`, `turn_id`, `tool_use_id`; optional `agent_id` | Subagents share parent session identity; never credit their events to main-turn adoption |

Relevant sources at the CLI commit:
[hook wire schemas](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/hooks/src/schema.rs),
[developer context placement](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/core/src/context/hook_additional_context.rs),
[tool response projection](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/core/src/tools/context.rs),
[skill roots](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/ext/skills/src/host_roots.rs),
[skill configuration rules](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/config/src/skills_config.rs),
[plugin installation selection](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/core-plugins/src/store.rs),
[plugin namespaces](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/ext/skills/src/loader/namespace.rs).

See also the official [hooks](https://learn.chatgpt.com/docs/hooks),
[skills](https://learn.chatgpt.com/docs/build-skills),
[plugins](https://learn.chatgpt.com/docs/build-plugins), and
[app-server](https://learn.chatgpt.com/docs/app-server) references. New upstream
schemas are not automatically supported contracts. A separate `skills/list`
instance is not evidence about an existing Desktop session.

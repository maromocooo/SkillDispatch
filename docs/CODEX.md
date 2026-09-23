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

## Catalog resolution

The default config root is `~/.codex`, overridden by absolute `CODEX_HOME`.
Sources are project `.agents/skills` from cwd to the nearest Git boundary, user
`~/.agents/skills`, CODEX_HOME `skills/` and its explicit `.system` source,
file-admin roots (default `/etc/codex/skills`), and additional library system/admin
roots. Trusted legacy project `.codex/skills` is retained. Hidden system content
is not counted a second time through the user scan. Canonical aliases collapse;
distinct same-name skills remain separate and ambiguous recommendations are omitted.

`metadata.codex` separates origin, configured enablement, implicit routing eligibility
and **unconfirmed** session availability. `enabled` retains its meaning: eligible
for automatic routing. Native names use frontmatter names and the owning plugin's
manifest namespace (`plugin:skill`), verified against Codex source rather than copied
from Claude. Names outside the safe advisory identifier subset are non-routable.
Path-based skill IDs retain their original meaning. A separate path-free identity
digest includes origin, name, plugin identity/version and scope. Fingerprints retain
duplicate multiplicity and reflect content/eligibility without containing home paths.

Plugins require effective `[plugins."name@marketplace"]` configuration and an
installed cache root. `enabled` defaults true within an explicitly configured entry;
`enabled = false` excludes that plugin. Effective file settings use system → user →
explicitly trusted project order. Project trust comes from Codex user settings,
independently of SkillDispatch's project-config trust switch. An explicit untrusted
child is not overridden by a trusted repository root. Non-file managed trust is not
reconstructed.

Only configured plugin IDs address `plugins/cache/<marketplace>/<name>`.
Upstream prefers the `local` installation when present. Without `local`, this adapter
accepts a single version directory; multiple versions produce a diagnostic and no
routing candidates. This is deliberately more conservative than upstream's semantic
version/lexical comparator. Neither mtime nor the greatest directory string establishes
active state here. Cache-only and marketplace-only skills are not made active.

Legacy `.codex-plugin/plugin.json` supports bounded `./skills` component strings or
arrays with recursive discovery. Portable root `plugin.json` supports the verified
Agent Plugins 1.0.0 schema and direct children of `skills/`. Extensions/overlays that
cannot be resolved safely are unsupported. Component traversal and symlink escape
are rejected; discovery never runs plugin code. Migrated legacy commands are not
included. Remote account-installed plugin snapshots are not reconstructed: a plugin
without locally observable configuration may be missing even if the Desktop offers it.

User `skills.config` rules match canonical absolute paths or exact native names,
in order. Shared project skill selectors are ignored, matching the verified source's
User/SessionFlags rule scopes. SessionFlags cannot be observed by this adapter.
`allow_implicit_invocation: false`, disabled instructions/bundled policy, invalid
policy and malformed authoritative settings exclude affected candidates. Nonempty
product restrictions are excluded conservatively because the current session's
product context cannot be certified. Unsupported profile selection and legacy managed
configuration are diagnosed; file marketplace requirements block unresolved plugins
without dropping otherwise healthy local skills. MDM/cloud/session overrides remain
outside this disk-state model. Windows admin roots require explicit library options.

## Opt-in and rollback

Both hosts default to shadow. In your **user** SkillDispatch config, merge:

```yaml
hook:
  codexContract: "0.155.1"
  modes:
    codex: advisory
```

Use `0.155.0-alpha.9.2` only when that is the verified target runtime, such as the
Desktop build listed above. This value declares a source-verified target; it is not
a runtime attestation. Check the actual CLI/embedded binary after host upgrades.
Unknown/absent contracts cannot emit Codex advisory or enable its observer readiness.
No per-turn Codex subprocess or app-server is launched to guess the host version.

```sh
skilldispatch hooks install codex --dry-run
skilldispatch hooks install codex
skilldispatch hooks status codex
skilldispatch doctor
```

The installer updates only its entries in `$CODEX_HOME/hooks.json`. Existing inline
hooks require manual resolution; the installer does not rewrite config.toml. Review
and trust the new definition in the **target** Codex host and reload/restart it with
the routing API key inherited. It never approves host trust automatically. Existing
Claude registrations are untouched. Status detects advisory/async mismatches and
reports the user-declared contract separately from unverified live host state.

Advisory uses sync UserPromptSubmit JSON, at most 4096 UTF-8 bytes. Only safe unique
native names are emitted; no path hints, bodies, descriptions, prompt, probabilities
or errors enter the context. It asks Codex to continue the original task, optionally
loading useful skills normally. It does not pretend `$name` text auto-expands like
structured skill input. Partial/failed/empty routing and mismatched registration
emit no context. Emission is not confirmation of host consumption.

For observation in shadow mode, retain the supported `codexContract` and set
`hook.modes.codex: shadow`, then reinstall. This restores async routing while keeping
async `PreToolUse`/`PostToolUse` **Bash** observers. There is no Codex `Skill` matcher or
`PostToolUseFailure` registration. To remove all owned Codex entries:

```sh
skilldispatch hooks uninstall codex --dry-run
skilldispatch hooks uninstall codex
```

Other registrations and existing telemetry files remain intact.

## Evidence and limits

The observer accepts only `cat`, `/bin/cat` or `/usr/bin/cat` with one literal,
absolute SKILL.md path (optional `--`, simple quoted paths allowed). It matches the
canonical file against a targeted catalog lookup; unrelated commands return before
catalog work. No command is ever executed by the observer.

Relative paths have no authoritative tool workdir in the normalized hook input.
Pipelines, redirects, substitutions, globs, dynamic variables, multiple commands,
partial readers and nested code wrappers are unsupported. A tool that merely
mentions a skill is not evidence. Symlink aliases outside recognized source roots
may remain unresolved by targeted lookup.

- Pre: a literal instruction-read **request** reached the tool hook.
- Post: a corresponding terminal event was observed. For unified exec, the host
  retains the original call ID/command across delayed completion. Running responses
  do not produce a terminal Post until completion; the observer does not scrape
  output or invent a separate write_stdin lifecycle.
- The supported Post hook response is output text, not the structured code-mode
  result containing exit code. Exit success/failure, truncation, complete instruction
  loading, understanding and compliance are therefore **unknown**.
- Pre-only remains unknown. Post-only is retained as terminal-without-attempt.
- Different content snapshots or conflicting identity are excluded from adoption
  pairs. A current file cannot prove the contents read earlier.
- Main, subagent and unknown execution context remain distinct. Subagent events
  never increase main-turn recommendation adoption counts.

HMAC domains match routing for `session_id` and `turn_id`, and use a separate
session-scoped tool-use domain. Joins include agent/session/turn/tool; missing IDs
are not guessed from nearby timestamps. No raw IDs, commands, paths, arguments,
stdout/stderr, errors, transcripts or API keys are persisted. The observer needs no
TypeSafe key and makes no API request. It is async, silent and bounded; missing
events never prove non-use or failure. There is no success/conversion rate.

## Storage and compatibility

Claude `invocations.jsonl` and its published v1 semantics are unchanged. Codex writes
`codex-instruction-reads.jsonl` using its own strict v1 event schema. Codex hook routes
write Route Trace **v2** to the existing route stream. The new CLI reads old v1 and new
v2 routes without migrating or mutating files; unsupported versions are counted
separately from corruption. Old CLIs can reject new Codex v2 records. Do not interpret
that rejection as historical file corruption.

Trace CLI JSON envelopes are **version 2**. Existing routing fields retain their
meaning; summary adds `instructionReads` and `instructionReadHealth`, and Codex show
adds `instructionReads`. Consumers should check envelope/schema versions. Claude
`observedModelInvoked`/`observedSucceeded` never include Codex reads. Read attempts and
terminal events have separate raw stream counts and deduplicated route-skill pair
counts. Old/unconfigured routes report telemetry unavailable; configured routes with
no event report not observed/unknown. All streams retain private permissions, link,
owner, bounded append and reserved key/stream collision checks.

## Private-host verification

Fixture/package smoke proves the integration plumbing, not live Codex behavior.
No host settings are changed during development. A read-only inventory can start with:

```sh
skilldispatch discover --agent codex
skilldispatch hooks status codex
skilldispatch doctor
```

Inspect source counts and diagnostics. Physical cache totals are not active catalog
counts. Compare with `/skills` or `skills/list` in the **same version/session** where
available; report missing/extra/disabled/ambiguous sources. Do not start a separate
app-server and call its catalog identical to the Desktop's. Such startup may refresh
plugins or authenticated state, so it is a separate manual check.

After explicit opt-in/install/trust, use a new host session and an isolated synthetic
repository with one harmless skill that instructs the agent to summarize a fixed
text. Keep real user files and external services outside the task. Try a matching
prompt and an unrelated negative prompt; confirm zero recommendations are valid.
Check that Codex performs the original task rather than only acknowledging context.
Then inspect exact trace IDs:

```sh
skilldispatch traces list --agent codex --limit 3
skilldispatch traces show <exact-trace-uuid>
skilldispatch traces summary --agent codex
```

Check selected vs emitted, observer configuration, read-attempt vs terminal evidence,
content correlation and unknown outcomes separately. Native invocation is unsupported
in these contracts, even when a read was observed. Real-host emission placement,
actual Pre/Post firing, reload/trust, delayed completion and model behavior remain
manual acceptance checks before release.

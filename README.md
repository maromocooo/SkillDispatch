# SkillDispatch

Universal, observable skill routing for coding agents.

PR1 is being implemented: offline discovery and deterministic mock routing. Jev,
hooks, telemetry, doctor, and eval execution belong to later PRs. The handoff and
trace schema describe that roadmap; they are not a list of shipped features.

## Development

Requires Node.js 20+ and pnpm 10.17.1.

```sh
npm install --global pnpm@10.17.1
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The library and CLI will keep discovery adapters, providers, and core policy
separate. No runtime network calls are made in PR1.

The library exports `SkillDescriptor`, `DiscoveryAdapter`, and a data-only
`parseSkill` parser. Invalid frontmatter returns diagnostics; it never executes
Markdown. Skill IDs use the agent and canonical path; content hashes use the
original source, independent of metadata whitespace normalization.

Codex discovery scans `.agents/skills` from CWD to the nearest Git repository
boundary, then `~/.agents/skills` and `/etc/codex/skills`. It follows directory
symlinks safely, retains distinct paths with duplicate names, and reads
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) for disabled paths.
`agents/openai.yaml` can also exclude explicit-only skills from routing.
Bundled system roots may be supplied through the adapter's `systemRoots` option;
PR1 does not guess paths inside a Codex installation or plugin cache.

Claude Code discovery reads `.claude/skills` from CWD to the repository root and
`$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`). Missing names use the
directory name; missing descriptions use the first non-empty body line, following
the current native format. Invalid metadata still yields diagnostics.
`disable-model-invocation` excludes a skill from automatic routing;
`user-invocable: false` does not. PR1 retains same-name paths even when a native
slash command would prefer the personal scope. Session visibility, managed
settings, `skillOverrides`, plugins, synced skills and legacy commands are not
modeled. This is a local catalog, not an assertion of host invocation behavior.

The library now exports `route`, `applyPolicy` and `MockRouterProvider`. Provider
input contains only candidate IDs, names, descriptions and scopes. Disabled
skills never reach the provider. Policy uses an inclusive threshold (default
0.75), descending probability, name/ID tie breaks and a four-skill cap.
Provider failures, invalid responses and timeouts return no recommendations plus
a diagnostic. Mock scores can be keyed by ID or name. Without fixture scores the
mock uses simple token overlap (0.9 for a match, 0.04 otherwise); these scores are
for plumbing tests and are not calibrated relevance probabilities.

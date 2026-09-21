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

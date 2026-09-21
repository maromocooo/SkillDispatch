# SkillDispatch

**Universal, observable skill routing for coding agents.**

SkillDispatch discovers local coding-agent skills and routes one prompt to **zero
or multiple skills**. PR1 provides Codex and Claude Code discovery, a normalized
catalog, pure selection policy, and an offline deterministic mock provider.

**Status:** PR1 development preview. Mock scores test the routing pipeline; they
are not calibrated relevance probabilities. Jev, hooks, telemetry, `doctor`, eval
execution, and Agent Skill Studio are not implemented. The handoff and trace
schema describe the future runtime, not the current CLI surface.

## Install from source

Requires Node.js 20+ and pnpm 10.17.1. There is no published npm release yet.

```sh
git clone https://github.com/maromocooo/SkillDispatch.git
cd SkillDispatch
npm install --global pnpm@10.17.1
pnpm install --frozen-lockfile
pnpm build
pnpm skilldispatch --help
```

Run directly with `node dist/cli/index.js`, or install the built package locally:

```sh
pnpm pack
npm install --global ./skilldispatch-0.1.0-dev.1.tgz
skilldispatch --version
```

PR1 makes no runtime network requests and needs no API key. Discovery does not
execute skill scripts, Markdown substitutions, or instructions.

## CLI

```sh
skilldispatch discover
skilldispatch discover --agent codex
skilldispatch discover --agent claude-code --json
skilldispatch discover --json

skilldispatch route "Review this authentication implementation"
skilldispatch route "Build a React form and write tests" --json
skilldispatch route "Review keyboard accessibility" --threshold 0.8 --max-skills 2
skilldispatch discover --cwd ./packages/web --json
```

From a source checkout, replace `skilldispatch` with `pnpm skilldispatch` or
`node dist/cli/index.js`. For scripts that need pure JSON, prefer the latter.

`discover --json` returns `{ skills, diagnostics }`, including disabled skills.
Text mode prints name, agent, scope, enabled state, and canonical path, with
diagnostics on stderr. Distinct paths with the same name remain separate skills.

`route --json` returns `selected`, `allDecisions`, `router`, `policy`, and
`diagnostics`. Decisions include IDs, names, paths, probabilities and selection
flags. Raw prompts and full skill bodies are not emitted or stored. Ordering and
mock scores are deterministic; measured `router.latencyMs` varies. The provider
is identified as `mock` in both output formats.

Exit status is 0 for successful commands, empty selections, partial discovery,
and fail-open provider failures (inspect diagnostics). Invalid CLI options,
invalid configuration, or an inaccessible CWD return a nonzero status. `--json`
applies to successful command results; usage/config errors are reported on stderr.

## Configuration

Read order, lowest to highest priority:

1. Built-in defaults.
2. `~/.config/skilldispatch/config.yaml`.
3. `.skilldispatch.yaml` in the effective CWD (`--cwd` if supplied).
4. `--config <file>`, relative to that CWD.
5. CLI `--agent`, `--threshold`, and `--max-skills`.

Project config lookup does not walk ancestors. Objects merge by field, score maps
merge by key, and agent arrays replace earlier arrays. Unknown keys warn; invalid
values fail with a concise error. Configuration files are never created for you.

```yaml
router:
  provider: mock
  timeoutMs: 2500
policy:
  threshold: 0.75
  maxSkills: 4
discovery:
  agents: [codex, claude-code]
```

Without fixture scores, the mock performs case-insensitive token overlap over
skill names/descriptions: 0.9 for a match, 0.04 otherwise. It does not understand
intent, negation, paraphrases, or multilingual semantics. The policy selects
`probability >= threshold`, caps the result at `maxSkills`, and sorts by
probability descending, then name and ID in locale-independent order.

For exact fixture scores, see [the working example](examples/skilldispatch.config.yaml):

```sh
skilldispatch route "Any fixture prompt" --config examples/skilldispatch.config.yaml --json
```

Configured scores are **prompt-independent**. Keys can be skill IDs or names;
an ID overrides a name. `router.mock.defaultProbability` controls unlisted skills.
No skill is forced when none passes the threshold.

The future trace location is `~/.local/share/skilldispatch/traces.jsonl`. PR1 does
not write traces and does not accept telemetry or mode configuration.

## Discovery behavior and current host differences

Official documentation checked on 2026-09-21:

- [Codex skills](https://learn.chatgpt.com/docs/build-skills): scans `.agents/skills`
  from CWD to the repository root, plus `~/.agents/skills` and `/etc/codex/skills`.
  Duplicate names remain separate. `~/.codex/config.toml` supports per-path
  disabling; `agents/openai.yaml` controls implicit invocation.
- [Claude Code skills](https://code.claude.com/docs/en/skills): project discovery
  also walks to the repository root. Unlike the handoff's strict parser, Claude
  allows missing names (directory fallback) and descriptions (first non-empty
  body line). Personal skills take precedence over project skills for native
  command-name collisions. Nested skills may also load later during a session.
- [Claude configuration directory](https://code.claude.com/docs/en/claude-directory):
  `CLAUDE_CONFIG_DIR` replaces `~/.claude` for personal skills.

The Codex adapter respects `CODEX_HOME` for user `config.toml`. SkillDispatch
retains disabled skills in discovery but excludes them before provider calls.
Codex `allow_implicit_invocation: false` and Claude
`disable-model-invocation: true` make `enabled` false for automatic routing;
explicit host invocation may still work. Claude boolean spellings such as `yes`
and `on` are supported. `user-invocable: false` does not disable automatic routing.

The generic/Codex parser still requires non-empty name and description. Claude
fallbacks live in its adapter; a skill with no usable description is diagnosed
and excluded. Claude `when_to_use` is appended to the routing description.

Boundaries and limitations:

- Git repositories, worktrees and submodules use the nearest `.git` directory or
  file as the upward boundary. Outside Git, only CWD is a project source.
- Symlink targets are canonicalized. Repeated canonical files load once per
  agent. Distinct same-name paths are retained even when a host would shadow one.
  `metadata.discovery` records the source and its scan order, not a universal
  native invocation precedence. Claude command names retain the local symlink
  entry name while descriptor paths use the canonical target.
- Codex recursively scans skill roots; Claude scans direct skill directories.
  Traversal stops at a skill boundary, skips hidden child directories and
  `node_modules`, and is bounded to depth 32 / 10,000 directories. Files are
  limited to regular files of at most 1 MiB. Invalid files and traversal failures become diagnostics.
- Codex system roots are explicit library options because installation paths
  vary. Plugin caches and old repository `.codex/skills` are not guessed.
- PR1 does not reproduce session state, repository trust, managed restrictions,
  Claude `skillOverrides`, synced skills, plugins, legacy commands, `--add-dir`,
  or skills activated later by file access. It is a local catalog, not telemetry
  of which skills a host actually loaded or invoked.
- Only Codex user TOML disable entries are read; project/managed config layering
  is deferred. Malformed config yields diagnostics; known explicit-only skills
  remain excluded. Review diagnostics before relying on the catalog.

## Library and architecture

```ts
import {
  CodexDiscoveryAdapter,
  MockRouterProvider,
  route,
} from "skilldispatch";
import { homedir } from "node:os";

const cwd = process.cwd();
const catalog = await new CodexDiscoveryAdapter().discover({ cwd, home: homedir() });
const result = await route(
  { prompt: "Build a React form", cwd, agent: "codex", skills: catalog.skills },
  new MockRouterProvider(),
  { threshold: 0.75, maxSkills: 4 },
);
console.log(result.selected);
```

```text
src/
  core/         Domain types, pure policy, fail-open route execution
  discovery/    Parser, safe traversal, Codex and Claude adapters
  providers/    Metadata-only RouterProvider interface and deterministic mock
  config/       YAML validation and layered loading
  cli/          Composition root and discover/route commands
tests/
  fixtures/     Valid/invalid skills, scope layouts and score fixtures
  discovery/    Parser, scopes, duplicates, symlinks, disabled skills
  routing/      Policy, provider isolation, validation, timeout and failure
  config/       Config precedence and diagnostics
  cli/          Command output, filtering, multi-skill routing and errors
```

IDs hash `agent + canonical path`; content hashes use the original file text.
Renaming/moving a file changes its ID; editing content changes only its hash.
Core imports no agent adapter or SDK. Providers receive IDs, names, descriptions,
scopes and each candidate's host agent, never skill bodies or arbitrary frontmatter. One decision per eligible
candidate is required; malformed, missing or duplicate decisions fail open.
Provider exceptions and timeouts likewise return no recommendations. Providers
must honor the abort signal to cancel their own work after a timeout.

## Development and PR2

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Tests use temporary homes/repositories and fixtures instead of the developer's
personal skills. No model or network is used. Format with `pnpm format`.

PR2 should add the official Jev SDK behind `RouterProvider`, independent binary
judgments, bounded chunk/concurrency handling, probability mapping, and mocked
SDK tests for failures and timeouts. Verify the then-current SDK/API before
implementation. Hooks, telemetry, eval execution and Studio remain later work.

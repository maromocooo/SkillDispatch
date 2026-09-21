# SkillDispatch

**Universal, observable skill routing for coding agents.**

SkillDispatch discovers local coding-agent skills and routes one prompt to **zero
or multiple skills**. It provides Codex and Claude Code discovery, a normalized
catalog, pure selection policy, a TypeSafe Jev provider and an offline mock provider.

**Status:** PR2 development preview. Routing quality has not been evaluated yet.
Hooks, telemetry, `doctor`, eval execution, and Agent Skill Studio are not implemented. The handoff and trace
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

Discovery is offline and needs no API key. It does not execute skill scripts,
Markdown substitutions, or instructions. Routing defaults to **Jev** and sends
request content to TypeSafe. Obtain a key from the [TypeSafe console](https://console.typesafe.ai/)
and set `TYPESAFE_API_KEY` using your shell or secrets manager before routing.
Never put credentials in YAML or commit them. Missing, blank, whitespace/control-containing
or non-ASCII credentials are rejected before any request. There is no silent mock fallback.

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
Routing supports skills from multiple host agents. Same-name skills from different
agents are distinct and are not duplicate-name conflicts. `duplicate_name` groups
only the same agent and whitespace-normalized name (case-sensitive).

`route --json` returns `selected`, `allDecisions`, `router`, `policy`, and
`diagnostics`. Decisions include IDs, names, paths, probabilities and selection
flags. Raw prompts and full skill bodies are not emitted or stored. Ordering and
mock scores are deterministic; measured `router.latencyMs` varies. The provider
is identified as `jev` or `mock` in both output formats. Jev text output also
prints `Model:` when the API returns a consistent model across successful chunks;
JSON includes `router.model` and `router.latencyMs`.

Exit status is 0 for successful commands, empty selections, partial discovery,
and fail-open provider failures (inspect diagnostics). Invalid CLI options,
invalid configuration/credentials, or an inaccessible CWD return a nonzero status. `--json`
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
  provider: jev
  timeoutMs: 2500
  jev:
    model: jev-latest
    chunkSize: 48
    concurrency: 2
    requestTimeoutMs: 1800
    maxRetries: 0
policy:
  threshold: 0.75
  maxSkills: 4
discovery:
  agents: [codex, claude-code]
```

Jev asks one independent **Noul** per candidate, mapping `noul` directly to
`probability` (never Choice confidence). Candidates sort by stable ID, with up to
48 per request and two concurrent requests by default. `chunkSize` accepts 1–48;
48 is a local safety ceiling, not an advertised API count limit. The current API
publishes token limits instead (see [PR2 validation](docs/PR2_VALIDATION.md)).
`concurrency` is a positive integer; request timeout is a positive 32-bit integer.
Retries default to 0 (configurable 0–2) to avoid delaying the agent prompt path.
`requestTimeoutMs` bounds each attempt; `timeoutMs` bounds the whole route.

Successful chunks survive another chunk's failure via the existing partial
contract. A request timeout or cancellation stops new chunks. The overall route
deadline still fails open with no recommendations. Failures never produce mock
scores. Diagnostics contain fixed safe messages, not SDK error text or stacks.

Independent Noul is the initial multi-label baseline. Similar or broad skills may
all score highly; these judgments do not compete with one another. Thresholds
are not claimed to be globally optimal or calibrated for arbitrary catalogs.
The future eval layer must measure routing quality before stronger claims.

For offline development, explicitly set `router.provider: mock`.
Without fixture scores, the mock performs case-insensitive token overlap over
skill names/descriptions: 0.9 for a match, 0.04 otherwise. It does not understand
intent, negation, paraphrases, or multilingual semantics. The policy selects
`probability >= threshold`, caps the result at `maxSkills`, and sorts by
probability descending, then name and ID in locale-independent order.

For exact fixture scores, see [the working example](examples/skilldispatch.mock.yaml):

```sh
skilldispatch route "Any fixture prompt" --config examples/skilldispatch.mock.yaml --json
```

Configured scores are **prompt-independent**. Keys can be skill IDs or names;
an ID overrides a name. `router.mock.defaultProbability` controls unlisted skills.
No skill is forced when none passes the threshold.

Jev sends the raw **prompt**, requesting agent, and each candidate's **name,
description, host agent and scope** to `https://api.typesafe.ai/v1/systemone`.
Full SKILL.md bodies, paths, absolute CWD, skill IDs and arbitrary metadata are
not added to requests. Descriptions include discovery-normalized fallbacks;
anything you include in a prompt or description is therefore sent. The API key
is used only for authentication, never in model input or diagnostics. SDK debug
logging and environment endpoint overrides are disabled. Responses are buffered
before SDK stream cloning to avoid the Node 20 cancellation issue; see
[the validation notes](docs/PR2_VALIDATION.md) for tests and limitations.

The future trace location is `~/.local/share/skilldispatch/traces.jsonl`. PR2 does
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
  JevRouterProvider,
  route,
} from "skilldispatch";
import { homedir } from "node:os";

const cwd = process.cwd();
const catalog = await new CodexDiscoveryAdapter().discover({ cwd, home: homedir() });
const result = await route(
  { prompt: "Build a React form", cwd, agent: "codex", skills: catalog.skills },
  new JevRouterProvider({ apiKey: process.env.TYPESAFE_API_KEY }),
  { threshold: 0.75, maxSkills: 4 },
);
console.log(result.selected);
```

```text
src/
  core/         Domain types, pure policy, fail-open route execution
  discovery/    Parser, safe traversal, Codex and Claude adapters
  providers/    RouterProvider contract, deterministic mock and Jev SDK boundary
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
scopes and each candidate's host agent, never skill bodies or arbitrary frontmatter.
`ProviderRouteOutput.completeness` is required:

- `complete`: exactly one decision per eligible candidate, no failed IDs.
- `partial`: decisions and `failedSkillIds` partition the candidates; at least one
  failed ID is required. Policy uses successful decisions. A `provider_partial`
  diagnostic lists unevaluated IDs in `skillIds`; no scores are invented for them.
- Malformed: missing, unknown, duplicate or overlapping IDs, invalid probabilities
  or invalid completeness fail open with `invalid_provider_response` and no decisions.

Providers may supply safe domain diagnostics. Provider exceptions and overall
route timeouts still return no recommendations. Providers must honor the abort
signal and return a valid partial result before that deadline to retain successes.
See [the provider contract](docs/ARCHITECTURE.md#routerprovider) for details.

## Development

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Tests use temporary homes/repositories and fixtures instead of the developer's
personal skills. No external API is used: SDK tests use fake fetch or loopback
HTTP in child processes. Format with `pnpm format`. See
[PR2 validation](docs/PR2_VALIDATION.md) for runtime and package checks.
Hooks, telemetry, eval execution and Studio remain later work.

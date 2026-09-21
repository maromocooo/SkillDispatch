# SkillDispatch

**Universal, observable skill routing for coding agents.**

SkillDispatch discovers local coding-agent skills and routes one prompt to **zero
or multiple skills**. It provides Codex and Claude Code discovery, a normalized
catalog, pure selection policy, a TypeSafe Jev provider and an offline mock provider.

**Status:** PR4 development preview: discovery, routing, evaluation, and silent
shadow hooks with private local JSONL traces. Real Jev routing quality has not been
established. Advisory injection, `doctor`, and Agent Skill Studio are not implemented.

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

skilldispatch eval evals/example.yaml
skilldispatch eval evals/example.yaml --json
skilldispatch eval evals/example.yaml --min-recall 0.90 --min-precision 0.90

# Host command hooks supply their UserPromptSubmit JSON on stdin.
skilldispatch hook codex
skilldispatch hook claude
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
Evaluation emits its result even when a quality gate fails (exit 2). Eval input,
config and provider setup errors exit 1. Without gates, a completed evaluation
exits 0; inspect reliability counts as well as quality metrics.

## Configuration

For `discover`, `route`, and `eval`, read order is lowest to highest priority:

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
`concurrency` is an integer from 1 to 8 (default 2). `MAX_JEV_CONCURRENCY = 8`
is SkillDispatch's local burst/cost safety ceiling, not an official TypeSafe API
limit. Request timeout is a positive 32-bit integer.
Retries default to 0 (configurable 0–2) to avoid delaying the agent prompt path.
`requestTimeoutMs` bounds each attempt; `timeoutMs` bounds the whole route.

Successful chunks survive another chunk's failure via the existing partial
contract. A request timeout or cancellation stops new chunks. The overall route
deadline still fails open with no recommendations. Failures never produce mock
scores. Diagnostics contain fixed safe messages, not SDK error text or stacks.

Independent Noul is the initial multi-label baseline. Similar or broad skills may
all score highly; these judgments do not compete with one another. Thresholds
are not claimed to be globally optimal or calibrated for arbitrary catalogs.
Use the eval layer to measure routing quality before making stronger claims.

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

Only hook commands persist traces. `discover`, `route`, and `eval` keep their
existing behavior and never write telemetry, even when it is enabled.

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

## Routing evaluation

`eval` discovers the catalog once and runs cases in file order through the same
provider, policy and timeout as `route`. No provider fallback occurs. First adapt
the names in [evals/example.yaml](evals/example.yaml) to your discovered skills:

```yaml
version: 1
cases:
  - id: frontend-form
    prompt: "Build the React form and add tests."
    should:
      - {name: react-patterns, agent: codex, scope: repo}
      - {name: frontend-testing, agent: codex, scope: repo}
    should_not:
      - {name: deployment, agent: codex, scope: repo}
    fully_labeled: false
```

Names are case-sensitive and whitespace-normalized. Optional `agent` and `scope`
qualify a selector; it must resolve to exactly one skill. Missing and ambiguous
matches produce `unknown_eval_skill` and `ambiguous_eval_skill`, before any
requests. Qualify same-agent repo/user duplicates by scope. Duplicate labels and
positive/negative overlap are errors, including different selectors resolving to
the same ID. Disabled skills remain resolvable: an expected disabled skill is a
false negative because automatic routing cannot select it. Case IDs must be
unique, prompts nonblank, and unknown YAML fields are rejected.

`should` and `should_not` default to empty arrays. With `fully_labeled: false`
(the default), unlisted skills are **unlabeled**, not negative. With `true`, every
available skill outside `should` is negative. Only fully labeled cases contribute
to exact-set accuracy. Keep that flag false unless the entire catalog is labeled.

Metrics sum counts across cases (micro aggregation):

- **Labeled precision** = TP / (TP + FP). In partial-label cases only selected
  explicit `should_not` skills count as FP; unlabeled selections are reported
  separately and excluded from this denominator. Fully labeled cases use ordinary
  precision. A high labeled precision alone says nothing about unlabeled skills.
- **Recall** = TP / (TP + FN); **F1** = 2TP / (2TP + FP + FN).
- A zero denominator is `null` (`n/a` in text), never NaN. F1 can be 0 when
  precision or recall is undefined but FP or FN exists.
- **Exact-set accuracy** = matching fully labeled cases / all fully labeled
  cases; `null` when there are none. An empty expected/selected set matches.
- Average selected skills counts all selections, including unlabeled ones.
  P50/P95 use nearest-rank route latency, excluding discovery and file loading.

```sh
# Real Jev: requires TYPESAFE_API_KEY and sends dataset prompts to TypeSafe.
skilldispatch eval evals/example.yaml --json
skilldispatch eval evals/example.yaml --min-recall 0.90 --min-precision 0.90
# Explicit offline fixture provider; these scores are NOT Jev quality measurements.
skilldispatch eval evals/example.yaml --config examples/skilldispatch.mock.yaml
```

The dataset path is relative to the invocation directory; `--cwd` controls
discovery, project config and relative `--config`. Eval accepts route's
`--agent`, `--threshold` and `--max-skills`. Optional YAML
`gates: {min_recall: 0.90, min_precision: 0.90}` sets gates; CLI flags override
each field. Bounds are inclusive 0–1. Undefined metrics fail a requested gate,
even a zero gate. JSON still contains the complete result on gate failure.

Failures are evaluated, never removed: `provider_failed`, `provider_timeout`,
and `invalid_provider_response` count toward `providerFailureCount` and their
empty selections can create false negatives. `provider_partial` increments
`providerPartialCount`; successful decisions remain, missing recommendations
affect quality normally. An all-failed partial result counts as partial, not as a
core contract failure. Without gates these results exit 0, so also inspect the
reliability counts. There is no separate reliability gate in PR3.

Results contain case IDs, skill references/probabilities, FP/FN lists, metrics,
provider/model, latency and diagnostic codes; **no raw prompts, diagnostic message
bodies, local paths or full skills**. Nothing is persisted. Jev still receives
the prompt and allowed skill descriptions as described above. Manual live eval
is opt-in by running the command with Jev credentials; tests/CI/prepack never
call the external API.

Independent Noul routing quality is not established merely by implementing a
provider. SkillDispatch uses evals before making accuracy claims. Similar or broad
skills may all score highly; thresholds are not universally calibrated. The
example dataset illustrates explicit/implicit/multiple/no-skill, overlapping,
negated, Japanese and mixed-language requests; tailor labels and broad/specific
skill pairs to your catalog. No automatic threshold tuning or reranking is added.

## Shadow hooks and local traces

PR4 runs routing for observation only. It never returns `additionalContext`, a
blocking decision, a reason, or a system message. Both hook commands finish with
**exit 0 and empty stdout/stderr**, including errors. This preserves host context
and decisions, but synchronous hooks still add bounded latency. `selected` means
**recommended by SkillDispatch's policy**, not that the host invoked or followed
a skill or that output quality improved.

### Enable manually

After installing the CLI, add the following to the appropriate host settings.
Make the executable and `TYPESAFE_API_KEY` available to the host process; use an
absolute executable path if its PATH differs from your shell. No installer or
settings mutation is provided. Retain any existing hooks when editing these files.

For [Codex hooks](https://learn.chatgpt.com/docs/hooks), use
`~/.codex/hooks.json` or a trusted project's `.codex/hooks.json`. Review/trust
the hook definition in Codex before it runs; avoid registering it in both places:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "skilldispatch hook codex",
        "timeout": 5
      }]
    }]
  }
}
```

For [Claude Code hooks](https://code.claude.com/docs/en/hooks), add to
`~/.claude/settings.json` or the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "skilldispatch hook claude",
        "timeout": 5
      }]
    }]
  }
}
```

Both examples use **seconds**. Five seconds gives headroom around the default
2,500 ms route timeout. SkillDispatch limits stdin to 1 MiB / 1 second and the
dedicated CLI hook process to 4 seconds, including setup/storage. The latter is
an emergency cutoff; it may leave no trace. Claude's synchronous UserPromptSubmit
hook blocks prompt processing while it runs, so keep this budget short.

Each adapter uses the hook's CWD for project skill discovery, forces its own
agent (`codex` or `claude-code`), and never routes the other host's skills.
Required/known fields are type-checked; unknown future fields are ignored.
Codex session/turn/model are supported. Claude supplies session correlation but
no UserPromptSubmit model/turn ID; its optional `prompt_id` is not treated as a
turn ID. Transcript paths are discarded without reading the file.

### Hook configuration trust

Global hooks ignore project `.skilldispatch.yaml` **by default**. They load
built-in defaults and `~/.config/skilldispatch/config.yaml` only; they still
discover project skills using the hook CWD. Reading project skills does not grant
a repository authority over trace destinations, raw prompt storage, telemetry
opt-out or provider/network settings.

To explicitly allow project settings in hook runs, put this **in user config**:

```yaml
hook:
  trustProjectConfig: true
```

The default is false. Only the user layer can set this switch; project or explicit
CLI config cannot enable it. Without trust, project config is not even read or
validated. With trust, the usual project layer can override user routing/telemetry
settings, so enable this only for environments where those repositories are
trusted. Hook commands have no explicit config override. Ordinary
`discover` / `route` / `eval` retain user → project → explicit CLI layering.

### Storage and privacy

Hook configuration belongs in `~/.config/skilldispatch/config.yaml` by default.
A project `.skilldispatch.yaml` applies only after the user opt-in above:


```yaml
telemetry:
  enabled: true
  prompt: hash
  # Optional absolute or ~/ path; its parent must be private.
  # tracePath: ~/.local/share/skilldispatch/traces.jsonl
```

The default directory is `~/.local/share/skilldispatch`. An absolute
`SKILLDISPATCH_DATA_DIR` overrides it; otherwise an absolute `XDG_DATA_HOME`
places it at `$XDG_DATA_HOME/skilldispatch`. The directory contains `install.key`
and `traces.jsonl`. A custom `tracePath` changes only the trace destination;
it cannot target the installation key. Set `telemetry.enabled: false` to skip
hook routing and storage. `router.provider: mock` remains an explicit offline
option for testing hook setup.

- **`hash` (default):** HMAC-SHA256 of the exact prompt using a private, local
  32-byte random installation key. Same installation/prompt correlates; separate
  keys produce different hashes. The API key is never used as the hash key.
- **`none`:** neither raw prompt nor prompt hash is stored. Session/turn
  correlation is still keyed and available.
- **`raw`: explicit opt-in only.** Stores the complete hook prompt locally,
  potentially including source code, personal data or secrets. Review retention
  and file access before enabling it. It is not needed for ordinary shadow use.

Session/turn values also use HMAC, with separate domains and the host agent;
raw host IDs are not stored. New directories/files use 0700/0600 on POSIX.
Key creation is race-safe; an existing key is never replaced automatically.
Unsafe permissions, symlink destinations, corrupt keys and I/O failures cause
silent no-op behavior rather than exposing data or blocking the host. Back up
or remove keys deliberately: changing the key breaks historical correlation.
Protect the key separately from any trace you choose to share.

[Route Trace v1](schemas/route-trace.schema.json) is a strict, versioned public
contract. It stores a trace ID/time, host, policy, provider/model/latency,
catalog fingerprint/counts, scored decisions, and diagnostic codes/levels/skill
IDs. Decisions include skill name/agent/scope/content hash/probability/selection.
The catalog fingerprint ignores paths and path-derived IDs, includes enabled
state, and preserves duplicate counts. Skill IDs themselves remain local identities.

It does **not** store CWD, skill paths/directories/descriptions/bodies, transcript
paths, raw session/turn IDs, diagnostic messages/stacks, SDK errors, API keys or
environment values. Allowed fields such as skill names are metadata, not an
arbitrary-secret redaction mechanism. Prompt hashing protects local storage;
**Jev still receives the prompt and permitted skill descriptions** as described
above. There is no upload, cloud sync, automatic rotation or retention manager.

`outcome` is `complete`, `partial`, or `failed`. Partial decisions survive, and
`provider_partial.skillIds` identifies unevaluated candidates (including an
all-failed partial). Provider exceptions, overall timeouts, invalid results and
setup failures produce failed traces when safe setup is available. Config,
discovery or key failures may prevent any trace. Writer failures are swallowed.
Events use one append each; storage is best effort, not a durable audit log.

### Host visibility and advisory deferral

Only supplied prompt text is evaluated. Codex currently omits structured
attachments from this event, as reported in [upstream #41128](https://github.com/openai/codex/issues/41128).
SkillDispatch does not inspect transcripts, images, session files or missing
Claude content to compensate. Empty/whitespace-only text is a safe no-op.

PR4 intentionally implements shadow mode only: measure first, inject later.
Codex's context placement/salience concern is tracked in
[upstream #40680](https://github.com/openai/codex/issues/40680). Advisory behavior
will be evaluated separately for each host after shadow observations are
available. Claude does not receive advisory injection ahead of Codex.

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
  eval/         YAML schema, selector resolution, metrics and sequential runner
  runtime/      Config/discovery/provider composition shared by CLI and hooks
  hooks/        Bounded stdin, host wire adapters and silent shadow runtime
  telemetry/    Trace v1 projection, HMAC, catalog fingerprint and JSONL sink
  cli/          discover/route/eval/hook commands
tests/
  fixtures/     Valid/invalid skills, scope layouts and score fixtures
  discovery/    Parser, scopes, duplicates, symlinks, disabled skills
  routing/      Policy, provider isolation, validation, timeout and failure
  providers/    Jev mapping, chunking, concurrency, privacy and partial failures
  runtime/      Strict child processes, SDK loopback and concurrent trace storage
  hooks/        Host fixtures, single-agent routing and fail-open behavior
  telemetry/    Privacy, schema parity, hashing, permissions and append behavior
  eval/         Input, labels, metrics, reliability, privacy and dataset fixtures
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

The public trace exports are `RouteTrace`, `TraceSink`, `routeTraceSchema`,
`catalogFingerprint`, and `JsonlTraceSink`. Host parsers/runtime and key-management
helpers remain internal. JSON Schema is generated from the strict Zod definition;
Ajv tests validate emitted events and detect schema drift.

The library also exports `parseEvalYaml`, `loadEvalFile`, and `runEvaluation`.
Evaluation resolves every expected skill against a catalog before routing any
case, then reuses `route()` with the supplied provider and policy. Results omit
prompts and diagnostic messages. Micro precision counts labeled predictions only;
recall counts expected positives, and undefined ratios are `null`. Fully labeled
cases alone contribute to exact-set accuracy. Provider failures remain in metrics.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm pack
```

For an opt-in live service smoke test from the source checkout:

```sh
pnpm test:jev-live
```

It skips without a key. With `TYPESAFE_API_KEY`, it sends only a small synthetic
prompt/catalog, prints no prompt/key, and checks integration rather than accuracy.
It is never run by `pnpm test` or CI automatically.

Tests use temporary homes/repositories and fixtures instead of the developer's
personal skills. No external API is used: SDK tests use fake fetch or loopback
HTTP in child processes. Format with `pnpm format`. See
[PR4 validation](docs/PR4_VALIDATION.md) for hooks, traces and package checks,
[PR3 validation](docs/PR3_VALIDATION.md) for eval checks, and
[PR2 validation](docs/PR2_VALIDATION.md) for the unchanged SDK boundary.
Advisory/enforce modes, invocation detection, Studio and cloud trace services remain later work.

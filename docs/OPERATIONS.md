# Operational reference

Detailed configuration, discovery, evaluation and telemetry behavior. Start with
the [public quick start](../README.md#quick-start).

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
48 is a local safety ceiling, not an advertised API count limit. Consult the
[TypeSafe API reference](https://docs.typesafe.ai/api) for upstream request limits.
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

For exact fixture scores, see [the working example](../examples/skilldispatch.mock.yaml):

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
before SDK stream cloning to keep cancellation safe on Node 20. The provider
boundary uses the [official SDK](https://github.com/typesafe-ai/typesafe-sdk-js);
normal tests exercise fake calls and loopback transport, not the live service.

Only hook commands persist traces. `discover`, `route`, and `eval` keep their
existing behavior and never write telemetry, even when it is enabled.

## Discovery behavior and current host differences

Discovery follows the documented sources below, with the explicit coverage limits
in this section:

- [Codex skills](https://learn.chatgpt.com/docs/build-skills): scans `.agents/skills`
  from CWD to the repository root, plus `~/.agents/skills` and `/etc/codex/skills`.
  Duplicate names remain separate. `~/.codex/config.toml` supports per-path
  disabling; `agents/openai.yaml` controls implicit invocation.
- [Claude Code skills](https://code.claude.com/docs/en/skills): project discovery
  also walks to the repository root. Claude
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

Claude cached synced skills are read explicitly from
`<CLAUDE_CONFIG_DIR>/skills/synced/<sync-directory>/<skill>/SKILL.md`, separately
from personal skills. Advisory uses `anthropic-skills:<skill>`; sync-directory
names are not invocation identifiers. Duplicate names across sync directories are
conservatively marked non-routable with `ambiguous_synced_skill`: there is no
public local active-account selector, so SkillDispatch does not guess a winner.
Identical duplicate versions collapse; differing content stays visible for review.
This is an offline cache snapshot, not proof of current account/session availability.
`syncClaudeAiSkills: false` in user, local or file-managed settings suppresses this
source even if a later file sets true. Shared project settings cannot disable it;
true never forces syncing on. Session `--settings` values are not observable here.

Plugin state resolution requires version-2 `installed_plugins.json` records and
a valid installed manifest or registered marketplace definition (`strict: false`).
`enabledPlugins` merges user → CWD project → local → file managed settings. Explicit state overrides marketplace `defaultEnabled`, then
installed-manifest `defaultEnabled` (default true). Marketplace manifests are read
only by a registered location and exact plugin name; their Skill trees are never
scanned. Malformed state and ambiguous applicable versions are diagnosed and
excluded. `CLAUDE_CODE_PLUGIN_CACHE_DIR` overrides the **plugins parent**, not only
its cache. With `strict: false`, the marketplace entry owns the definition; an
installed manifest that also declares components is a conflict. Marketplace-root
plugins must declare their skill subset; missing paths never trigger a broader scan.
No host commands, installation or enablement mutations are performed.

Active plugin skills load only from registry installation roots (`skills/` and safe
manifest/marketplace-declared skill directories and single-skill roots), with
`plugin-name:<frontmatter-name>` or a directory-name fallback, per current Claude docs. Personal/project names still use
the directory. `metadata.claude` records origin separately from scope. Manual-only
skills remain discoverable but cannot become routing/advisory candidates. Explicit
`skillOverrides` restrictions apply to non-plugin skills; plugin enablement is
controlled by `enabledPlugins` instead. File-based managed settings and enterprise
skill roots are supported read-only; MDM/server/session overrides are not inferred.
`strictPluginOnlyCustomization` is read only from managed settings: true locks
skills, while an array locks skills only when it contains `"skills"`. Unknown
surface names and non-managed copies of this policy are ignored. With skills locked,
plugin/managed skills remain eligible; local skills remain visible but non-routable,
and synced skills are not loaded. Manual-only restrictions still apply.

See the official [plugin reference](https://code.claude.com/docs/en/plugins-reference),
[marketplace defaults](https://code.claude.com/docs/en/plugin-marketplaces),
[environment variables](https://code.claude.com/docs/en/env-vars),
[managed settings](https://code.claude.com/docs/en/managed-settings), and setting-specific
rules for [sync opt-out](https://code.claude.com/docs/en/settings-reference#syncclaudeaiskills)
and [customization policy](https://code.claude.com/docs/en/settings-reference#strictpluginonlycustomization).

Inspect the expanded catalog offline:

```bash
skilldispatch discover --agent claude-code
skilldispatch discover --agent claude-code --json
skilldispatch doctor --json
```

Discovery reports per-origin discovered/model-routable counts (`local-user`,
`local-project`, `synced`, `plugin`, `managed`). JSON retains `skills`/`diagnostics`
and adds `summary`; descriptions and paths remain local discovery data. Doctor
shows counts only. Fingerprints add an adapter-generated path-free identity digest
(origin, native name, plugin identity/version/scope, model eligibility). Cache and
sync-directory relocation do not change it; plugin version/namespace changes do.
Older Route Trace v1 records remain readable; the first expanded catalog naturally
has a new fingerprint. No trace schema migration is needed.

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
- Discovery does not reproduce live session state, repository trust, non-file managed restrictions,
  CLI/session setting overrides, legacy commands, `--add-dir`,
  bundled skills, skills-directory plugins, or skills activated later by file access. It is a local catalog, not telemetry
  of which skills a host actually loaded or invoked.
- Only Codex user TOML disable entries are read; project/managed config layering
  is deferred. Malformed config yields diagnostics; known explicit-only skills
  remain excluded. Review diagnostics before relying on the catalog.

## Routing evaluation

`eval` discovers the catalog once and runs cases in file order through the same
provider, policy and timeout as `route`. No provider fallback occurs. First adapt
the names in [evals/example.yaml](../evals/example.yaml) to your discovered skills:

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
reliability counts. Evaluation gates cover precision and recall; provider
reliability is reported separately.

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


## Hook registration and modes

```sh
skilldispatch hooks status
skilldispatch hooks install claude --dry-run
skilldispatch hooks install claude
skilldispatch hooks install codex
skilldispatch doctor
```

Installation edits only user `~/.claude/settings.json` or `~/.codex/hooks.json`.
It resolves an absolute Node executable/CLI entrypoint with platform-safe quoting,
so host PATH need not match the interactive shell. Repeated installation reconciles
owned registrations without duplicates. Unrelated hooks/settings are preserved.
`--dry-run` creates no files, directories or backups.

Shadow is the default for both agents. Claude installation also registers the
PreToolUse/PostToolUse/PostToolUseFailure `Skill` observers asynchronously. To enable
Claude advisory, merge this into `~/.config/skilldispatch/config.yaml`, then reinstall
Claude's registration and reload the host:

```yaml
hook:
  modes:
    claude: advisory
    codex: shadow
```

Advisory uses a synchronous UserPromptSubmit handler. A config change alone does
not edit host settings: status/doctor report a mismatch until install reconciles
it. Switching Claude to shadow and reinstalling restores async execution.
`--sync` is available for Claude shadow debugging; Codex remains async-only and
rejects that option. Observer hooks stay async in either mode.

Advisory requires complete routing and safe native skill identifiers. It injects
only a bounded recommendation, not skill content. Empty, partial, failed or unsafe
results add no context. The user request and host permissions remain authoritative.

Existing settings receive a first private `.skilldispatch.bak` backup which is
never overwritten. Mutations use a same-directory temporary file and atomic rename,
retain permissions and refuse unsafe links, malformed input or modified/ambiguous
registrations. Custom host directories require manual setup. Host trust/reload is
not inferred from registration success; review Codex hooks when requested.

```sh
skilldispatch hooks uninstall claude --dry-run
skilldispatch hooks uninstall claude
skilldispatch hooks uninstall codex
```

Uninstall removes only owned routing/observer handlers. It does not restore a whole
backup or delete runtime data. Remove registrations before uninstalling the package.

### Manual alternative and Codex inline conflict

Retain existing settings when editing manually. These user-scope JSON examples use
async command hooks; replace the illustrative command with an absolute command if
PATH differs in the host. The installer generates safer absolute commands for you.

For [Codex hooks](https://learn.chatgpt.com/docs/hooks), use
`~/.codex/hooks.json`. Review/trust the definition before it runs. If your user
config already uses inline hooks, keep that source instead of creating hooks.json:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "skilldispatch hook codex",
        "async": true,
        "timeout": 5
      }]
    }]
  }
}
```

Example inline Codex registration to merge manually into an existing
`~/.codex/config.toml` (do not add it if the same registration is in hooks.json):

```toml
[[hooks.UserPromptSubmit]]
hooks = [{ type = "command", command = "skilldispatch hook codex", async = true, timeout = 5 }]
```

For [Claude Code hooks](https://code.claude.com/docs/en/hooks), add to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "skilldispatch hook claude",
        "async": true,
        "timeout": 5
      }]
    }]
  }
}
```

Timeout fields use **seconds**; Claude does not enforce this field after a normal async
hook starts. For synchronous execution, five seconds gives headroom around the default
2,500 ms route timeout. SkillDispatch limits stdin to 1 MiB / 1 second and the
dedicated CLI hook process to 4 seconds, including setup/storage. The latter is
an emergency cutoff; it may leave no trace. Claude's synchronous UserPromptSubmit
hook blocks prompt processing while it runs, so keep this budget short.

Each adapter uses the hook's CWD for project skill discovery, forces its own
agent (`codex` or `claude-code`), and never routes the other host's skills.
Required/known fields are type-checked; unknown future fields are ignored.
Codex session/turn/model are supported. Claude supplies session correlation and
an optional `prompt_id` for current prompt submission correlation, but no
UserPromptSubmit model. Transcript paths are discarded without reading the file.

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
trusted. Execution modes remain user-owned even under this opt-in. Hook commands
have no explicit config override. Ordinary
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
- **`none`:** neither raw prompt nor prompt hash is stored. Session/submission
  correlation is still keyed and available.
- **`raw`: explicit opt-in only.** Stores the complete hook prompt locally,
  potentially including source code, personal data or secrets. Review retention
  and file access before enabling it. It is not needed for ordinary shadow use.

`prompt.hash` identifies **text content**: repeating identical text produces the
same hash with the same installation key. `host.promptKey` identifies the **host
prompt submission**: Codex `turn_id` or Claude `prompt_id`, hashed as
`HMAC(key, "host-prompt\0" + agent + "\0" + id)`. Different host IDs produce
different promptKeys even for identical text. Hosts are domain-separated; legacy
Claude inputs without `prompt_id` omit promptKey rather than inventing an ID.
`host.sessionKey` is a separate HMAC of the session. Raw host IDs are never stored.

Route Trace v1 uses `host.promptKey` for submission correlation. This field is
optional because not every host input supplies a prompt submission identifier.

New directories/files use 0700/0600 on POSIX.
Key creation is race-safe; an existing key is never replaced automatically.
Unsafe permissions, symlink destinations, corrupt keys and I/O failures cause
silent no-op behavior rather than exposing data or blocking the host. Back up
or remove keys deliberately: changing the key breaks historical correlation.
Protect the key separately from any trace you choose to share.

[Route Trace v1](../schemas/route-trace.schema.json) is a strict, versioned public
contract. It stores a trace ID/time, host, policy, provider/model/latency,
catalog fingerprint/counts, scored decisions, and diagnostic codes/levels/skill
IDs. Decisions include skill name/agent/scope/content hash/probability/selection.
The catalog fingerprint ignores paths and path-derived IDs, includes enabled
state, and preserves duplicate counts. Skill IDs themselves remain local identities.

It does **not** store CWD, skill paths/directories/descriptions/bodies, transcript
paths, raw session/submission IDs, diagnostic messages/stacks, SDK errors, API keys or
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

### Host visibility and Codex advisory deferral

Only supplied prompt text is evaluated. Codex currently omits structured
attachments from this event, as reported in [upstream #41128](https://github.com/openai/codex/issues/41128).
SkillDispatch does not inspect transcripts, images, session files or missing
Claude content to compensate. Empty/whitespace-only text is a safe no-op.

Codex stays shadow-only. Its context placement/salience concern is tracked in
[upstream #40680](https://github.com/openai/codex/issues/40680). Codex has no context
injection in v0.1.0. Claude advisory is separately opt-in; delivery alone does not
prove native invocation or improved routing accuracy.

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
  hooks/        Bounded stdin, shared mode-aware runtime and safe Claude advisory
  telemetry/    Trace projection, HMAC, fingerprint, safe JSONL and analytics
  observability/ Claude Skill observer, lifecycle correlation and observed adoption
  registration/ User-scope hook inspection, planning and atomic updates
  ops/          Offline readiness and storage health checks
  cli/          Commands and privacy-safe output views
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

Local skill IDs hash `agent + canonical path`; content hashes use the original file
text. Renaming a local file changes its ID. Synced/plugin IDs instead hash logical
source identity and content: moving a cache/account directory alone preserves IDs,
while plugin version or content changes produce a new version identity.
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
See [the provider contract](ARCHITECTURE.md#routerprovider) for details.


## Local trace inspection

`traces summary`, `traces list`, and `traces show <trace-id>` read the
hook trace destination, with `--json` available on each. They use the hook config
trust policy: user settings only, unless the user opts into project config. They
never write events or display raw prompts, prompt hashes, session keys or prompt
keys, even when raw prompt storage was explicitly enabled.

Summary reports valid/invalid lines, matching traces, agents, providers, outcomes,
average recommendations, P50/P95 route latency and distinct catalog fingerprints.
Skill versions use name + agent + scope + contentHash; seen/selected counts are
per trace, merging equal versions within a trace. “Never selected” means a version
observed in decisions but never selected in this dataset, not an undiscovered or
unobserved skill. “Selected” always means a SkillDispatch recommendation.

List keeps the newest 20 records by timestamp (UUID tie-break), with `--limit`
1–1000, `--agent` and `--outcome` filters. Summary and list accept `--since 1h`,
`24h`, `7d`, etc. Time windows include both endpoints and exclude future timestamps;
without `--since`, future records are included. Show requires a full UUID and exits
1 for missing or duplicate IDs. Corrupt lines are counted and skipped.

## Offline installation health

After adding the shadow hook commands from the setup examples above, run
`skilldispatch doctor`. It checks Node 20+, trusted config and user config location,
hook project trust, both skill catalogs, provider and credential presence, private
data/key/trace storage, the shipped schema and valid/invalid trace counts.
It also inspects user hook registrations as installed/not-installed/conflict. Missing,
malformed, unsafe or conflicting host hook config is WARN (doctor remains usable
unless another check FAILs). Codex registration retains a trust-not-verified WARN;
Claude `disableAllHooks` is reported. Project/managed/plugin layers and host approval
are not certified. No unrelated host command or config contents are displayed.

`doctor --json` returns `{version, usable, checks}` with PASS/WARN/FAIL checks.
Exit 0 means no FAIL; exit 1 means a configuration or installation problem. Missing
Jev credentials, a first-run missing key/trace and corrupt JSONL lines are WARN.
Malformed settings, invalid credentials, unsafe storage or unwritable trace
destinations are FAIL. Missing credentials still prevent useful Jev routing even
though offline installation checks can complete successfully. The separate
`routing_ready` check is true only when local provider prerequisites pass (mock,
or a valid-shaped Jev key) and hook telemetry is enabled. It is false/WARN for
missing/invalid keys, disabled telemetry, or unreadable routing config. It does
not prove online authentication, host registration/trust or trace delivery.
`hooks status` returns exit 1 for conflicts; an absent registration alone is exit 0.

Doctor makes no API calls, creates no key/directories/files, changes no host
settings and appends no traces. Writability is a permission probe, not a disk-space
or durability guarantee. It never prints credential values, skill paths or
diagnostic messages. Configuration/data/trace locations are shown intentionally.

Trace reads are streaming with a 2 MiB per-line bound, using the opened file's
initial byte size. New appends appear on the next command. An intact final JSON
object without a newline is accepted; blank, truncated, invalid UTF-8/schema and
oversized lines are invalid. No line contents or parser excerpts are printed.
Missing files are empty datasets. Existing files must be private, owned regular
files with one link; file/leaf-directory symlinks are rejected, as with the writer.
The installation key and user config are reserved destinations, including parent
aliases; SkillDispatch API credentials are environment-only, with no key-file mode.

JSON counts `totalLines`, `validTraces` and `invalidLines` cover the scanned file;
`matchedTraces` and all analytics cover valid records matching filters. Invalid
lines cannot be assigned a host/time. Unfiltered reads include future timestamps.
List/show exit 1 on invalid options or unsafe storage; otherwise trace commands
exit 0 despite skipped corrupt lines. Duplicate *valid* IDs are rejected by show;
summary/list count records independently, without a global UUID deduplication set.

Skill statistics sort by selected count descending, then agent, name, scope and
contentHash using locale-independent ordering. Text summary shows up to 20 versions;
JSON includes all observed versions. Null means no observations for averages/P50/P95.
Quantiles use the same exact nearest-rank definition as eval. Summary retains only
frequency maps for latencies and skill versions plus distinct catalog fingerprints,
not trace bodies; memory therefore grows with unique values. List retains at most
its requested limit; show retains one redacted detail view. All commands scan the
file, with no index, rotation, repair or deletion. These statistics describe router
behavior, not skill usefulness. Invocation analytics reports positive evidence
from Claude Skill observers when exact correlation is available.

To repeat the installed package check offline after packing/installing in a
temporary directory:

```sh
node scripts/trace-ops-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
```

This explicit development script uses temporary settings and denies fetch; it is
also run by the isolated package smoke in CI; it does not run during ordinary
unit tests or prepack. No online doctor or raw-prompt display option exists. Claude
advisory is supported through explicit user opt-in.

## Claude model Skill invocation telemetry

The Claude native Skill observer, `skilldispatch hook claude-skill`, accepts
`PreToolUse`, `PostToolUse`, or `PostToolUseFailure` JSON for `tool_name: "Skill"`
on stdin. It is local-only, silent, and fail-open. Events go to the private
`invocations.jsonl` in the SkillDispatch data directory, separately from routing
traces. Arguments, tool responses, errors, transcripts and raw host IDs are not
persisted. Only exact native identifier matches resolve to catalog metadata.

Run `skilldispatch hooks install claude` to reconcile the routing hook and the
three `Skill` observers together. Observers always use `async: true`; advisory
`UserPromptSubmit` remains synchronous. `hooks status claude` lists each observer;
`doctor` checks `skill_invocation_telemetry_ready` independently of advisory.
Observer persistence uses user configuration only, even if project routing
configuration was explicitly trusted. It never invokes Jev.

`skilldispatch traces summary` reports observed adoption counts; `traces show <id>`
shows same-prompt model Skill lifecycles. **Recommended ≠ injected ≠ observed
model-invoked ≠ observed succeeded**. Observed success means the native Skill tool
completed, not that Claude
followed the skill or improved the task outcome. Direct user `/skillname`
invocations use a separate host path and are not model adoption.

Adoption counts use route × logical skill-version pairs for observer-configured
Claude advisory traces. Observed adoption requires exact session/prompt keys.
The invocation observer is **async / best-effort**: absence of an invocation event
is not proof that Claude did not invoke the skill. An observed attempt without a
terminal event has an **unknown** outcome, not failure. This telemetry provides
positive evidence of adoption, not complete negative observation. Exact
injection-to-invocation conversion and invocation success percentages are
intentionally not reported; they require a future per-turn observation-completeness
mechanism. No completeness witness is implemented.

Old traces without the capability marker are **telemetry unavailable**, outside
these adoption counts rather than negative examples. Subagent-marked events remain
visible separately and do not count as main-turn adoption. Direct user `/skillname`
invocation remains outside model-adoption metrics. No transcript parsing or online
calls are used to fill gaps.

After installing or updating SkillDispatch:

```sh
skilldispatch hooks install claude
skilldispatch hooks status claude
skilldispatch doctor
# Reload/restart Claude Code, then use it normally.
skilldispatch traces summary --since 24h
skilldispatch traces show <route-trace-id>
```

`capabilities.skillInvocationTelemetry: true` means observer registration and local
persistence prerequisites were detected **at routing time**. Configured ≠ delivered
≠ completely observed: it does not confirm host reload, host policy permission,
observer startup, delivery, or complete observation of that turn. No real-user settings are
changed during tests. All three observer handlers use exact matcher `Skill` and
`skilldispatch hook claude-skill`; `hooks uninstall claude` removes only the
managed routing/observer registrations. Codex remains shadow-only.

The invocation stream uses the existing private installation key. Session and
prompt HMACs match routing traces; tool IDs use a separate session-scoped HMAC.
Invocation storage has no project-configurable destination: it is always
`<SkillDispatch data directory>/invocations.jsonl` (honoring
`SKILLDISPATCH_DATA_DIR` / `XDG_DATA_HOME`). User `telemetry.enabled: false`
disables observers even with trusted project routing config. `telemetry.prompt`
does not enable prompt/argument persistence for observers.

Summary JSON's `advisoryFunnel` reports facts, with no conversion-rate fields:

- `recommended`, `injected`: route-skill-version pairs from configured advisory
  traces. Existing top-level advisory totals still include older records.
- `observedModelInvoked`: recommended pairs with an exact resolved main-context
  attempted event. Multiple attempts of one skill count once per route pair.
- `observedSucceeded`: those pairs with an observed success for the same attempted
  tool lifecycle. An actual failure event remains a factual failed lifecycle.
- `injectedPairsWithoutObservedInvocation`: injected pairs lacking a matching
  resolved main-context attempt in the read snapshot. This means **no matching event
  observed**, including missing/unresolvable events or unavailable correlation;
  it never means not invoked.
- `telemetryConfiguredTraces`, `telemetryUnconfiguredTraces`: marker present/absent
  among Claude advisory traces, independent of current stream readability.
- `uncorrelatableTraces`: configured traces without session/prompt keys or a readable
  stream. Their recommendation/injection facts remain counted. `uncorrelatablePairs`
  counts selected decisions without logical identity, excluded from pair totals.
- `skills`: the same pair counts per skill version, in deterministic order.

`traces show` labels **Model skill invocations observed** and distinguishes
`observerConfigured`, `streamReadable` and `correlationAvailable` in JSON. None of
these confirms delivery or completeness. An empty `calls` array means no matching
lifecycle was observed, not that Claude did nothing. JSON contains observed counts
without exact conversion-rate fields.

Invocation stream health counts cover the full stream, while `--since` / `--agent`
filter routing cohorts and their funnel. Invalid lines are counted and skipped;
an unreadable/unsafe stream makes correlation unavailable without erasing the
routing-time configuration marker. No records are repaired,
removed or uploaded. Raw prompt text, hashes and host correlation keys are never
printed by trace commands. Matching is exact: aliases, unresolved/bundled names
and changed catalog/content versions cannot receive speculative observed-adoption credit.

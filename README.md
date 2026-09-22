# SkillDispatch

**Universal, observable skill routing for coding agents.**

SkillDispatch discovers local coding-agent skills and routes one prompt to **zero
or multiple skills**. It provides Codex and Claude Code discovery, a normalized
catalog, pure selection policy, a TypeSafe Jev provider and an offline mock provider.

**Status:** PR9 development preview: discovery, routing, evaluation, private local
traces, operational CLI, user hook registration, and explicit **Claude advisory**.
Both hosts default to shadow. Codex remains shadow-only. Real Jev routing quality
has not been established. Optional Claude Skill observers record model-initiated
native tool lifecycles locally; this does not measure task quality.

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

skilldispatch hooks status --json
skilldispatch hooks install codex --dry-run
skilldispatch hooks install codex
skilldispatch hooks install claude
skilldispatch hooks install claude --sync
skilldispatch hooks uninstall codex
skilldispatch hooks uninstall claude

skilldispatch doctor
skilldispatch doctor --json
skilldispatch traces summary --agent codex --since 7d
skilldispatch traces list --limit 20 --outcome partial
skilldispatch traces show <trace-id> --json
```

From a source checkout, replace `skilldispatch` with `pnpm skilldispatch` or
`node dist/cli/index.js`. For scripts that need pure JSON, prefer the latter.

`discover --json` returns `{ skills, diagnostics, summary }`, including disabled skills.
Text mode prints name, agent, scope, enabled state, and canonical path, with
diagnostics on stderr. Distinct paths with the same name remain separate skills.
Routing supports skills from multiple host agents. Same-name skills from different
agents are distinct and are not duplicate-name conflicts. `duplicate_name` groups
only the same agent and whitespace-normalized name (case-sensitive) for generic/Codex skills.
Claude uses normalized native invocation identity: distinct plugin namespaces do
not conflict just because their display names match.

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

Codex references were checked on 2026-09-21; Claude references were rechecked for PR8 on 2026-09-22:

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

Claude cached synced skills are now read explicitly from
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

Shadow mode runs routing for observation only and returns no host context. Both
hooks default to **exit 0 and empty stdout/stderr**, including errors. Claude can
explicitly opt into the advisory mode below. `selected` means **recommended by
SkillDispatch's policy**, not that the host invoked or followed a skill or that
output quality improved.

### Quick start: register shadow hooks

1. Install the built package as described above.
2. Make `TYPESAFE_API_KEY` available to your coding agent process, including GUI
   launches. SkillDispatch never copies credentials into host settings.
3. Run `skilldispatch hooks install codex` and/or `skilldispatch hooks install claude`.
4. Review and trust the new definition in Codex `/hooks`; registration alone is
   not host approval. Restart/reload hosts as their settings lifecycle requires.
5. Run `skilldispatch doctor`, use the agents normally, then inspect
   `skilldispatch traces summary` and `skilldispatch traces list`.

Registration is **async shadow by default**: agent processing can proceed while
routing runs in the background. Claude shadow has an optional `hooks install claude
--sync` debug setting, still with empty output; ordinary install restores async.
Codex installation is async only (`--sync` is rejected in PR7). Repeating install
is idempotent. Claude advisory installs synchronously as described below.

Use `hooks status [codex|claude] --json` for a read-only report. Omit the host to
inspect both. `hooks uninstall codex` / `hooks uninstall claude` remove only the
current installation's canonical registration; they never restore an entire
backup or delete the config file. Install/uninstall accept `--dry-run`, which
creates no directories, backup, lock or config. Status and registration management
are offline; they do not route prompts or write traces.

The installer edits only `~/.codex/hooks.json` and `~/.claude/settings.json`.
It never edits project, managed, system or plugin settings. Non-default
`CODEX_HOME` / `CLAUDE_CONFIG_DIR` overrides require manual setup; the installer
refuses them rather than guessing whether they refer to a user or project layer.
It checks Codex `~/.codex/config.toml` read-only. Any top-level inline `hooks`
configuration causes `conflict` / manual action required: current Codex loads both
user sources and warns. SkillDispatch never migrates or rewrites TOML automatically.

Existing unrelated settings, hook handlers, JSON numeric/string values and file
permissions are preserved. Strict JSON is required (no comments, trailing commas
or duplicate keys); files are bounded to 1 MiB and must be owned regular files,
not symlinks/hardlinks. POSIX files/directories must not be group/world writable.
New configs/directories use 0600/0700 where supported. Writes use an exclusive
cooperative lock, same-directory temporary file, fsync and atomic rename, with
external-change checks before replacement. A crash can leave a `.skilldispatch.lock`;
remove it manually only after verifying no installer is running. There is no stale-lock stealing.

The first actual edit to an existing file saves a private, same-directory
`hooks.json.skilldispatch.bak` or `settings.json.skilldispatch.bak`. Existing safe
backups are never overwritten. No backup is needed for an absent new file. Keep
backups private: they may contain unrelated credentials already in your settings.
They are never printed or automatically restored. Inspect/move them yourself if
needed. Concurrent editors should be closed; filesystem checks cannot provide a
transaction against another process editing the same file at the final rename instant.

Commands pin the **real absolute Node executable and CLI entrypoint**, avoiding GUI
PATH differences. Codex uses literal shell quoting; Claude uses the current official
`command` + `args` exec form, with no shell. Moving/removing the package or Node
installation breaks these paths: uninstall using the old installation before moving,
then reinstall. Obvious legacy/other SkillDispatch commands cause manual conflict;
arbitrary custom wrappers cannot reliably be identified. Uninstall never deletes by
fuzzy matching. Status shows only SkillDispatch's own command, never unrelated
commands or settings. Its text/JSON command paths can reveal your home directory;
redact these paths before sharing status output. Windows command generation is
unit-tested (Codex uses Windows PowerShell encoded commands; Claude uses node.exe);
native Windows host execution and ACL durability are not certified.

Async telemetry is **best effort**. Codex cancels unfinished background hooks when
the session ends; Claude may terminate them when non-interactive sessions end.
**Missing trace does not mean the router selected no skills.** Host lifecycle,
permissions/trust and host-level disable settings still control execution. Current
Claude ordinary async hooks do not enforce the command `timeout` once running;
SkillDispatch retains its own 4-second process cutoff. No delivery guarantee or
host async lifecycle emulation is implemented.

### Claude advisory (explicit opt-in)

Edit **user** `~/.config/skilldispatch/config.yaml`, retaining your other settings:

```yaml
hook:
  trustProjectConfig: false
  modes:
    claude: advisory
    codex: shadow
```

Then reconcile the existing registration and reload/restart Claude as needed:

```sh
skilldispatch hooks install claude --dry-run
skilldispatch hooks install claude
skilldispatch hooks status claude
skilldispatch doctor
```

Both mode defaults are `shadow`. `codex: advisory` is invalid. Project and explicit
CLI configs cannot set execution modes, **even with trustProjectConfig enabled**.
Changing YAML does not edit host settings. Status reports `hook_execution_mismatch`
and an install command when configured advisory still has async registration (or
shadow still has sync registration). Doctor reports `hook_mode_claude`,
`hook_execution_claude` and boolean `advisory_ready`. Missing/mismatched registration
is WARN, not a blocker to the host. These are local checks, not online auth or proof
Claude reloaded its configuration.

Claude advisory uses synchronous UserPromptSubmit JSON
`hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: "..."}`.
The [official hooks reference](https://code.claude.com/docs/en/hooks) distinguishes
same-turn synchronous context from async output delivered on a later turn. The
runtime checks its owned Claude registration is sync and enabled before returning
advisory; unknown, async or conflicting registration stays silent. Reload the host
when changing registration: an on-disk inspection cannot detect cached host state.
Manual wrappers/custom host roots require review and are not advisory-ready here.

Advisory trades extra prompt latency for same-turn recommendations. The existing
2500 ms route timeout, zero SDK retries, 4-second process cutoff and 5-second host
timeout are unchanged. Shadow remains async by default. To return to shadow, set
`claude: shadow`, run `hooks install claude` again and reload the host.

Only complete routing with safe selected skills can emit context. Zero selections,
partial/failed/timeout/invalid responses emit nothing. Partial recommendations still
appear in traces. Identifier omissions have safe diagnostics, and remaining safe
recommendations keep the route policy order. If all are omitted, stdout is empty.
All hook failures remain exit 0 without blocking decisions. A failed trace append
does not prevent otherwise safe advisory output; failed key/config initialization
can suppress both output and trace. `telemetry.enabled: false` still disables the
entire hook runtime, including advisory.

The context asks Claude to consider native Skill invocation **if available,
permitted and applicable**, with the user's request taking priority. It never
copies instructions or contains descriptions, bodies, paths, CWD, prompt text,
probabilities or provider diagnostics. Only safe native identifiers are dynamic.
Context is bounded to **4096 UTF-8 bytes**, keeping whole identifiers in policy
order; omitted IDs are recorded without their content.

For directly discovered local personal/project skills the native command is the
**directory name**, not frontmatter display `name`. The
[official skills reference](https://code.claude.com/docs/en/skills) describes native
invocation and body loading. SkillDispatch uses adapter provenance, restricts names
to letters/numbers/marks/underscore/ASCII hyphen (max 128 characters), and omits
ambiguous invocation names across the entire discovered catalog. It does not
reimplement host precedence. `disable-model-invocation` and disabled skills are
checked again before delivery. Synced and active installed plugin names are supported
by PR8. Bundled, legacy, additional-directory and nested lazy-loaded skills remain
unsupported. File-based `skillOverrides` restrictions are checked; MDM/server/CLI
settings and native session availability are not fully modeled: Claude's native
permission/invocation mechanism remains authoritative; this is a recommendation,
not a bypass or a guarantee of invocation.

**Recommended != injected != actually invoked.** Trace v1 keeps existing shadow
records valid and adds `mode: advisory` plus optional
`delivery: {kind: "none" | "claude-advisory", injectedSkillIds: [...]}`. Injected
means included in emitted hook JSON, not proof of host receipt or tool use. A crash
or stdout failure can still prevent delivery after a trace write. Summary separates
mode counts/advisory recommended and injected counts; `traces show` labels injected
recommendations separately. No advisory context text is persisted in traces.

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

The pre-release v1 schema replaces `turnKey` with `promptKey`; schemaVersion stays
`1.0`; this change was made before the first v1 release and before PR4 merged. Old development traces
using turnKey do not validate against the revised schema.

New directories/files use 0700/0600 on POSIX.
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
[upstream #40680](https://github.com/openai/codex/issues/40680); PR7 adds no Codex
workaround, context injection or subagent routing. Claude advisory is separately
opt-in and does not claim native invocation or improved routing accuracy.

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
[PR5 validation](docs/PR5_VALIDATION.md) for trace operations,
[PR6 validation](docs/PR6_VALIDATION.md) for registration management,
[PR7 validation](docs/PR7_VALIDATION.md) for Claude advisory safety and installed-package checks,
[PR8 validation](docs/PR8_VALIDATION.md) for native catalog sources, official naming differences,
conservative resolution and package checks,
[PR4 validation](docs/PR4_VALIDATION.md) for hooks and trace privacy,
[PR3 validation](docs/PR3_VALIDATION.md) for eval checks, and
[PR2 validation](docs/PR2_VALIDATION.md) for the unchanged SDK boundary.
Codex advisory, enforce mode, invocation detection, Studio and cloud trace services remain later work.

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
behavior, not skill usefulness. The separate PR9 funnel reports observed model
Skill calls only when correlation and observer availability permit it.

To repeat the installed package check offline after packing/installing in a
temporary directory:

```sh
node scripts/trace-ops-smoke.mjs /path/to/install/node_modules/.bin/skilldispatch
```

This explicit development script uses temporary settings and denies fetch; it is
not run by normal tests, CI or prepack. No online doctor or raw-prompt display
option exists. Advisory remains deferred.

## Claude model Skill invocation telemetry

Claude native Skill observer (PR9): `skilldispatch hook claude-skill` accepts
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

`skilldispatch traces summary` now reports an advisory funnel; `traces show <id>`
shows same-prompt model Skill lifecycles. **Recommended ≠ injected ≠ model-invoked
≠ succeeded**. Success means the native Skill tool completed, not that Claude
followed the skill or improved the task outcome. Direct user `/skillname`
invocations use a separate host path and are not model adoption.

Conversions count route × logical skill-version pairs, only for Claude advisory
traces with confirmed local observer capability and exact session/prompt keys.
Old traces are **telemetry unavailable**, not negative examples. Attempts without
a terminal event remain unknown; async hooks can be terminated with the host.
Subagent-marked events remain visible separately and do not count as main-turn
adoption. No transcript parsing or online calls are used to fill gaps.

After updating an existing installation:

```sh
pnpm build
pnpm skilldispatch hooks install claude
pnpm skilldispatch hooks status claude
pnpm skilldispatch doctor
# Reload/restart Claude Code, then use it normally.
pnpm skilldispatch traces summary --since 24h
pnpm skilldispatch traces show <route-trace-id>
```

Registration checks are local prerequisites, not proof that host policy permits
execution or that a background observer finished. No real-user settings are
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

Summary's advisory funnel contains only observer-capable same-prompt records;
existing advisory totals still include older records. `modelInvoked` counts
recommended pairs with an observed main-context attempt. Injected-to-model
conversion uses the intersection of injected and model-invoked pairs, so an
independently invoked recommendation cannot inflate it. Success requires an
observed success for an attempted tool lifecycle. Zero denominators yield
`null` / `n/a`. Per-skill pair counts are available in summary JSON.

Invocation stream health counts cover the full stream, while `--since` / `--agent`
filter routing cohorts and their funnel. Invalid lines are counted and skipped;
an unreadable/unsafe stream makes telemetry unavailable. No records are repaired,
removed or uploaded. Raw prompt text, hashes and host correlation keys are never
printed by trace commands. Matching is exact: aliases, unresolved/bundled names
and changed catalog/content versions cannot receive speculative conversion credit.

# Architecture

## Implemented PR8 boundary

The shipped implementation is a single `skilldispatch` package with separate ESM
library and CLI entry points. Discovery, Jev/mock routing, routing evaluation,
shadow hooks, local traces, offline doctor, trace analytics and user hook registration
are active. Claude discovery includes explicit synced and active installed-plugin sources.
Claude advisory is user opt-in; Codex stays shadow-only. Enforce and
subagent routing are not implemented.

```text
cli/program + commands
  -> runtime/context -> config/load + schema
  -> discovery/codex | discovery/claude
       -> scan + parse-skill + catalog
  -> core/route -> RouterProvider (providers/types)
       -> core/policy
  -> providers/jev | providers/mock (chosen by the CLI composition root)
       -> jev/client -> @typesafe-ai/sdk (Jev only)
  -> eval/schema -> eval/resolve -> eval/runner -> core/route
       -> eval/metrics (pure scoring and aggregation)
  -> hooks/codex | hooks/claude -> hooks/runtime -> runtime/context + core/route
       -> hooks/advisory + discovery/claude-invocation (Claude only)
       -> telemetry/trace -> privacy + fingerprint -> JsonlTraceSink
  -> ops/context -> trusted config + telemetry storage paths
       -> telemetry/reader -> analytics + views -> traces CLI
  -> registration/inspect + command -> user host settings (read-only status)
       -> document + manage + atomic (explicit install/uninstall only)
  -> ops/doctor -> registration/inspect + config + discovery + storage/schema checks
```

`RouterProvider.judge` is the provider contract. Every eligible candidate must be
accounted for as one independent probability or an explicitly failed evaluation.
The coordinator removes disabled skills before crossing that boundary and
validates coverage/completeness before applying policy to successful decisions.
Malformed results fail open; valid partial results preserve successes. An overall
timeout uses an abort signal; Jev cancels in-flight requests through its safe
transport and stops scheduling additional chunks.

Discovery normalizes canonical paths and retains same-name local skills. Local
IDs hash agent/path; synced/plugin IDs use adapter-owned logical identity and
content to avoid cache-path churn. Duplicate-name diagnostics group by agent and
whitespace-normalized name (case-sensitive) for generic/Codex skills; Claude uses
normalized native invocation identity, including namespace. Skills
belonging to different host agents are distinct even when their names match.
Host-specific fallback fields and invocation restrictions stay in adapters.
Generic parsing and traversal do not
execute skill content. Scan order is recorded as source metadata; it is not a
promise that every host will resolve collisions identically.

`enabled` means eligible for automatic routing. It also becomes false for
explicit-only host skills; it does not claim that a human cannot invoke them.
Discover, route and eval keep their existing nonpersisting behavior. Only hooks
write the new public Route Trace v1 contract; prompt storage defaults to HMAC.

Configuration accepts `jev` (default) or explicit `mock`. Unsupported providers
error; unknown config fields warn. Eval input uses its own strict versioned schema.
Telemetry configuration is hook-only; advisory mode is an explicit user-owned
Claude hook option. Shared composition selects the same provider/policy for all commands.

See [README](../README.md) for supported paths, current host differences,
configuration precedence and known discovery boundaries.

## Dependency direction

```text
                         CLI
                          │
         ┌────────────────┼────────────────┐
         │                │                │
     discovery          hooks             eval
         │                │                │
         └──────────────┬─┴────────────────┘
                        ▼
                    core/domain
                  route + policy
                        │
                        ▼
                 RouterProvider
                  ▲           ▲
                 mock         jev

telemetry consumes domain events; domain never imports telemetry.
agent adapters depend on core; core never depends on agent adapters.
```

## Public boundaries

### DiscoveryAdapter

```ts
interface DiscoveryAdapter {
  agent: AgentKind;
  discover(ctx: DiscoveryContext): Promise<DiscoveryResult>;
}
```

### RouterProvider

```ts
interface RouterProvider {
  name: string;
  judge(input: ProviderRouteInput): Promise<ProviderRouteOutput>;
}

interface ProviderRouteOutput {
  decisions: ProviderDecision[];
  completeness: "complete" | "partial";
  failedSkillIds?: string[];
  diagnostics?: ProviderDiagnostic[];
  model?: string;
}
```

Each `RoutingCandidate` contains `id`, `name`, `description`, `scope`, and `agent`.
The request-level `agent` describes the caller; it does not override a candidate's
host identity. No host hook payloads or provider SDK types enter this contract.

The contract is checked against the **enabled input candidate IDs**:

| Result | Required coverage | Routing behavior |
| --- | --- | --- |
| `complete` | Exactly one decision per candidate; failed IDs absent or empty | Apply policy to all decisions |
| `partial` | Decisions and failed IDs form a disjoint, duplicate-free partition of all candidates; at least one failed ID | Apply policy only to successful decisions |
| Malformed | Invalid shape/probability/completeness, unknown or duplicate IDs, overlap, or uncovered candidates | Return empty `selected` and `allDecisions`, with `invalid_provider_response` |

For example, decisions `A=0.95`, `B=0.82`, `D=0.10` and failed ID `C` are a valid
partial result for candidates A–D. A threshold of 0.75 selects A and B. C receives
no fabricated decision or zero score. `RouteResult.diagnostics` contains
`{ code: "provider_partial", level: "warning", message: "...", skillIds: ["C"] }`.
An all-failed result is also valid partial output with no decisions. A result
with no failures must declare `complete`. Omitting `completeness` is malformed;
the mock always supplies `complete`.

`ProviderDiagnostic` reuses the domain's `code`, `level`, `message`, and optional
`skillIds`. Referenced IDs must be unique and belong to the eligible candidates.
Providers must supply safe messages, never raw SDK errors, prompts, API keys, or
environment values. Invalid output is rejected before its diagnostics/model are
forwarded. After validation, the core emits its partial diagnostic first, then
provider diagnostics in deterministic code/level/message/ID order. Diagnostic
skill IDs are sorted; selection still uses probability/name/ID ordering. Input
objects are not mutated, and measured latency remains nondeterministic.

A provider exception or overall route timeout still fails open with
`provider_failed` or `provider_timeout`. To preserve successes, a provider
must account for failures and return valid partial output before the overall
deadline. SDK/transport details remain outside this contract.

### RoutingPolicy

Pure function:
```ts
applyPolicy(decisions, config) -> selected
```

Keep network concerns out of policy.

## Jev implementation (PR2)

`JevRouterProvider` implements the unchanged `RouterProvider.judge` contract.
Only the provider boundary imports `@typesafe-ai/sdk` (pinned to 0.6.0).
`JevCall` is a narrow injectable function returning `unknown`; response validation
is required even though the SDK has TypeScript types. Tests never need the real API.

The request is `systemOne({ model, state, questions })`:

- Shared state contains only `prompt` and `requestingAgent`.
- Candidates sort by ID before chunking. Each chunk assigns local keys `q000`,
  `q001`, … to independent Noul questions and keeps key-to-skill-ID mappings locally.
- A structured question contains material-relevance instructions and only the
  skill's name, description, host agent and scope. It describes yes/no criteria
  and discourages incidental keyword matches. It does not send IDs, canonical
  paths, CWD, arbitrary metadata, or complete SKILL.md bodies.
- Every answer must have `type: noul` and a finite `noul` in [0, 1]. Missing/extra
  keys, wrong types and invalid scores invalidate that chunk. Answer object order
  is immaterial. `noul` becomes `probability` without rounding or calibration.

A bounded worker pool processes at most `concurrency` chunks (default 2), with
a local ceiling of `MAX_JEV_CONCURRENCY = 8` workers (valid range 1–8),
introduced in PR3 to bound burst/cost from configuration mistakes. This is not
a TypeSafe API concurrency limit. Results are stored by chunk index, so
completion order does not change decision or
diagnostic ordering. The default and local maximum `chunkSize` is 48. Official
OpenAPI publishes no question-count maximum; official model limits are token-based.
48 is a conservative application bound, not a promise to fit every prompt/catalog
into the model context. See [PR2 validation](PR2_VALIDATION.md) for sources.

Chunk errors yield fixed safe codes and failed skill IDs; other successful chunks
remain usable. All success is `complete`, any failures are `partial`, including
all-failed results. Invalid **API chunk** responses become failed chunks in a valid
partial domain result. An invalid **provider contract** still makes core routing
fail open with empty decisions. API/network failures allow other chunks to proceed;
a request timeout or cancellation stops queued work, while already-running workers
settle. Unscheduled candidates also get explicit failed IDs. Overall `route()`
timeout aborts the provider and returns an empty recommendation set as before.

Retries default to 0 rather than the SDK's 2. `requestTimeoutMs` defaults to 1800
per attempt; the route deadline defaults to 2500. Configurable retries are limited
to 0–2 and stay subject to the overall deadline. No fallback to mock occurs.
The returned actual model is reported only if successful chunks agree; an alias
change across requests produces a safe `jev_model_mismatch` diagnostic instead
of falsely attributing all decisions to one model.

The SDK 0.6.0 native response-clone cancellation issue affects Node 20/22. Our
custom fetch fully reads the single native response body before returning a new,
in-memory Response to the SDK. Only this buffered transport receives the caller
signal through the SDK, including SDK timeout cancellation. There is no native
stream tee during abort and no process-wide rejection handler. Healthy, cancelled,
body/header timeout and outer-route timeout paths run against loopback HTTP in
strict child processes on Node 20 and 24. Revalidate this boundary on SDK upgrades.

Credentials come from the CLI's `TYPESAFE_API_KEY` environment entry. Missing,
blank or malformed credentials fail before network use. The key is sent only in
SDK authentication, not in model input. SDK log level is explicitly `off`; its
endpoint is fixed to `https://api.typesafe.ai` and redirects are rejected. Raw SDK
exceptions, causes/stacks and HTTP error bodies never become domain diagnostics.
The prompt and allowed descriptions **are sent to TypeSafe**; data embedded in
those fields is not automatically redacted. Discovery remains entirely local.

Independent Noul is a multi-label baseline, not competitive selection. Similar or
broad skills may all score highly. Neither global threshold calibration nor
catalog-specific accuracy is established. The eval layer measures behavior
before any stronger accuracy claim or alternative strategy is adopted.

## Routing evaluation (PR3)

`eval/schema.ts` loads regular YAML files up to 1 MiB, bounds alias expansion,
rejects cycles, duplicate keys and unknown fields, and validates version 1.
Datasets require at least one case; case IDs are unique and prompts nonblank.
Parser/schema errors have fixed messages and codes rather than source excerpts.
`should` / `should_not` default to `[]`; `fully_labeled` defaults to false.
Optional file gates use `min_precision` / `min_recall`, each in [0, 1].

`eval/resolve.ts` resolves `{name, agent?, scope?}` selectors against the complete
discovered catalog, including disabled skills. Names are case-sensitive after
whitespace normalization. Zero matches fail with `unknown_eval_skill`; multiple
matches fail with `ambiguous_eval_skill`. Agent qualifiers distinguish hosts;
scope qualifiers can distinguish repo/user duplicates. If those still leave more
than one match, the dataset cannot uniquely label that skill and fails. No paths
or machine-specific IDs are required in datasets. Duplicate catalog IDs,
duplicate resolved labels and overlapping positive/negative labels are errors.
All cases are resolved before the first provider request.

`eval/runner.ts` takes a snapshot of catalog routing fields, validates policy and
gates, then routes cases sequentially in file order. It delegates to the existing
core `route()` with one provider instance; the CLI's `routingForCommand` is shared
by route and eval for config/discovery/provider selection. There is no eval-only
network client, timeout policy, router algorithm or automatic retry layer.
Core remains independent of eval and SDK types. Disabled labeled positives remain
false negatives, making discovery/eligibility changes visible to regression tests.

`eval/metrics.ts` scores actual selected sets and aggregates pure count-based
metrics. A partial-label case recognizes only `should` as positive and
`should_not` as negative; unlisted selected skills go to `unlabeledSelected`.
For fully labeled cases, all selected skills outside `should` are false positives.
Exact-set matching compares the full selected ID set with the resolved positives,
and only fully labeled cases enter its denominator. No-skill expectations and
empty selections are a valid exact match.

Precision/recall/F1 are micro metrics: TP/(TP+FP), TP/(TP+FN), and
2TP/(2TP+FP+FN). Every zero denominator gives `null`. Thus F1 is zero for an
all-false-positive or all-false-negative result even if precision or recall is
undefined. Average selected skills includes unlabeled predictions. Latency is
core route time, excluding setup/discovery; P50/P95 use sorted nearest rank
`ceil(p * count) - 1`. The internal aggregator also returns null ratios/latencies
for an empty input, though datasets require at least one case.

`provider_failed`, `provider_timeout`, and `invalid_provider_response` mark a
case as failed and increment `providerFailureCount`. `provider_partial` marks
partial and increments `providerPartialCount`, including all-failed partials.
These cases are never removed from quality metrics: actual recommendations (or
their absence) are scored normally. Failure on a negative case can therefore
coincide with an exact match; consumers must also inspect reliability counts.
PR3 has only precision/recall gates, no implicit reliability gate.

The version-1 result contains policy, ordered cases, metrics, gate outcomes and
diagnostic codes/levels/skill IDs. Each case includes selected probabilities,
TP/FP/FN/unlabeled lists, `fullyLabeled`, nullable `exactMatch`, latency and
provider/model/partial/failed metadata. No prompt, body, path, arbitrary metadata,
provider diagnostic message or reason code is copied into evaluation output.
Allowed metadata (case IDs, skill names, safe provider/model/codes) is not a secret
redaction service; provider contracts still require safe diagnostic fields.
YAML prompt content is sent to the selected provider but never persisted by eval.

Given the same catalog, dataset, scores and policy, ordering and count metrics
are deterministic. Core ranking is retained for selections; label and diagnostic
ordering uses the existing locale-independent comparison. Live API responses and
measured latency can vary. Pin catalog descriptions/config/dataset and a stable
model where available for comparisons; eval itself has no run registry or persistence.

CLI gates override file gates per field and compare inclusively. An undefined
metric cannot pass a requested gate, even at zero. Completed results exit 0 unless
a gate fails (exit 2); setup/input errors exit 1. Gate failure still emits the full
JSON result. Public library exports are `parseEvalYaml`, `loadEvalFile`,
`runEvaluation`, `EvalInputError`, and their input/result types; scoring and
resolution helpers stay internal. See [PR3 validation](PR3_VALIDATION.md).

Implementing independent Noul does not establish routing accuracy. Evals measure
explicit/implicit/multiple/no-skill, overlapping or broad/specific, negated and
multilingual cases before accuracy claims. Fixture scores test the measurement
pipeline, not Jev semantics. No threshold tuning or alternate router is added.

## Shadow hooks (PR4)

`hooks/codex.ts` and `hooks/claude.ts` translate current UserPromptSubmit wire
objects into `{agent, cwd, prompt, sessionId, promptCorrelationId?, model?}`. Zod object parsers
check required fields and known optional types, then strip unknown extensions.
Codex requires session/turn/model, accepts a null transcript path, and discards
agent_id/agent_type. Claude requires session/transcript/CWD/permission/event/prompt,
maps optional `prompt_id` to `promptCorrelationId` and discards unrelated common
fields after type checking. Codex maps `turn_id` to that same neutral field.
Legacy Claude inputs omit it; no model or submission ID is invented.
Neither adapter reads a transcript or passes its path to the runtime.

`hooks/stdin.ts` reads at most 1 MiB and waits at most one second for EOF. Invalid
JSON/event/types, oversized input, stream errors and empty prompt text are silent
no-ops before any provider request. `hooks/runtime.ts` loads config/discovery
through `runtime/context.ts` using the **hook CWD**, forcing the host's single-agent
catalog regardless of `discovery.agents`. Normal CLI can still use both agents.
Disabled skills remain in counts/fingerprints but never become provider candidates.

Config loading remains one implementation: `config/load.ts` labels each layer
`user`, `project`, or `explicit`. Normal CLI retains defaults → user → project →
explicit config. Hook runtime requests `mode: "hook"`: defaults → user only,
unless the **user layer** sets `hook.trustProjectConfig: true` (default false).
Untrusted project config is skipped before stat/read/parse, including malformed
files and self-authorizing trust flags. Hook mode accepts no explicit layer;
project/explicit layers can never change the user trust switch or execution modes
in any mode. Registration reads `mode: "user"`, skipping all project settings.
Core domain types do not know config provenance.

This isolates global hooks from repository-controlled trace paths, raw prompt
persistence and network/provider changes. User opt-out and offline provider
choices cannot be overridden by an untrusted project. Skill discovery still uses
hook CWD: reading project skills is separate from trusting project runtime config.
Explicit user opt-in delegates normal routing/telemetry overrides to project
settings; it is not a per-repository trust registry. Invalid user config still
fails open silently. See the README for the user-only opt-in example.

The runtime creates private storage/key prerequisites, selects the existing
provider, calls core `route()`, explicitly projects a trace and awaits the sink.
There is no parallel implementation of routing policy or SDK behavior. Every
exception is contained; provider setup errors become fixed `provider_setup_failed`
diagnostics when input/config/catalog/key setup is available. Core failures
retain their existing safe codes. Unexpected route exceptions become
`hook_runtime_failed`. Config/discovery/key initialization errors may produce no
trace at all. An invalid or unwritable sink never fails the host operation.

Only `skilldispatch hook codex|claude` gets a 4-second process deadline, covering
stdin, discovery, routing and storage. On return it exits 0 even if timed-out SDK
work still has sockets alive. The library has no process lifecycle side effects.
The underlying route default remains 2500 ms. Recommend host command timeout 5
seconds for startup/headroom. Default shadow registration is asynchronous; explicit
Claude advisory runs synchronously and adds routing latency to the current prompt.

Shadow output is empty; only Claude advisory can return the official UserPromptSubmit
JSON response. Neither mode emits blocking decisions/reasons/system messages. Invalid
CLI usage retains ordinary command semantics. See [PR4 validation](PR4_VALIDATION.md)
for shadow input/privacy and [PR7 validation](PR7_VALIDATION.md) for advisory behavior.

## Route Trace v1 and TraceSink

```ts
interface TraceSink {
  write(trace: RouteTrace): Promise<void>;
}
```

`telemetry/types.ts` is the strict Zod definition of schemaVersion `1.0`;
`schemas/route-trace.schema.json` is its shipped draft-2020-12 JSON Schema.
Objects reject extra properties. Tests compare generated schema and validate
emitted JSONL with a dev-only Ajv validator. This replaces the never-emitted
handoff draft. The pre-merge hardening replaces `host.turnKey` with
`host.promptKey` while keeping `1.0`, since no public v1 release has shipped.
Old development traces with turnKey are rejected by the revised strict schema.
Readers should dispatch by schemaVersion; incompatible changes after release
require an explicit new contract version.

The allowlist projection includes trace UUID/time, agent/mode, prompt
storage discriminator, pseudonymous host keys/model, catalog fingerprint/counts,
provider/model/route latency, threshold/maxSkills, outcome, scored decisions and
diagnostic code/level/known skill IDs. Decisions contain local skill ID, name,
agent, scope, contentHash, probability and policy-selected flag, in core ranking
order. No decision is fabricated for disabled or failed candidates. Selection
means a SkillDispatch recommendation only, not native invocation or adherence.

Outcome precedence is failed before partial before complete. Core provider
exception/timeout/malformed-response, setup failure and unexpected route failure
are failed. `provider_partial` means partial, including all-failed partials; its
skillIds identify missing evaluations. Otherwise routing is complete, including
an empty eligible catalog requiring no judgments. Provider setup failures have
latency 0; otherwise latency is route execution only, not whole-hook wall time.

Raw prompt/session/submission IDs, CWD, transcript/skill paths, directories, descriptions,
bodies, arbitrary metadata, reason codes and diagnostic messages/stacks never
flow through this projection (except explicit raw prompt opt-in). Diagnostic IDs
are filtered to the catalog, deduplicated and sorted; codes and optional models
use bounded safe token formats. Those formats do not identify arbitrary secrets;
allowed metadata still depends on its source contract. Never use raw SDK text as
a diagnostic field. Trace metadata ordering uses the locale-independent helper;
UUID, timestamp and measured latency intentionally vary across events.

### Private correlation and fingerprinting

`prompt.storage` is `hash` by default, `none` for no prompt fields, or explicit
`raw` for a raw field only. HMAC-SHA256 inputs are `prompt\0` + exact prompt,
`session\0` + agent + `\0` + session ID, and `host-prompt\0` + agent + `\0` +
host submission ID. `host.promptKey` uses Codex `turn_id` or Claude `prompt_id`;
legacy Claude input without prompt_id omits that key. No transcript lookup,
random ID generation or session-based inference fills the gap.

`prompt.hash` correlates content, while `host.promptKey` correlates submissions.
Two submissions with identical text have identical prompt hashes but different
promptKeys when their host IDs differ. Equal literal IDs from different hosts
also produce different promptKeys. The session, content and host-prompt domains
are distinct; the installation key is independent of API credentials.

The key is exactly 32 cryptographically random bytes at `<dataDir>/install.key`.
Data-dir priority: absolute `SKILLDISPATCH_DATA_DIR`, absolute `XDG_DATA_HOME`
plus `/skilldispatch`, then `~/.local/share/skilldispatch`. A private temporary
file is written/closed, then atomically published by an exclusive hard link.
Racing creators read the winning complete key; corrupt keys are not replaced.
No automatic key rotation is performed. POSIX leaf directories/files must belong
to the current user and have no group/other permissions (new modes 0700/0600).
Leaf-directory/file symlinks are rejected; file opens use no-follow/nonblocking
flags where supported. Windows permission/ACL behavior is not certified here.

Catalog fingerprint is SHA-256 of UTF-8 JSON of the sorted array of serialized
`[agent, scope, whitespaceNormalizedName, contentHash, enabled]` tuples. Sorting
uses `compareText`, retains multiplicity, and is independent of input order,
locale, absolute paths and path-derived IDs. Names remain case-sensitive. Content
or enabled changes affect the fingerprint; moving otherwise identical skills does
not. This enables semantic catalog comparison across installations, while each
trace decision's existing skill ID remains a catalog identity. PR8 optionally
appends an adapter-generated 64-hex `catalogIdentity` digest to Claude tuples.
It commits to origin, native name, plugin identity/version/installation scope and
model eligibility, without passing Claude-specific types into the fingerprint layer.
Legacy traces require no rewrite; expanded catalogs naturally have new fingerprints.

### JSONL persistence

Default `<dataDir>/traces.jsonl`, optionally overridden by absolute or `~/`
`telemetry.tracePath`; this cannot target the installation key. Each validated
event is serialized once with one trailing newline and written with **one
O_APPEND operation**. No short-write retry splits an event across writes. Trace
files must be private regular files with one link. Multiple local processes are
tested; this is best-effort storage, not transactional or fsync-durable. A crash,
short write, disk failure or process deadline can drop an event or leave an
incomplete final line. Consumers should tolerate a damaged trailing line.
Network filesystem append/link guarantees are not assumed.

No trace is written by discover/route/eval. `telemetry.enabled: false` skips hook
routing/storage. There is no retention manager or upload. Hook runtime never
mutates host settings; explicit registration management is separate. Prompt hashing changes local storage only: Jev still receives the
prompt and routing descriptions under the existing request privacy contract.
Text absent from the host hook is not reconstructed from transcripts or images.

## Failure behavior

- discovery partial failure: continue with successfully discovered skills + diagnostics;
- zero skills: return empty route immediately;
- valid partial provider response: retain successful decisions and diagnose failed IDs;
- Jev chunk timeout/network failure: retain successful chunks as partial;
- overall route timeout: fail open with no recommendations;
- malformed provider response: fail open + diagnostic;
- telemetry failure: ignore for prompt path;
- hook/config/key/trace failure: return silent, empty success; no host output is serialized.

## Caching

v0.1 may cache parsed skill metadata in memory for one CLI process.
Do not create persistent cache until profiling demonstrates value.

Future persistent cache key:
- canonical SKILL.md path
- mtime/size or content hash

## Security

- Do not execute anything in skill directories during discovery.
- Parse frontmatter as data only.
- Canonicalize paths.
- Protect symlink traversal loops.
- No shell interpolation of prompt text.
- Hook adapter input is untrusted JSON.
- Keep API keys only in the process environment (or an explicit library constructor
  argument); never in YAML, model input or diagnostics.

## Operational CLI and trace analytics (PR5)

`doctor` and `traces` use the same source-aware **hook** config policy as the runtime:
defaults → user, with repository config only under user `hook.trustProjectConfig`.
There is no explicit config override for these commands. Normal discover/route/eval
layering remains unchanged. Reading project skills and trusting project runtime
settings remain separate. `ops/context.ts` composes trusted config and existing
`dataDirectory`/`tracePath` helpers without discovery or provider creation for traces.

`TraceReader.read()` yields validated Route Trace v1 or line-number/safe-code
errors. `JsonlTraceReader` checks reserved paths and canonical aliases, rejects
symlink leaves, nonregular files and nlink != 1, checks POSIX owner/private modes
on the file and parent leaf directory, and compares lstat identity with the
no-follow/nonblocking opened descriptor. Earlier ancestor aliases follow the
writer's convention; this is not a sandbox against same-user concurrent filesystem
mutation. API keys have no on-disk mode; callers can also reserve credential files.
Operational callers reserve the installation key and user configuration.

Reads use 64 KiB blocks, at most 2 MiB line accumulation, fatal UTF-8 decoding, JSON
parse and strict Zod schema validation. The starting file size bounds this read;
concurrent appends are visible next time. A complete final object without LF is
accepted; partial/corrupt/oversized/blank lines count as invalid and do not abort
other records. Missing data is empty. Errors expose fixed text, not paths or parse
excerpts. Readers never create, repair, chmod, rotate or delete files.

`telemetry/views.ts` explicitly projects output and removes all prompt content,
prompt hashes, sessionKey/promptKey and host objects, not merely `prompt.raw`.
Show includes only the storage discriminator, policy, counts/fingerprint, safe
routing metadata, scored decisions and diagnostic code/level. Skill IDs are also
omitted from these CLI views. Schema-valid names/models/codes remain metadata,
not a general secret detection/redaction mechanism. Text escapes control chars.
No trace or SDK error is dumped directly. JSON uses an internal version-1 envelope;
these ops APIs are not newly exposed from the package library entry point.

`analytics.ts` streams matched records into aggregate counts/maps. File-health
counts always cover all scanned lines; matchedTraces and metrics use only matching
valid records. Summary reports outcome/host/provider counts, selected decision
count mean (including failure/partial traces), exact nearest-rank P50/P95, distinct
catalog fingerprints and per-version recommendation frequency. Empty averages
and quantiles are null. Exact latency histograms cost O(unique latency values),
skills O(unique name/agent/scope/contentHash tuples), catalogs O(unique fingerprints).
Full trace bodies are not retained, but aggregate cardinalities are not bounded.

A version is seen at most once per trace, selected if any equal-version decision
was selected. Versions on different paths collapse only for this statistic;
routing identities/catalogs remain unchanged. Never selected means observed but
never recommended, excluding unobserved skills entirely. Sort: selected count
desc, agent, name, scope, contentHash asc using compareText. The summary does not
infer complete catalogs or skill invocation from decisions.

List keeps bounded top-N safe views (default 20, maximum 1000), newest timestamp
then UUID ascending, with later file records first for exact timestamp/ID ties.
Show scans to EOF for an exact UUID, treating UUID case as equivalent, rejects
multiple valid matches and returns no partial output on missing/duplicate IDs.
Summary/list count duplicate records rather than building an unbounded UUID set.
Agent/outcome filters and positive integer hour/day `--since` windows are local:
since and now inclusive, future excluded only when a window is requested.

Doctor never constructs a provider, authenticates online or mutates files. It
reports command availability and read-only user registration inspection, without claiming host trust or delivery. Existing key
health checks permissions, regular single-link identity, readability and 32-byte
size without exposing content or creating a missing key. Destination checks use
permission probes and nearest existing writable ancestor for missing directories;
these do not guarantee free space or durable writes. Config/unsafe storage/schema/
discovery failures are FAIL (exit 1). Missing key/trace, missing Jev credential,
empty/diagnostic-bearing discovery, disabled telemetry or invalid lines are WARN
(exit 0 unless another check fails). Invalid credential format is FAIL. Mock needs
no credentials. File locations for user config/data/trace are deliberately visible;
absolute skill paths, diagnostic messages and correlation data are not.

The historical PR4 contract remains unchanged. This stage supplies only local
operational visibility: no context injection, invocation tracking, cloud upload,
trace mutation or automatic optimization. See [PR5 validation](PR5_VALIDATION.md).


## Safe hook onboarding (PR6)

`registration/` is outside core and routing. `command.ts` resolves the real running
Node and CLI entrypoint. Codex POSIX commands quote each literal argument; Windows
commands encode a PowerShell script as UTF-16LE Base64 with literal single-quoted
paths. Claude uses the official exec form (`command` + literal `args`), avoiding
shell evaluation entirely. Relative/control-character/host-placeholder paths are
refused. Status never serializes unrelated commands/config values.

`inspect.ts` reads only user `.codex/hooks.json`, `.codex/config.toml` and
`.claude/settings.json`. Top-level TOML hooks cause Codex conflict because the two
same-layer sources both load. Custom host-directory overrides are refused for
automatic management. The inspector does not follow project/plugin/managed layers,
claim Codex trust, or infer that a registered handler ran. Claude user
`disableAllHooks` is an issue; other layers can still affect actual execution.

`document.ts` validates strict, bounded JSON, including duplicate-key and structure
checks. Exact `UserPromptSubmit` + `type: command` + canonical command/args identify
ownership. Optional Windows overrides exclude ownership. A heuristic can only
signal manual conflict, never authorize deletion. Syntax-tree edits through pinned
`jsonc-parser` preserve unrelated values, including numeric lexemes that JSON.parse
plus JSON.stringify would round. Uninstall removes only owned handlers and their
empty plain group; event/object containers may remain. No whole-backup restore.

`files.ts` performs lstat/no-follow/nonblocking reads with descriptor identity checks,
regular/nlink=1/current-owner checks and POSIX no-group/world-write permissions.
Host configs may be 0644; their existing permissions are preserved. New files are
0600 and new host directories 0700. Both read and proposed output are bounded to
1 MiB. Invalid UTF-8/JSON/TOML and unsafe paths produce fixed error codes, not excerpts.

`manage.ts` reuses inspection/planning for dry-run and actual edits. Actual changes
acquire an exclusive cooperative `.skilldispatch.lock`, reread/replan, write a
same-directory unique temporary file, fsync, compare the original again, and rename.
Codex inline conflict is checked again before rename. Directory fsync is best effort.
The first modification of an existing config publishes a 0600 same-directory
`.skilldispatch.bak` exclusively; an existing safe backup is retained forever.
A failed replacement leaves the original intact (a backup can already exist).
No stale lock is stolen. This guards cooperating installers and detected external
edits, not arbitrary malicious same-user races at the final rename boundary.

Shadow install defaults to `async: true`, `timeout: 5` seconds. Claude advisory is
sync. Claude shadow supports `--sync` debugging; Codex `--sync` is rejected in PR7.
Install reconciles only owned execution/timeout fields; mode changes alone do not
mutate host settings. The hook retains its 4-second cutoff, 1-second bounded stdin,
and 2500 ms routing deadline. Stdout is flushed before terminating pending SDK sockets.
Claude does not enforce `timeout` on already-running ordinary async hooks. Async
session lifecycle is host-owned: cancellation/teardown may omit traces; absence is
not a no-skill decision. Codex trust review remains necessary after registration.

CLI composition uses this layer for `hooks status/install/uninstall`; doctor reuses
read-only inspection. Hook conflicts are WARN in doctor, conflict exit 1 in status,
and safe refusal for install. Missing registrations are WARN in doctor, exit 0 in
status. `routing_ready` is a separate boolean local-prerequisite check: provider
setup plus telemetry enabled, not authentication, host approval, or delivery.
Existing FAIL/usable doctor semantics otherwise remain. No API request, key creation,
trace append or mutation occurs during status/doctor. Dry-run does not create even
an absent directory or backup. Registration operations never read SkillDispatch
project config to select a destination.

See [PR6 validation](PR6_VALIDATION.md) for official host references and runtime
verification. This phase adds no advisory/context injection, project registration,
host settings migration, invocation tracking, delivery queue or cloud functionality.

## Claude advisory boundary (PR7)

`hook.modes` defaults to `{claude: shadow, codex: shadow}`; only the user config can
change Claude to advisory. Even explicitly trusted projects cannot change either
mode. Unknown modes and Codex advisory reject configuration, without silent coercion.
Core routing and provider contracts are unchanged and have no host-specific types.

`hooks/runtime.ts` reuses single-agent discovery, provider creation and `route()`.
Only complete results with selections can reach `hooks/advisory.ts`. The CLI supplies
a read-only registration readiness check: exact owned Claude command, one sync
registration, configured advisory, no conflict/disable issue. Async/unknown state
gets `advisory_registration_not_ready` and no output. Current file state is not proof
that a running host reloaded settings; host lifecycle remains external.

`discovery/claude-invocation.ts` validates adapter-owned native identifiers. Local
skills retain source-entry names (including symlinks) rather than canonical-target
or frontmatter display names. PR8 supplies synced/plugin namespaces as described
below. Only bounded safe identifier segments are accepted. Counts include disabled
entries; multiple normalized native matches cause
`advisory_ambiguous_skill_invocation`. No approximate native precedence is applied.
The builder independently checks manual-only and model eligibility restrictions.
Native session permissions and availability remain authoritative.

The pure builder projects only identifiers, retaining selection order. Static text
prioritizes the user's request, asks to consider native Skill invocation if permitted
and applicable, and says to continue normally if unavailable. No prompt, probability,
description, body, path, diagnostic or arbitrary metadata is included. A 4096-byte
UTF-8 context budget omits a deterministic suffix without truncating identifiers.
Omissions have code/skill-ID diagnostics. JSON is serialized, never concatenated.
Serialization/resolution failures are silent and get a safe trace diagnostic where
possible. Partial or failed routing never produces advisory output.

Trace v1 additively extends mode to shadow/advisory and allows optional delivery
kind/injectedSkillIds. Old shadow traces without delivery remain valid against both
Zod and JSON Schema. Selected denotes routing policy; injected denotes emitted hook
JSON, not host acknowledgement. The trace is appended before output; a later stdout
failure/crash can prevent receipt. Writer failure is swallowed while safe output can
still be returned. Initialization failures may produce neither. No native invocation
or compliance tracking is implied. Analytics retains selection statistics and adds
mode/advisory counts and a safe injected flag, without exposing context text or raw
prompt/correlation data. Trace-only APIs do not route or mutate events.

Registration mode ownership is shared via `registration/mode.ts`; installer and
inspector use the same user config parser. Mismatches remain installed with a safe
issue and reinstall guidance, and doctor WARNs. `advisory_ready` requires configured
advisory, sync registration without issues and `routing_ready`; shadow reports false
without implying an installation failure. Status/doctor never reconcile automatically.
Atomic mutation, private backup, exact ownership and offline behavior remain intact.

## Claude native catalog (PR8)

All new discovery is read-only and offline. The adapter resolves `CLAUDE_CONFIG_DIR`
(default home/.claude), and `CLAUDE_CODE_PLUGIN_CACHE_DIR` (default configRoot/plugins,
**the parent of cache**, also containing registry state). No `claude` subprocess,
authentication, marketplace walk, plugin installation or host mutation is involved.
The SkillDispatch hook project-config trust boundary remains separate: Claude
project settings describe native catalog eligibility, never SkillDispatch telemetry,
provider selection or advisory mode.

The adapter pipeline is:

1. `claude-settings`: bounded reads of user, CWD project, CWD legacy local,
   owned repository-root local settings (macOS/Linux), then file-managed base and
   ordered fragments. Per-key plugin enablement and non-plugin invocation overrides
   merge at this boundary; malformed authoritative state makes candidates non-routable.
   Each location retains its user/project/local/managed source, so source-specific
   restrictions are resolved before normalization instead of flattening all keys.
2. Existing direct personal/project traversal, plus file-managed enterprise skills.
   A local directory containing a plugin manifest is marked unsupported instead of
   being mislabeled as an unqualified native command.
3. `claude-synced`: explicit account-directory then direct skill-directory scans.
   Synced name collisions across accounts are non-routable, not resolved by mtime.
   Identical duplicate versions collapse; different content remains visible.
4. `claude-plugins`: version-2 registry, project applicability, targeted marketplace
   metadata and effective installed definition. Explicit `enabledPlugins` wins over
   entry default, then manifest default, then true. Valid registry membership alone
   is insufficient. Multiple applicable versions are ambiguous and excluded.
5. `claude-plugin-skills`: default/declarative skill roots inside the resolved install
   path. Equivalent same-version copies collapse after content comparison; differing
   copies are excluded. No recursive cache or marketplace skill enumeration.
6. Apply frontmatter model restrictions, non-plugin `skillOverrides`, origin metadata,
   deterministic final ordering and native-identity duplicate diagnostics.

Special catalog settings have their own scope and merge rules:

- `syncClaudeAiSkills` can only opt out. A false from user, project-local or any
  observed file-managed document suppresses synced discovery; a later true cannot
  undo it. Shared project settings do not participate, even when false. The internal
  default true only means no observed opt-out, not proof of a signed-in sync session.
- `strictPluginOnlyCustomization` is read only from managed documents and normalized
  to `strictPluginOnlySkills`. True locks skills; a surface array locks them only if
  it contains `skills`. Unknown string surfaces are ignored. Managed fragment arrays
  combine, while scalar values follow existing file order. Non-managed values are
  ignored without validation or catalog invalidation, even if their shape is invalid.
- A skills lock preserves plugin and managed eligibility (subject to existing
  manual-only/override checks). Local-user/local-project entries remain visible with
  enabled/modelInvocable false; synced entries are not loaded. The policy would also
  allow bundled skills, but this adapter does not discover them.
- Unknown fields and ignored-source values do not invalidate settings. Malformed
  authoritative catalog fields still produce a fixed diagnostic and conservative
  non-routability. No raw value is included. EnabledPlugins continues its per-key
  user < project < local < managed precedence, separately from these rules.

Session `--settings`, non-file policy and live account state remain unobservable.
The resolver neither guesses them nor executes policy helpers. These changes only
control catalog eligibility; they do not implement hook-surface enforcement or
mutate synced caches (including the host's own trash behavior).

Plugin `strict: true` uses installed manifest metadata, with additional declared
marketplace components. `strict: false` uses the marketplace entry, rejects a second
component-bearing manifest, and permits no installed manifest. Marketplace-root
entries use only their explicit component subset. SkillDispatch deliberately does
not reproduce the host's fallback-to-full-scan when all declared paths are missing.
Single-skill roots and custom skill directories are supported; executable components
and arbitrary includes are never evaluated.

`metadata.claude` owns `origin`, `nativeInvocationName`, `modelInvocable`, and optional
plugin ID/name/version/installation scope. Frontmatter cannot spoof this provenance.
Core `scope` stays repo/user/admin/system/unknown; project/local plugins map to repo,
managed to admin. Origin describes source, scope describes applicability. `enabled`
and `modelInvocable` mean eligible for model routing, not installed/enabled plugin
state or whether a human can explicitly run a skill. Disabled plugins are excluded;
manual-only skills from active sources remain visible but are not provider candidates.

Native identifiers follow current official naming: local directory name; synced
`anthropic-skills:<name>`; plugin manifest name plus frontmatter skill name (directory
fallback, already-qualified prefix preserved once). Namespace components are validated
before advisory. Local/synced collisions can coexist via the explicit synced namespace.
Local enterprise/personal/project collisions retain distinct paths and advisory refuses
ambiguous invocation rather than guessing native precedence.

JSON state reads are strict, bounded to 1 MiB/depth 32, reject duplicate keys, invalid
UTF-8, leaf/parent symlinks and non-regular or multiply-linked files. Registry limits
are 1024 plugin IDs and 256 records per ID; known directory enumeration is bounded to
256 entries. Existing skill reads retain 1 MiB limits and traversal bounds. New synced
and plugin scans reject symlinks. Source errors emit fixed codes/messages without raw
content or paths; ordinary local discovery JSON still exposes the existing descriptor
paths/descriptions by design. Provider requests and advisory never receive the new
state, installation paths, account directory names, plugin versions or full bodies.

`discover` adds optional summary/origin counts without removing JSON fields; doctor
reports counts and safe diagnostics. Discovery diagnostics yield WARN in doctor, not
proof of host/UI parity. Existing Route Trace v1 and analytics shapes are unchanged.
Fingerprints add logical identity as described above; historical per-skill analytics
still groups by name/agent/scope/contentHash and cannot reconstruct namespaces from
old trace snapshots.

This is a filesystem snapshot, not a native session catalog API. Active login/account,
MDM/server policy, session flags, worktree-main-checkout local settings, additional-dir
runtime loads, nested lazy skills, bundled commands, legacy commands, plugin seed/cloud
state, and skills-directory plugin trust are not inferred. Unknown registry versions,
ambiguous cached accounts/installations and unsafe sources have conservative diagnostics.
See [PR8 validation](PR8_VALIDATION.md) for official sources, tested assumptions,
known host differences and reproducible checks.

## PR9 — Claude native Skill tool observability

`src/observability/claude-skill-hook.ts` is a separate local-only runtime. The
`hook claude-skill` entrypoint shares only the bounded stdin reader and silent
4-second process deadline with routing hooks. It reads `tool_input.skill` for
PreToolUse/PostToolUse/PostToolUseFailure whose `tool_name` is exactly `Skill`.
Unknown fields are discarded, not spread; args, error, responses, transcripts,
paths, API credentials and prompt text never enter the event projection. No
provider is constructed and no Claude subprocess/transcript is used. The parser
requires session/tool IDs and absolute cwd for catalog discovery; prompt ID is
optional. Optional finite nonnegative `duration_ms` is projected only on terminal
events; `is_interrupt` only on failures. Subagent ID presence becomes a boolean
kind, not an ID or routing request.

`invocation-types.ts` and `schemas/skill-invocation.schema.json` define a strict
v1 event contract, separately from RouteTrace. The observer resolves native names
by exact match against adapter-derived identifiers in the current catalog. It
never resolves a display-name alias or guesses precedence. An absent/ambiguous
match records `resolved: false` plus a fixed diagnostic code. A discovery exception
still permits an unresolved event. Resolving an observed call is independent of
model-routability: the event reports what the host emitted, not permission advice.

Correlations use the same installation key as route records:

- session: HMAC-SHA256 over `session\0claude-code\0<session_id>`;
- prompt: HMAC-SHA256 over `host-prompt\0claude-code\0<prompt_id>`;
- tool: HMAC-SHA256 over `tool-use\0` plus the JSON tuple
  `["claude-code", session_id, tool_use_id]` (unambiguous tuple boundaries).

`invocations.jsonl` has a fixed data-directory-relative location. Observer config
is user-only, even with `hook.trustProjectConfig: true`. Its append sink validates
schema and limits each UTF-8 record to 16 KiB, then performs one O_APPEND write.
It rejects key/route-file aliases, symlinks, hardlinks and unsafe POSIX ownership
or permissions; parent directories/files use 0700/0600. Key health is checked
before persistence. Failure is silent and never changes tool permission or context.
The shared generic private JSONL reader preserves the trace reader's 2 MiB line
bound, snapshot size, UTF-8 validation and corrupt-line isolation. Route writes
also reject the invocation destination. No stream is rewritten.

Registration mutation generalizes the existing AST editor to four Claude events
and still makes one atomic config replacement/first backup under the existing
lock. Exact command + event + `Skill` matcher identifies an observer; modified
matchers/conditional handlers are refused for install. Observers are always async,
while UserPromptSubmit keeps its existing user-owned sync/advisory or async/shadow
semantics. Missing observers do not disable an otherwise ready advisory hook.
Status adds per-event observer state and `skill_invocation_telemetry_incomplete`;
doctor adds an independent readiness check. Its PASS means safe local registration
and storage prerequisites, not host delivery, trust or active-session policy.

RouteTrace v1 gains optional `capabilities.skillInvocationTelemetry: true` and
optional decision `catalogIdentity` (existing adapter-owned path-free digest).
Legacy records remain valid. A capability is emitted only on Claude routes with
a prompt ID, checked observer registrations and user-authorized safe storage.
This is a cohort marker, not a delivery guarantee. It contains no raw native IDs
or tool payloads. Existing recommended/selected and emitted/injected meanings are
unchanged; routing traces are immutable.

`invocation-analytics.ts` reads the event stream incrementally and indexes sanitized
lifecycle state by session/tool keys, independent of physical append order. It
deduplicates tool+phase using timestamp, event UUID and canonical record ordering.
Contradictory identifiers/prompt IDs or both success and failure are unknown and
excluded from conversion credit. A post event lacking prompt ID may complete an
attempt with the same session/tool ID; an attempt without prompt ID never gets
route conversion credit. Attempted-only means terminal outcome not observed.
No completion is inferred from timeouts or permission denial.

The advisory funnel uses observer-capable Claude advisory route × catalog identity
× content hash pairs. It matches exact session/prompt and resolved main-context
attempts. Repeated calls of one skill count once per route pair. Independent calls
of a non-injected recommendation remain model-invoked recommendations, but only
injected-and-invoked pairs contribute to the injection conversion numerator.
Success requires that an eligible attempt's tool lifecycle has a success event.
Subagent events are shown with their kind but excluded from main-turn adoption.
Old/no-marker/no-prompt/unreadable-storage cohorts are unavailable, never negative
examples. Undefined ratios are null. Per-skill JSON counts are deterministically
ordered. Stream health is global; routing filters choose conversion cohorts.

The index stores only lifecycle state, not all JSONL bytes or prompt bodies.
Memory still grows with unique tool calls and skill versions; bounded-memory
external joins/persistent indexes are future work. Async delivery is best effort;
missing records can undercount adoption. Claude direct `/skillname` follows
UserPromptExpansion and is deliberately outside this model-adoption funnel.
Skill tool completion does not establish task success, adherence or output quality.

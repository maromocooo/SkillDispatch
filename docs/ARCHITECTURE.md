# Architecture

## Implemented PR4 boundary

The shipped implementation is a single `skilldispatch` package with separate ESM
library and CLI entry points. Discovery, Jev/mock routing, routing evaluation,
shadow hooks and local traces are active. Advisory/enforce behavior is deferred.

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
       -> telemetry/trace -> privacy + fingerprint -> JsonlTraceSink
```

`RouterProvider.judge` is the provider contract. Every eligible candidate must be
accounted for as one independent probability or an explicitly failed evaluation.
The coordinator removes disabled skills before crossing that boundary and
validates coverage/completeness before applying policy to successful decisions.
Malformed results fail open; valid partial results preserve successes. An overall
timeout uses an abort signal; Jev cancels in-flight requests through its safe
transport and stops scheduling additional chunks.

Discovery normalizes canonical paths, hashes agent/path identity independently
of content, and retains same-name skills. Duplicate-name diagnostics group by
agent and whitespace-normalized name (case-sensitive), not name alone. Skills
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
Telemetry configuration is hook-only; no mode option or context-injection path
is accepted. Shared composition selects the same provider/policy for all commands.

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
objects into `{agent, cwd, prompt, sessionId, turnId?, model?}`. Zod object parsers
check required fields and known optional types, then strip unknown extensions.
Codex requires session/turn/model, accepts a null transcript path, and discards
agent_id/agent_type. Claude requires session/transcript/CWD/permission/event/prompt,
validates current optional prompt_id/scratchpad/agent/effort fields, and discards
them. Its prompt_id is not a turn identifier; no model or turn is invented.
Neither adapter reads a transcript or passes its path to the runtime.

`hooks/stdin.ts` reads at most 1 MiB and waits at most one second for EOF. Invalid
JSON/event/types, oversized input, stream errors and empty prompt text are silent
no-ops before any provider request. `hooks/runtime.ts` loads config/discovery
through `runtime/context.ts` using the **hook CWD**, forcing the host's single-agent
catalog regardless of `discovery.agents`. Normal CLI can still use both agents.
Disabled skills remain in counts/fingerprints but never become provider candidates.

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
seconds for startup/headroom; command hooks block while running, so shadow mode
has a latency cost despite leaving context and decisions untouched.

The result is always empty stdout, silent stderr and exit 0; no response JSON,
additionalContext, decision, reason or systemMessage is generated. Empty success
is neutral for both current hosts. Help/invalid CLI usage retain ordinary CLI
semantics; fail-open applies to supported hook invocations. This is deliberately
**shadow only**. Advisory injection will be evaluated separately per host after
shadow data is available, including Codex's reported context-placement concern.
See [PR4 validation](PR4_VALIDATION.md) for official input/output/config sources.

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
handoff draft. Readers should dispatch by schemaVersion; incompatible changes
after this release require an explicit new contract version.

The allowlist projection includes trace UUID/time, agent/shadow mode, prompt
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

Raw prompt/session/turn IDs, CWD, transcript/skill paths, directories, descriptions,
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
`session\0` + agent + `\0` + session ID, and `turn\0` + agent + `\0` + turn ID.
This separates domains and hosts while allowing same-installation correlation.
There is no invented Claude turnKey. The key is independent of API credentials.

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
trace decision's existing skill ID remains a local identity.

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
routing/storage. There is no retention manager, upload or automatic settings
mutation. Prompt hashing changes local storage only: Jev still receives the
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

# Architecture

## Implemented PR2 boundary

The shipped implementation is a single `skilldispatch` package with separate ESM
library and CLI entry points. Discovery, Jev routing and offline mock routing are active.
The sections describing hooks, telemetry and eval below are the roadmap.

```text
cli/program + commands
  -> config/load + schema
  -> discovery/codex | discovery/claude
       -> scan + parse-skill + catalog
  -> core/route -> RouterProvider (providers/types)
       -> core/policy
  -> providers/jev | providers/mock (chosen by the CLI composition root)
       -> jev/client -> @typesafe-ai/sdk (Jev only)
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
The CLI returns structured JSON with no raw prompt and no persistent writes.
The future trace schema is retained as a design artifact only.

Configuration accepts `jev` (default) or explicit `mock`. Unsupported providers
error; unknown fields warn. No hook, telemetry, or eval stub is shipped.

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

A bounded worker pool processes at most `concurrency` chunks (default 2). Results
are stored by chunk index, so completion order does not change decision or
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
catalog-specific accuracy is established. The future eval layer must measure
this before any stronger accuracy claim or alternative strategy is adopted.

## TraceSink (roadmap)

```ts
interface TraceSink {
  write(trace: RouteTrace): Promise<void>;
}
```

Trace failures are swallowed after optional debug logging.

## Planned full-runtime execution

```text
discover skills
    ↓
filter enabled/valid
    ↓
build RouteRequest
    ↓
provider.judge()
    ↓
validate completeness, ID coverage and probabilities
    ↓
applyPolicy(successful decisions)
    ↓
emit trace
    ↓
hook adapter response
```

## Failure behavior

- discovery partial failure: continue with successfully discovered skills + diagnostics;
- zero skills: return empty route immediately;
- valid partial provider response: retain successful decisions and diagnose failed IDs;
- Jev chunk timeout/network failure: retain successful chunks as partial;
- overall route timeout: fail open with no recommendations;
- malformed provider response: fail open + diagnostic;
- telemetry failure: ignore for prompt path;
- hook response serialization failure: emit minimal host-compatible success if possible.

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

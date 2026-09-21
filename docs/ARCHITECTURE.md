# Architecture

## Implemented PR1 / PR1.1 boundary

The shipped implementation is a single `skilldispatch` package with separate ESM
library and CLI entry points. Only discovery and offline mock routing are active.
The sections describing hooks, telemetry and eval below are the roadmap.

```text
cli/program + commands
  -> config/load + schema
  -> discovery/codex | discovery/claude
       -> scan + parse-skill + catalog
  -> core/route -> RouterProvider (providers/types)
       -> core/policy
  -> providers/mock (chosen by the CLI composition root)
```

`RouterProvider.judge` is the provider contract. Every eligible candidate must be
accounted for as one independent probability or an explicitly failed evaluation.
The coordinator removes disabled skills before crossing that boundary and
validates coverage/completeness before applying policy to successful decisions.
Malformed results fail open; valid partial results preserve successes. An overall
timeout uses an abort signal; future providers must cancel their own work.

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

Configuration is restricted to implemented PR1 options. Unsupported providers
error; unknown fields warn. No hook, Jev, telemetry, or eval stub is shipped.

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
`provider_failed` or `provider_timeout`. To preserve successes, a future provider
must account for failures and return valid partial output before the overall
deadline. This contract introduces no chunking, concurrency, network or telemetry.

### RoutingPolicy

Pure function:
```ts
applyPolicy(decisions, config) -> selected
```

Keep network concerns out of policy.

### TraceSink

```ts
interface TraceSink {
  write(trace: RouteTrace): Promise<void>;
}
```

Trace failures are swallowed after optional debug logging.

## Route execution

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
- Jev timeout/network failure: fail open;
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
- Keep API keys only in process environment/config mechanism; never trace them.

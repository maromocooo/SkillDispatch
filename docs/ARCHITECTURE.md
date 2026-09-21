# Architecture

## Implemented PR1 boundary

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

`RouterProvider.judge` is the provider contract. Each eligible candidate receives
one independent probability; a single-choice interface is intentionally absent.
The coordinator removes disabled skills before crossing that boundary and
validates the full response before applying the pure policy. Scores outside
0..1, missing IDs, unknown IDs and duplicate IDs fail open. Timeout uses an abort
signal and returns a diagnostic; future providers must cancel their own work.

Discovery normalizes canonical paths, hashes agent/path identity independently
of content, and retains name collisions. Host-specific fallback fields and
invocation restrictions stay in adapters. Generic parsing and traversal do not
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
```

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
normalize probabilities
    ↓
applyPolicy()
    ↓
emit trace
    ↓
hook adapter response
```

## Failure behavior

- discovery partial failure: continue with successfully discovered skills + diagnostics;
- zero skills: return empty route immediately;
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

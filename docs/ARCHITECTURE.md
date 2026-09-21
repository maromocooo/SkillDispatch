# Architecture

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

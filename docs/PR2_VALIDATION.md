# PR2 validation — Jev provider

Validated locally on 2026-09-21, macOS. Base `main` was created at PR1.1 tip
`a86a634` with explicit repository-owner authorization; PR2 work is on
`feat/pr2-jev-provider`. No PR1/PR1.1 history was rewritten.

## SDK and official API assumptions

- `npm view @typesafe-ai/sdk version` reported **0.6.0**. This exact version is
  pinned in package.json and pnpm-lock.yaml. Official SDK main was release commit
  `66880ccded6cb642dc1809620c2b108c33730214`.
- The [official JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js)
  exposes `TypeSafeClient`, `systemOne` and `noul`. The client sends
  `POST https://api.typesafe.ai/v1/systemone`; request `model` selects the model.
  The provider supplies the endpoint and log level explicitly rather than
  inheriting SDK environment overrides.
- The [Noul reference](https://docs.typesafe.ai/primitives/noul) defines structured
  instructions and optional `true`/`false` criteria. Each answer has
  `{ type: "noul", noul: number }`. SkillDispatch copies `noul` into `probability`,
  with no rounding/calibration or use of Choice confidence. Local question keys
  are mapped back to skill IDs; response order is ignored.
- The [API reference](https://docs.typesafe.ai/api) and live
  [OpenAPI schema](https://api.typesafe.ai/openapi.json) were checked. The latter's
  `SystemOneRequest.questions` has `minProperties: 1` and **no `maxProperties`**.
  Neither the public reference nor SDK question validator declares a maximum
  question count. We therefore do not invent an API count limit or claim unlimited
  questions. **48 is both the default and a local configurable ceiling** (1–48),
  chosen for conservative batches and bounded per-failure impact.
- The [model documentation](https://docs.typesafe.ai/models) instead specifies
  64k total tokens/request and 32k for state plus the longest question. Count-only
  chunking cannot guarantee fitting arbitrary long prompts/descriptions. An API
  size rejection fails that chunk safely; tokenization/adaptive packing is not
  implemented. `jev-latest` currently points to `jev-1.13.0`, but may move. We
  report the response model, not an assumed version; mixed chunk models get a
  diagnostic and no single model attribution.

The configuration nests Jev settings under `router.jev` instead of the original
handoff's top-level `router.chunkSize`. The SDK-independent PR1.1 contract is
unchanged. Candidate bodies, paths, CWD, IDs and arbitrary metadata never enter
the API payload; raw prompt and allowed descriptive fields do.

## Cancellation, retries and security

Relevant official SDK issues were reviewed and remained open at implementation:

- [#2: Node 20/22 abort can terminate the process](https://github.com/typesafe-ai/typesafe-sdk-js/issues/2).
  SDK 0.6.0 clones/drains native response streams. Cancelling during body delivery
  can leave a native Undici rejection even if the caller catches the SDK error.
- [#14: connection error can include the API key](https://github.com/typesafe-ai/typesafe-sdk-js/issues/14).
  Blank/invalid header credentials are not adequately rejected by the SDK itself.
- [#8: oversized timeout overflows Node timers](https://github.com/typesafe-ai/typesafe-sdk-js/issues/8).
  SkillDispatch rejects request timeouts outside integer 1–2,147,483,647.
- [#11: multi-label selection API discussion](https://github.com/typesafe-ai/typesafe-sdk-js/issues/11).
  Independent Noul remains our initial baseline, with no new competitive or
  calibrated multi-label claim.

The selected transport consumes the native response's single body with
`arrayBuffer()` before returning a new in-memory `Response` to the SDK. Thus its
cloning never tees the native response stream. The SDK can still abort the actual
fetch while reading headers/body. Caller signals are passed only through this
buffered transport, not through the unsafe default SDK fetch. No process-wide
`unhandledRejection` handler is installed. The regression fixture uses the **real
SDK**, loopback HTTP and child processes with `--unhandled-rejections=strict`.
It exercises healthy responses, body-phase cancellation, body timeout, header
timeout, and outer `route()` timeout; each case repeats three times and exits 0.
This verifies the selected workaround on the runtimes below, not every future
SDK/Undici release. Responses are buffered in memory, not streamed.

[SDK retry source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts)
defaults to two retries, 10-second attempts and exponential backoff. SkillDispatch
explicitly uses **0 retries**, **1800 ms per attempt**, **2500 ms overall routing**,
**48 candidates/chunk**, and **2 workers**. Retries may be configured from 0–2;
positive settings use the SDK backoff and remain cancellable by the overall
deadline. Routing should fail open quickly instead of holding up an agent prompt.
A request timeout stops new chunks; in-flight workers settle. An overall timeout
aborts requests and returns the core's existing empty fail-open result.

Credentials must be non-empty printable ASCII without whitespace/control
characters and are validated before SDK construction/network use. CLI credentials
come only from `TYPESAFE_API_KEY`; YAML keys are ignored with a value-free warning.
The SDK log level is forced to `off`, its endpoint is fixed, redirects are
rejected, and caught errors are replaced by fixed codes/messages with no cause.
Tests inject exception/HTTP bodies containing synthetic key, prompt and secret
sentinels and assert that output/JSON/stderr do not expose them. No real key is
present in source or fixtures. Data users put in allowed prompt/description fields
is not automatically redacted.

## Contract and tests

All **121 existing tests remain**, with **78 new tests: 199 total** in 14 files.
New coverage includes:

- Exact 0/0.5/1 mapping, local-key identity and reordered answers.
- Permitted candidate fields versus path/body/CWD/metadata/key exclusion.
- Empty/single/exact-boundary/overflow/multiple chunks and catalog-order stability.
- Concurrency 1/2 bounds, invalid options, complete and all/partially failed results.
- Malformed API response fields/keys/scores becoming failed chunks, successful
  policy application, deterministic diagnostics despite completion order.
- Cancellation, stopping queued work, SDK and outer route timeout fail-open.
- Model disagreement, API key validation, log/error sanitization, explicit retry
  count and no-retry default, Jev config merging, CLI provider/model output.
- Real SDK runtime safety in child processes, including no subsequent requests
  after the outer route deadline.

| Check | Node 20.20.2 / Undici 6.24.1 | Node 24.12.0 / Undici 7.16.0 |
| --- | --- | --- |
| `pnpm test` | 199 passed | 199 passed |
| `pnpm typecheck` | passed | passed |
| `pnpm lint` | passed | passed |
| `pnpm build` | passed | passed |
| SDK strict child-process regressions | 5 cases passed | 5 cases passed |
| Installed public CLI/library smoke | passed | passed |

Normal tests use fake calls/fetch or loopback HTTP only, never the external
TypeSafe API. The local sandbox initially denied loopback listening (`EPERM`);
the runtime tests were rerun with local-socket access, without weakening tests.
Formatting failures during development were fixed before commits.

## Package and live validation

`pnpm pack --pack-destination /tmp/skilldispatch-pr2-package` succeeded. The
tarball was installed offline into a separate temporary directory using pnpm's
cached dependencies. Both Node versions passed installed `skilldispatch --help`,
`--version`, fixture `discover --agent claude-code --json`, explicit mock `route`
in text/JSON, missing/malformed Jev credential errors and the public
`JevRouterProvider` export with an injected call. The mock fixture selected
react-patterns at 0.95 and frontend-testing at 0.91. These are fixture scores,
not measured Jev accuracy.

`pnpm test:jev-live` was invoked and **safely skipped**: this environment has no
`TYPESAFE_API_KEY`. No live Jev routing request was sent. From a source checkout,
that explicit command with a key sends a small synthetic request and verifies
three valid independent decisions, printing neither prompt nor key. It is not
part of normal tests or automatic CI.

## Known limitations and next-stage readiness

- No implementation-contract blocker remains. A live authenticated smoke call
  remains unverified; run the opt-in command with credentials before deployment.
- Independent Noul can rate overlapping or overly broad skills highly together.
  Thresholds are not globally calibrated and routing accuracy has not been
  evaluated, including Japanese/mixed-language catalogs. Future eval work must
  establish quality before alternate strategies or stronger claims.
- No token-aware packing, adaptive retry, persistent connection strategy, custom
  endpoint configuration or response streaming. Large requests may fail safely.
- SDK #2/#14 remain upstream issues; keep the transport/security regressions and
  re-check them before SDK upgrades. Node 22 was not separately exercised.
- Hooks, telemetry/JSONL, eval runner and Studio remain out of scope.

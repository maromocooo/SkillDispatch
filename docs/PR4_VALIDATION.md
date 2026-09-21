# PR4 validation — Shadow hooks and local routing traces

Validated on 2026-09-21–22 (JST), macOS. Base main:
`0ffbd9c13aad6b3aac8be04a518f37f727a5b136`. Implementation branch:
`feat/pr4-shadow-hooks-traces`. The SDK remains exactly `@typesafe-ai/sdk@0.6.0`;
its transport, independent-Noul policy and concurrency ceiling are unchanged.

## PR3 integration

Fetched/pruned origin, verified a clean synchronized working tree, and checked
that main was an ancestor of the PR3 branch. The entire reviewed branch difference
was `aa61d8a`, `6149955`, `35a2429`, `cb577b5`, `5fed47c`, `0ffbd9c`.
`git pull --ff-only origin main` followed by
`git merge --ff-only origin/feat/pr3-routing-eval` advanced main without a merge
commit. All existing **283 tests**, typecheck, lint and build passed on Node 20
before the ordinary main push.

After push/fetch, main and origin/main matched the full base SHA above. Remote
`feat/pr3-routing-eval` was deleted with ordinary `git push origin --delete`;
its local branch was deleted with `git branch -d`. PR4 was created from main.
No new implementation was committed on main, and no force push, rebase, amend,
reset or history rewrite was used.

## Current host specifications reviewed

Official documentation/source was inspected before adapter implementation:

- [Codex hook documentation](https://learn.chatgpt.com/docs/hooks).
- [Codex input schema](https://github.com/openai/codex/blob/40eeb6e8a89ef421c25d4c40e06fa1d40ce66b4f/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json)
  and [output schema](https://github.com/openai/codex/blob/40eeb6e8a89ef421c25d4c40e06fa1d40ce66b4f/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json),
  pinned to the inspected upstream main revision
  `40eeb6e8a89ef421c25d4c40e06fa1d40ce66b4f`.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), especially
  common input, UserPromptSubmit, output handling, configuration and timeouts.
- Open Codex reports [#40680](https://github.com/openai/codex/issues/40680)
  (context placement/salience) and [#41128](https://github.com/openai/codex/issues/41128)
  (structured attachments omitted from hook text).

| Host | Input handled | Neutral output / setup |
| --- | --- | --- |
| Codex | Required session_id, turn_id, cwd, hook_event_name, model, permission_mode, prompt, transcript_path (string or null); optional agent_id/agent_type | Exit 0, no output. User/project hooks.json; trust review applies. Timeout is seconds. |
| Claude Code | Required session_id, cwd, hook_event_name, permission_mode, prompt, transcript_path; optional prompt_id, scratchpad_dir, agent_id/agent_type, effort.level | Exit 0, no output. User/project settings.json. Timeout is seconds; this synchronous event blocks model processing. |

The handoff's conceptual shared host shape is not copied into core. Current
Claude optional `prompt_id` is validated but discarded, not invented as a turn
ID. UserPromptSubmit supplies no current model/turn_id there. Codex supplies both.
Unknown future fields are ignored rather than rejected; known field types and
required fields are checked. Permission mode strings tolerate future values.
Transcript paths are dropped by adapters and are never read or persisted.

Current Codex output can add developer context; Claude can also consume plain
stdout as context. SkillDispatch prints neither text nor JSON and returns no
additionalContext/decision/reason/systemMessage. Advisory injection is deferred
for **both** hosts pending separate host-specific evaluation. The reported Codex
placement issue is not treated as proof about every host/version.

Codex currently omits structured image/attachment items from this hook payload.
Only supplied text is routed; blank or whitespace-only text is a no-op. No image,
transcript or session-file scraping fills gaps for either host. No actual skill
invocation, adherence or downstream quality is observed.

## Contract and privacy

The never-emitted draft was replaced by **Route Trace schemaVersion `1.0`**.
Strict objects reject unknown properties. The shipped draft-2020-12 JSON Schema
is generated from the runtime Zod schema, compared structurally in tests, and
used by dev-only Ajv to validate actual JSONL events. `RouteTrace`, `TraceSink`,
`routeTraceSchema`, `catalogFingerprint` and `JsonlTraceSink` are public exports;
wire adapters/runtime and key-management helpers remain internal.

Default `telemetry.enabled` is true and `telemetry.prompt` is **hash**. Only hook
commands persist. `none` contains no prompt hash/raw; `raw` is explicit opt-in and
stores the full prompt locally. Defaults never store raw prompts or raw host IDs.
HMAC-SHA256 uses a cryptographically random 32-byte installation key, with domains:

- `prompt\0` + exact prompt;
- `session\0` + host agent + `\0` + session ID;
- `turn\0` + host agent + `\0` + turn ID (only when supplied).

This allows same-installation correlation while separating domains/hosts. It is
not an unsalted prompt digest, and never reuses TypeSafe credentials. Changing
installation keys intentionally breaks correlation. Keys must not accompany
shared traces. Prompt hashing affects local storage only; normal Jev requests
still transmit the prompt and allowed skill descriptions to TypeSafe.

The key lives at `<dataDir>/install.key`. Data-dir precedence is absolute
`SKILLDISPATCH_DATA_DIR`, absolute `XDG_DATA_HOME` + `/skilldispatch`, then
`~/.local/share/skilldispatch`. New POSIX directories/files use 0700/0600. Existing
unsafe permissions or ownership, symlink leaf/file destinations and corrupt
keys are rejected without chmod/overwrite. Creation writes a private temporary
key completely before an exclusive hard-link publication; concurrent creators
reuse the winner. Twelve simultaneous child processes verified the same key.

Trace default: `<dataDir>/traces.jsonl`; optional `telemetry.tracePath` must be
absolute or `~/`-relative and cannot name the reserved installation key. Each
event is validated, serialized to one JSON line and appended in one O_APPEND
write. Files must be private, regular and have a single link. Sequential and
cross-process concurrent appends were verified on the local filesystem.

Catalog fingerprint is SHA-256 over UTF-8 JSON of sorted serialized tuples:
`[agent, scope, whitespaceNormalizedName, contentHash, enabled]`. Ordering uses
locale-independent `compareText`, case is preserved, and multiplicity is retained.
IDs and paths are excluded. Order/path-only changes preserve it; content/enabled
changes affect it. Decision IDs themselves remain path-derived local identities.

Trace projection excludes CWD, skill/transcript paths, directories, descriptions,
bodies, arbitrary metadata, raw SDK errors, diagnostic messages/stacks and env
values. Diagnostics retain code/level/known skill IDs only. Optional model/code
formats are bounded; allowed metadata fields are not a universal secret detector.
`selected` is solely SkillDispatch's policy recommendation, never host invocation.

## Failure behavior and budgets

- `complete`: valid complete routing, including no eligible candidates.
- `partial`: valid provider partial, retaining successful scored decisions.
  `provider_partial.skillIds` lists unevaluated skills. All-failed partial remains
  partial with an empty decisions array; no fabricated zeros are added.
- `failed`: provider exception, overall timeout, malformed response, provider
  setup failure (including missing credentials), or unexpected route failure.
  Failure diagnostics are fixed safe codes. Setup failures report latency 0.
- Trace initialization/config/discovery failure can leave no event; sink failure
  is swallowed. Hook commands still exit 0 with empty stdout/stderr.
- Unsupported CLI usage/help retain normal CLI semantics. Ordinary route/eval
  setup errors remain nonzero, and neither command gains persistence.

stdin is bounded to **1 MiB and 1 second**. Malformed/oversized/wrong-event input
never reaches a provider. Shared composition uses hook CWD and exactly that
host's catalog, overriding a cross-agent discovery setting. `telemetry.enabled:
false` skips hook routing/storage.

Default route timeout stays **2500 ms**. The dedicated hook CLI has a **4-second
process ceiling** for setup/routing/storage; completion also exits explicitly
so outstanding work cannot hold up the host. Library users get no process-global
handlers or exit behavior. A **5-second host timeout** is recommended. Current
Codex default is 600 seconds for this event; Claude's is 30 seconds. Both are too
long for this intended prompt-path use. A hard cutoff may prevent trace emission.

## Validation results

All 283 pre-PR4 tests are retained, with **104 additional tests: 387 in 27 files**.
The old unsupported-hook CLI test now rejects an unsupported host; valid hook
commands have dedicated coverage.

| Check | Node 20.20.2 | Node 24.12.0 |
| --- | --- | --- |
| `pnpm test` | 387 passed | 387 passed |
| `pnpm typecheck` | passed | passed |
| `pnpm lint` | passed, no warnings | passed, no warnings |
| `pnpm build` | passed | passed |
| `pnpm pack` including build lifecycle | passed | passed |
| SDK loopback strict child-process regression | 5 cases passed | 5 cases passed |
| New shadow strict child-process tests | 5 passed | 5 passed |
| Installed public CLI and trace smoke | passed | passed |

pnpm 10.17.1. Tarballs were packed to `/tmp/skilldispatch-pr4-final-node20` and
`/tmp/skilldispatch-pr4-final-node24`. The Node 20 artifact was installed offline
into `/tmp/skilldispatch-pr4-install` with cached production dependencies, then
its public executable was exercised under both runtimes, outside the checkout.
No dev-only Ajv dependency is required by the installed runtime.

Installed smoke covered:

- `--help`, `hook --help`, `discover` and `route` text/JSON, and `eval` text/JSON
  with passing gates against synthetic skills/scores.
- Both installed hook commands receiving current fixture shapes on stdin,
  writing version-1 JSONL, filtering by host and exiting 0 without output.
- Actual directory/file permissions, key length, same-prompt correlation,
  cross-host session separation and absent Claude model/turn keys.
- Missing credentials -> failed trace with `provider_setup_failed`, still empty
  success for hooks; ordinary route/eval still exit 1.
- Invalid JSON, oversized/wrong-event input and invalid config -> empty success.
- Prompt/path/transcript/description/body/error sentinels absent from default
  JSONL. No route/eval/discover persistence even with telemetry enabled.
- Shipped JSON Schema version, strictness and public telemetry exports.

Unit/fixture coverage additionally includes all prompt modes, different keys,
domain separation, fingerprint sensitivity/order/multiplicity, schema drift,
known/unknown input fields, no transcript reads, hook CWD, successful partials,
all-failed partials, exceptions/timeouts/malformed output, fake SDK secret-bearing
errors, corrupt key/unsafe destination behavior, reserved-key path and parent-alias protection,
unexpected runtime exceptions and throwing sinks. Stalled stdin is tested in
the production CLI entry. Twelve concurrent child processes produce twelve
parseable lines with one shared installation key and distinct trace IDs.

Normal tests use temporary homes/catalogs and fake calls/fetch. Existing SDK
transport tests use **local loopback only** with explicit socket permission.
Installed CLI smoke uses temporary project skills, explicit mock config, a
separate data directory, an isolated Claude personal directory and a child env
without API credentials; Codex may also discover native user/admin catalog roots.
No host settings were changed and no real Codex/Claude session was launched.
**No live Jev call was performed in PR4.** No external TypeSafe API request is
made by tests/CI/prepack; official documentation/GitHub checks used network access.

## Limitations and PR5 readiness

- No PR4 implementation blocker remains. These are fixture/package checks, not
  an end-to-end certification of every installed host version or platform.
- Before advisory work: inspect real shadow observations, review per-host
  placement/salience behavior, and separately measure whether injection helps.
  No injection path or new routing algorithm is included here.
- Independent Noul quality and thresholds remain uncalibrated. Shadow selections
  do not demonstrate host invocation, compliance, output quality or causality.
- Text-only visibility and existing discovery/plugin/trust limitations remain.
  Claude prompt-level IDs are intentionally not added to this first contract.
- JSONL is best effort, not an audit-grade durable log: disk failure, short write,
  process exit or hard timeout can drop an event or leave a partial trailing line.
  There is no rotation/retention manager; consumers must tolerate incomplete tails.
- Local POSIX filesystem behavior was tested on macOS. Windows ACLs, network
  filesystems and Node 22 were not separately validated. Filesystems without the
  needed exclusive-link/append behavior may safely produce no traces.
- Hashes/metadata are pseudonymous local observations, not anonymous data. Do not
  distribute the key with traces; review names and raw-mode content before sharing.

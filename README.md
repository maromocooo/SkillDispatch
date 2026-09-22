# SkillDispatch

**Observable skill routing for coding agents.**

Your coding agent may have dozens of skills. SkillDispatch routes each prompt to
zero or more relevant skills and shows what was recommended, injected, and observed
being invoked. It is a universal routing runtime with agent adapters and replaceable
providers; Jev is the first real provider.

**v0.1.0 release candidate — npm publication is pending.** Use the source/tarball
installation below until the first release. Node.js 20+; MIT licensed.

- Claude Code and Codex catalog discovery, including Claude synced/enabled plugin skills
- Independent multi-skill Jev routing; mock provider for offline development
- Shadow by default; Claude same-turn advisory through explicit user opt-in
- Routing evals, offline doctor, private local JSONL traces and CLI analytics
- Recommended → injected → **observed** model invocation → **observed** success

## Why SkillDispatch?

As catalogs grow, broad descriptions overlap and skill selection gets harder to
inspect. SkillDispatch separates discovery, routing policy, host delivery and
observation so you can test descriptions and inspect behavior. It does not replace
native skill invocation or require a dashboard, account, database or Studio.

## How it works

```mermaid
flowchart TD
  P[User prompt] --> H[Host hook]
  H --> C[Agent skill catalog]
  C --> J[Jev independent skill judgments]
  J --> R[Threshold and max-skills policy]
  R --> S[Shadow: no context change]
  R --> A[Claude advisory: safe native identifiers]
  P --> G[Coding agent]
  A --> G
  R --> T[Local routing traces]
  G --> O[Claude Skill tool observers]
  O --> I[Local invocation events]
  T --> V[CLI analytics]
  I --> V
```

Shadow routing and invocation observers run asynchronously. Claude advisory waits
for routing to supply a recommendation to the current turn. No skill body is injected.

## Quick Start

**Available now: install the release candidate from source.** Install Node.js 20+
and pnpm 10.17.1 first, then:

```sh
git clone https://github.com/maromocooo/SkillDispatch.git
cd SkillDispatch
pnpm install --frozen-lockfile
pnpm build
pnpm pack
npm install --global ./skilldispatch-0.1.0.tgz
```

After npm publication, the equivalent installation will be:

```sh
npm install --global skilldispatch
```

For real routing, obtain a TypeSafe API key and make it available to the shell that
launches your coding agent. The command below contains a placeholder, not a key:

```sh
export TYPESAFE_API_KEY='<your-key>'
skilldispatch doctor
skilldispatch hooks install claude --dry-run
skilldispatch hooks install claude
# Optional: register Codex shadow too.
skilldispatch hooks install codex
skilldispatch hooks status
```

These install **user-level** hooks. Shadow is the default: no context is injected.
Claude also gets local-only async Skill observers. Restart/reload the hosts and
review/trust Codex hooks when requested. A GUI host must inherit the API key too;
`doctor` in your shell cannot verify the GUI's environment or authenticate the key.
Use the agents normally, then:

```sh
skilldispatch traces summary --since 24h
skilldispatch traces list --limit 20
skilldispatch traces show <trace-id>
```

No key yet? `doctor`, discovery and analytics work offline. Missing Jev credentials
produce a routing-readiness warning; no silent fallback to mock occurs. Try the
[offline mock demo](#offline-demo) without installing any hooks.

To remove only SkillDispatch's host registrations:

```sh
skilldispatch hooks uninstall claude
skilldispatch hooks uninstall codex
npm uninstall --global skilldispatch
```

Unregister before removing the package. Existing local traces and installation key
are retained; uninstall never restores a whole host config from backup.

## Supported agents

| Capability | Claude Code | Codex |
|---|---|---|
| Local/project skills | Yes | Yes |
| Synced and enabled plugin skills | Yes, local state snapshot | Not supported |
| File-managed skills | Read-only where documented | Configured admin/system sources |
| Shadow routing | Async by default | Async only |
| Advisory | Explicit opt-in, synchronous | Not yet |
| Observed model Skill invocation | Async Pre/Post/Failure observers | Not yet |

Discovery is a conservative local snapshot, not the host's private session catalog.
Bundled, lazy/nested, extra-directory and session-only sources are not fully covered.
See [coverage and precedence](docs/OPERATIONS.md#discovery-behavior-and-current-host-differences).

## Shadow vs advisory

Shadow records recommendations without changing agent context. To opt into Claude
advisory, merge this into **your user config** at `~/.config/skilldispatch/config.yaml`:

```yaml
hook:
  modes:
    claude: advisory
    codex: shadow
```

Then reconcile the existing registration:

```sh
skilldispatch hooks install claude
skilldispatch hooks status claude
skilldispatch doctor
```

Claude advisory is synchronous and adds routing latency to prompt processing. The
2500 ms overall routing budget is unchanged; degraded/empty routing injects nothing.
Only safe, unambiguous, model-invocable native skill identifiers enter
`hookSpecificOutput.additionalContext`. Claude decides whether to invoke them using
its native Skill tool. Returning the mode to `shadow` and reinstalling restores async.
Changing configuration alone does not silently mutate host registrations.

Codex remains shadow-only. Codex inline `[hooks]` conflicts are refused instead of
rewriting `config.toml`; see the [manual setup alternative](docs/OPERATIONS.md#manual-alternative-and-codex-inline-conflict).

## Example and offline demo

A maintainer-reported Claude dogfood run with the intent “prepare an issue ticket”
observed `jira-ticket` recommended and injected, followed by attempted → succeeded:

```text
Recommended              1
Injected                 1
Observed model-invoked   1
Observed succeeded       1
```

This is an anecdote, not a benchmark or a 100% conversion claim. No private prompt,
project identifier or company workflow is reproduced here.

### Offline demo

From the built checkout, run:

```sh
node examples/demo/run.mjs
```

It uses four synthetic skills, temporary configuration and the real CLI with fixed
mock scores: React 0.96, frontend tests 0.91, accessibility 0.87. **Mock demo, not Jev
accuracy.** It needs no key, reads no real-home skills and registers no hooks.

## Observability

`recommended != injected != observed model-invoked != observed succeeded`.

Invocation observers provide **positive evidence only**. Missing async events do
not prove that Claude skipped a skill; attempted-only means unknown terminal
outcome. Observer configuration is not delivery or complete turn coverage. Exact
injection-to-invocation and success conversion rates are intentionally absent.
Direct user `/skillname` commands are outside model-adoption metrics. Success means
native tool completion, not task quality or adherence to instructions.

Default files: `~/.local/share/skilldispatch/traces.jsonl` and `invocations.jsonl`.
`SKILLDISPATCH_DATA_DIR` / `XDG_DATA_HOME` can relocate storage. Summary reports
latencies, failures, selected skill versions and observed adoption; “never selected”
means seen in decisions but never selected, not every skill installed on your machine.
All trace commands support `--json` and never print raw prompts or correlation keys.
[Detailed semantics](docs/OPERATIONS.md#claude-model-skill-invocation-telemetry).

## Routing evals and public benchmark

```sh
skilldispatch eval evals/example.yaml --json
skilldispatch eval my-evals.yaml --min-recall 0.90 --min-precision 0.90
```

Selectors must match your discovered catalog exactly. Partial labels use labeled
precision: unlabeled selections are not false positives. `fully_labeled: true`
marks every other available skill negative and enables exact-set accuracy. Metrics
without a denominator are `null`; gates fail for missing/below-minimum metrics.
Provider failures stay in quality metrics and have separate reliability counts.

The [public synthetic benchmark](benchmarks/public-routing-v1/README.md) has
**24 skills and 100 fixed cases** in English, Japanese and mixed language. Labels
are AI-assisted drafts awaiting maintainer review. From the built checkout:

```sh
node scripts/public-benchmark.mjs --mock --json
# Manual opt-in only; requires TYPESAFE_API_KEY and makes paid routing requests.
node scripts/public-benchmark.mjs --live --json
```

The runner excludes real user skills/config. CI validates syntax and mock execution
only. No measured Jev score or superiority over native Claude routing is claimed.
Independent Noul is a multi-label baseline; overlapping/broad skills can all score
high, and thresholds are not universally calibrated.

## Privacy and security

- TypeSafe receives the prompt plus minimal skill name/description/agent/scope for
  routing. No skill bodies, paths, cwd or arbitrary metadata are sent.
- Prompts are stored locally as installation-key HMACs by default; raw persistence
  requires explicit opt-in. `prompt: none` also exists.
- SkillDispatch **does not upload local traces or invocation telemetry**. Its
  application API traffic is routing requests to TypeSafe, not cloud analytics.
- Invocation events contain native identifiers and keyed correlation metadata,
  never args, tool responses, raw host IDs, error strings or transcripts.
- Global hooks ignore project SkillDispatch config by default. Even trusted project
  config cannot enable advisory; execution mode is always user-owned.
- Files use private permissions and symlink/hardlink protections. Hooks fail open.
  No guarantee is made against a compromised OS or a process running as your user.

Read the [security model](docs/SECURITY_MODEL.md) and [vulnerability reporting policy](SECURITY.md).
Do not paste credentials, raw prompts or full host settings into issues. Discovery
JSON is a local inspection view and can contain skill paths; redact it before sharing.

## Configuration and CLI

Defaults: Jev, threshold 0.75, maxSkills 4, chunks 48, concurrency 2 (local ceiling
8), request timeout 1800 ms, overall timeout 2500 ms, retries 0, both modes shadow.
Config and examples: [reference](docs/OPERATIONS.md#configuration),
[complete example](examples/skilldispatch.config.yaml).

| Command | Purpose |
|---|---|
| `discover [--agent claude-code]` | Catalog and source diagnostics |
| `route "prompt" [--json]` | One prompt through configured routing policy |
| `eval file.yaml [--json]` | Labeled routing quality and optional CI gates |
| `hook codex`, `hook claude`, `hook claude-skill` | Host stdin entrypoints |
| `hooks status/install/uninstall` | Safe user-scope registration management |
| `doctor [--json]` | Offline installation, routing and observer prerequisites |
| `traces summary/list/show` | Privacy-safe local analytics |

`doctor` exit 0 means the installation is usable, not authenticated or fully
observed. Read `routing_ready`, `advisory_ready` and observer readiness separately.
WARN-only returns 0; installation/config problems return 1. Use `--help` per command.
Registration status can expose the path to SkillDispatch itself; redact home paths
before sharing. Installers preserve unrelated hooks/settings and keep the first
private backup; custom host locations may require manual setup.

## Architecture, limitations and roadmap

The [architecture](docs/ARCHITECTURE.md) keeps host discovery/adapters and Jev SDK
outside the core `RouterProvider` contract. Existing library exports are retained;
CLI usage is the primary public workflow. Source is tracked; `dist` is built for
every package and excluded from Git.

Async hooks are best effort and may be lost at host teardown. Host updates, policy,
trust and session-only configuration can differ from local inspection. Advisory
adds latency and is only a recommendation. Native catalog completeness and routing
accuracy are not guaranteed. There is no delivery witness, cloud sync, automatic
threshold tuning or trace retention daemon.

Future work, not included in this release: Codex advisory/observers, subagent-aware
routing, richer evals, local/non-Jev providers and optional Studio integration.

## Contributing and release

See [CONTRIBUTING](CONTRIBUTING.md), the [release checklist](docs/RELEASE_CHECKLIST.md)
and [launch drafts](docs/LAUNCH.md). Normal tests/CI never call TypeSafe. Please bring
sanitized edge cases, especially catalog mismatches and overlapping descriptions.

[MIT License](LICENSE). Runtime dependency license details are recorded in
[THIRD_PARTY](docs/THIRD_PARTY.md).

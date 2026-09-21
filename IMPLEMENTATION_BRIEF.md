# SkillDispatch — implementation handoff

Status: implementation-ready
Date: 2026-09-21
Target: local Codex
Project name: **SkillDispatch**

---

## 1. Why this exists

Coding agents such as Claude Code and Codex support reusable skills and can implicitly choose them from a user prompt. As skill libraries grow, three separate problems appear:

1. **Discovery/routing reliability** — a relevant skill may not be selected, especially when descriptions overlap or the initial skill catalog is constrained.
2. **Observability** — users cannot easily answer “what did the router think should run?” and compare that with native agent behavior.
3. **Evaluation/maintenance** — routing behavior can regress when a skill description changes or when many similar skills are added.

The commercial/product hypothesis is **Agent Skill Studio**: a GUI for skill lifecycle management, routing observability, evals, versions, improvement and cross-agent analytics.

This repository is deliberately narrower. It is the open-source wedge and runtime:

> **Universal, observable skill routing for coding agents.**

The runtime must stand on its own and must not require Agent Skill Studio.

---

## 2. Positioning

Do not position this as:

> “Jev chooses a skill.”

That is already too easy to reproduce and overlaps with emerging projects.

Position it as:

> **A cross-agent skill-routing runtime and trace protocol. Jev is the default fast decision backend.**

Differentiators:

- multi-skill routing, not only one-of-N routing;
- multiple coding-agent adapters;
- common skill metadata model;
- `shadow` mode to measure before changing agent behavior;
- stable routing trace schema;
- repeatable routing evals;
- backend-agnostic router interface;
- natural upstream integration with Agent Skill Studio.

---

## 3. v0.1 scope

### In scope

- TypeScript CLI/library on Node.js 20+.
- Discover local `SKILL.md` files for:
  - Codex
  - Claude Code
- Normalize them into a common `SkillDescriptor`.
- Route a prompt to **zero, one, or multiple** skills.
- Jev provider using independent decisions for overlapping labels.
- Configurable:
  - minimum probability,
  - maximum selected skills,
  - chunk size,
  - timeouts,
  - routing mode.
- Hook adapters:
  - Codex `UserPromptSubmit`
  - Claude Code `UserPromptSubmit`
- Modes:
  - `shadow`: calculate + trace only; do not alter host context.
  - `advisory`: calculate + add concise recommended-skill context.
  - reserve `enforce` in config/schema but do not promise it in v0.1.
- Local JSONL traces.
- CLI eval runner.
- Offline deterministic mock provider for tests.

### Explicitly out of scope for v0.1

- Agent Skill Studio GUI.
- Cloud account/team management.
- Skill syncing/distribution.
- Automatic skill rewriting.
- Embedding index / vector database.
- “Actual invocation” telemetry based on fragile transcript scraping.
- Automatic mutation of skill files.
- A claim that Jev is always superior to native routing.
- Arbitrary agent/tool routing beyond skills.

---

## 4. Current integration facts to build against

Verify these again during implementation because coding-agent interfaces evolve.

### Codex

Current Codex documentation exposes `UserPromptSubmit`.

Input includes at least:
- `prompt`
- `cwd`
- `session_id`
- `turn_id`
- `model`
- `permission_mode`
- `transcript_path`

A successful hook may return `hookSpecificOutput.additionalContext`, which is added as developer context before the model handles the turn.

Codex currently discovers skills from `.agents/skills` while walking from CWD toward repository root, from `$HOME/.agents/skills`, and from additional admin/system scopes. Current official docs should remain the source of truth during implementation.

### Claude Code

Claude Code also exposes `UserPromptSubmit`, firing after the user submits a prompt and before Claude processes it.

Project skills live under `.claude/skills/<name>/SKILL.md`; user/global skills live under `~/.claude/skills/...` (or the configured Claude config directory).

### Jev

Use the official TypeSafe JavaScript/TypeScript SDK (`@typesafe-ai/sdk`).

Core design:
- user prompt/project context belongs in shared request state;
- each candidate skill receives an independent yes/no style judgment when skills can overlap;
- use returned probability for policy;
- “confidence” and “probability of the chosen label” are not interchangeable concepts.

---

## 5. Core data model

```ts
export type AgentKind = "codex" | "claude-code" | "generic";

export type SkillScope =
  | "repo"
  | "user"
  | "admin"
  | "system"
  | "unknown";

export interface SkillDescriptor {
  id: string;                  // stable hash of agent + canonical path
  name: string;
  description: string;
  path: string;                // canonical SKILL.md path
  directory: string;
  scope: SkillScope;
  agent: AgentKind;
  enabled: boolean;
  metadata: Record<string, unknown>;
  contentHash: string;
}

export interface RouteRequest {
  prompt: string;
  cwd: string;
  agent: AgentKind;
  skills: SkillDescriptor[];
  context?: {
    repoRoot?: string;
    model?: string;
    sessionId?: string;
    turnId?: string;
  };
}

export interface SkillDecision {
  skillId: string;
  name: string;
  probability: number;         // normalized 0..1
  selected: boolean;
  reasonCode?: string;         // machine-oriented, optional
}

export interface RouteResult {
  selected: SkillDecision[];
  allDecisions: SkillDecision[];
  router: {
    provider: string;
    model?: string;
    latencyMs: number;
  };
  policy: {
    threshold: number;
    maxSkills: number;
  };
}
```

Do not include agent-specific hook payloads in the core models.

---

## 6. Skill discovery rules

### General parsing

A skill is a directory containing `SKILL.md`.

Parse YAML frontmatter:
- `name` required
- `description` required

Normalize whitespace but preserve source text for hashing.

Invalid skills:
- appear in `discover --json` as diagnostics if useful,
- are not passed to routing,
- do not crash the hook.

Duplicate `name`s:
- keep both as distinct skills by path/id;
- report a collision diagnostic;
- never silently merge.

### Codex adapter

Implement official current local discovery behavior rather than old assumptions.

At minimum:
- scan relevant `.agents/skills` directories from CWD upward to repo root;
- user scope `$HOME/.agents/skills`;
- support config-based disabled skills where safely parseable;
- architect admin/system support as optional discovery sources.

The adapter should return precedence/scope metadata but the core router must not discard duplicates automatically.

### Claude Code adapter

At minimum:
- project `.claude/skills`;
- user/global `~/.claude/skills`, respecting the current Claude config directory environment convention if set.

Later versions may add plugin-managed skill discovery.

---

## 7. Routing strategy

### Why not a single Choice?

A coding request can need several skills simultaneously.

Example:

> “Implement the React login form, add tests, and check keyboard accessibility.”

Expected candidates may be:
- `react-patterns`
- `frontend-testing`
- `accessibility-review`

Therefore the primary routing primitive must be **multi-label**.

### Jev provider

For each candidate, ask an independent binary decision equivalent to:

> Should this skill be made available/recommended for this request?

Shared state should contain:
- prompt,
- optional concise project metadata,
- optionally file/repo hints if already available without expensive scanning.

Per-skill decision data should contain:
- skill name,
- description,
- scope if relevant.

Do not send the full SKILL.md body unless a future eval demonstrates it is needed. The runtime is solving **discovery**, so the routing input should mirror what agents normally use: name + description (+ minimal metadata).

### Batch/chunking

Do not assume unlimited decisions in one API call.

Config:
```yaml
router:
  provider: jev
  chunkSize: 48
```

Process chunks with bounded concurrency. Merge by `skillId`.

### Selection policy

Default proposal:

```yaml
policy:
  threshold: 0.75
  maxSkills: 4
  ambiguityBand:
    min: 0.55
    max: 0.75
```

v0.1 behavior:
1. sort decisions by probability desc;
2. choose `p >= threshold`;
3. cap at `maxSkills`;
4. if nothing passes threshold, select none;
5. retain every decision in trace output.

Do not force a skill merely to avoid an empty result.

### Future provider interface

```ts
export interface RouterProvider {
  readonly name: string;
  route(input: ProviderRouteInput): Promise<ProviderRouteOutput>;
}
```

Planned future implementations:
- embedding prefilter;
- LLM judge;
- hybrid embedding → Jev;
- local decision model.

The domain/policy layer should not care which is used.

---

## 8. Runtime modes

### `shadow`

Purpose: adoption without risk.

Flow:

```text
prompt
  ├────────────> native coding agent (unchanged)
  └─> SkillDispatch -> decisions -> trace
```

Requirements:
- no added prompt/developer context;
- fail-open;
- concise optional stderr diagnostic only when debugging;
- default recommended first-run mode.

### `advisory`

Flow:

```text
prompt
 -> SkillDispatch
 -> selected skill names + canonical paths
 -> hook additional context
 -> coding agent
```

Injected context should be short and auditable, e.g.:

```text
SkillDispatch recommends these skills for this turn:
- react-patterns: /.../react-patterns/SKILL.md
- accessibility-review: /.../accessibility-review/SKILL.md

Inspect and follow the relevant SKILL.md instructions before executing the task.
Use your own judgment if a recommendation is not actually applicable.
```

Do not inject probabilities unless an eval shows they help the host model.

Do not inject full skill bodies by default.

### `enforce`

Reserve the enum/config value, but do not implement strong enforcement in v0.1.
“Enforcement” semantics differ across agents and can create unsafe/unexpected prompt behavior.

---

## 9. Hook adapters

Adapters translate host wire format ↔ core API.

```ts
export interface HookAdapter<TInput, TOutput> {
  parse(input: unknown): TInput;
  toRouteRequest(input: TInput): Promise<RouteRequest>;
  respond(input: TInput, result: RouteResult, mode: RoutingMode): TOutput;
}
```

### Codex

Input: JSON from stdin.

In `shadow`, return a successful neutral output.

In `advisory`, return the current documented `UserPromptSubmit` JSON shape with `hookSpecificOutput.additionalContext`.

Preserve normal host operation on:
- malformed config,
- routing timeout,
- Jev unavailable,
- trace writer failure.

### Claude Code

Implement using the current official `UserPromptSubmit` wire format.
Keep the agent-specific output serializer isolated from core.

---

## 10. Trace protocol

Agent Skill Studio should be able to consume traces without importing this CLI package.

Use versioned newline-delimited JSON.

Trace properties:
- schema version;
- trace id;
- UTC timestamp;
- agent;
- mode;
- prompt hash by default;
- raw prompt only when explicitly opted in;
- skill catalog fingerprint;
- router provider/model;
- routing latency;
- all decisions;
- selected decisions;
- diagnostics;
- hook/session metadata safe for local storage.

See `schemas/route-trace.schema.json`.

### Privacy defaults

Default:
```yaml
telemetry:
  prompt: hash
  traces: ~/.local/share/skilldispatch/traces.jsonl
```

Options:
- `none`
- `hash`
- `raw`

Hash should use a per-install random salt stored in the local config/state directory, so identical prompts cannot be trivially matched across machines.

Never include:
- API keys;
- raw environment dumps;
- full transcripts;
- complete SKILL.md body.

---

## 11. Eval format

See `evals/example.yaml`.

Each case can define:

```yaml
- id: react-login
  prompt: "Implement the React login form and add tests."
  should:
    - react-patterns
    - frontend-testing
  should_not:
    - deployment
```

Important:
- `should` means required/relevant expected skills.
- `should_not` means explicitly irrelevant skills.
- skills not listed in either are “unlabeled”, not automatically false positives.

Metrics:
- precision over labeled decisions;
- recall over `should`;
- F1;
- exact expected-set match (for fully labeled cases only);
- false-positive list;
- false-negative list;
- P50/P95 routing latency;
- average selected skill count.

CLI:

```bash
skilldispatch eval ./evals/example.yaml
skilldispatch eval ./evals/example.yaml --json
```

Exit non-zero only when an explicit threshold gate fails, e.g.:

```bash
skilldispatch eval evals.yaml --min-recall 0.90 --min-precision 0.90
```

This makes it usable in CI.

---

## 12. Collision analysis

MVP collision diagnostics can be simple and deterministic, not AI-powered.

Start with:
- duplicate names;
- normalized description exact duplicates;
- high lexical overlap (optional basic token/Jaccard threshold).

Output:

```text
Potential skill collisions:
- frontend-review <-> ui-review (description overlap: 0.82)
```

Do not call Jev just to find collisions in v0.1.

Future Studio can add semantic collision analysis.

---

## 13. CLI surface

```bash
# list normalized skills
skilldispatch discover
skilldispatch discover --agent codex --json

# route an ad-hoc prompt
skilldispatch route "Review this authentication implementation"
skilldispatch route "Build a React form and write tests" --json

# stdin hook entry points
skilldispatch hook codex
skilldispatch hook claude

# validate installation/config/integration
skilldispatch doctor

# routing eval
skilldispatch eval evals.yaml

# optional later helper
skilldispatch init
```

`doctor` should check:
- Node version;
- config parse;
- Jev key presence without printing it;
- skill directories;
- number of valid/invalid skills;
- writable trace location;
- selected agent hook config visibility;
- Jev connectivity only when `--online` is passed.

---

## 14. Configuration

Suggested default path:
- project: `.skilldispatch.yaml`
- user: `~/.config/skilldispatch/config.yaml`

Merge order:
1. defaults
2. user
3. project
4. explicit CLI flags

Example is in `examples/skilldispatch.config.yaml`.

Unknown config keys should warn, not silently disappear.

---

## 15. Repository layout

```text
skilldispatch/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── biome.json
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands/
│   │       ├── discover.ts
│   │       ├── route.ts
│   │       ├── hook.ts
│   │       ├── eval.ts
│   │       └── doctor.ts
│   ├── core/
│   │   ├── types.ts
│   │   ├── route.ts
│   │   ├── policy.ts
│   │   └── diagnostics.ts
│   ├── discovery/
│   │   ├── types.ts
│   │   ├── parse-skill.ts
│   │   ├── codex.ts
│   │   └── claude.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── mock.ts
│   │   └── jev.ts
│   ├── hooks/
│   │   ├── codex.ts
│   │   └── claude.ts
│   ├── telemetry/
│   │   ├── trace.ts
│   │   └── privacy.ts
│   ├── eval/
│   │   ├── schema.ts
│   │   ├── runner.ts
│   │   └── metrics.ts
│   └── config/
│       ├── schema.ts
│       └── load.ts
├── tests/
│   ├── fixtures/
│   ├── discovery/
│   ├── routing/
│   ├── hooks/
│   └── eval/
├── schemas/
│   └── route-trace.schema.json
├── examples/
│   └── skilldispatch.config.yaml
└── evals/
    └── example.yaml
```

Do not start as a monorepo. Split packages only when real reuse requires it.

---

## 16. Tests required before v0.1

### Discovery

- parses valid SKILL.md;
- rejects missing name/description;
- keeps duplicate names with separate IDs;
- handles symlinked skill directory safely;
- identifies project/user scope;
- deterministic ordering;
- does not recurse infinitely through symlinks.

### Routing policy

- 0 selected;
- 1 selected;
- multiple selected;
- threshold boundary;
- maxSkills cap;
- stable sort for equal scores;
- disabled skills excluded before provider call.

### Jev provider

Mock HTTP/client boundary:
- maps each response back to the correct skill;
- handles chunking;
- partial chunk failure;
- timeout;
- invalid/missing answer;
- bounded concurrency.

### Hooks

Fixture tests using captured/documented wire shape:
- parse Codex input;
- neutral shadow output;
- advisory additional context;
- malformed input fails open where possible;
- router timeout does not block normal turn.

Repeat analogous tests for Claude adapter.

### Trace

- validates against JSON schema;
- no raw prompt under default hash setting;
- no API key leakage;
- writer failure does not fail route.

### Eval

- precision/recall calculations;
- partially labeled cases;
- gate exit behavior.

---

## 17. Acceptance tests

### A. Cross-agent discovery

Given fixtures representing Codex and Claude skills:
```bash
skilldispatch discover --json
```
returns the same normalized shape.

### B. Multi-skill routing

Given:
- react-patterns
- frontend-testing
- accessibility-review
- deployment

and prompt:
> Implement a React login form, add tests and make sure keyboard navigation works.

the fake provider fixture selects all three relevant skills and not deployment.

### C. Shadow safety

A hook call in `shadow` mode:
- produces a trace;
- returns no routing context to the coding agent.

### D. Advisory injection

A hook call in `advisory`:
- emits selected skill name/path context;
- does not inject full skill content;
- does not block the host if routing fails.

### E. CI eval

```bash
skilldispatch eval evals/example.yaml --min-recall 0.8
```
returns 0 when passing and non-zero when failing.

---

## 18. Agent Skill Studio contract

Studio is a separate project.

Do not create Studio-specific runtime dependencies here.

The initial integration contract is simply:
1. JSONL trace schema;
2. skill IDs stable by canonical source identity;
3. optional future local IPC/export endpoint.

Studio will later provide:
- route history;
- recommended vs actual comparisons when reliable host telemetry exists;
- dead/never-recommended skills;
- collision visualization;
- per-skill precision/recall;
- version comparison;
- description improvement proposals;
- regression evals;
- cross-agent analytics.

The OSS trace schema is therefore a product surface. Treat backward compatibility seriously.

---

## 19. Important product decisions

### Decision: Jev is a provider, not the project identity

Reason:
- avoids being commoditized if another routing model becomes better;
- permits offline/local/provider alternatives;
- clearer differentiation from existing Jev router demos.

### Decision: multi-label before hierarchical routing

Start simple:
- scan all normalized descriptions;
- chunk Jev binary decisions.

Only add:
- embedding prefilter,
- category hierarchy,
- cached candidate shortlist

after real benchmarks show scale/latency problems.

### Decision: shadow first

Users should be able to measure routing before trusting it with context mutation.

### Decision: traces before dashboards

The Studio needs reliable events more than this repo needs a UI.

---

## 20. Benchmark plan after MVP

Create a public eval dataset with:
- 20–50 skills;
- at least 200 prompts;
- explicit single-skill prompts;
- implicit paraphrases;
- multi-skill prompts;
- unrelated prompts;
- intentionally overlapping skill descriptions.

Compare:
1. native agent selection if observable;
2. Jev SkillDispatch;
3. lexical baseline;
4. optional embedding baseline.

Track:
- precision;
- recall;
- F1;
- no-skill accuracy;
- multi-skill exact-set rate;
- latency;
- cost per routed turn.

Do not market “better routing” until this exists.

---

## 21. First implementation milestone

The first PR should be intentionally boring:

**PR 1: normalized skill discovery + fake routing provider**

It should include:
- repo/tooling bootstrap;
- domain types;
- SKILL.md parser;
- Codex discovery;
- Claude discovery;
- fake deterministic provider;
- `discover` and `route` CLI;
- unit tests.

No Jev, hooks, telemetry, or network in PR 1.

PR 2:
- Jev provider + policy + chunking.

PR 3:
- trace schema + JSONL.

PR 4:
- Codex and Claude hooks, shadow/advisory.

PR 5:
- eval runner + docs + release packaging.

This sequencing isolates failures and prevents hook/network complexity from contaminating the core.

---

## 22. Codex implementation prompt

Use `CODEX_PROMPT.md` as the initial message to the local Codex session.

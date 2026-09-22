# Launch drafts — do not post automatically

## Repository presentation proposal

Description: Observable multi-skill routing for Claude Code and Codex.

Topics: claude-code, codex, agent-skills, ai-agents, developer-tools, jev,
llm, observability. No repository settings were changed to apply these proposals.

## 45-second synthetic demo plan

1. 0–8s: show a disposable catalog with generic skills; explain that selection is
   hard to inspect as the catalog grows.
2. 8–15s: submit a harmless issue-writing request in a disposable Claude session.
3. 15–25s: show routing selected a generic issue skill and advisory emitted its native name.
4. 25–35s: show a native Skill attempt/success if actually observed; never manufacture
   host events for a purported real demo. Label simulated footage or mock scores.
5. 35–45s: show `traces show` and observed counts, noting async missing events are unknown.

Use only `benchmarks/public-routing-v1` or `examples/demo` synthetic skills, a
throwaway user profile and fictional project names. Hide usernames, command paths,
credentials and unrelated terminal history. Never record a company PC/catalog.
No raw prompt or telemetry files need to be uploaded. If no real event arrives,
explain best-effort delivery rather than editing it into a success claim.

## Reddit draft

Title: I wanted to see which skills my coding agent selected, so I built an open-source skill router

As my skill catalog grew, it became harder to tell whether a relevant workflow was
being considered, especially when descriptions overlapped. I built SkillDispatch
to make that decision inspectable.

It discovers Claude Code/Codex skills, routes a prompt to zero or more candidates
through Jev, and keeps local traces. Shadow is the default and leaves context alone.
Claude advisory is an explicit opt-in that recommends native skill identifiers;
it doesn't copy skill bodies into the prompt. Claude Skill tool observers can show
positive evidence of model attempts and completion.

The limitations matter: async observers can lose events, so missing events aren't
proof of non-use and there are no exact conversion percentages. Routing sends
prompt text and minimal descriptions to TypeSafe; traces themselves aren't uploaded.
The synthetic benchmark is a reviewable starting point, not proof this outperforms
native routing. Codex advisory and subagent routing aren't implemented.

MIT licensed: https://github.com/maromocooo/SkillDispatch

I'd appreciate sanitized catalog edge cases, ambiguous descriptions, and feedback
on whether the trace/eval workflow helps you debug skill selection.

## Show HN draft

Title: Show HN: SkillDispatch – Observable multi-skill routing for coding agents

SkillDispatch is a TypeScript/Node runtime with agent discovery adapters, an
SDK-independent RouterProvider contract, 0..N selection policy and local JSONL
analytics. Jev's independent binary judgments are the first provider baseline;
chunking/concurrency/deadlines are bounded, and failures leave the host running.

Claude supports opt-in synchronous advisory and async native Skill observers;
Codex is shadow-only. We separate recommendation, emitted context and observed
model attempts/completion. Observation is positive evidence, not a completeness
claim. Local prompts default to HMACs, but routing sends prompt text plus minimal
skill metadata to TypeSafe. There is no telemetry upload.

Includes evals, a synthetic benchmark draft and offline package tests. Feedback on
catalog fidelity, the provider boundary and difficult multi-label cases is welcome.
https://github.com/maromocooo/SkillDispatch

## Product Hunt draft

Tagline: See how your coding agent's skills get routed

One line: An open-source runtime for multi-skill routing, opt-in Claude recommendations
and privacy-safe local observation across coding agents.

Maker comment: I wanted a small way to inspect skill selection before changing agent
behavior. SkillDispatch starts in shadow mode; you can opt into Claude advisory and
inspect observed Skill tool attempts. It uses Jev for routing and stores traces locally.
It's early: the benchmark is synthetic, async observation is incomplete, and we don't
claim better-than-native routing. I'd love feedback on real catalog edge cases using
sanitized examples. Source and limitations are on GitHub.

Do not claim deployment, npm availability, accuracy gains or independent human label
review until verified. These are drafts; no launch posts or release publication were made.

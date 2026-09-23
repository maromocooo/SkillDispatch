# Changelog

## 0.2.0 — Unreleased

- Expand Codex discovery to CODEX_HOME user/system roots and configured installed
  plugin skills, with conservative eligibility and path-free catalog fingerprints.
- Add user-owned Codex advisory for verified target contracts, synchronous
  reconciliation, status/doctor and rollback through the existing safe installer.
- Observe narrow Codex instruction-read requests and terminal events in a separate
  local stream. This is not native Skill invocation, exit success or full loading.
- Correlate exact agent/session/turn/tool identities and content versions; expose
  Codex read evidence separately from unchanged Claude invocation analytics.
- Retain old route/invocation files; introduce Codex route v2, read-event v1 and
  trace CLI JSON envelope v2. Older CLIs cannot read new Codex route records.
- Keep provider and hook persistence user-owned even for trusted project configs;
  move any previously trusted-project provider/telemetry overrides to user config.

Known limits: source-verified contracts require real-host validation; live session,
cloud/account/MDM/profile state is not reconstructed. Async absence remains unknown.
Unsupported or ambiguous catalog/policy states are excluded, not guessed.

## 0.1.0

- Discover Codex and Claude Code local/project skills; include Claude synced,
  enabled installed plugin and documented file-managed sources.
- Route zero or more skills using independent Jev judgments, bounded requests,
  deterministic policy and SDK-independent provider contracts.
- Safely install, inspect and remove user-level shadow hooks; opt into Claude-only
  synchronous advisory without injecting skill bodies.
- Evaluate fixed labeled datasets with partial-label metrics and CI gates.
- Inspect privacy-safe local routing traces with offline doctor and analytics.
- Observe Claude model Skill attempts/successes/failures in a separate local stream.
  Async telemetry reports positive evidence only, never exact conversion from absence.
- Provide a synthetic public benchmark draft, offline demo, package/CI/release
  checks and public onboarding documentation.

Known limitations: Codex is shadow-only; Claude invocation observers are best-effort
and exclude direct user slash commands. Some live/session-only catalog sources are
unsupported. Routing thresholds are configured explicitly, without automatic tuning.

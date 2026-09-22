# Security and privacy model

## Boundaries

Core routing is independent of SDK and host wire formats. Jev receives prompt text
and minimal candidate name/description/agent/scope, not paths, cwd, plugin account
IDs, skill bodies or arbitrary metadata. TypeSafe handles that request under its
own service terms; local prompt hashing does **not** anonymize the external routing
request. Route sensitive prompts only when you accept that external data boundary.
The application has no trace upload, cloud analytics or account service.

UserPromptSubmit hooks fail open under parsing, setup, provider, timeout and storage
failure. Shadow and observers are silent. Claude advisory emits only bounded JSON
with safe native identifiers after complete routing; no blocking decision, body,
description, probability or priority escalation enters context. Host native
permissions/invocation remain authoritative. Fail-open is not an enforcement mode.

## Configuration authority

Ordinary discover/route/eval layer defaults → user → project → explicit config.
Global hooks ignore project SkillDispatch config unless the user sets
`hook.trustProjectConfig: true`. Project skill discovery still uses host cwd.
Even with that opt-in, execution modes are user-owned, so a project cannot silently
enable advisory. Invocation observer enablement/storage uses user config only.
The user opt-in grants broader routing/trace configuration trust; review repos
before enabling it. Registration commands edit user scope only and preserve
unrelated settings; they refuse malformed, linked or conflicting destinations.

## Local storage and sharing

Default prompt storage is HMAC-SHA256 with a random installation-local key (32 bytes),
not unsalted SHA-256. Session/prompt/tool IDs use separate domains. The default data
directory is `~/.local/share/skilldispatch`, with `SKILLDISPATCH_DATA_DIR` and
`XDG_DATA_HOME` overrides. Keys are 0600 and directories 0700 where supported.
Readers/writers check regular files, links, ownership/private permissions and
key/stream collisions. Appends and read line sizes are bounded. Files are local-only.
These checks cannot defend against an attacker already executing as your user.

`telemetry.prompt: raw` explicitly stores raw prompt text and may capture secrets.
Keep `hash` or use `none`. Trace CLI views never print raw prompts, prompt hashes or
host correlation keys, even for raw-mode files. Invocation events omit arguments,
responses, error strings, cwd and transcripts. SDK errors are replaced by fixed codes.

Not every CLI output is shareable unchanged: discovery JSON contains local skill
paths, and hook status can show the installed command path. Names/descriptions are
also user-controlled. Review/redact outputs before sharing. Don't upload raw JSONL
or installation keys to a bug report.

## Observability limits

Recommended ≠ injected ≠ observed model-invoked ≠ observed succeeded. Async observers
may be lost at host teardown or not loaded by the active session. The capability
marker checks local registration/persistence prerequisites only. Missing events
remain unknown; no exact conversion or success percentage is inferred. Native tool
success does not prove task quality. Direct `/skillname` and unsupported catalogs
are not fully observed. There is no transcript scraping or delivery witness.

## Maintenance

Normal tests use synthetic fixtures and no external API (loopback transport tests
are local). GitHub workflow permissions are minimized; actions are SHA pinned.
Packages are built from source with an explicit files allowlist. Publish is a
separate manually gated step, never triggered by a PR. Report vulnerabilities using
[SECURITY.md](../SECURITY.md); this runtime is not a security audit authority.

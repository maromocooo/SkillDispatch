# Security policy

## Reporting privately

Do not post API keys, npm/GitHub tokens, raw prompts, full host settings, transcripts,
company data, or unredacted traces in a public issue.

Use GitHub's **Security → Report a vulnerability** for this repository when enabled:
https://github.com/maromocooo/SkillDispatch/security/advisories/new

Private vulnerability reporting was **not enabled** during release-candidate review.
It must be enabled by the maintainer before public launch. If the button is absent,
open a public issue containing only “Please enable private vulnerability reporting”
and wait for a private channel; do not include exploit details or sensitive data.
No security inbox or response-time guarantee is claimed.

Reports should include the affected version, OS/Node/host versions, a minimal
synthetic reproduction, expected boundary and impact. Prompt leakage, unintended
external requests, unsafe local file access and hook configuration trust issues
are security-relevant. Replace all real identifiers with placeholders.

## Supported versions

The latest 0.1.x release is the intended supported line after publication. The
current 0.1.0 candidate is not yet published. Earlier development snapshots should
upgrade rather than expect backports. There is no paid support or patch SLA.

## Scope

See [the security model](docs/SECURITY_MODEL.md). Fail-open hooks preserve host
continuation; they are not a sandbox, authorization policy or proof of complete
observation. Local files are protected within documented OS limits; a compromised
account/OS, hostile plugin execution or third-party service behavior is outside
those guarantees. Never use missing observer events as a security audit assertion.

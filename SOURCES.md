# PR1 implementation references

Checked on 2026-09-21. Official documentation takes precedence over the handoff.

- [OpenAI: Build skills](https://learn.chatgpt.com/docs/build-skills) — local Codex
  discovery paths, duplicate names, symlinks, per-path disable configuration and
  implicit invocation policy. The previous developers.openai.com/codex/skills
  link redirects here.
- [Claude Code: Skills](https://code.claude.com/docs/en/skills) — project/personal
  paths, ancestor discovery, fallback metadata, invocation controls and native
  command precedence.
- [Claude Code: Configuration directory](https://code.claude.com/docs/en/claude-directory)
  — `CLAUDE_CONFIG_DIR` overrides the personal directory.

Implementation choices and scope limits are recorded in [README](README.md).
PR1 makes no network calls. Jev SDK, hook protocols and trace/eval integration
must be reverified in their respective future implementation PRs; the handoff's
notes about those APIs were not implementation validation for this PR.

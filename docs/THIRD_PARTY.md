# Runtime dependency licenses

Release candidate audit: installed dependency licenses, with versions pinned by
`pnpm-lock.yaml`. SkillDispatch retains its existing MIT license; no relicensing of
third-party code is intended.

| Direct dependency | Audited version | Declared license |
|---|---|---|
| @typesafe-ai/sdk | 0.6.0 | MIT |
| commander | 13.1.0 | MIT |
| jsonc-parser | 3.3.1 | MIT |
| smol-toml | 1.8.0 | BSD-3-Clause |
| string-width | 8.2.0 | MIT |
| yaml | 2.9.1 | ISC |
| zod | 4.6.5 | MIT |

`string-width` measures sanitized terminal text, including East Asian characters
and combining marks. Its ESM package supports Node 20+; it is used only by the CLI
renderer. Its installed runtime dependencies are `get-east-asian-width` 1.7.0,
`strip-ansi` 7.2.0 and `ansi-regex` 6.3.0 (all MIT). Their installed license files
were included in this audit. SkillDispatch does not import these transitive
dependencies directly. See the [upstream usage and width rules](https://github.com/sindresorhus/string-width).

Runtime dependencies remain external in the built package and are installed as
separate npm packages, retaining their own license files. SDK 0.6.0 declares no
additional npm dependencies. Inspect the installed packages for full
copyright and license texts. No third-party source or skill catalog was copied
into the public benchmark. No additional upstream NOTICE requirement was identified
in this dependency/license-file audit, so no artificial NOTICE file was added.

Before publishing an updated dependency set, repeat the lockfile/package inventory
and license check. Package manager installation downloads are distinct from
SkillDispatch's application routing API traffic.

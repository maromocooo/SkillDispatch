# Public routing v1 (synthetic draft)

24 original generic skills; 100 fixed cases: 24 explicit, 24 paraphrase,
16 multi-skill, 8 no-skill, 8 negative, 8 Japanese, 8 mixed-language and 4 ambiguous.
The broad `code-review` description is intentionally narrower than every code edit.
English cases also cover generic/specific overlap; negative cases use explicit negatives.
88 cases are fully labeled; 12 use partial labels. Unlabeled selections in partial
cases do not become false positives. Ambiguous cases assert only three explicit
negatives, not an invented uniquely correct positive skill.

These are **AI-assisted, manually specified synthetic drafts**, not independently
human-validated ground truth. A maintainer must review the labels before publishing
an accuracy claim. Labels are committed YAML, never generated from provider results
or changed automatically to improve a score. No private catalog or company workflow
was copied. The repository MIT license covers these original fixtures.

## Reproduce without reading your installed catalog

From a built checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/public-benchmark.mjs --mock --json
# Opt-in only: 100 routing requests with the default 24-question catalog.
# A TypeSafe API key and any associated request costs are required.
node scripts/public-benchmark.mjs --live --json
```

The runner uses the exported `parseSkill`, `runEvaluation`, provider and routing
policy APIs on **only these files**. It does not load user/project configuration,
real-home skills, hooks or telemetry. Synthetic identities are independent of checkout
paths. Defaults are threshold 0.75, maxSkills 4, overall timeout 2500 ms, SDK 0.6.0,
requested model `jev-latest`, zero retries. Actual returned models and latency
runtime are included in output. It does not claim that a moving model alias is immutable.

For an independently prepared disposable catalog, the ordinary command is also valid:

```sh
skilldispatch eval benchmarks/public-routing-v1/evals.yaml --agent claude-code --json
```

That command uses your normal discovered catalog/configuration. Copy `skills/*` to
that disposable project's `.claude/skills/` first, then run from its root with the
correct path to this YAML. It intentionally errors if selectors are unknown or
ambiguous. Prefer the isolated runner above for reproducible public measurements.

`--output <new-file.json>` writes a privacy-safe report without overwriting existing
files. Review results before committing under `results/`; include this dataset hash,
model, date, SDK, policy and runtime metadata. Raw prompts are absent from reports.
No live result has been committed. Mock results verify plumbing, **not Jev accuracy**.
This benchmark does not compare Claude's native routing or claim calibrated thresholds.

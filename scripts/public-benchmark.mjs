// Manual release tooling. Never called with --live by tests, CI or prepack.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";
import {
  catalogFingerprint,
  JevRouterProvider,
  loadEvalFile,
  MockRouterProvider,
  parseSkill,
  runEvaluation,
  VERSION,
} from "../dist/index.js";

try {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const outputIndex = args.indexOf("--output");
  const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputIndex >= 0 && (!output || output.startsWith("--")))
    throw new Error();
  const options = args.filter(
    (_, i) => (i !== outputIndex && i !== outputIndex + 1) || outputIndex < 0,
  );
  if (
    options.some((a) => !["--live", "--mock", "--json"].includes(a)) ||
    (live && args.includes("--mock"))
  )
    throw new Error();
  if (live && !process.env.TYPESAFE_API_KEY) {
    process.stderr.write("Live benchmark skipped: TYPESAFE_API_KEY missing.\n");
  } else {
    if (!live)
      globalThis.fetch = () => {
        throw new Error("Offline benchmark");
      };
    const root = new URL("../benchmarks/public-routing-v1/", import.meta.url);
    const catalog = [];
    for (const name of (await readdir(new URL("skills/", root))).sort()) {
      const text = await readFile(
        new URL(`skills/${name}/SKILL.md`, root),
        "utf8",
      );
      const parsed = parseSkill(text, {
        path: `/synthetic/public-routing-v1/skills/${name}/SKILL.md`,
        agent: "claude-code",
        scope: "repo",
      });
      if (parsed.diagnostics.length || parsed.skills.length !== 1)
        throw new Error();
      catalog.push(...parsed.skills);
    }
    const requestedModel = "jev-latest";
    const provider = live
      ? new JevRouterProvider({
          apiKey: process.env.TYPESAFE_API_KEY,
          model: requestedModel,
        })
      : new MockRouterProvider({ defaultProbability: 0 });
    const dataset = await loadEvalFile(
      fileURLToPath(new URL("evals.yaml", root)),
    );
    const result = await runEvaluation(dataset, {
      skills: catalog,
      provider,
      cwd: "/synthetic/public-routing-v1",
      agent: "claude-code",
      policy: { threshold: 0.75, maxSkills: 4 },
      timeoutMs: 2500,
    });
    const report = {
      benchmark: "public-routing-v1",
      labelStatus: "AI-assisted draft; maintainer review pending",
      measurement: live
        ? "manual-live-jev"
        : "mock-pipeline-check-not-accuracy",
      date: new Date().toISOString(),
      packageVersion: VERSION,
      sdkVersion: "0.6.0",
      requestedModel: live ? requestedModel : "mock",
      returnedModels: [
        ...new Set(
          result.cases.flatMap((c) =>
            c.routing.model ? [c.routing.model] : [],
          ),
        ),
      ].sort(),
      runtime: { node: process.version, platform: platform(), arch: arch() },
      datasetSha256: createHash("sha256")
        .update(await readFile(new URL("evals.yaml", root)))
        .digest("hex"),
      catalogFingerprint: catalogFingerprint(catalog),
      skillCount: catalog.length,
      ...result,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output) await writeFile(output, json, { flag: "wx", mode: 0o600 });
    process.stdout.write(
      args.includes("--json")
        ? json
        : `${report.measurement}: ${catalog.length} skills, ${dataset.cases.length} cases\nPrecision ${result.metrics.precision ?? "n/a"}, recall ${result.metrics.recall ?? "n/a"}, F1 ${result.metrics.f1 ?? "n/a"}\nFailures ${result.metrics.providerFailureCount}, partial ${result.metrics.providerPartialCount}\n`,
    );
  }
} catch {
  process.stderr.write(
    "Benchmark failed. Check arguments, public dataset and provider setup; raw errors are omitted.\n",
  );
  process.exitCode = 1;
}

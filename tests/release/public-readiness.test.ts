import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { createProgram } from "../../src/cli/program.js";
import { resolveEvalCases } from "../../src/eval/resolve.js";
import * as api from "../../src/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFile(resolve(root, path), "utf8");
async function publicCatalog() {
  const base = "benchmarks/public-routing-v1/skills";
  return (
    await Promise.all(
      (await readdir(resolve(root, base))).sort().map(async (name) => {
        const parsed = api.parseSkill(await read(`${base}/${name}/SKILL.md`), {
          agent: "claude-code",
          scope: "repo",
          path: `/synthetic/${name}/SKILL.md`,
        });
        expect(parsed.diagnostics).toEqual([]);
        return parsed.skills;
      }),
    )
  ).flat();
}
describe("public release artifacts", () => {
  it("preserves the existing minimal runtime exports and consistent release metadata", async () => {
    const pkg = JSON.parse(await read("package.json"));
    expect(pkg).toMatchObject({
      name: "skilldispatch",
      version: api.VERSION,
      license: "MIT",
      engines: { node: ">=20" },
      bin: { skilldispatch: "dist/cli/index.js" },
      publishConfig: { access: "public" },
    });
    expect(api.VERSION).toBe("0.1.0");
    expect(Object.keys(api).sort()).toEqual(
      [
        "VERSION",
        "applyPolicy",
        "DEFAULT_POLICY",
        "route",
        "finalizeCatalog",
        "ClaudeDiscoveryAdapter",
        "CodexDiscoveryAdapter",
        "parseSkill",
        "runEvaluation",
        "EvalInputError",
        "loadEvalFile",
        "parseEvalYaml",
        "JevRouterProvider",
        "MockRouterProvider",
        "catalogFingerprint",
        "JsonlTraceSink",
        "routeTraceSchema",
      ].sort(),
    );
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    expect(pkg.files).not.toContain("tests");
    expect(pkg.scripts).not.toHaveProperty("postinstall");
  });
  it("resolves every fixed benchmark label against the public synthetic catalog", async () => {
    const skills = await publicCatalog();
    const dataset = api.parseEvalYaml(
      await read("benchmarks/public-routing-v1/evals.yaml"),
    );
    expect(skills).toHaveLength(24);
    expect(new Set(skills.map((s) => s.id)).size).toBe(24);
    expect(skills.every((s) => s.enabled)).toBe(true);
    expect(dataset.cases).toHaveLength(100);
    expect(resolveEvalCases(dataset, skills)).toHaveLength(100);
    expect(dataset.cases.filter((c) => c.fully_labeled)).toHaveLength(88);
    const groups = new Set(dataset.cases.map((c) => c.id.split("-")[0]));
    expect([...groups].sort()).toEqual([
      "ambiguous",
      "explicit",
      "japanese",
      "mixed",
      "multi",
      "negative",
      "no",
      "paraphrase",
    ]);
  });
  it("executes the whole public eval with a mock without sending network requests or returning prompts", async () => {
    const skills = await publicCatalog();
    const dataset = api.parseEvalYaml(
      await read("benchmarks/public-routing-v1/evals.yaml"),
    );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Network forbidden"));
    try {
      const result = await api.runEvaluation(dataset, {
        skills,
        provider: new api.MockRouterProvider({ defaultProbability: 0 }),
        cwd: "/synthetic",
        agent: "claude-code",
      });
      expect(result.metrics.caseCount).toBe(100);
      expect(result.metrics.providerFailureCount).toBe(0);
      expect(result.metrics.recall).toBe(0); // Offline plumbing only, not accuracy.
      for (const c of dataset.cases)
        expect(JSON.stringify(result)).not.toContain(c.prompt);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("offers an offline-first help path without reading a real home", async () => {
    let text = "";
    const cli = createProgram(
      { cwd: "/synthetic", home: "/synthetic/home", env: {} },
      {
        stdout: (t) => {
          text += t;
        },
        stderr: () => {},
      },
    );
    cli.outputHelp();
    expect(text).toContain("skilldispatch doctor");
    expect(text).toContain("hooks install claude --dry-run");
    expect(text).toContain("Shadow is the default");
  });
  it("validates workflow YAML and enforces manually gated publishing separately from CI", async () => {
    for (const file of ["ci.yml", "release.yml", "publish.yml"]) {
      const doc = parseDocument(await read(`.github/workflows/${file}`));
      expect(doc.errors).toEqual([]);
      const workflow = doc.toJS();
      expect(workflow.permissions.contents).toBe("read");
      for (const job of Object.values(workflow.jobs) as {
        steps: { uses?: string; run?: string }[];
      }[]) {
        for (const step of job.steps)
          if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      }
    }
    const ci = parseDocument(await read(".github/workflows/ci.yml")).toJS();
    expect(ci.jobs.validate.strategy.matrix.node).toEqual(["20", "24"]);
    expect(await read(".github/workflows/ci.yml")).not.toContain("--live");
    expect(await read(".github/workflows/release.yml")).not.toContain(
      "npm publish",
    );
    const publish = parseDocument(
      await read(".github/workflows/publish.yml"),
    ).toJS();
    expect(Object.keys(publish.on)).toEqual(["workflow_dispatch"]);
    expect(publish.jobs.publish.if).toContain(
      "vars.NPM_PUBLISH_ENABLED == 'true'",
    );
    expect(publish.jobs.publish.environment).toBe("npm-release");
    expect(publish.jobs.publish.permissions["id-token"]).toBe("write");
  });
  it("keeps public documentation relative file links resolvable", async () => {
    for (const file of [
      "README.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "docs/OPERATIONS.md",
      "docs/RELEASE_CHECKLIST.md",
      "docs/SECURITY_MODEL.md",
      "docs/LAUNCH.md",
      "benchmarks/public-routing-v1/README.md",
    ]) {
      const text = await read(file);
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const link = match[1] ?? "";
        if (/^(?:https?:|#)/.test(link)) continue;
        const target = resolve(root, dirname(file), link.split("#")[0] ?? "");
        expect(await stat(target), `${file}: ${link}`).toBeTruthy();
      }
    }
  });
});

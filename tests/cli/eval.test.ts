import { join } from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { CliEnvironment } from "../../src/cli/context.js";
import { createProgram } from "../../src/cli/program.js";
import { workspace, write } from "../helpers.js";

const sentinel = "PRIVATE_EVAL_PROMPT_SENTINEL";
async function run(args: string[], environment: CliEnvironment) {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const program = createProgram(environment, {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    exitCode = error instanceof CommanderError ? error.exitCode : 1;
    if (!(error instanceof CommanderError)) stderr += String(error);
  }
  return { stdout, stderr, exitCode };
}
const label = (name: string) => ({ name, agent: "codex", scope: "repo" });
async function fixture(
  should = ["react-patterns", "frontend-testing"],
  shouldNot: string[] = [],
  fullyLabeled = true,
) {
  const ctx = await workspace();
  await write(
    join(ctx.cwd, ".skilldispatch.yaml"),
    "router:\n  provider: mock\n  mock:\n    defaultProbability: 0\n    scores:\n      react-patterns: 0.95\n      frontend-testing: 0.91\n",
  );
  await write(
    join(ctx.cwd, "eval.yaml"),
    stringify({
      version: 1,
      cases: [
        {
          id: "frontend",
          prompt: sentinel,
          should: should.map(label),
          should_not: shouldNot.map(label),
          fully_labeled: fullyLabeled,
        },
      ],
    }),
  );
  return ctx;
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error(`${sentinel} synthetic-api-key raw-secret`),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("eval CLI", () => {
  it.each([false, true])(
    "runs a dataset without exposing prompts (json=%s)",
    async (json) => {
      const output = await run(
        ["eval", "eval.yaml", ...(json ? ["--json"] : [])],
        await fixture(),
      );
      expect(output.exitCode).toBe(0);
      expect(output.stdout + output.stderr).not.toContain(sentinel);
      if (json) {
        const result = JSON.parse(output.stdout);
        expect(result.metrics).toMatchObject({
          precision: 1,
          recall: 1,
          f1: 1,
          exactSetAccuracy: 1,
        });
        expect(
          result.cases[0].selected.map((item: { name: string }) => item.name),
        ).toEqual(["react-patterns", "frontend-testing"]);
        expect(output.stderr).toBe("");
      } else {
        expect(output.stdout).toContain("Precision (labeled, micro): 1.0000");
        expect(output.stdout).toContain("offline mock");
        expect(output.stdout).toContain("Provider failure count: 0");
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("passes inclusive gates with exit zero", async () => {
    const output = await run(
      [
        "eval",
        "eval.yaml",
        "--min-recall",
        "1",
        "--min-precision",
        "1",
        "--json",
      ],
      await fixture(),
    );
    expect(output.exitCode).toBe(0);
    expect(
      JSON.parse(output.stdout).gates.every(
        (gate: { passed: boolean }) => gate.passed,
      ),
    ).toBe(true);
  });
  it("fails a precision gate with exit 2 and still emits a complete JSON result", async () => {
    const ctx = await fixture(["react-patterns"], ["frontend-testing"], false);
    const output = await run(
      ["eval", "eval.yaml", "--min-precision", "0.9", "--json"],
      ctx,
    );
    expect(output.exitCode).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({
      passed: false,
      metrics: { precision: 0.5, recall: 1 },
    });
  });
  it("fails recall gates after applying the same policy flags as route", async () => {
    const ctx = await fixture();
    const output = await run(
      ["eval", "eval.yaml", "--max-skills", "1", "--min-recall", "0.9"],
      ctx,
    );
    expect(output.exitCode).toBe(2);
    expect(output.stdout).toContain("Recall (micro): 0.5000");
    const route = JSON.parse(
      (await run(["route", sentinel, "--max-skills", "1", "--json"], ctx))
        .stdout,
    );
    const evaluation = JSON.parse(
      (await run(["eval", "eval.yaml", "--max-skills", "1", "--json"], ctx))
        .stdout,
    );
    expect(
      evaluation.cases[0].selected.map((item: { id: string }) => item.id),
    ).toEqual(route.selected.map((item: { skillId: string }) => item.skillId));
  });
  it("undefined recall cannot pass a requested gate", async () => {
    const output = await run(
      ["eval", "eval.yaml", "--min-recall", "0", "--json"],
      await fixture([], [], false),
    );
    expect(output.exitCode).toBe(2);
    expect(JSON.parse(output.stdout).gates[0]).toMatchObject({
      actual: null,
      passed: false,
    });
  });
  it.each(["--min-recall", "--min-precision"])(
    "rejects out-of-range or nonnumeric %s",
    async (flag) => {
      const ctx = await fixture();
      for (const value of ["-0.1", "1.01", "NaN", "Infinity", " ", sentinel]) {
        const output = await run(["eval", "eval.yaml", flag, value], ctx);
        expect(output.exitCode).toBe(1);
        expect(output.stdout + output.stderr).not.toContain(sentinel);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    `version: 1\ncases: [${sentinel}`,
    stringify({
      version: 1,
      cases: [{ id: "bad", prompt: sentinel, should: [sentinel] }],
    }),
  ])("rejects malformed input safely %#", async (source) => {
    const ctx = await fixture();
    await write(join(ctx.cwd, "eval.yaml"), source);
    const output = await run(["eval", "eval.yaml", "--json"], ctx);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain("invalid_eval_input");
    expect(output.stdout + output.stderr).not.toContain(sentinel);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("unknown and ambiguous labels are input errors", async () => {
    const unknown = await run(
      ["eval", "eval.yaml"],
      await fixture(["missing"]),
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("unknown_eval_skill");
    const ctx = await fixture();
    await write(
      join(ctx.cwd, "eval.yaml"),
      stringify({
        version: 1,
        cases: [
          {
            id: "same",
            prompt: sentinel,
            should: [{ name: "duplicate-name" }],
          },
        ],
      }),
    );
    // Fixture catalogs contain multiple same-name skills; use their actual name.
    const discovery = JSON.parse(
      (await run(["discover", "--json"], ctx)).stdout,
    );
    const duplicate = discovery.skills.find(
      (item: { name: string }, i: number, all: { name: string }[]) =>
        all.some((other, j) => j !== i && item.name === other.name),
    );
    expect(duplicate).toBeDefined();
    await write(
      join(ctx.cwd, "eval.yaml"),
      stringify({
        version: 1,
        cases: [
          { id: "same", prompt: sentinel, should: [{ name: duplicate.name }] },
        ],
      }),
    );
    const ambiguous = await run(["eval", "eval.yaml"], ctx);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous_eval_skill");
  });
  it("shares Jev composition and uses actual model metadata with fake fetch", async () => {
    const ctx = await fixture();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  provider: jev\n",
    );
    vi.mocked(fetch).mockImplementation(async (_, init) => {
      const { state, questions } = JSON.parse(String(init?.body));
      expect(state.prompt).toBe(sentinel);
      return new Response(
        JSON.stringify({
          model: "jev-fixture",
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { type: "noul", noul: 0.95 },
            ]),
          ),
        }),
      );
    });
    const output = await run(["eval", "eval.yaml", "--json"], {
      ...ctx,
      env: { TYPESAFE_API_KEY: "synthetic-api-key" },
    });
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout).cases[0].routing).toEqual({
      provider: "jev",
      model: "jev-fixture",
      partial: false,
      failed: false,
    });
    expect(output.stdout + output.stderr).not.toContain(sentinel);
  });
  it.each([false, true])(
    "records Jev partial failure without leaking SDK errors (json=%s)",
    async (json) => {
      const ctx = await fixture();
      await write(
        join(ctx.cwd, ".skilldispatch.yaml"),
        "router:\n  provider: jev\n",
      );
      const output = await run(
        ["eval", "eval.yaml", ...(json ? ["--json"] : [])],
        { ...ctx, env: { TYPESAFE_API_KEY: "synthetic-api-key" } },
      );
      expect(output.exitCode).toBe(0);
      expect(output.stdout + output.stderr).not.toMatch(
        /PRIVATE_EVAL_PROMPT_SENTINEL|synthetic-api-key|raw-secret/,
      );
      if (json)
        expect(JSON.parse(output.stdout).metrics).toMatchObject({
          providerPartialCount: 1,
          providerFailureCount: 0,
          falseNegatives: 2,
        });
      else expect(output.stdout).toContain("Provider partial count: 1");
    },
  );
  it("provider setup and config errors have nonzero exit without network", async () => {
    const ctx = await fixture();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  provider: jev\n",
    );
    const output = await run(["eval", "eval.yaml"], ctx);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain("TYPESAFE_API_KEY is required");
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  jev:\n    concurrency: 9\n",
    );
    expect((await run(["eval", "eval.yaml"], ctx)).exitCode).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses --cwd, --config, --agent and --threshold while resolving the eval file from the invocation directory", async () => {
    const ctx = await fixture(["react-patterns"]);
    await write(
      join(ctx.repo, "custom.yaml"),
      "router:\n  provider: mock\n  mock:\n    defaultProbability: 0\n    scores:\n      react-patterns: 0.9\n",
    );
    const output = await run(
      [
        "eval",
        "eval.yaml",
        "--cwd",
        "../..",
        "--config",
        "custom.yaml",
        "--agent",
        "codex",
        "--threshold",
        "0.9",
        "--json",
      ],
      ctx,
    );
    expect(output.exitCode).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result.policy.threshold).toBe(0.9);
    expect(result.cases[0].selected).toHaveLength(1);
    expect(result.cases[0].selected[0]).toMatchObject({
      name: "react-patterns",
      agent: "codex",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("CLI gates override file gates without changing other fields", async () => {
    const ctx = await fixture(["react-patterns"], ["frontend-testing"], false);
    await write(
      join(ctx.cwd, "eval.yaml"),
      stringify({
        version: 1,
        cases: [
          {
            id: "one",
            prompt: sentinel,
            should: [label("react-patterns")],
            should_not: [label("frontend-testing")],
          },
        ],
        gates: { min_precision: 1, min_recall: 1 },
      }),
    );
    expect((await run(["eval", "eval.yaml"], ctx)).exitCode).toBe(2);
    expect(
      (await run(["eval", "eval.yaml", "--min-precision", "0.5"], ctx))
        .exitCode,
    ).toBe(0);
  });
});

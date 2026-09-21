import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { MAX_HOOK_INPUT_BYTES } from "../../src/hooks/stdin.js";
import { workspace, write } from "../helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("PRIVATE_PROVIDER_ERROR"),
  );
});
afterEach(() => vi.restoreAllMocks());

it.each(["codex", "claude"] as const)(
  "hook %s is silent on valid, future, invalid, oversized and setup-failure inputs",
  async (host) => {
    const ctx = await workspace();
    const data = join(ctx.root, "trace-data");
    const wire = JSON.parse(
      await readFile(
        new URL(`../fixtures/hooks/${host}.json`, import.meta.url),
        "utf8",
      ),
    );
    wire.cwd = ctx.cwd;
    const env = { ...ctx, env: { SKILLDISPATCH_DATA_DIR: data } };
    let output = "";
    const run = async (input: string) =>
      createProgram(
        env,
        {
          stdout: (s) => {
            output += s;
          },
          stderr: (s) => {
            output += s;
          },
        },
        Readable.from([input]),
      ).parseAsync(["hook", host], { from: "user" });
    for (const input of [
      "{invalid",
      JSON.stringify({ ...wire, prompt: undefined }),
      JSON.stringify({ ...wire, hook_event_name: "Stop" }),
      " ".repeat(MAX_HOOK_INPUT_BYTES + 1),
    ])
      await expect(run(input)).resolves.toBeDefined();
    await expect(access(data)).rejects.toThrow();
    // Missing API key is a setup error for route/eval, but a failed trace for hooks.
    await expect(run(JSON.stringify(wire))).resolves.toBeDefined();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router: {provider: mock}\n",
    );
    await expect(
      run(JSON.stringify({ ...wire, future_field: { arbitrary: true } })),
    ).resolves.toBeDefined();
    const text = await readFile(join(data, "traces.jsonl"), "utf8");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).outcome),
    ).toEqual(["failed", "complete"]);
    expect(text).not.toContain(wire.prompt);
    expect(output).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("does not persist anything for discover, route or eval even with telemetry enabled", async () => {
  const ctx = await workspace();
  const data = join(ctx.root, "trace-data");
  await write(
    join(ctx.cwd, ".skilldispatch.yaml"),
    "router: {provider: mock}\ntelemetry: {enabled: true, prompt: raw}\n",
  );
  const file = join(ctx.root, "eval.yaml");
  await write(
    file,
    "version: 1\ncases:\n  - id: no-expectation\n    prompt: PRIVATE_PROMPT\n",
  );
  for (const args of [
    ["discover", "--json"],
    ["route", "PRIVATE_PROMPT", "--json"],
    ["eval", file, "--json"],
  ]) {
    await createProgram(
      { ...ctx, env: { SKILLDISPATCH_DATA_DIR: data } },
      { stdout: () => {}, stderr: () => {} },
    ).parseAsync(args, { from: "user" });
  }
  await expect(access(data)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("documents the hook and both hosts in CLI help", async () => {
  const ctx = await workspace();
  let output = "";
  for (const args of [["--help"], ["hook", "--help"]]) {
    await expect(
      createProgram(ctx, {
        stdout: (s) => {
          output += s;
        },
        stderr: () => {},
      }).parseAsync(args, { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 0 });
  }
  expect(output).toContain("hook");
  expect(output).toContain("codex");
  expect(output).toContain("claude");
});

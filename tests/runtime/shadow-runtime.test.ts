import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspace, write } from "../helpers.js";
import { schemaValidator } from "../telemetry/helpers.js";

let output: string;
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "skilldispatch-shadow-runtime-"));
  await build({
    entry: {
      fixture: "tests/runtime/fixtures/shadow-child.ts",
      cli: "src/cli/index.ts",
    },
    outDir: output,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    target: "node20",
    // Commander is CJS; supply Node require only in the standalone test bundle.
    banner: {
      js: 'import { createRequire as testRequire } from "node:module"; const require = testRequire(import.meta.url);',
    },
    noExternal: ["@typesafe-ai/sdk", "zod", "yaml", "commander", "smol-toml"],
    silent: true,
    config: false,
  });
});
afterAll(async () => {
  if (output) await rm(output, { recursive: true, force: true });
});

function child(entry: string, args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [
          "--unhandled-rejections=strict",
          join(output, `${entry}.mjs`),
          ...args,
        ],
        { env: { PATH: process.env.PATH }, stdio: "pipe" },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("Child timed out."));
      }, 6500);
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      proc.stdin.on("error", () => {}); // Oversize input can legitimately close its pipe early.
      if (input !== undefined) proc.stdin.end(input);
    },
  );
}

describe("shadow hooks in strict child processes", () => {
  it.each(["codex", "claude"] as const)(
    "%s exits 0, writes a valid trace, and remains silent on missing credentials",
    async (host) => {
      const ctx = await workspace();
      const wire = JSON.parse(
        await readFile(
          new URL(`../fixtures/hooks/${host}.json`, import.meta.url),
          "utf8",
        ),
      );
      wire.cwd = ctx.cwd;
      const args = [host, ctx.root, ctx.cwd, ctx.home];
      await write(
        join(ctx.cwd, ".skilldispatch.yaml"),
        "router: {provider: mock}\n",
      );
      expect(await child("fixture", args, JSON.stringify(wire))).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      await write(
        join(ctx.cwd, ".skilldispatch.yaml"),
        "router: {provider: jev}\n",
      );
      expect(await child("fixture", args, JSON.stringify(wire))).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      const text = await readFile(
        join(ctx.root, "private-data/traces.jsonl"),
        "utf8",
      );
      const lines = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const valid = await schemaValidator();
      expect(lines.every((trace) => valid(trace))).toBe(true);
      expect(lines.map((trace) => trace.outcome)).toEqual([
        "complete",
        "failed",
      ]);
      expect(text).not.toContain(wire.prompt);
      expect(text).not.toContain(wire.transcript_path);
    },
  );

  it.each(["codex", "claude"] as const)(
    "production %s CLI exits 0 for malformed, oversized and stalled stdin",
    async (host) => {
      for (const input of ["{", " ".repeat(1024 * 1024 + 1), undefined]) {
        expect(await child("cli", ["hook", host], input)).toEqual({
          code: 0,
          stdout: "",
          stderr: "",
        });
      }
    },
  );

  it("publishes one complete key and appends whole lines across concurrent processes", async () => {
    const ctx = await workspace();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        child("fixture", ["storage", ctx.root, ctx.cwd, ctx.home], ""),
      ),
    );
    for (const result of results)
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const data = join(ctx.root, "private-data");
    expect(await readdir(data)).toEqual(["install.key", "traces.jsonl"]);
    expect((await readFile(join(data, "install.key"))).byteLength).toBe(32);
    const text = await readFile(join(data, "traces.jsonl"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const traces = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(traces).toHaveLength(12);
    expect(new Set(traces.map((trace) => trace.prompt.hash)).size).toBe(1);
    expect(new Set(traces.map((trace) => trace.host.sessionKey)).size).toBe(1);
    expect(new Set(traces.map((trace) => trace.traceId)).size).toBe(12);
    const valid = await schemaValidator();
    expect(traces.every((trace) => valid(trace))).toBe(true);
    expect(text).not.toMatch(
      /PRIVATE_CHILD_PROMPT|PRIVATE_SESSION|synthetic-api-key/,
    );
  });
});

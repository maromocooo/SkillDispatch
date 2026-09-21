import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
let output: string;
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "skilldispatch-runtime-"));
  await build({
    entry: ["tests/runtime/fixtures/jev-child.ts"],
    outDir: output,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    target: "node20",
    noExternal: ["@typesafe-ai/sdk", "zod"],
    silent: true,
    config: false,
  });
});
afterAll(async () => {
  if (output) await rm(output, { recursive: true, force: true });
});

describe("real SDK with loopback HTTP in a strict child process", () => {
  it.each(["healthy", "cancel", "timeout", "before-headers"])(
    "exits 0 after %s on the current Node runtime",
    async (mode) => {
      const result = await run(
        process.execPath,
        ["--unhandled-rejections=strict", join(output, "jev-child.mjs"), mode],
        {
          timeout: 8000,
          env: { PATH: process.env.PATH, TYPESAFE_LOG_LEVEL: "debug" },
        },
      );
      expect(result.stdout).toBe("runtime fixture passed\n");
      expect(result.stderr).toBe("");
    },
  );
});

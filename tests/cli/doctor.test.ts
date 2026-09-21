import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliEnvironment } from "../../src/cli/context.js";
import { createProgram } from "../../src/cli/program.js";
import { workspace, write } from "../helpers.js";
import { traceFixture } from "../telemetry/helpers.js";

afterEach(() => vi.unstubAllGlobals());
async function run(args: string[], environment: CliEnvironment) {
  let stdout = "",
    stderr = "",
    exit = 0;
  try {
    await createProgram(environment, {
      stdout: (t) => {
        stdout += t;
      },
      stderr: (t) => {
        stderr += t;
      },
    }).parseAsync(args, { from: "user" });
  } catch (error) {
    exit = (error as { exitCode: number }).exitCode;
  }
  return { stdout, stderr, exit };
}
describe("doctor CLI", () => {
  it.each([{ flags: [] }, { flags: ["--json"] }])(
    "protects prompt, correlation, secrets and skill paths %j",
    async ({ flags }) => {
      const ctx = await workspace();
      const directory = join(ctx.root, "data");
      await mkdir(directory, { mode: 0o700 });
      const raw = traceFixture();
      raw.prompt = { storage: "raw", raw: "PRIVATE_RAW_PROMPT_SENTINEL" };
      const hash = traceFixture();
      const path = join(directory, "traces.jsonl");
      const source = `${JSON.stringify(raw)}\n${JSON.stringify(hash)}\n`;
      await writeFile(path, source, { mode: 0o600 });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const result = await run(["doctor", ...flags], {
        ...ctx,
        env: {
          SKILLDISPATCH_DATA_DIR: directory,
          TYPESAFE_API_KEY: "PRIVATE_API_KEY_SENTINEL",
        },
      });
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(
        /PRIVATE_|sessionKey|promptKey|SKILL.md/,
      );
      for (const secret of [
        raw.host.sessionKey,
        raw.host.promptKey,
        hash.prompt.storage === "hash" ? hash.prompt.hash : undefined,
      ])
        if (secret) expect(result.stdout).not.toContain(secret);
      if (flags.length)
        expect(Object.keys(JSON.parse(result.stdout))).toEqual([
          "version",
          "usable",
          "checks",
        ]);
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(source);
    },
  );
  it("warns with exit 0 for missing credentials, fails with exit 1 for malformed config", async () => {
    const ctx = await workspace();
    const result = await run(["doctor", "--json"], ctx);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout).usable).toBe(true);
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "router: [PRIVATE_ERROR\n",
    );
    const failed = await run(["doctor", "--json"], ctx);
    expect(failed.exit).toBe(1);
    expect(JSON.parse(failed.stdout).usable).toBe(false);
    expect(failed.stdout + failed.stderr).not.toContain("PRIVATE_ERROR");
  });
});

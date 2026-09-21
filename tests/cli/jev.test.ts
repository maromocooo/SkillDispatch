import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliEnvironment } from "../../src/cli/context.js";
import { createProgram } from "../../src/cli/program.js";
import { workspace, write } from "../helpers.js";

async function run(environment: CliEnvironment, json = false) {
  let stdout = "";
  let stderr = "";
  const program = createProgram(environment, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  await program.parseAsync(
    ["route", "private-prompt-sentinel", ...(json ? ["--json"] : [])],
    { from: "user" },
  );
  return { stdout, stderr };
}

beforeEach(() => {
  // No CLI test can accidentally call the real API.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("synthetic-api-key private-prompt-sentinel secret-looking-error"),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Jev CLI composition", () => {
  it("defaults to Jev, reports the actual model and preserves routing JSON", async () => {
    const ctx = await workspace();
    vi.mocked(fetch).mockImplementation(async (_, init) => {
      const { questions } = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { type: "noul", noul: 0.96 },
            ]),
          ),
        }),
      );
    });
    const environment = {
      ...ctx,
      env: { TYPESAFE_API_KEY: "synthetic-api-key" },
    };
    const result = JSON.parse((await run(environment, true)).stdout);
    expect(result.router).toMatchObject({
      provider: "jev",
      model: "jev-1.13.0",
      latencyMs: expect.any(Number),
    });
    expect(result.selected).toHaveLength(4);
    expect(result.allDecisions.length).toBeGreaterThanOrEqual(4);
    const output = await run(environment);
    expect(output.stdout).toContain("Provider: jev\nModel: jev-1.13.0\n");
    expect(output.stdout).not.toContain("offline mock");
    expect(JSON.stringify(result)).not.toContain("private-prompt-sentinel");
  });

  it.each([false, true])(
    "fails open without a mock fallback or leaking SDK errors (json=%s)",
    async (json) => {
      vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
      const output = await run(
        {
          ...(await workspace()),
          env: { TYPESAFE_API_KEY: "synthetic-api-key" },
        },
        json,
      );
      const combined = output.stdout + output.stderr;
      expect(combined).not.toMatch(
        /synthetic-api-key|private-prompt-sentinel|secret-looking-error/,
      );
      expect(combined).toContain("jev_request_failed");
      expect(combined).not.toContain("offline mock");
      if (json) {
        const result = JSON.parse(output.stdout);
        expect(result.router.provider).toBe("jev");
        expect(result.selected).toEqual([]);
        expect(result.allDecisions).toEqual([]);
        expect(
          result.diagnostics.some(
            (diagnostic: { code: string }) =>
              diagnostic.code === "provider_partial",
          ),
        ).toBe(true);
      }
    },
  );

  it.each([undefined, "", " ", "synthetic-api-key\ninvalid"])(
    "rejects credentials safely before fetching (%#)",
    async (apiKey) => {
      const environment = {
        ...(await workspace()),
        env: { TYPESAFE_API_KEY: apiKey },
      };
      await expect(run(environment)).rejects.toThrow(
        /TYPESAFE_API_KEY (is required|has an invalid format)/,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps discovery offline and usable without credentials", async () => {
    const program = createProgram(await workspace(), {
      stdout: () => {},
      stderr: () => {},
    });
    await program.parseAsync(["discover", "--json"], { from: "user" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses mock only when configured explicitly", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "router:\n  provider: mock\n  mock:\n    defaultProbability: 0.95\n",
    );
    const result = JSON.parse((await run(ctx, true)).stdout);
    expect(result.router.provider).toBe("mock");
    expect(result.selected).toHaveLength(4);
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import type { RouteTrace } from "../../src/telemetry/types.js";
import { workspace, write } from "../helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("EXTERNAL_NETWORK_FORBIDDEN"),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(host: "codex" | "claude") {
  const ctx = await workspace();
  const wire = JSON.parse(
    await readFile(
      new URL(`../fixtures/hooks/${host}.json`, import.meta.url),
      "utf8",
    ),
  );
  wire.cwd = ctx.cwd;
  const data = join(ctx.root, "private-data");
  const userConfig = join(ctx.home, ".config/skilldispatch/config.yaml");
  const projectConfig = join(ctx.cwd, ".skilldispatch.yaml");
  const run = async (apiKey?: string) => {
    let output = "";
    await createProgram(
      {
        ...ctx,
        cwd: ctx.root,
        env: {
          SKILLDISPATCH_DATA_DIR: data,
          ...(apiKey === undefined ? {} : { TYPESAFE_API_KEY: apiKey }),
        },
      },
      {
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          output += text;
        },
      },
      Readable.from([JSON.stringify(wire)]),
    ).parseAsync(["hook", host], { from: "user" });
    expect(output).toBe("");
  };
  const trace = async (
    path = join(data, "traces.jsonl"),
  ): Promise<RouteTrace> => JSON.parse(await readFile(path, "utf8"));
  return { ctx, wire, data, userConfig, projectConfig, run, trace };
}

describe.each(["codex", "claude"] as const)(
  "%s hook trust boundary",
  (host) => {
    it.each([false, true])(
      "ignores project raw storage/provider/private path, including self-trust=%s",
      async (selfTrust) => {
        const f = await setup(host);
        const privateFile = join(f.ctx.root, "private-existing-file");
        const sentinel = "PRIVATE_EXISTING_FILE_SENTINEL";
        await writeFile(privateFile, sentinel, { mode: 0o600 });
        const before = await stat(privateFile);
        await write(
          f.projectConfig,
          `hook: {trustProjectConfig: ${selfTrust}}\ntelemetry:\n  tracePath: ${privateFile}\n  prompt: raw\nrouter: {provider: mock}\n`,
        );
        await f.run(); // No user config: secure defaults, Jev setup fails without a key.
        expect(await readFile(privateFile, "utf8")).toBe(sentinel);
        expect((await stat(privateFile)).mtimeMs).toBe(before.mtimeMs);
        expect((await stat(privateFile)).mode & 0o777).toBe(0o600);
        const trace = await f.trace();
        expect(trace).toMatchObject({
          router: { provider: "jev" },
          prompt: { storage: "hash" },
          outcome: "failed",
        });
        expect(trace.catalog.enabledSkillCount).toBeGreaterThan(0); // Skills still discovered from hook CWD.
        expect(
          trace.diagnostics.some((d) => d.code === "provider_setup_failed"),
        ).toBe(true);
        expect(JSON.stringify(trace)).not.toContain(f.wire.prompt);
        expect(fetch).not.toHaveBeenCalled();
      },
    );

    it("keeps provider and persistence user-owned even with explicit project trust", async () => {
      const f = await setup(host);
      const path = join(f.ctx.root, "trusted-traces/events.jsonl");
      await write(
        f.userConfig,
        "hook: {trustProjectConfig: true}\nrouter: {provider: mock, mock: {defaultProbability: 0.95}}\n",
      );
      await write(
        f.projectConfig,
        `router:\n  provider: mock\n  mock: {defaultProbability: 0.95}\ntelemetry:\n  tracePath: ${path}\n  prompt: raw\n`,
      );
      await f.run();
      const trace = await f.trace();
      expect(trace).toMatchObject({
        router: { provider: "mock" },
        outcome: "complete",
        prompt: { storage: "hash" },
      });
      expect(
        trace.decisions.some(
          (s) =>
            s.scope === "repo" &&
            s.name ===
              (host === "codex" ? "frontend-testing" : "accessibility-review"),
        ),
      ).toBe(true);
      expect(
        trace.decisions.every(
          (s) => s.agent === (host === "codex" ? "codex" : "claude-code"),
        ),
      ).toBe(true);
      await expect(f.trace(path)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("does not let a project re-enable user-disabled routing/telemetry", async () => {
      const f = await setup(host);
      await write(f.userConfig, "telemetry: {enabled: false}\n");
      await write(
        f.projectConfig,
        "hook: {trustProjectConfig: true}\ntelemetry: {enabled: true, prompt: raw}\nrouter: {provider: jev}\n",
      );
      await f.run("synthetic-api-key");
      await expect(access(f.data)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("cannot switch a user's offline provider to Jev or change policy/privacy", async () => {
      const f = await setup(host);
      await write(
        f.userConfig,
        "router: {provider: mock}\ntelemetry: {prompt: none}\npolicy: {threshold: 0.8}\n",
      );
      await write(
        f.projectConfig,
        "router: {provider: jev}\ntelemetry: {prompt: raw}\npolicy: {threshold: 0}\n",
      );
      await f.run("synthetic-api-key");
      expect(await f.trace()).toMatchObject({
        router: { provider: "mock" },
        policy: { threshold: 0.8 },
        prompt: { storage: "none" },
        outcome: "complete",
      });
      expect(fetch).not.toHaveBeenCalled();
    });
  },
);

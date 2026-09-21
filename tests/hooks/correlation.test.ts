import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { parseClaudeInput } from "../../src/hooks/claude.js";
import { keyedHash } from "../../src/telemetry/privacy.js";
import type { RouteTrace } from "../../src/telemetry/types.js";
import { workspace, write } from "../helpers.js";
import { schemaValidator } from "../telemetry/helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("EXTERNAL_NETWORK_FORBIDDEN"),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const ctx = await workspace();
  await write(
    join(ctx.home, ".config/skilldispatch/config.yaml"),
    "router: {provider: mock}\n",
  );
  const data = join(ctx.root, "private-data");
  const run = async (host: "codex" | "claude", id?: string) => {
    const wire = JSON.parse(
      await readFile(
        new URL(`../fixtures/hooks/${host}.json`, import.meta.url),
        "utf8",
      ),
    );
    wire.cwd = ctx.cwd;
    wire.session_id = "PRIVATE_COMMON_HOST_SESSION";
    const field = host === "codex" ? "turn_id" : "prompt_id";
    if (id === undefined) delete wire[field];
    else wire[field] = id;
    let output = "";
    await createProgram(
      { ...ctx, env: { SKILLDISPATCH_DATA_DIR: data } },
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
    expect(fetch).not.toHaveBeenCalled();
  };
  return {
    run,
    key: () => readFile(join(data, "install.key")),
    traces: async (): Promise<RouteTrace[]> =>
      (await readFile(join(data, "traces.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

describe("host-neutral prompt submission correlation", () => {
  it.each(["codex", "claude"] as const)(
    "maps the supplied %s ID without storing it raw",
    async (host) => {
      const f = await setup();
      const id = "PRIVATE_HOST_SUBMISSION_X";
      await f.run(host, id);
      const [trace] = await f.traces();
      const agent = host === "codex" ? "codex" : "claude-code";
      expect(trace?.host.promptKey).toBe(
        keyedHash(await f.key(), "host-prompt", `${agent}\0${id}`),
      );
      expect(trace?.host).not.toHaveProperty("turnKey");
      expect(JSON.stringify(trace)).not.toMatch(/PRIVATE_|turn_id|prompt_id/);
      expect((await schemaValidator())(trace)).toBe(true);
    },
  );

  it("keeps legacy Claude working without inventing a submission key", async () => {
    const f = await setup();
    await f.run("claude");
    const [trace] = await f.traces();
    expect(trace?.outcome).toBe("complete");
    expect(trace?.host).not.toHaveProperty("promptKey");
    expect(trace?.host.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await schemaValidator())(trace)).toBe(true);
  });

  it.each(["codex", "claude"] as const)(
    "separates repeated text from distinct %s submissions",
    async (host) => {
      const f = await setup();
      await f.run(host, "PRIVATE_FIRST_ID");
      await f.run(host, "PRIVATE_SECOND_ID");
      await f.run(host, "PRIVATE_SECOND_ID");
      const [first, second, repeated] = await f.traces();
      expect(first?.prompt).toEqual(second?.prompt);
      expect(first?.host.sessionKey).toBe(second?.host.sessionKey);
      expect(first?.host.promptKey).not.toBe(second?.host.promptKey);
      expect(second?.host.promptKey).toBe(repeated?.host.promptKey);
    },
  );

  it("separates hosts and HMAC domains even when literal IDs are equal", async () => {
    const f = await setup();
    await f.run("codex", "PRIVATE_COMMON_HOST_SESSION");
    await f.run("claude", "PRIVATE_COMMON_HOST_SESSION");
    const [codex, claude] = await f.traces();
    expect(codex?.host.promptKey).not.toBe(claude?.host.promptKey);
    expect(codex?.prompt).toEqual(claude?.prompt);
    expect(codex?.host.promptKey).not.toBe(codex?.host.sessionKey);
    expect(codex?.host.promptKey).not.toBe(
      keyedHash(await f.key(), "prompt", "codex\0PRIVATE_COMMON_HOST_SESSION"),
    );
  });

  it("rejects blank or wrongly typed Claude prompt IDs and ignores future fields", async () => {
    const wire = JSON.parse(
      await readFile(
        new URL("../fixtures/hooks/claude.json", import.meta.url),
        "utf8",
      ),
    );
    for (const value of ["", null, 42, {}])
      expect(parseClaudeInput({ ...wire, prompt_id: value })).toBeUndefined();
    expect(
      parseClaudeInput({ ...wire, future_correlation: "ignored" })
        ?.promptCorrelationId,
    ).toBe(wire.prompt_id);
  });
});

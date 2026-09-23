import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { catalogFingerprint } from "../../src/telemetry/fingerprint.js";
import { keyedHash } from "../../src/telemetry/privacy.js";
import { createRouteTrace } from "../../src/telemetry/trace.js";
import { routeTraceSchema, routeTraceV1Schema } from "../../src/telemetry/types.js";
import {
  digest,
  schemaValidator,
  skill,
  traceFixture,
  traceInput,
} from "./helpers.js";

describe("route trace v1 privacy and schema", () => {
  it("defaults to keyed hashing and emits only allowlisted fields", async () => {
    const trace = traceFixture();
    expect(trace.prompt).toEqual({
      storage: "hash",
      hash: keyedHash(Buffer.alloc(32, 1), "prompt", "PRIVATE_PROMPT_SENTINEL"),
    });
    expect(JSON.stringify(trace)).not.toMatch(
      /PRIVATE_|synthetic-api-key|reasonCode|description|directory|transcript_path|stack|message/,
    );
    expect(trace.outcome).toBe("complete");
    expect(trace.decisions[0]).toMatchObject({
      agent: "codex",
      scope: "repo",
      contentHash: digest("content:react"),
      selected: true,
    });
    expect((await schemaValidator())(trace)).toBe(true);
  });
  it.each(["none", "raw"] as const)(
    "supports explicit prompt storage %s",
    async (promptStorage) => {
      const trace = createRouteTrace({ ...traceInput(), promptStorage });
      expect(trace.prompt).toEqual(
        promptStorage === "none"
          ? { storage: "none" }
          : { storage: "raw", raw: "PRIVATE_PROMPT_SENTINEL" },
      );
      expect((await schemaValidator())(trace)).toBe(true);
    },
  );
  it("uses stable installation-specific and domain-separated HMACs", () => {
    const key = Buffer.alloc(32, 1);
    expect(keyedHash(key, "prompt", "same")).toBe(
      keyedHash(key, "prompt", "same"),
    );
    expect(keyedHash(key, "prompt", "same")).not.toBe(
      keyedHash(Buffer.alloc(32, 2), "prompt", "same"),
    );
    expect(
      new Set(
        ["prompt", "session", "host-prompt"].map((domain) =>
          keyedHash(
            key,
            domain as "prompt" | "session" | "host-prompt",
            "same",
          ),
        ),
      ).size,
    ).toBe(3);
    expect(() => keyedHash(Buffer.alloc(31), "prompt", "same")).toThrow(
      "Invalid installation key",
    );
    expect(
      createRouteTrace({ ...traceInput(), agent: "claude-code" }).host
        .sessionKey,
    ).not.toBe(traceFixture().host.sessionKey);
  });
  it.each([
    "provider_failed",
    "provider_timeout",
    "invalid_provider_response",
    "provider_setup_failed",
    "hook_runtime_failed",
    "provider_partial",
  ])("classifies %s without persisting messages", (code) => {
    const input = traceInput();
    const diagnostic = input.result.diagnostics[0];
    if (!diagnostic) throw new Error("Missing fixture");
    input.result.diagnostics[0] = { ...diagnostic, code };
    expect(createRouteTrace(input).outcome).toBe(
      code === "provider_partial" ? "partial" : "failed",
    );
  });
  it("does not invent model/prompt-submission metadata and discards unsafe model strings", () => {
    const input = traceInput();
    const trace = createRouteTrace({
      ...input,
      hostModel: "/PRIVATE_MODEL_PATH",
      result: {
        ...input.result,
        router: {
          provider: "mock",
          model: "PRIVATE_MODEL\nsecret",
          latencyMs: 0,
        },
      },
    });
    expect(trace.host.model).toBeUndefined();
    expect(trace.router.model).toBeUndefined();
    const {
      promptCorrelationId: _submission,
      hostModel: _model,
      ...without
    } = input;
    expect(createRouteTrace(without).host.promptKey).toBeUndefined();
  });
  it("has no runtime/JSON Schema drift", async () => {
    const shipped = JSON.parse(
      await readFile(
        new URL("../../schemas/route-trace.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(shipped).toEqual(
      z.toJSONSchema(routeTraceV1Schema, { target: "draft-2020-12" }),
    );
  });
  it.each([
    { cwd: "/private" },
    { mode: "enforce" },
    { schemaVersion: "99.0" },
    { prompt: { storage: "none", hash: digest("x") } },
    { prompt: { storage: "hash", raw: "private" } },
    {
      diagnostics: [{ code: "warning", level: "warning", message: "private" }],
    },
    { host: { event: "UserPromptSubmit", session_id: "raw" } },
    { host: { event: "UserPromptSubmit", turnKey: digest("retired") } },
  ])(
    "rejects extra fields and invalid privacy combinations %#",
    async (extra) => {
      const value = { ...traceFixture(), ...extra };
      expect(routeTraceSchema.safeParse(value).success).toBe(false);
      expect((await schemaValidator())(value)).toBe(false);
    },
  );
});

describe("path-independent catalog fingerprint", () => {
  it("is order independent and preserves duplicate multiplicity", () => {
    const a = skill("ä"),
      b = skill("Z");
    expect(catalogFingerprint([a, b])).toBe(catalogFingerprint([b, a]));
    expect(catalogFingerprint([a, a, b])).not.toBe(catalogFingerprint([a, b]));
    expect(catalogFingerprint([])).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { contentHash: digest("changed") },
    { enabled: false },
    { agent: "claude-code" as const },
    { scope: "user" as const },
    { name: "different" },
  ])("changes when semantic fields change %#", (extra) =>
    expect(catalogFingerprint([skill()])).not.toBe(
      catalogFingerprint([skill("react", extra)]),
    ),
  );
  it("ignores path-derived identity and arbitrary metadata but normalizes name whitespace", () => {
    expect(catalogFingerprint([skill("react patterns")])).toBe(
      catalogFingerprint([
        skill(" react  patterns ", {
          id: digest("moved"),
          path: "/moved/SKILL.md",
          directory: "/moved",
          contentHash: digest("content:react patterns"),
          metadata: { other: true },
        }),
      ]),
    );
  });
});

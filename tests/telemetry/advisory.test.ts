import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listTraces,
  showTrace,
  summarizeTraces,
} from "../../src/telemetry/analytics.js";
import { JsonlTraceSink } from "../../src/telemetry/jsonl.js";
import { JsonlTraceReader } from "../../src/telemetry/reader.js";
import { createRouteTrace } from "../../src/telemetry/trace.js";
import { routeTraceSchema } from "../../src/telemetry/types.js";
import { workspace } from "../helpers.js";
import { schemaValidator, traceFixture, traceInput } from "./helpers.js";

describe("backward compatible advisory traces", () => {
  it("keeps old shadow traces without delivery valid", async () => {
    const old = traceFixture();
    expect(old).not.toHaveProperty("delivery");
    expect(routeTraceSchema.safeParse(old).success).toBe(true);
    expect((await schemaValidator())(old)).toBe(true);
  });
  it("validates optional delivery against Zod and shipped JSON Schema", async () => {
    const input = traceInput();
    const trace = createRouteTrace({
      ...input,
      agent: "claude-code",
      mode: "advisory",
      delivery: {
        kind: "claude-advisory",
        injectedSkillIds: [input.skills[0]?.id ?? ""],
      },
    });
    const validate = await schemaValidator();
    expect(validate(trace)).toBe(true);
    for (const delivery of [
      { kind: "invalid", injectedSkillIds: [] },
      { kind: "none", injectedSkillIds: ["bad"] },
      { kind: "none", injectedSkillIds: [], context: "PRIVATE_CONTEXT" },
    ]) {
      expect(validate({ ...trace, delivery })).toBe(false);
      expect(routeTraceSchema.safeParse({ ...trace, delivery }).success).toBe(
        false,
      );
    }
  });
  it("streams mixed old/new records and separates recommendations from injections", async () => {
    const ctx = await workspace();
    const path = join(ctx.root, "traces.jsonl");
    const sink = new JsonlTraceSink(path);
    const old = traceFixture();
    const positive = {
      ...traceFixture(),
      mode: "advisory" as const,
      agent: "claude-code" as const,
      delivery: {
        kind: "claude-advisory" as const,
        injectedSkillIds: [old.decisions[0]?.skillId ?? ""],
      },
    };
    const withheld = {
      ...traceFixture(),
      mode: "advisory" as const,
      agent: "claude-code" as const,
      delivery: { kind: "none" as const, injectedSkillIds: [] },
    };
    for (const t of [old, positive, withheld]) await sink.write(t);
    const reader = new JsonlTraceReader(path, []);
    expect(await summarizeTraces(reader)).toMatchObject({
      validTraces: 3,
      invalidLines: 0,
      modes: { shadow: 1, advisory: 2 },
      advisory: { recommendedCount: 2, injectedCount: 1 },
      averageSelectedSkills: 1,
    });
    expect((await listTraces(reader)).traces).toHaveLength(3);
    expect(
      (await showTrace(reader, positive.traceId)).trace.decisions[0],
    ).toMatchObject({ selected: true, injected: true });
    expect(
      (await showTrace(reader, withheld.traceId)).trace.decisions[0],
    ).toMatchObject({ selected: true, injected: false });
    expect(await readFile(path, "utf8")).not.toMatch(
      /PRIVATE_|additionalContext/,
    );
  });
});

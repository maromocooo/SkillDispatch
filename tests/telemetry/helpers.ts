import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type { SkillDescriptor } from "../../src/core/types.js";
import { createRouteTrace } from "../../src/telemetry/trace.js";

export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const skill = (
  name = "react",
  overrides: Partial<SkillDescriptor> = {},
): SkillDescriptor => ({
  id: digest(name),
  name,
  description: "PRIVATE_DESCRIPTION",
  path: "/PRIVATE_SKILL_PATH/SKILL.md",
  directory: "/PRIVATE_SKILL_PATH",
  agent: "codex",
  scope: "repo",
  enabled: true,
  metadata: { body: "PRIVATE_BODY" },
  contentHash: digest(`content:${name}`),
  ...overrides,
});
export const traceInput = () => ({
  agent: "codex" as const,
  prompt: "PRIVATE_PROMPT_SENTINEL",
  sessionId: "PRIVATE_SESSION",
  promptCorrelationId: "PRIVATE_TURN",
  hostModel: "gpt-fixture",
  key: Buffer.alloc(32, 1),
  skills: [skill()],
  result: {
    selected: [],
    allDecisions: [
      {
        skillId: skill().id,
        name: "react",
        probability: 0.9,
        selected: true,
        reasonCode: "PRIVATE_REASON",
      },
    ],
    router: { provider: "mock", model: "mock-fixture", latencyMs: 10 },
    policy: { threshold: 0.75, maxSkills: 4 },
    diagnostics: [
      {
        code: "fixture_warning",
        level: "warning" as const,
        message: "PRIVATE_SDK_ERROR synthetic-api-key",
        path: "/PRIVATE_DIAGNOSTIC_PATH",
        skillIds: [skill().id],
      },
    ],
  },
});
export const traceFixture = () => createRouteTrace(traceInput());
export async function schemaValidator() {
  const schema = JSON.parse(
    await readFile(
      new URL("../../schemas/route-trace.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat("uuid", fullFormats.uuid);
  ajv.addFormat("date-time", fullFormats["date-time"]);
  const next = JSON.parse(
    await readFile(
      new URL("../../schemas/route-trace-next.schema.json", import.meta.url),
      "utf8",
    ),
  );
  return ajv.compile({ oneOf: [schema, next] });
}

import { join } from "node:path";
import { createProgram } from "../../../src/cli/program.js";
import { JsonlTraceSink } from "../../../src/telemetry/jsonl.js";
import { installationKey } from "../../../src/telemetry/storage.js";
import { createRouteTrace } from "../../../src/telemetry/trace.js";

const [mode, root, cwd, home] = process.argv.slice(2);
if (!mode || !root || !cwd || !home) throw new Error("Invalid test arguments.");
// Fail closed for test networking. This child can never call the external API.
globalThis.fetch = async () => {
  throw new Error("PRIVATE_CHILD_SDK_ERROR synthetic-api-key");
};
const data = join(root, "private-data");
if (mode === "storage") {
  const key = await installationKey(data);
  await new JsonlTraceSink(join(data, "traces.jsonl")).write(
    createRouteTrace({
      agent: "codex",
      prompt: "PRIVATE_CHILD_PROMPT",
      sessionId: "PRIVATE_SESSION",
      key,
      skills: [],
      result: {
        selected: [],
        allDecisions: [],
        router: { provider: "mock", latencyMs: 0 },
        policy: { threshold: 0.75, maxSkills: 4 },
        diagnostics: [],
      },
    }),
  );
} else {
  await createProgram(
    { cwd, home, env: { SKILLDISPATCH_DATA_DIR: data } },
    {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    },
  ).parseAsync(["hook", mode], { from: "user" });
}

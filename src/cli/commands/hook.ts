import type { Readable } from "node:stream";
import { parseClaudeInput } from "../../hooks/claude.js";
import { parseCodexInput } from "../../hooks/codex.js";
import { runHook } from "../../hooks/runtime.js";
import { readHookJson } from "../../hooks/stdin.js";
import { invocationPersistenceReady } from "../../observability/readiness.js";
import { resolveExecution } from "../../registration/command.js";
import {
  inspectRegistration,
  routingRegistrationIssues,
} from "../../registration/inspect.js";
import type { CliEnvironment } from "../context.js";
import type { CliIO } from "../output.js";

export async function hookCommand(
  host: "codex" | "claude",
  environment: CliEnvironment,
  stdin: Readable,
  io: CliIO,
): Promise<void> {
  try {
    const raw = await readHookJson(stdin);
    const input =
      host === "codex" ? parseCodexInput(raw) : parseClaudeInput(raw);
    if (input) {
      const output = await runHook(input, environment, {
        invocationObserverConfigured: async () => {
          if (host !== "claude" || !environment.execution) return false;
          const execution = await resolveExecution(environment.execution);
          const status = await inspectRegistration(
            "claude",
            environment,
            execution,
          );
          return (
            status.skillObservers?.ready === true &&
            (await invocationPersistenceReady(environment))
          );
        },
        canAdvise: async () => {
          if (!environment.execution) return false;
          const execution = await resolveExecution(environment.execution);
          const status = await inspectRegistration(
            "claude",
            environment,
            execution,
          );
          return (
            status.mode === "advisory" &&
            status.registration === "installed" &&
            status.execution === "sync" &&
            routingRegistrationIssues(status).length === 0
          );
        },
      });
      if (output !== undefined) io.stdout(`${output}\n`);
    }
  } catch {
    /* Host input/output failures must never interrupt a prompt. */
  }
}

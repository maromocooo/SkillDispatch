import { CommanderError } from "commander";
import { runDoctor } from "../../ops/doctor.js";
import type { CliEnvironment } from "../context.js";
import { type CliIO, terminalText } from "../output.js";

export async function doctorCommand(
  options: { json?: boolean },
  environment: CliEnvironment,
  io: CliIO,
): Promise<void> {
  const result = await runDoctor(environment, environment.execution);
  if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const check of result.checks)
      io.stdout(
        `${check.status}\t${check.code}\t${check.detail}${check.value === undefined ? "" : ` ${terminalText(String(check.value))}`}\n`,
      );
    io.stdout(
      result.usable
        ? "Installation usable; warnings may need attention. Routing readiness is reported separately above.\n"
        : "Configuration or installation problems require attention.\n",
    );
  }
  if (!result.usable)
    throw new CommanderError(
      1,
      "doctor_failed",
      "Offline installation checks failed.",
    );
}

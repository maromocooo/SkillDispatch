import {
  type CliEnvironment,
  type CliOptions,
  discoverForCommand,
} from "../context.js";
import { type CliIO, printDiagnostics, terminalText } from "../output.js";

export async function discoverCommand(
  options: CliOptions,
  environment: CliEnvironment,
  io: CliIO,
): Promise<void> {
  const { catalog } = await discoverForCommand(options, environment);
  if (options.json) {
    io.stdout(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }
  io.stdout(`${catalog.skills.length} skills discovered\n`);
  for (const skill of catalog.skills)
    io.stdout(
      `${terminalText(skill.name)}\t${skill.agent}\t${skill.scope}\t${skill.enabled ? "enabled" : "disabled"}\t${terminalText(skill.path)}\n`,
    );
  printDiagnostics(catalog.diagnostics, io);
}

import {
  claudeMetadata,
  claudeOriginCounts,
} from "../../discovery/claude-origin.js";
import {
  codexMetadata,
  codexOriginCounts,
} from "../../discovery/codex-origin.js";
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
  const summary = {
    discovered: catalog.skills.length,
    modelRoutable: catalog.skills.filter((s) => s.enabled).length,
    claudeOrigins: claudeOriginCounts(catalog.skills),
    codexOrigins: codexOriginCounts(catalog.skills),
  };
  if (options.json) {
    io.stdout(`${JSON.stringify({ ...catalog, summary }, null, 2)}\n`);
    return;
  }
  io.stdout(
    `${summary.discovered} skills discovered; ${summary.modelRoutable} model-routable\n`,
  );
  for (const skill of catalog.skills)
    io.stdout(
      `${terminalText(skill.name)}\t${skill.agent}\t${skill.scope}\t${skill.enabled ? "enabled" : "disabled"}\t${terminalText(skill.path)}${codexMetadata(skill) ? `\t${codexMetadata(skill)?.origin} (session unconfirmed)` : ""}${claudeMetadata(skill) ? `\t${claudeMetadata(skill)?.origin}` : ""}\n`,
    );
  for (const [origin, counts] of Object.entries({
    ...Object.fromEntries(
      Object.entries(summary.claudeOrigins).map(([k, v]) => [k, v]),
    ),
    ...Object.fromEntries(
      Object.entries(summary.codexOrigins).map(([k, v]) => [`Codex ${k}`, v]),
    ),
  })) {
    if (counts.discovered)
      io.stdout(
        `Origin ${origin}: ${counts.discovered} discovered, ${counts.modelRoutable} model-routable\n`,
      );
  }
  printDiagnostics(catalog.diagnostics, io);
}

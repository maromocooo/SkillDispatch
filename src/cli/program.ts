import { Command, Option } from "commander";
import { VERSION } from "../version.js";
import { discoverCommand } from "./commands/discover.js";
import { routeCommand } from "./commands/route.js";
import type { CliEnvironment } from "./context.js";
import type { CliIO } from "./output.js";

export function createProgram(environment: CliEnvironment, io: CliIO): Command {
  const program = new Command()
    .name("skilldispatch")
    .description("Universal, observable skill routing for coding agents.")
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  const common = (command: Command) =>
    command
      .addOption(
        new Option(
          "--agent <agent>",
          "restrict discovery to one agent",
        ).choices(["codex", "claude-code"]),
      )
      .option("--json", "write structured JSON to stdout")
      .option(
        "--cwd <directory>",
        "working directory for project skill discovery",
      )
      .option(
        "--config <file>",
        "configuration file applied after user and project config",
      );
  common(
    program
      .command("discover")
      .description("Discover local skills and diagnostics"),
  ).action((options) => discoverCommand(options, environment, io));
  common(
    program
      .command("route")
      .description("Route a prompt with the offline mock provider")
      .argument("<prompt>", "natural-language request"),
  )
    .option(
      "--threshold <probability>",
      "inclusive selection threshold (default: 0.75)",
    )
    .option("--max-skills <count>", "maximum selected skills (default: 4)")
    .action((prompt, options) =>
      routeCommand(prompt, options, environment, io),
    );
  return program;
}

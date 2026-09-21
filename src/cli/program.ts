import { Command, Option } from "commander";
import { VERSION } from "../version.js";
import { discoverCommand } from "./commands/discover.js";
import { evalCommand } from "./commands/eval.js";
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
  const routingOptions = (command: Command) =>
    common(command)
      .option(
        "--threshold <probability>",
        "inclusive selection threshold (default: 0.75)",
      )
      .option("--max-skills <count>", "maximum selected skills (default: 4)");
  common(
    program
      .command("discover")
      .description("Discover local skills and diagnostics"),
  ).action((options) => discoverCommand(options, environment, io));
  routingOptions(
    program
      .command("route")
      .description("Route a prompt with the configured provider (default: Jev)")
      .argument("<prompt>", "natural-language request"),
  ).action((prompt, options) => routeCommand(prompt, options, environment, io));
  routingOptions(
    program
      .command("eval")
      .description("Evaluate routing against a labeled YAML dataset")
      .argument(
        "<file>",
        "eval YAML path relative to the invocation directory",
      ),
  )
    .option(
      "--min-recall <probability>",
      "minimum micro recall for a passing CI gate",
    )
    .option(
      "--min-precision <probability>",
      "minimum labeled micro precision for a passing CI gate",
    )
    .action((file, options) => evalCommand(file, options, environment, io));
  return program;
}

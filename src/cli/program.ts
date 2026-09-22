import type { Readable } from "node:stream";
import { Argument, Command, Option } from "commander";
import { VERSION } from "../version.js";
import { discoverCommand } from "./commands/discover.js";
import { doctorCommand } from "./commands/doctor.js";
import { evalCommand } from "./commands/eval.js";
import { hookCommand } from "./commands/hook.js";
import { hooksMutation, hooksStatus } from "./commands/hooks.js";
import { routeCommand } from "./commands/route.js";
import { tracesCommand } from "./commands/traces.js";
import type { CliEnvironment } from "./context.js";
import type { CliIO } from "./output.js";

export function createProgram(
  environment: CliEnvironment,
  io: CliIO,
  stdin: Readable = process.stdin,
): Command {
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
  const hook = program
    .command("hook")
    .description(
      "Run a silent shadow UserPromptSubmit hook from bounded stdin; never inject context",
    );
  for (const host of ["codex", "claude"] as const)
    hook
      .command(host)
      .description(
        `Shadow route ${host} skills and append a private local trace`,
      )
      .action(() => hookCommand(host, environment, stdin));
  program
    .command("doctor")
    .description(
      "Check local shadow routing readiness offline; no files changed",
    )
    .option("--json", "write privacy-safe JSON")
    .action((options) => doctorCommand(options, environment, io));
  const registrations = program
    .command("hooks")
    .description(
      "Inspect/install/remove user-scope shadow hook registrations offline",
    );
  registrations
    .command("status")
    .addArgument(new Argument("[host]").choices(["codex", "claude"]))
    .option("--json", "write safe registration status JSON")
    .action((host, options) => hooksStatus(host, options, environment, io));
  for (const action of ["install", "uninstall"] as const) {
    const command = registrations
      .command(action)
      .addArgument(new Argument("<host>").choices(["codex", "claude"]))
      .option(
        "--dry-run",
        "show proposed action without writing files, directories or backups",
      );
    if (action === "install")
      command.option(
        "--sync",
        "wait synchronously in the host (default: async shadow)",
      );
    command.action((host, options) =>
      hooksMutation(host, action, options, environment, io),
    );
  }
  const traces = program
    .command("traces")
    .description(
      "Inspect local shadow recommendations without exposing prompts",
    );
  for (const name of ["summary", "list"] as const) {
    const command = traces
      .command(name)
      .description(
        name === "summary"
          ? "Summarize trace health and recommendation statistics"
          : "List the newest matching traces",
      )
      .option("--json", "write privacy-safe JSON")
      .addOption(
        new Option("--agent <agent>", "filter by host").choices([
          "codex",
          "claude-code",
        ]),
      )
      .option(
        "--since <duration>",
        "filter from 1h, 24h, 7d, etc. through now",
      );
    if (name === "list")
      command
        .option("--limit <n>", "maximum results, 1–1000 (default: 20)")
        .addOption(
          new Option(
            "--outcome <outcome>",
            "filter by routing outcome",
          ).choices(["complete", "partial", "failed"]),
        );
    command.action((options) =>
      tracesCommand(name, undefined, options, environment, io),
    );
  }
  traces
    .command("show")
    .description("Inspect one exact trace UUID; prompts remain hidden")
    .argument("<trace-id>")
    .option("--json", "write privacy-safe JSON")
    .action((id, options) =>
      tracesCommand("show", id, options, environment, io),
    );
  return program;
}

import type { Readable } from "node:stream";
import { Argument, Command, Option } from "commander";
import { readHookJson } from "../hooks/stdin.js";
import { observeClaudeSkill } from "../observability/claude-skill-hook.js";
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
      .description("Discover local/native skill catalogs and safe diagnostics"),
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
      "Host stdin entrypoints: routing and local Skill observers (fail-open)",
    );
  for (const host of ["codex", "claude"] as const)
    hook
      .command(host)
      .description(
        host === "codex"
          ? "Shadow route Codex skills; stdout is always empty"
          : "Route Claude skills; user-owned mode controls advisory output",
      )
      .action(() => hookCommand(host, environment, stdin, io));
  hook
    .command("claude-skill")
    .description(
      "Observe a Claude native Skill tool event locally; always silent and fail-open",
    )
    .action(async () => {
      try {
        await observeClaudeSkill(await readHookJson(stdin), environment);
      } catch {
        /* fail open */
      }
    });
  program
    .command("doctor")
    .description("Check local routing readiness offline; no files changed")
    .option("--json", "write privacy-safe JSON")
    .action((options) => doctorCommand(options, environment, io));
  const registrations = program
    .command("hooks")
    .description(
      "Inspect/install/remove user-scope hook registrations offline",
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
        "Claude shadow debug only: wait synchronously (advisory is always sync)",
      );
    command.action((host, options) =>
      hooksMutation(host, action, options, environment, io),
    );
  }
  const traces = program
    .command("traces")
    .description("Inspect local recommendations without exposing prompts");
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
  program.addHelpText(
    "after",
    `
Examples:
  skilldispatch doctor
  skilldispatch discover --agent claude-code
  skilldispatch route "Review this change and add tests"
  skilldispatch hooks install claude --dry-run
  skilldispatch hooks install codex
  skilldispatch traces summary --since 24h
  skilldispatch eval evals.yaml --json

Shadow is the default. Claude advisory requires user configuration.
Jev routing requires TYPESAFE_API_KEY; doctor/status/analytics are offline.
See https://github.com/maromocooo/SkillDispatch#quick-start
`,
  );
  return program;
}

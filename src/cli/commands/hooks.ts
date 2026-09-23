import { CommanderError } from "commander";
import { resolveExecution } from "../../registration/command.js";
import { inspectRegistration } from "../../registration/inspect.js";
import { manageRegistration } from "../../registration/manage.js";
import {
  type Host,
  hosts,
  RegistrationError,
} from "../../registration/types.js";
import type { CliEnvironment } from "../context.js";
import { type CliIO, terminalText } from "../output.js";

export async function hooksStatus(
  host: Host | undefined,
  options: { json?: boolean },
  environment: CliEnvironment,
  io: CliIO,
) {
  let execution = environment.execution;
  if (execution) {
    try {
      execution = await resolveExecution(execution);
    } catch {
      execution = undefined;
    }
  }
  const statuses = await Promise.all(
    (host ? [host] : hosts).map((item) =>
      inspectRegistration(item, environment, execution),
    ),
  );
  const result = { version: 1, hosts: statuses };
  if (options.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else
    for (const status of statuses) {
      io.stdout(
        `${status.host}\tmode: ${status.mode ?? "unknown"}\t${status.registration}\t${status.execution ?? "-"}\nConfig source: ${status.configSource}\n`,
      );
      if (status.skillObservers) {
        io.stdout(
          `Claude Skill observers: ${status.skillObservers.ready ? "installed" : "incomplete"}\n`,
        );
        for (const event of status.skillObservers.events)
          io.stdout(
            `  ${event.event} Skill: ${event.registration} ${event.execution ?? "-"}\n`,
          );
      }
      if (status.instructionObservers) {
        io.stdout(`Codex contract: ${status.codexContract}; host reload/trust unconfirmed
Instruction read observers: ${status.instructionObservers.ready ? "installed" : "incomplete"}
`);
        for (const event of status.instructionObservers.events)
          io.stdout(`  ${event.event} Bash: ${event.registration} ${event.execution ?? "-"}
`);
      }
      if (status.command)
        io.stdout(
          `Command: ${terminalText(status.command.command)}${status.command.args ? ` ${terminalText(JSON.stringify(status.command.args))}` : ""}\n`,
        );
      if (status.issues.includes("hook_execution_mismatch"))
        io.stdout(
          `Configured ${status.mode} requires ${status.expectedExecution}. Re-run: skilldispatch hooks install ${status.host}\n`,
        );
      io.stdout(
        `Issues: ${status.issues.length ? status.issues.join(", ") : "none"}\n`,
      );
    }
  if (statuses.some((s) => s.registration === "conflict"))
    throw new CommanderError(
      1,
      "hook_registration_conflict",
      "Hook registration needs manual attention.",
    );
}
export async function hooksMutation(
  host: Host,
  action: "install" | "uninstall",
  options: { dryRun?: boolean; sync?: boolean },
  environment: CliEnvironment,
  io: CliIO,
) {
  if (!environment.execution)
    throw new RegistrationError("cli_identity_unavailable");
  const result = await manageRegistration(
    host,
    action,
    environment,
    environment.execution,
    options,
  );
  io.stdout(
    `${result.dryRun ? "Dry run: " : ""}${host}: ${result.action}${result.execution ? ` (${result.execution})` : ""}\nConfig: ${terminalText(result.configSource)}\n`,
  );
  if (result.backup)
    io.stdout(
      `${result.dryRun ? "Backup if needed" : "First backup retained"}: ${terminalText(result.backup)}\n`,
    );
  if (action === "install") {
    io.stdout(
      `Command: ${terminalText(result.command.command)}${result.command.args ? ` ${terminalText(JSON.stringify(result.command.args))}` : ""}\n`,
    );
    if (host === "codex")
      io.stdout(
        "Review and trust this registration in Codex /hooks; registration is not host approval.\n",
      );
    io.stdout(
      result.mode === "advisory"
        ? `${host} advisory: synchronous same-turn recommendations. Reload host hooks after changing registration.\n`
        : "Shadow only. Async delivery depends on host lifetime; missing trace does not mean no skill was selected.\n",
    );
  }
}

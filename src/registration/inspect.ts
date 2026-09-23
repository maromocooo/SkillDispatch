import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  codexReadEvents,
  supportedCodexContract,
} from "../hosts/codex-contract.js";
import { invocationEvents } from "../observability/invocation-types.js";
import {
  codexObserverCommand,
  shadowCommand,
  skillObserverCommand,
} from "./command.js";
import { HookDocument, ownsHandler, possibleOtherInstall } from "./document.js";
import { readHostFile } from "./files.js";
import { codexContract, registrationMode } from "./mode.js";
import {
  type CliExecution,
  type HookStatus,
  type Host,
  type RegistrationEnvironment,
  RegistrationError,
} from "./types.js";

export function hostPaths(host: Host, environment: RegistrationEnvironment) {
  if (!isAbsolute(environment.home))
    throw new RegistrationError("invalid_user_home");
  let directory = join(
    environment.home,
    host === "codex" ? ".codex" : ".claude",
  );
  const override =
    environment.env[host === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
  if (host === "codex" && override) {
    if (!isAbsolute(override))
      throw new RegistrationError("invalid_host_directory");
    directory = resolve(override);
  }
  if (override && resolve(override) !== resolve(directory))
    throw new RegistrationError("custom_host_directory_manual_action_required");
  return {
    directory,
    config: join(directory, host === "codex" ? "hooks.json" : "settings.json"),
    toml: join(directory, "config.toml"),
  };
}
export async function checkCodexInline(path: string) {
  const file = await readHostFile(path);
  if (!file) return;
  let parsed: object;
  try {
    parsed = parseToml(
      new TextDecoder("utf8", { fatal: true }).decode(file.bytes),
    );
  } catch {
    throw new RegistrationError("malformed_codex_toml");
  }
  if (Object.hasOwn(parsed, "hooks"))
    throw new RegistrationError("codex_inline_hooks_manual_action_required");
}
export async function loadRegistration(
  host: Host,
  environment: RegistrationEnvironment,
  checkInline = true,
) {
  const paths = hostPaths(host, environment);
  if (host === "codex" && checkInline) await checkCodexInline(paths.toml);
  const snapshot = await readHostFile(paths.config);
  let text: string;
  try {
    text = snapshot
      ? new TextDecoder("utf8", { fatal: true }).decode(snapshot.bytes)
      : "{}\n";
  } catch {
    throw new RegistrationError("malformed_host_json");
  }
  return { paths, snapshot, document: new HookDocument(text) };
}
export async function inspectRegistration(
  host: Host,
  environment: RegistrationEnvironment,
  execution?: CliExecution,
): Promise<HookStatus> {
  const status: HookStatus = {
    host,
    mode: null,
    expectedExecution: null,
    registration: "not-installed",
    execution: null,
    command: null,
    configSource:
      host === "codex" ? "~/.codex/hooks.json" : "~/.claude/settings.json",
    issues: [],
    registrations: 0,
  };
  try {
    status.mode = await registrationMode(host, environment);
    status.expectedExecution = status.mode === "advisory" ? "sync" : "async";
    const { document } = await loadRegistration(host, environment);
    if (!execution) throw new RegistrationError("cli_identity_unavailable");
    const command = shadowCommand(host, execution);
    const matching = document
      .handlers()
      .filter((h) => ownsHandler(h.value, command));
    status.registrations = matching.length;
    if (matching.length) {
      status.registration = "installed";
      status.command = command;
      const modes = new Set(
        matching.map((h) => (h.value.async === true ? "async" : "sync")),
      );
      status.execution =
        modes.size === 1 ? ([...modes][0] as "async" | "sync") : "mixed";
    }
    if (matching.length > 1) status.issues.push("duplicate_registration");
    if (
      document
        .handlers()
        .some(
          (h) =>
            !ownsHandler(h.value, command) &&
            possibleOtherInstall(h.value, host),
        )
    )
      status.issues.push("other_skilldispatch_command_manual_action_required");
    if (
      matching.some(
        (h) =>
          h.value.asyncRewake === true ||
          (h.value.async !== undefined && typeof h.value.async !== "boolean"),
      )
    )
      status.issues.push("modified_registration_manual_action_required");
    if (status.issues.length) status.registration = "conflict";
    if (host === "claude" && document.node(["disableAllHooks"])?.value === true)
      status.issues.push("host_hooks_disabled");
    if (matching.length && status.execution !== status.expectedExecution)
      status.issues.push("hook_execution_mismatch");
    {
      const isCodex = host === "codex";
      const observer = isCodex
        ? codexObserverCommand(execution)
        : skillObserverCommand(execution);
      const matcher = isCodex ? "Bash" : "Skill";
      const events = (isCodex ? codexReadEvents : invocationEvents).map(
        (event) => {
          const owned = document
            .handlers(event)
            .filter((h) => ownsHandler(h.value, observer));
          const first = owned[0];
          const conflict =
            owned.length > 1 ||
            owned.some(
              (h) =>
                h.matcher !== matcher ||
                h.value.asyncRewake === true ||
                h.value.if !== undefined ||
                (h.value.async !== undefined &&
                  typeof h.value.async !== "boolean"),
            ) ||
            document
              .handlers(event)
              .some(
                (h) =>
                  !ownsHandler(h.value, observer) &&
                  possibleOtherInstall(h.value, host),
              );
          return {
            event,
            matcher,
            registration: conflict
              ? ("conflict" as const)
              : first
                ? ("installed" as const)
                : ("not-installed" as const),
            execution: first
              ? first.value.async === true
                ? ("async" as const)
                : ("sync" as const)
              : null,
            registrations: owned.length,
          };
        },
      );
      const observers = {
        ready:
          (!isCodex ||
            supportedCodexContract(await codexContract(environment))) &&
          document.node(["disableAllHooks"])?.value !== true &&
          events.every(
            (e) => e.registration === "installed" && e.execution === "async",
          ),
        events,
      };
      if (isCodex) {
        status.instructionObservers = observers;
        status.codexContract = supportedCodexContract(
          await codexContract(environment),
        )
          ? "source-verified-user-target"
          : "unverified";
        if (status.codexContract === "unverified")
          status.issues.push("codex_contract_unverified");
      } else status.skillObservers = observers;
      if (!observers.ready)
        status.issues.push(
          isCodex
            ? "skill_instruction_telemetry_incomplete"
            : "skill_invocation_telemetry_incomplete",
        );
    }
    if (host === "codex" && matching.length)
      status.issues.push("codex_host_trust_not_verified");
  } catch (error) {
    status.registration = "conflict";
    status.issues = [
      error instanceof RegistrationError
        ? error.code
        : "registration_inspection_failed",
    ];
  }
  return status;
}

/** Observer readiness is independent of same-turn advisory readiness. */
export function routingRegistrationIssues(status: HookStatus): string[] {
  return status.issues.filter(
    (code) =>
      code !== "skill_invocation_telemetry_incomplete" &&
      code !== "skill_instruction_telemetry_incomplete" &&
      code !== "codex_host_trust_not_verified",
  );
}

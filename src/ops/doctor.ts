import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/load.js";
import { ClaudeDiscoveryAdapter } from "../discovery/claude.js";
import { claudeOriginCounts } from "../discovery/claude-origin.js";
import { CodexDiscoveryAdapter } from "../discovery/codex.js";
import { codexOriginCounts } from "../discovery/codex-origin.js";
import { isMissing } from "../discovery/filesystem.js";
import {
  codexReadPath,
  codexReadPersistenceReady,
} from "../observability/codex-read-storage.js";
import { invocationPersistenceReady } from "../observability/readiness.js";
import { validateApiKey } from "../providers/jev/options.js";
import { resolveExecution } from "../registration/command.js";
import {
  inspectRegistration,
  routingRegistrationIssues,
} from "../registration/inspect.js";
import {
  type CliExecution,
  type HookStatus,
  hosts,
} from "../registration/types.js";
import type { RuntimeEnvironment } from "../runtime/context.js";
import {
  assertTraceDestination,
  checkPrivateDirectory,
  JsonlTraceReader,
  openPrivateFile,
} from "../telemetry/reader.js";
import { dataDirectory, tracePath } from "../telemetry/storage.js";

export interface DoctorCheck {
  code: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  value?: string | number | boolean;
}
export interface DoctorResult {
  version: 1;
  usable: boolean;
  checks: DoctorCheck[];
}

/** No probe files. Absence is allowed when the closest existing ancestor permits creation. */
async function directoryHealth(path: string): Promise<boolean> {
  try {
    await checkPrivateDirectory(path);
    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch (error) {
    if (!isMissing(error)) throw error;
    let ancestor = dirname(path);
    while (true) {
      try {
        const info = await stat(ancestor);
        if (!info.isDirectory()) throw new Error("Invalid parent.");
        await access(ancestor, constants.W_OK | constants.X_OK);
        return false;
      } catch (parentError) {
        if (!isMissing(parentError) || dirname(ancestor) === ancestor)
          throw parentError;
        ancestor = dirname(ancestor);
      }
    }
  }
}

export async function runDoctor(
  environment: RuntimeEnvironment,
  execution?: CliExecution,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const add = (
    code: string,
    status: DoctorCheck["status"],
    detail: string,
    value?: DoctorCheck["value"],
  ) => {
    checks.push({
      code,
      status,
      detail,
      ...(value === undefined ? {} : { value }),
    });
  };
  const result = (): DoctorResult => ({
    version: 1,
    usable: !checks.some((c) => c.status === "FAIL"),
    checks,
  });
  add(
    "node",
    Number(process.versions.node.split(".")[0]) >= 20 ? "PASS" : "FAIL",
    "Node.js 20+ required.",
    process.versions.node,
  );
  add(
    "user_config",
    "PASS",
    "User configuration location.",
    join(environment.home, ".config/skilldispatch/config.yaml"),
  );
  add(
    "hook_commands",
    "PASS",
    "Commands available: skilldispatch hook codex; skilldispatch hook claude. User registration is inspected read-only; host trust/lifecycle is not verified.",
  );
  let resolved: CliExecution | undefined;
  if (execution) {
    try {
      resolved = await resolveExecution(execution);
    } catch {
      /* Report unavailable identity below. */
    }
  }
  let codexRegistration: HookStatus | undefined;
  let claudeRegistration: HookStatus | undefined;
  for (const host of hosts) {
    const registration = await inspectRegistration(host, environment, resolved);
    if (host === "claude") claudeRegistration = registration;
    else codexRegistration = registration;
    add(
      `hook_${host}`,
      registration.registration === "installed" && !registration.issues.length
        ? "PASS"
        : "WARN",
      `${host} ${registration.mode ?? "unknown"} hook: ${registration.registration}${registration.execution ? ` (${registration.execution})` : ""}. User layer only.${registration.issues.length ? ` Issues: ${registration.issues.join(", ")}.` : ""}`,
      registration.registration,
    );
  }
  const readReady =
    codexRegistration?.instructionObservers?.ready === true &&
    (await codexReadPersistenceReady(environment));
  add(
    "codex_instruction_read_telemetry_ready",
    readReady ? "PASS" : "WARN",
    "Local instruction-read observers/storage only; target contract is user-declared, host version, trust, reload and delivery need user verification.",
    readReady,
  );
  add(
    "codex_host_contract",
    codexRegistration?.codexContract === "source-verified-user-target"
      ? "PASS"
      : "WARN",
    "No live host capability probe or automatic trust approval performed.",
    codexRegistration?.codexContract ?? "unverified",
  );
  const invocationReady =
    claudeRegistration?.skillObservers?.ready === true &&
    (await invocationPersistenceReady(environment));
  add(
    "skill_invocation_telemetry_ready",
    invocationReady ? "PASS" : "WARN",
    "Local observer registrations and private invocation storage prerequisites only; host policy, lifecycle and delivery are not verified.",
    invocationReady,
  );
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig({ ...environment, mode: "hook" });
  } catch {
    add(
      "config",
      "FAIL",
      "Cannot load trusted configuration. Check user settings and any explicitly trusted project settings.",
    );
    add(
      "routing_ready",
      "WARN",
      "Routing prerequisites could not be checked because configuration is invalid.",
      false,
    );
    return result();
  }
  const { config, diagnostics } = loaded;
  add(
    "config",
    diagnostics.length ? "WARN" : "PASS",
    diagnostics.length
      ? "Configuration loaded with ignored settings; diagnostic messages are withheld."
      : "Trusted configuration is valid.",
  );
  add(
    "hook_project_config",
    "PASS",
    config.hook.trustProjectConfig
      ? "Project config trusted by user opt-in."
      : "Project config ignored (default).",
    config.hook.trustProjectConfig,
  );
  add(
    "telemetry",
    config.telemetry.enabled ? "PASS" : "WARN",
    config.telemetry.enabled
      ? "Hook routing and persistence enabled."
      : "Hook routing and persistence disabled by configuration.",
  );
  add(
    "provider",
    "PASS",
    "Configured provider; no connection test performed.",
    config.router.provider,
  );
  const apiKey = environment.env.TYPESAFE_API_KEY;
  let providerReady = config.router.provider === "mock";
  if (config.router.provider === "mock")
    add(
      "api_key",
      "PASS",
      "Mock provider needs no API key; credentials are not used.",
    );
  else if (!apiKey?.trim())
    add(
      "api_key",
      "WARN",
      "TYPESAFE_API_KEY is absent or blank; Jev routing will fail open.",
    );
  else {
    try {
      validateApiKey(apiKey);
      providerReady = true;
      add(
        "api_key",
        "PASS",
        "TYPESAFE_API_KEY is present; not authenticated online.",
      );
    } catch {
      add(
        "api_key",
        "FAIL",
        "TYPESAFE_API_KEY has an invalid format; value withheld.",
      );
    }
  }
  const routingReady = providerReady && config.telemetry.enabled;
  add(
    "routing_ready",
    routingReady ? "PASS" : "WARN",
    "Local routing prerequisites only; does not verify online authentication, host registration/trust or delivery.",
    routingReady,
  );
  const codexMode = config.hook.modes.codex;
  const codexReady =
    codexMode === "advisory" &&
    routingReady &&
    codexRegistration?.registration === "installed" &&
    codexRegistration.execution === "sync" &&
    !routingRegistrationIssues(codexRegistration).length;
  add(
    "codex_advisory_ready",
    codexMode === "shadow" || codexReady ? "PASS" : "WARN",
    "Local prerequisites only. Configure a supported Codex target contract, reinstall and review/trust hooks in the target host.",
    codexReady,
  );
  const claudeMode = config.hook.modes.claude;
  const executionMatches =
    claudeRegistration?.registration === "installed" &&
    claudeRegistration.execution ===
      (claudeMode === "advisory" ? "sync" : "async") &&
    !routingRegistrationIssues(claudeRegistration).length;
  add(
    "hook_mode_claude",
    "PASS",
    "Claude execution mode is owned by user configuration.",
    claudeMode,
  );
  add(
    "hook_execution_claude",
    executionMatches ? "PASS" : "WARN",
    executionMatches
      ? "Claude registration matches configured mode."
      : "Re-run: skilldispatch hooks install claude. Reload host hooks after reconciling.",
    claudeRegistration?.execution ?? "not-installed",
  );
  const advisoryReady =
    claudeMode === "advisory" && executionMatches && routingReady;
  add(
    "advisory_ready",
    claudeMode === "shadow" || advisoryReady ? "PASS" : "WARN",
    claudeMode === "shadow"
      ? "Claude advisory is disabled (shadow mode)."
      : "Local advisory prerequisites only; native skill availability, host reload and online authentication are not verified.",
    advisoryReady,
  );
  for (const adapter of [
    new CodexDiscoveryAdapter(),
    new ClaudeDiscoveryAdapter(),
  ]) {
    try {
      const catalog = await adapter.discover(environment);
      add(
        `discovery_${adapter.agent.replaceAll("-", "_")}`,
        catalog.diagnostics.length || !catalog.skills.length ? "WARN" : "PASS",
        `Discovered ${catalog.skills.length} skills, ${catalog.skills.filter((s) => s.enabled).length} enabled, ${catalog.diagnostics.length} diagnostics. Paths/messages withheld.`,
        catalog.skills.length,
      );
      if (adapter.agent === "codex")
        for (const [origin, count] of Object.entries(
          codexOriginCounts(catalog.skills),
        )) {
          if (count.discovered)
            add(
              `codex_origin_${origin.replaceAll("-", "_")}`,
              "PASS",
              `${origin}: ${count.discovered} discovered, ${count.modelRoutable} model-routable; session availability unconfirmed.`,
              count.discovered,
            );
        }
      if (adapter.agent === "claude-code") {
        for (const [origin, counts] of Object.entries(
          claudeOriginCounts(catalog.skills),
        )) {
          if (counts.discovered)
            add(
              `claude_origin_${origin.replaceAll("-", "_")}`,
              "PASS",
              `${origin}: ${counts.discovered} discovered, ${counts.modelRoutable} model-routable.`,
              counts.discovered,
            );
        }
      }
    } catch {
      add(
        `discovery_${adapter.agent.replaceAll("-", "_")}`,
        "FAIL",
        "Skill discovery unavailable; paths and error details withheld.",
      );
    }
  }
  try {
    const url = new URL(
      "../../schemas/route-trace.schema.json",
      import.meta.url,
    );
    const info = await stat(url);
    if (!info.isFile() || info.size > 1_048_576)
      throw new Error("Invalid schema.");
    const schema = JSON.parse(await readFile(url, "utf8"));
    if (
      schema.properties?.schemaVersion?.const !== "1.0" ||
      schema.additionalProperties !== false
    )
      throw new Error("Invalid schema.");
    add(
      "trace_schema",
      "PASS",
      "Packaged Route Trace v1 JSON Schema is readable.",
    );
  } catch {
    add(
      "trace_schema",
      "FAIL",
      "Packaged Route Trace v1 JSON Schema is unavailable or invalid.",
    );
  }
  let directory: string, path: string;
  try {
    directory = dataDirectory(environment);
    path = tracePath(environment, config.telemetry.tracePath);
  } catch {
    add(
      "storage_config",
      "FAIL",
      "Invalid data directory or trace destination configuration.",
    );
    return result();
  }
  try {
    const exists = await directoryHealth(directory);
    add(
      "data_directory",
      exists ? "PASS" : "WARN",
      exists
        ? "Private data directory is accessible."
        : "Data directory not created yet; parent permits creation.",
      directory,
    );
  } catch {
    add("data_directory", "FAIL", "Data directory is unsafe or inaccessible.");
  }
  const keyPath = join(directory, "install.key");
  try {
    const keyFile = await openPrivateFile(keyPath);
    if (!keyFile)
      add(
        "installation_key",
        "WARN",
        "Installation key not created yet; doctor does not create it.",
      );
    else {
      try {
        if ((await keyFile.stat()).size !== 32) throw new Error("Invalid key.");
        add(
          "installation_key",
          "PASS",
          "Existing installation key has private ownership/permissions and 32-byte size; content withheld.",
        );
      } finally {
        await keyFile.close();
      }
    }
  } catch {
    add(
      "installation_key",
      "FAIL",
      "Installation key is unsafe, unreadable or has invalid size.",
    );
  }
  try {
    const reserved = [
      keyPath,
      codexReadPath(environment),
      join(directory, "invocations.jsonl"),
      join(environment.home, ".config/skilldispatch/config.yaml"),
    ];
    await assertTraceDestination(path, reserved);
    await directoryHealth(dirname(path));
    const file = await openPrivateFile(path);
    if (file) {
      try {
        const info = await file.stat();
        if (process.platform !== "win32" && !(info.mode & 0o200))
          throw new Error("Not writable.");
        await access(path, constants.R_OK | constants.W_OK);
      } finally {
        await file.close();
      }
    }
    add(
      "trace_destination",
      file ? "PASS" : "WARN",
      file
        ? "Trace file is private, readable and writable (permission probe only)."
        : "Trace file not created yet; parent permits creation.",
      path,
    );
    let valid = 0,
      invalid = 0,
      unsupported = 0;
    for await (const item of new JsonlTraceReader(path, reserved).read()) {
      if (item.kind === "valid") valid++;
      else if (item.kind === "unsupported") unsupported++;
      else invalid++;
    }
    add(
      "trace_health",
      invalid || unsupported ? "WARN" : "PASS",
      `Valid traces: ${valid}; invalid lines: ${invalid}; unsupported versions: ${unsupported}.`,
    );
    add("valid_traces", "PASS", "Validated trace count.", valid);
    add(
      "invalid_lines",
      invalid ? "WARN" : "PASS",
      "Corrupt/oversized lines are skipped; no repair performed.",
      invalid,
    );
  } catch {
    add(
      "trace_destination",
      "FAIL",
      "Trace destination is unsafe, unreadable or unwritable; no file changed.",
    );
  }
  return result();
}

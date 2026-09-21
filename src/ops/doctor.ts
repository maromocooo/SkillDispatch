import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/load.js";
import { ClaudeDiscoveryAdapter } from "../discovery/claude.js";
import { CodexDiscoveryAdapter } from "../discovery/codex.js";
import { isMissing } from "../discovery/filesystem.js";
import { validateApiKey } from "../providers/jev/options.js";
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
    "Commands available: skilldispatch hook codex; skilldispatch hook claude. Host registration is not checked.",
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
      ? "Shadow hook routing and persistence enabled."
      : "Shadow hook routing and persistence disabled by configuration.",
  );
  add(
    "provider",
    "PASS",
    "Configured provider; no connection test performed.",
    config.router.provider,
  );
  const apiKey = environment.env.TYPESAFE_API_KEY;
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
      invalid = 0;
    for await (const item of new JsonlTraceReader(path, reserved).read()) {
      if (item.kind === "valid") valid++;
      else invalid++;
    }
    add(
      "trace_health",
      invalid ? "WARN" : "PASS",
      `Valid traces: ${valid}; invalid lines: ${invalid}.`,
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

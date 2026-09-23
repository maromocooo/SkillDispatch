import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { Diagnostic } from "../core/types.js";
import { isMissing } from "../discovery/filesystem.js";
import { configFileSchema, defaultConfig } from "./schema.js";

export type ConfigSource = "user" | "project" | "explicit";
export type ConfigMode = "cli" | "hook" | "user";

interface ConfigLayer {
  source: ConfigSource;
  path: string;
}

export async function loadConfig(options: {
  cwd: string;
  home: string;
  configPath?: string;
  mode?: ConfigMode;
}) {
  const config = defaultConfig();
  const diagnostics: Diagnostic[] = [];
  const layers: ConfigLayer[] = [
    {
      source: "user",
      path: join(options.home, ".config/skilldispatch/config.yaml"),
    },
    { source: "project", path: join(options.cwd, ".skilldispatch.yaml") },
  ];
  // Hook configuration authority is user-only. No explicit layer may bypass it.
  if (
    (options.mode === undefined || options.mode === "cli") &&
    options.configPath !== undefined
  )
    layers.push({
      source: "explicit",
      path: resolve(options.cwd, options.configPath),
    });
  for (const { source, path } of layers) {
    if (
      source === "project" &&
      (options.mode === "user" ||
        (options.mode === "hook" && !config.hook.trustProjectConfig))
    )
      continue; // Do not stat, parse or diagnose an untrusted repository's settings.
    let contents: string;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 1_048_576)
        throw new Error("Not a supported regular file");
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (source !== "explicit" && isMissing(error)) continue;
      throw new Error(`Cannot read SkillDispatch config: ${path}`);
    }
    let raw: unknown;
    try {
      const document = parseDocument(contents);
      if (document.errors.length || document.warnings.length)
        throw new Error("Invalid YAML");
      raw = document.toJS({ maxAliasCount: 20 }) ?? {};
      JSON.stringify(raw);
    } catch {
      throw new Error(`Invalid YAML in SkillDispatch config: ${path}`);
    }
    const parsed = configFileSchema.safeParse(raw);
    if (!parsed.success) {
      // Zod/YAML error strings may contain secrets from an unrelated config key.
      throw new Error(
        `Invalid SkillDispatch config: ${path}. Check provider, probabilities, limits and agent names.`,
      );
    }
    for (const key of unknownKeys(raw, parsed.data))
      diagnostics.push({
        code: "unknown_config_key",
        level: "warning",
        message: `Ignored unknown configuration key: ${key}`,
        path,
      });
    const file = parsed.data;
    if (source === "user" && file.hook?.codexContract !== undefined)
      config.hook.codexContract = file.hook.codexContract;
    if (source === "project" && options.mode === "hook") {
      // Trusted project routing policy never owns credentials, provider or persistence.
      if (file.telemetry || file.router)
        diagnostics.push({
          code: "ignored_config_setting",
          level: "warning",
          message: "Project security-sensitive hook settings ignored.",
        });
      delete file.telemetry;
      delete file.router;
    }
    if (file.hook?.trustProjectConfig !== undefined) {
      if (source === "user")
        config.hook.trustProjectConfig = file.hook.trustProjectConfig;
      else
        diagnostics.push({
          code: "ignored_config_setting",
          level: "warning",
          message:
            "hook.trustProjectConfig can only be set in user configuration.",
          path,
        });
    }
    if (file.hook?.modes !== undefined) {
      if (source === "user") Object.assign(config.hook.modes, file.hook.modes);
      else
        diagnostics.push({
          code: "ignored_config_setting",
          level: "warning",
          message: "hook.modes can only be set in user configuration.",
          path,
        });
    }
    if (file.telemetry !== undefined)
      Object.assign(config.telemetry, file.telemetry);
    if (file.router?.provider !== undefined)
      config.router.provider = file.router.provider;
    if (file.router?.timeoutMs !== undefined)
      config.router.timeoutMs = file.router.timeoutMs;
    if (file.router?.jev !== undefined)
      Object.assign(config.router.jev, file.router.jev);
    if (file.router?.mock?.scores !== undefined)
      config.router.mock.scores = {
        ...config.router.mock.scores,
        ...file.router.mock.scores,
      };
    if (file.router?.mock?.defaultProbability !== undefined)
      config.router.mock.defaultProbability =
        file.router.mock.defaultProbability;
    if (file.policy?.threshold !== undefined)
      config.policy.threshold = file.policy.threshold;
    if (file.policy?.maxSkills !== undefined)
      config.policy.maxSkills = file.policy.maxSkills;
    if (file.discovery?.agents !== undefined)
      config.discovery.agents = [...new Set(file.discovery.agents)];
  }
  return { config, diagnostics };
}

function unknownKeys(raw: unknown, parsed: unknown, prefix = ""): string[] {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !parsed ||
    typeof parsed !== "object"
  )
    return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(parsed, key)) keys.push(name);
    else
      keys.push(
        ...unknownKeys(value, (parsed as Record<string, unknown>)[key], name),
      );
  }
  return keys.sort();
}

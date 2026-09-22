import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { compareText } from "../core/order.js";
import type { Diagnostic } from "../core/types.js";
import { claudeDiagnostic, readClaudeJson } from "./claude-files.js";
import { isMissing } from "./filesystem.js";
import type { DiscoveryContext } from "./types.js";

type ClaudeSettingSource = "user" | "project" | "local" | "managed";
interface ClaudeSettingsLocation {
  source: ClaudeSettingSource;
  path: string;
}

export interface ClaudeCatalogSettings {
  valid: boolean;
  enabledPlugins: Map<string, boolean>;
  skillOverrides: Map<string, string>;
  syncClaudeAiSkills: boolean;
  strictPluginOnlyCustomization: boolean;
}
export function managedClaudeDirectory(platform = process.platform): string {
  return platform === "darwin"
    ? "/Library/Application Support/ClaudeCode"
    : platform === "win32"
      ? "C:\\Program Files\\ClaudeCode"
      : "/etc/claude-code";
}

/** Catalog settings, not SkillDispatch runtime config. Never reads env/credentials. */
export async function loadClaudeCatalogSettings(
  context: DiscoveryContext,
  configRoot: string,
  directories: readonly string[],
  managedDirectory: string | null,
  diagnostics: Diagnostic[],
): Promise<ClaudeCatalogSettings> {
  const settings: ClaudeCatalogSettings = {
    valid: true,
    enabledPlugins: new Map(),
    skillOverrides: new Map(),
    syncClaudeAiSkills: true,
    strictPluginOnlyCustomization: false,
  };
  const locations: ClaudeSettingsLocation[] = [
    { source: "user", path: join(configRoot, "settings.json") },
    { source: "project", path: join(context.cwd, ".claude/settings.json") },
    { source: "local", path: join(context.cwd, ".claude/settings.local.json") },
  ];
  const repo = directories.at(-1);
  // Current macOS/Linux native local settings live at the owned repository root.
  if (
    repo &&
    repo !== context.cwd &&
    repo !== context.home &&
    process.platform !== "win32"
  ) {
    const roots = [repo, join(repo, ".git")];
    let owned = true;
    for (const path of [...roots, join(repo, ".claude")]) {
      try {
        if ((await lstat(path)).uid !== process.getuid?.()) owned = false;
      } catch (error) {
        if (!isMissing(error)) owned = false;
      }
    }
    if (owned)
      locations.push({
        source: "local",
        path: join(repo, ".claude/settings.local.json"),
      });
  }
  if (managedDirectory) {
    locations.push({
      source: "managed",
      path: join(managedDirectory, "managed-settings.json"),
    });
    try {
      const root = join(managedDirectory, "managed-settings.d");
      if (!(await lstat(root)).isDirectory()) throw new Error();
      const names: string[] = [];
      let count = 0;
      for await (const entry of await opendir(root)) {
        if (++count > 256) throw new Error();
        if (!entry.name.startsWith(".") && entry.name.endsWith(".json"))
          names.push(entry.name);
      }
      locations.push(
        ...names.sort(compareText).map(
          (name): ClaudeSettingsLocation => ({
            source: "managed",
            path: join(root, name),
          }),
        ),
      );
    } catch (error) {
      if (!isMissing(error)) {
        settings.valid = false;
        claudeDiagnostic(diagnostics, "invalid_claude_settings");
      }
    }
  }
  for (const { path, source } of locations) {
    const count = diagnostics.length;
    const data = await readClaudeJson(
      path,
      diagnostics,
      "invalid_claude_settings",
    );
    if (diagnostics.length !== count) settings.valid = false;
    if (!data) continue;
    try {
      for (const field of ["enabledPlugins", "skillOverrides"] as const) {
        if (data[field] === undefined) continue;
        const entries = data[field];
        if (!entries || typeof entries !== "object" || Array.isArray(entries))
          throw new Error();
        for (const [key, value] of Object.entries(entries)) {
          if (field === "enabledPlugins") {
            if (typeof value !== "boolean") throw new Error();
            settings.enabledPlugins.set(key, value);
          } else {
            if (
              typeof value !== "string" ||
              !["on", "off", "name-only", "user-invocable-only"].includes(value)
            )
              throw new Error();
            settings.skillOverrides.set(key, value);
          }
        }
      }
      // This opt-out is restrictive, not a highest-precedence boolean. Shared
      // project files cannot opt the user out; true never clears an earlier false.
      if (source !== "project" && data.syncClaudeAiSkills !== undefined) {
        if (typeof data.syncClaudeAiSkills !== "boolean") throw new Error();
        if (data.syncClaudeAiSkills === false)
          settings.syncClaudeAiSkills = false;
      }
      if (data.strictPluginOnlyCustomization !== undefined) {
        if (typeof data.strictPluginOnlyCustomization !== "boolean")
          throw new Error();
        settings.strictPluginOnlyCustomization =
          data.strictPluginOnlyCustomization;
      }
    } catch {
      settings.valid = false;
      claudeDiagnostic(diagnostics, "invalid_claude_settings");
    }
  }
  return settings;
}

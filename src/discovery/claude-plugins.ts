import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { compareText } from "../core/order.js";
import type { Diagnostic } from "../core/types.js";
import {
  absoluteStatePath,
  claudeDiagnostic,
  readClaudeJson,
  safeDirectory,
} from "./claude-files.js";
import type { ClaudeCatalogSettings } from "./claude-settings.js";
import { isMissing } from "./filesystem.js";

const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u);
const recordSchema = z.object({
  scope: z.enum(["user", "project", "local", "managed"]),
  installPath: z.string().refine(absoluteStatePath),
  version: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u),
  projectPath: z.string().refine(absoluteStatePath).optional(),
});
export type PluginRecord = z.infer<typeof recordSchema>;
export interface ActivePlugin {
  id: string;
  name: string;
  version: string;
  scope: PluginRecord["scope"];
  paths: string[];
  skillDirectories: string[];
  rootSkillFallback: boolean;
}
const manifestSchema = z.object({
  name: token,
  version: z.string().optional(),
  defaultEnabled: z.boolean().optional(),
  skills: z.union([z.string(), z.array(z.string()).max(64)]).optional(),
});
function pluginKey(id: string) {
  const parts = id.split("@");
  return parts.length === 2 &&
    parts.every((part) => token.safeParse(part).success)
    ? (parts as [string, string])
    : undefined;
}
const severity = { user: 0, project: 1, local: 2, managed: 3 };

/** Registry paths are authoritative. No discovery by scanning cache or marketplace trees. */
export async function resolveClaudePlugins(
  pluginRoot: string,
  settings: ClaudeCatalogSettings,
  directories: readonly string[],
  diagnostics: Diagnostic[],
): Promise<ActivePlugin[]> {
  if (!settings.valid) return [];
  const data = await readClaudeJson(
    join(pluginRoot, "installed_plugins.json"),
    diagnostics,
    "invalid_plugin_registry",
  );
  let entries: Record<string, unknown> = {};
  if (data) {
    if (
      data.version !== 2 ||
      !data.plugins ||
      typeof data.plugins !== "object" ||
      Array.isArray(data.plugins) ||
      Object.keys(data.plugins).length > 1024
    ) {
      claudeDiagnostic(diagnostics, "invalid_plugin_registry");
      return [];
    }
    entries = data.plugins as Record<string, unknown>;
  }
  for (const [id, enabled] of settings.enabledPlugins) {
    if (enabled && !Object.hasOwn(entries, id))
      claudeDiagnostic(diagnostics, "plugin_install_missing");
  }
  // Read only registry-selected marketplace manifests; never traverse their skill trees.
  let known: Record<string, unknown> | undefined;
  let knownLoaded = false;
  let knownInvalid = false;
  const marketCache = new Map<string, Record<string, unknown> | undefined>();
  async function marketplaceEntry(
    id: string,
  ): Promise<Record<string, unknown> | undefined | false> {
    const parts = pluginKey(id);
    if (!parts) return false;
    const [name, market] = parts;
    if (!knownLoaded) {
      knownLoaded = true;
      const diagnosticCount = diagnostics.length;
      known = await readClaudeJson(
        join(pluginRoot, "known_marketplaces.json"),
        diagnostics,
        "invalid_plugin_marketplace",
      );
      knownInvalid = diagnostics.length !== diagnosticCount;
    }
    if (knownInvalid) return false;
    const location = (
      known?.[market] as { installLocation?: unknown } | undefined
    )?.installLocation;
    // No heuristic marketplace directory probing; absent metadata uses installed manifest.
    if (location === undefined) return undefined;
    if (!absoluteStatePath(location)) {
      claudeDiagnostic(diagnostics, "invalid_plugin_marketplace");
      return false;
    }
    if (!marketCache.has(market))
      marketCache.set(
        market,
        await readClaudeJson(
          join(location, ".claude-plugin/marketplace.json"),
          diagnostics,
          "invalid_plugin_marketplace",
        ),
      );
    const manifest = marketCache.get(market);
    if (!manifest || !Array.isArray(manifest.plugins)) {
      claudeDiagnostic(diagnostics, "invalid_plugin_marketplace");
      return false;
    }
    const matches = manifest.plugins.filter(
      (p: unknown) =>
        p &&
        typeof p === "object" &&
        (p as Record<string, unknown>).name === name,
    );
    if (matches.length !== 1) {
      claudeDiagnostic(diagnostics, "invalid_plugin_marketplace");
      return false;
    }
    return matches[0] as Record<string, unknown>;
  }
  const active: ActivePlugin[] = [];
  for (const id of Object.keys(entries).sort(compareText)) {
    if (!pluginKey(id)) {
      claudeDiagnostic(diagnostics, "invalid_plugin_registry");
      continue;
    }
    if (settings.enabledPlugins.get(id) === false) {
      diagnostics.push({
        code: "plugin_disabled",
        level: "info",
        message: "Installed plugin disabled by settings.",
      });
      continue;
    }
    const raw = entries[id];
    if (!Array.isArray(raw) || raw.length > 256) {
      claudeDiagnostic(diagnostics, "invalid_plugin_registry");
      continue;
    }
    const records: PluginRecord[] = [];
    let invalid = false;
    for (const candidate of raw) {
      const parsed = recordSchema.safeParse(candidate);
      if (!parsed.success) {
        invalid = true;
        claudeDiagnostic(diagnostics, "invalid_plugin_registry");
        continue;
      }
      const record = parsed.data;
      if (record.scope === "project" || record.scope === "local") {
        if (!record.projectPath) {
          invalid = true;
          claudeDiagnostic(diagnostics, "invalid_plugin_registry");
          continue;
        }
        let project: string;
        try {
          project = await safeDirectory(record.projectPath);
        } catch {
          claudeDiagnostic(diagnostics, "plugin_scope_mismatch");
          continue;
        }
        if (!directories.includes(project)) {
          claudeDiagnostic(diagnostics, "plugin_scope_mismatch");
          continue;
        }
      }
      records.push(record);
    }
    if (invalid) continue;
    if (!records.length) {
      if (!raw.length) claudeDiagnostic(diagnostics, "plugin_install_missing");
      continue;
    }
    const versions = new Set(records.map((r) => r.version));
    if (versions.size !== 1) {
      claudeDiagnostic(diagnostics, "ambiguous_plugin_installation");
      continue;
    }
    records.sort(
      (a, b) =>
        severity[b.scope] - severity[a.scope] ||
        compareText(a.installPath, b.installPath),
    );
    const primary = records[0];
    if (!primary) continue;
    const roots = new Set<string>();
    let manifest: z.infer<typeof manifestSchema> | undefined;
    for (const record of records) {
      try {
        const root = await safeDirectory(record.installPath);
        if (roots.has(root)) continue;
        roots.add(root);
        const parsed = manifestSchema.safeParse(
          await readClaudeJson(
            join(root, ".claude-plugin/plugin.json"),
            diagnostics,
            "invalid_plugin_manifest",
          ),
        );
        if (!parsed.success) {
          claudeDiagnostic(diagnostics, "invalid_plugin_manifest");
          invalid = true;
          continue;
        }
        if (
          manifest &&
          JSON.stringify(manifest) !== JSON.stringify(parsed.data)
        ) {
          claudeDiagnostic(diagnostics, "ambiguous_plugin_installation");
          invalid = true;
        }
        manifest = parsed.data;
      } catch (error) {
        invalid = true;
        claudeDiagnostic(
          diagnostics,
          isMissing(error)
            ? "plugin_install_missing"
            : "unsafe_plugin_installation",
        );
      }
    }
    if (invalid || !manifest) continue;
    const explicit = settings.enabledPlugins.get(id);
    // Marketplace component declarations also affect scan roots, not only defaults.
    const matched = await marketplaceEntry(id);
    if (matched === false) continue;
    const entry = matched;
    if (
      entry?.defaultEnabled !== undefined &&
      typeof entry.defaultEnabled !== "boolean"
    ) {
      claudeDiagnostic(diagnostics, "invalid_plugin_marketplace");
      continue;
    }
    const enabled =
      explicit ?? entry?.defaultEnabled ?? manifest.defaultEnabled ?? true;
    if (!enabled) {
      diagnostics.push({
        code: "plugin_disabled",
        level: "info",
        message: "Installed plugin disabled by its default.",
      });
      continue;
    }
    // Component merging / strict:false marketplace-only manifests need host state;
    // never guess additional component roots from a marketplace source.
    if (
      entry?.strict === false ||
      entry?.source === "." ||
      entry?.source === "./"
    ) {
      claudeDiagnostic(diagnostics, "unsupported_plugin_layout");
      continue;
    }
    const declared = z
      .union([z.string(), z.array(z.string()).max(64)])
      .optional()
      .safeParse(entry?.skills);
    if (!declared.success) {
      claudeDiagnostic(diagnostics, "invalid_plugin_marketplace");
      continue;
    }
    const paths = (value: string | string[] | undefined) =>
      value === undefined ? [] : typeof value === "string" ? [value] : value;
    const skillDirectories = [
      "./skills",
      ...paths(manifest.skills),
      ...paths(declared.data),
    ];
    if (
      skillDirectories.some(
        (path) =>
          (path !== "." && !path.startsWith("./")) ||
          path.includes("\\") ||
          /[\p{Cc}]/u.test(path) ||
          path.split("/").includes("..") ||
          relative("/plugin", resolve("/plugin", path)).startsWith(".."),
      )
    ) {
      claudeDiagnostic(diagnostics, "invalid_plugin_manifest");
      continue;
    }
    active.push({
      id,
      name: manifest.name,
      version: primary.version,
      scope: primary.scope,
      paths: [...roots].sort(compareText),
      skillDirectories: [...new Set(skillDirectories)],
      rootSkillFallback:
        manifest.skills === undefined && declared.data === undefined,
    });
  }
  return active;
}

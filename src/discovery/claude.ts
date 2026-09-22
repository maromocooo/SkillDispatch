import { basename, dirname, join, resolve } from "node:path";
import { finalizeCatalog } from "./catalog.js";
import { claudeDiagnostic } from "./claude-files.js";
import { parseClaudeBoolean } from "./claude-invocation.js";
import { claudeMetadata, safeInvocationSegment } from "./claude-origin.js";
import { discoverPluginSkills } from "./claude-plugin-skills.js";
import { resolveClaudePlugins } from "./claude-plugins.js";
import {
  loadClaudeCatalogSettings,
  managedClaudeDirectory,
} from "./claude-settings.js";
import { discoverSyncedSkills } from "./claude-synced.js";
import { projectDirectories } from "./filesystem.js";
import { scanSources } from "./scan.js";
import type {
  DiscoveryAdapter,
  DiscoveryContext,
  DiscoveryMetadata,
  DiscoverySource,
} from "./types.js";

/** Read-only native catalog snapshot; host session state remains authoritative. */
export class ClaudeDiscoveryAdapter implements DiscoveryAdapter {
  readonly agent = "claude-code";
  constructor(
    private readonly options: { managedDirectory?: string | null } = {},
  ) {}

  async discover(context: DiscoveryContext) {
    const directories = await projectDirectories(context.cwd);
    const configHome = resolve(
      context.cwd,
      context.env?.CLAUDE_CONFIG_DIR || join(context.home, ".claude"),
    );
    const pluginRoot = resolve(
      context.cwd,
      context.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(configHome, "plugins"),
    );
    const managedDirectory =
      this.options.managedDirectory === undefined
        ? managedClaudeDirectory()
        : this.options.managedDirectory;
    const diagnostics: import("../core/types.js").Diagnostic[] = [];
    const settings = await loadClaudeCatalogSettings(
      context,
      configHome,
      directories,
      managedDirectory,
      diagnostics,
    );
    // Personal wins over project for canonical aliases. Distinct same-name skills stay.
    const sources: DiscoverySource[] = [
      ...(managedDirectory
        ? [
            {
              path: join(managedDirectory, ".claude/skills"),
              scope: "admin" as const,
            },
          ]
        : []),
      { path: join(configHome, "skills"), scope: "user" },
      ...directories.map((directory) => ({
        path: join(directory, ".claude/skills"),
        scope: "repo" as const,
      })),
    ];
    const result = await scanSources(this.agent, sources, {
      skipDirectory: (name) => name.toLowerCase() === "synced",
      parserOptions: (path) => ({
        fallbackName: basename(path),
        fallbackDescriptionFromBody: true,
        allowMissingFrontmatter: true,
      }),
    });
    for (const skill of result.skills) {
      const discovery = skill.metadata.discovery as DiscoveryMetadata;
      const name = basename(dirname(discovery.path));
      skill.metadata.commandName = name;
      skill.metadata.claude = {
        origin:
          skill.scope === "admin"
            ? "managed"
            : skill.scope === "user"
              ? "local-user"
              : "local-project",
        modelInvocable: skill.enabled,
        ...(safeInvocationSegment(name) ? { nativeInvocationName: name } : {}),
      };
    }
    result.diagnostics.push(...diagnostics);
    const synced =
      settings.valid &&
      settings.syncClaudeAiSkills &&
      !settings.strictPluginOnlyCustomization
        ? await discoverSyncedSkills(configHome)
        : { skills: [], diagnostics: [] };
    result.skills.push(...synced.skills);
    result.diagnostics.push(...synced.diagnostics);
    const plugins = await resolveClaudePlugins(
      pluginRoot,
      settings,
      directories,
      result.diagnostics,
    );
    const pluginSkills = await discoverPluginSkills(plugins);
    result.skills.push(...pluginSkills.skills);
    result.diagnostics.push(...pluginSkills.diagnostics);
    for (const skill of result.skills) {
      const origin = claudeMetadata(skill);
      // Never trust frontmatter to claim adapter-owned origin/invocation metadata.
      if (
        !settings.valid ||
        (settings.strictPluginOnlyCustomization && origin?.origin !== "plugin")
      ) {
        skill.enabled = false;
        skill.metadata.disabledReason = "claude_settings_restricted";
      }
      if (origin?.origin !== "plugin") {
        const override = settings.skillOverrides.get(
          origin?.nativeInvocationName ?? skill.name,
        );
        if (override === "off" || override === "user-invocable-only") {
          skill.enabled = false;
          skill.metadata.disabledReason = "skill_override";
        }
      }
      if (origin?.origin === "unknown")
        claudeDiagnostic(result.diagnostics, "unsupported_native_invocation");
      const value = skill.metadata["disable-model-invocation"];
      const disabled = parseClaudeBoolean(value);
      if (value !== undefined && disabled === undefined) {
        skill.enabled = false;
        skill.metadata.disabledReason = "invalid_invocation_policy";
        result.diagnostics.push({
          code: "invalid_invocation_policy",
          level: "warning",
          message:
            "Invalid disable-model-invocation value; skill excluded from routing.",
          path: skill.path,
        });
      } else if (disabled) {
        skill.enabled = false;
        skill.metadata.disabledReason = "explicit_invocation_only";
      }
      const whenToUse = skill.metadata.when_to_use;
      if (typeof whenToUse === "string" && whenToUse.trim()) {
        skill.description = `${skill.description} ${whenToUse.replace(/\s+/gu, " ").trim()}`;
      }
      (skill.metadata.claude as { modelInvocable: boolean }).modelInvocable =
        skill.enabled;
    }
    return finalizeCatalog([result]);
  }
}

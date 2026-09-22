import { basename, dirname, join } from "node:path";
import { finalizeCatalog } from "./catalog.js";
import { parseClaudeBoolean } from "./claude-invocation.js";
import { safeInvocationSegment } from "./claude-origin.js";
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

  async discover(context: DiscoveryContext) {
    const directories = await projectDirectories(context.cwd);
    const configHome =
      context.env?.CLAUDE_CONFIG_DIR || join(context.home, ".claude");
    // Personal wins over project for canonical aliases. Distinct same-name skills stay.
    const sources: DiscoverySource[] = [
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
        origin: skill.scope === "user" ? "local-user" : "local-project",
        modelInvocable: skill.enabled,
        ...(safeInvocationSegment(name) ? { nativeInvocationName: name } : {}),
      };
    }
    const synced = await discoverSyncedSkills(configHome);
    result.skills.push(...synced.skills);
    result.diagnostics.push(...synced.diagnostics);
    for (const skill of result.skills) {
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

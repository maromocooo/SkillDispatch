import { basename, dirname, join } from "node:path";
import { finalizeCatalog } from "./catalog.js";
import { parseClaudeBoolean } from "./claude-invocation.js";
import { projectDirectories } from "./filesystem.js";
import { scanSources } from "./scan.js";
import type {
  DiscoveryAdapter,
  DiscoveryContext,
  DiscoveryMetadata,
  DiscoverySource,
} from "./types.js";

/** Local personal/project skills only; plugin and session state require host APIs. */
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
      // Retain the command-name distinction: frontmatter name is only a display label.
      const discovery = skill.metadata.discovery as DiscoveryMetadata;
      skill.metadata.commandName = basename(dirname(discovery.path));
    }
    return finalizeCatalog([result]);
  }
}

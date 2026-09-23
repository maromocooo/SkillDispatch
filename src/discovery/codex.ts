import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { finalizeCatalog } from "./catalog.js";
import {
  type CodexSkillMetadata,
  codexCatalogIdentity,
  codexMetadata,
  safeCodexName,
} from "./codex-origin.js";
import { discoverCodexPlugins } from "./codex-plugins.js";
import { codexHome, loadCodexSettings } from "./codex-settings.js";
import { projectDirectories, readOptional } from "./filesystem.js";
import { scanSources } from "./scan.js";
import type {
  DiscoveryAdapter,
  DiscoveryContext,
  DiscoverySource,
} from "./types.js";

const policySchema = z.object({
  policy: z
    .object({
      allow_implicit_invocation: z.boolean().optional(),
      products: z.array(z.string()).optional(),
    })
    .optional(),
});

export interface CodexDiscoveryOptions {
  /** Overrides the default /etc/codex/skills source; [] disables admin scanning. */
  adminRoots?: readonly string[];
  /** Additional system roots; the CODEX_HOME .system root is always included. */
  systemRoots?: readonly string[];
}

export class CodexDiscoveryAdapter implements DiscoveryAdapter {
  readonly agent = "codex";
  constructor(private readonly options: CodexDiscoveryOptions = {}) {}

  async discover(context: DiscoveryContext) {
    const directories = await projectDirectories(context.cwd);
    const home = codexHome(context);
    const adminRoots = this.options.adminRoots ?? ["/etc/codex/skills"];
    const settings = await loadCodexSettings(context, directories, adminRoots);
    const sources: DiscoverySource[] = [
      ...directories.map((directory) => ({
        path: join(directory, ".agents/skills"),
        scope: "repo" as const,
      })),
      { path: join(context.home, ".agents/skills"), scope: "user" },
      { path: join(home, "skills/.system"), scope: "system" },
      { path: join(home, "skills"), scope: "user" },
      ...adminRoots.map((path) => ({
        path: resolve(path),
        scope: "admin" as const,
      })),
      ...(this.options.systemRoots ?? []).map((path) => ({
        path: resolve(path),
        scope: "system" as const,
      })),
    ];
    const result = await scanSources(this.agent, sources, { recursive: true });
    for (const skill of result.skills) delete skill.metadata.codex;
    const plugins = await discoverCodexPlugins(
      home,
      settings.plugins,
      settings.valid && settings.pluginsValid,
    );
    result.skills.push(...plugins.skills);
    result.diagnostics.push(...settings.diagnostics, ...plugins.diagnostics);
    const unique = finalizeCatalog([result]);
    result.skills = unique.skills;
    for (const skill of result.skills) {
      let configuredEnabled = true;
      for (const rule of settings.rules)
        if (rule.path === skill.path || rule.name === skill.name)
          configuredEnabled = rule.enabled;
      const metadata =
        codexMetadata(skill) ??
        ({
          origin:
            skill.scope === "repo"
              ? "local-project"
              : skill.scope === "system"
                ? "system"
                : skill.scope === "admin"
                  ? "admin"
                  : "local-user",
          nativeName: skill.name,
          configuredEnabled,
          modelInvocable: true,
          sessionAvailability: "unconfirmed",
        } satisfies CodexSkillMetadata);
      metadata.configuredEnabled = configuredEnabled;
      skill.metadata.codex = metadata;
      if (
        !settings.valid ||
        !settings.includeInstructions ||
        !configuredEnabled ||
        (skill.scope === "system" && !settings.bundled) ||
        !safeCodexName(skill.name)
      ) {
        skill.enabled = false;
        skill.metadata.disabledReason = "codex_config";
      }
      const policyPath = join(skill.directory, "agents/openai.yaml");
      const policy = await readOptional(policyPath, result.diagnostics);
      if (policy !== undefined) {
        try {
          const document = parseDocument(policy);
          if (document.errors.length || document.warnings.length)
            throw new Error("Invalid policy");
          const parsed = policySchema.parse(
            document.toJS({ maxAliasCount: 20 }),
          );
          if (
            parsed.policy?.allow_implicit_invocation === false ||
            (parsed.policy?.products?.length &&
              !parsed.policy.products.includes("codex"))
          ) {
            skill.enabled = false;
            skill.metadata.disabledReason = "explicit_invocation_only";
          }
        } catch {
          skill.enabled = false;
          skill.metadata.disabledReason = "invalid_invocation_policy";
          result.diagnostics.push({
            code: "invalid_invocation_policy",
            level: "warning",
            message:
              "Cannot parse automatic invocation policy; skill excluded from routing.",
            path: policyPath,
          });
        }
      } else if (result.diagnostics.some((d) => d.path === policyPath)) {
        skill.enabled = false;
        skill.metadata.disabledReason = "unreadable_invocation_policy";
      }
      metadata.modelInvocable = skill.enabled;
      skill.metadata.catalogIdentity = codexCatalogIdentity(skill);
    }
    return finalizeCatalog([result]);
  }
}

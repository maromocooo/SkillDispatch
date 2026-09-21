import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Diagnostic } from "../core/types.js";
import { finalizeCatalog } from "./catalog.js";
import {
  canonicalPath,
  projectDirectories,
  readOptional,
} from "./filesystem.js";
import { scanSources } from "./scan.js";
import type {
  DiscoveryAdapter,
  DiscoveryContext,
  DiscoverySource,
} from "./types.js";

const configSchema = z.object({
  skills: z
    .object({
      config: z
        .array(z.object({ path: z.string().min(1), enabled: z.boolean() }))
        .optional(),
    })
    .optional(),
});
const policySchema = z.object({
  policy: z
    .object({ allow_implicit_invocation: z.boolean().optional() })
    .optional(),
});

export interface CodexDiscoveryOptions {
  /** Overrides the default /etc/codex/skills source; [] disables admin scanning. */
  adminRoots?: readonly string[];
  /** Bundled skill paths are installation-specific and must be supplied explicitly. */
  systemRoots?: readonly string[];
}

export class CodexDiscoveryAdapter implements DiscoveryAdapter {
  readonly agent = "codex";
  constructor(private readonly options: CodexDiscoveryOptions = {}) {}

  async discover(context: DiscoveryContext) {
    const directories = await projectDirectories(context.cwd);
    const sources: DiscoverySource[] = [
      ...directories.map((directory) => ({
        path: join(directory, ".agents/skills"),
        scope: "repo" as const,
      })),
      { path: join(context.home, ".agents/skills"), scope: "user" },
      ...(this.options.adminRoots ?? ["/etc/codex/skills"]).map((path) => ({
        path: resolve(path),
        scope: "admin" as const,
      })),
      ...(this.options.systemRoots ?? []).map((path) => ({
        path: resolve(path),
        scope: "system" as const,
      })),
    ];
    const result = await scanSources(this.agent, sources, { recursive: true });
    const configPath = join(
      context.env?.CODEX_HOME || join(context.home, ".codex"),
      "config.toml",
    );
    const disabled = await disabledPaths(configPath, result.diagnostics);
    for (const skill of result.skills) {
      if (disabled.has(skill.path)) {
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
          if (parsed.policy?.allow_implicit_invocation === false) {
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
    }
    return finalizeCatalog([result]);
  }
}

async function disabledPaths(
  path: string,
  diagnostics: Diagnostic[],
): Promise<Set<string>> {
  const disabled = new Set<string>();
  const content = await readOptional(path, diagnostics);
  if (content === undefined) return disabled;
  try {
    const config = configSchema.parse(parseToml(content));
    for (const entry of config.skills?.config ?? []) {
      if (!isAbsolute(entry.path)) {
        diagnostics.push({
          code: "invalid_disabled_path",
          level: "warning",
          message:
            "Codex skill configuration requires an absolute SKILL.md path.",
          path,
        });
        continue;
      }
      const canonical = await canonicalPath(entry.path);
      if (entry.enabled) disabled.delete(canonical);
      else disabled.add(canonical);
    }
  } catch {
    diagnostics.push({
      code: "invalid_codex_config",
      level: "warning",
      message: "Cannot read disabled skills from Codex configuration.",
      path,
    });
  }
  return disabled;
}

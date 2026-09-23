import { isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Diagnostic } from "../core/types.js";
import { canonicalPath, readOptional } from "./filesystem.js";
import type { DiscoveryContext } from "./types.js";

export function codexHome(c: DiscoveryContext): string {
  const root = c.env?.CODEX_HOME || join(c.home, ".codex");
  if (!isAbsolute(root)) throw new Error("Invalid Codex configuration root.");
  return root;
}
export const codexDiagnostic = (diagnostics: Diagnostic[], code: string) =>
  diagnostics.push({
    code,
    level: "warning",
    message:
      "Codex catalog state could not be fully resolved; affected entries are excluded.",
  });
const record = z.record(z.string(), z.unknown());
const skillsSchema = z.object({
  config: z
    .array(
      z.object({
        path: z.string().optional(),
        name: z.string().optional(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  include_instructions: z.boolean().optional(),
  bundled: z.object({ enabled: z.boolean().optional() }).optional(),
});
export async function loadCodexSettings(
  context: DiscoveryContext,
  directories: string[],
  adminRoots: readonly string[],
) {
  const diagnostics: Diagnostic[] = [];
  let valid = true,
    pluginsValid = true;
  async function document(path: string) {
    const before = diagnostics.length;
    const text = await readOptional(path, diagnostics);
    if (text === undefined) {
      if (diagnostics.length !== before) valid = false;
      return {};
    }
    try {
      return record.parse(parseToml(text));
    } catch {
      valid = false;
      codexDiagnostic(diagnostics, "invalid_codex_config");
      return {};
    }
  }
  const user = await document(join(codexHome(context), "config.toml"));
  const layers: Record<string, unknown>[] = [];
  for (const root of adminRoots) {
    // The admin source's sibling config/requirements are file-managed authority.
    const config = await document(join(root, "..", "config.toml"));
    layers.push(config);
    const legacy = await document(join(root, "..", "managed_config.toml"));
    if (Object.keys(legacy).length) {
      valid = false;
      codexDiagnostic(diagnostics, "codex_managed_config_unresolved");
    }
    const requirements = await document(join(root, "..", "requirements.toml"));
    if (requirements.marketplaces !== undefined) {
      pluginsValid = false;
      codexDiagnostic(diagnostics, "codex_marketplace_requirements_unresolved");
    }
    if (requirements.skills !== undefined) {
      valid = false;
      codexDiagnostic(diagnostics, "codex_skill_requirements_unresolved");
    }
  }
  layers.push(user);
  const projects = record.safeParse(user.projects);
  const trust = new Map<string, unknown>();
  if (projects.success)
    for (const [path, value] of Object.entries(projects.data)) {
      if (isAbsolute(path) && record.safeParse(value).success)
        trust.set(
          await canonicalPath(path),
          (value as Record<string, unknown>).trust_level,
        );
    }
  const repo = directories.at(-1);
  const trustedDirectories: string[] = [];
  for (const directory of [...directories].reverse()) {
    const decision =
      trust.get(await canonicalPath(directory)) ??
      (repo ? trust.get(await canonicalPath(repo)) : undefined);
    if (decision === "trusted") {
      layers.push(await document(join(directory, ".codex/config.toml")));
      trustedDirectories.push(directory);
    }
  }
  const plugins: Record<string, { enabled: boolean }> = {};
  let pluginsEnabled = true;
  let includeInstructions = true,
    bundled = true;
  for (const layer of layers) {
    const features = record.safeParse(layer.features);
    if (layer.features !== undefined && !features.success) {
      pluginsValid = false;
      codexDiagnostic(diagnostics, "invalid_codex_plugin_policy");
    }
    if (features.success && features.data.plugins !== undefined) {
      if (typeof features.data.plugins === "boolean")
        pluginsEnabled = features.data.plugins;
      else {
        pluginsValid = false;
        codexDiagnostic(diagnostics, "invalid_codex_plugin_policy");
      }
    }
    if (layer.profile !== undefined) {
      // Session profile selection/overrides are not reconstructible from a hook payload.
      valid = false;
      codexDiagnostic(diagnostics, "codex_profile_state_unresolved");
    }
    if (layer.skills !== undefined) {
      const parsed = skillsSchema.safeParse(layer.skills);
      if (!parsed.success) {
        valid = false;
        codexDiagnostic(diagnostics, "invalid_codex_config");
      } else {
        includeInstructions =
          parsed.data.include_instructions ?? includeInstructions;
        bundled = parsed.data.bundled?.enabled ?? bundled;
      }
    }
    if (layer.plugins !== undefined) {
      const parsed = z
        .record(z.string(), z.object({ enabled: z.boolean().optional() }))
        .safeParse(layer.plugins);
      if (!parsed.success) {
        pluginsValid = false;
        codexDiagnostic(diagnostics, "invalid_codex_plugin_config");
      } else {
        for (const [identity, entry] of Object.entries(parsed.data)) {
          plugins[identity] = {
            enabled: entry.enabled ?? plugins[identity]?.enabled ?? true,
          };
        }
      }
    }
  }
  // Upstream enable/disable selectors use User + SessionFlags only, not project layers.
  const rules: Array<{ path?: string; name?: string; enabled: boolean }> = [];
  const parsed = skillsSchema.safeParse(user.skills ?? {});
  if (parsed.success)
    for (const rule of parsed.data.config ?? []) {
      if (
        (rule.path === undefined) === (rule.name === undefined) ||
        (rule.path !== undefined && !isAbsolute(rule.path)) ||
        rule.name?.trim() === ""
      ) {
        valid = false;
        codexDiagnostic(diagnostics, "invalid_disabled_path");
        continue;
      }
      rules.push(
        rule.path
          ? { path: await canonicalPath(rule.path), enabled: rule.enabled }
          : { name: rule.name?.trim() ?? "", enabled: rule.enabled },
      );
    }
  return {
    valid,
    pluginsValid: pluginsValid && pluginsEnabled,
    trustedDirectories,
    plugins,
    rules,
    includeInstructions,
    bundled,
    diagnostics,
  };
}

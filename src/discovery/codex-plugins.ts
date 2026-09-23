import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { CodexSkillMetadata } from "./codex-origin.js";
import { codexDiagnostic } from "./codex-settings.js";
import { isMissing, readOptional } from "./filesystem.js";
import { scanSources } from "./scan.js";
import type { DiscoveryResult } from "./types.js";

const segment = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u;
const manifestSchema = z.object({
  name: z.string().regex(segment),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
});
const contained = (root: string, path: string) => {
  const r = relative(root, path);
  return !r.startsWith("..") && !isAbsolute(r);
};
export async function discoverCodexPlugins(
  home: string,
  configured: Record<string, { enabled: boolean }>,
  allowed: boolean,
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { skills: [], diagnostics: [] };
  const warn = (code: string) => codexDiagnostic(result.diagnostics, code);
  if (!allowed) return result;
  for (const [identity, config] of Object.entries(configured)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 256)) {
    const parts = identity.split("@");
    if (parts.length !== 2 || !parts.every((p) => segment.test(p))) {
      warn("invalid_codex_plugin_identity");
      continue;
    }
    if (!config.enabled) {
      warn("codex_plugin_disabled");
      continue;
    }
    const [name, marketplace] = parts as [string, string];
    const base = join(home, "plugins/cache", marketplace, name);
    try {
      const cache = await realpath(join(home, "plugins/cache"));
      if (!contained(cache, await realpath(base))) {
        warn("unsafe_codex_plugin_root");
        continue;
      }
      const entries = await readdir(base, { withFileTypes: true });
      if (entries.length > 256) {
        warn("codex_plugin_version_unresolved");
        continue;
      }
      const versions = entries
        .filter((e) => e.isDirectory() && segment.test(e.name))
        .map((e) => e.name);
      // Upstream prefers `local`. Otherwise multiple versions are deliberately conservative:
      // do not infer active versions from lexical maxima or timestamps.
      const version = versions.includes("local")
        ? "local"
        : versions.length === 1
          ? versions[0]
          : undefined;
      if (!version) {
        warn("codex_plugin_version_unresolved");
        continue;
      }
      const root = await realpath(join(base, version));
      if (!contained(cache, root)) {
        warn("unsafe_codex_plugin_root");
        continue;
      }
      const portablePath = join(root, "plugin.json");
      const portable = await readOptional(portablePath, result.diagnostics);
      const manifestPath =
        portable === undefined
          ? join(root, ".codex-plugin/plugin.json")
          : portablePath;
      if (
        (await lstat(manifestPath)).isSymbolicLink() ||
        !contained(root, await realpath(manifestPath))
      )
        throw new Error();
      const text =
        portable ?? (await readOptional(manifestPath, result.diagnostics));
      const raw: unknown = JSON.parse(text ?? "");
      const manifest = manifestSchema.parse(raw);
      if (portable !== undefined) {
        const doc = z
          .object({
            $schema: z.literal(
              "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            ),
            extensions: z.unknown().optional(),
          })
          .parse(raw);
        if (doc.extensions !== undefined || manifest.skills !== undefined) {
          warn("unsupported_codex_plugin_extension");
          continue;
        }
      }
      const components =
        manifest.skills === undefined
          ? ["./skills"]
          : typeof manifest.skills === "string"
            ? [manifest.skills]
            : manifest.skills;
      if (components.length > 64) throw new Error();
      for (const component of components.length ? components : ["./skills"]) {
        const path = resolve(root, component);
        if (
          !component.startsWith("./") ||
          component.split(/[\\/]/u).includes("..") ||
          !contained(root, path)
        ) {
          warn("unsafe_codex_plugin_component");
          continue;
        }
        let canonical: string;
        try {
          canonical = await realpath(path);
        } catch (e) {
          if (isMissing(e)) continue;
          throw e;
        }
        if (
          !contained(root, canonical) ||
          (await lstat(path)).isSymbolicLink()
        ) {
          warn("unsafe_codex_plugin_component");
          continue;
        }
        const found = await scanSources("codex", [{ path, scope: "user" }], {
          recursive: portable === undefined,
          followSymlinks: false,
          rootSkill: false,
        });
        for (const skill of found.skills) {
          skill.name = `${manifest.name}:${skill.name}`;
          skill.metadata.codex = {
            origin: "plugin",
            nativeName: skill.name,
            configuredEnabled: true,
            modelInvocable: true,
            sessionAvailability: "unconfirmed",
            pluginIdentity: identity,
            pluginVersion: version,
          } satisfies CodexSkillMetadata;
        }
        result.skills.push(...found.skills);
        result.diagnostics.push(...found.diagnostics);
      }
    } catch (e) {
      warn(
        isMissing(e)
          ? "codex_plugin_install_missing"
          : "invalid_codex_plugin_manifest",
      );
    }
  }
  return result;
}

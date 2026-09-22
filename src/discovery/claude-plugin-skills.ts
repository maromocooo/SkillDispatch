import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { compareText } from "../core/order.js";
import { claudeDiagnostic } from "./claude-files.js";
import { invocationIdentity, safeInvocationSegment } from "./claude-origin.js";
import type { ActivePlugin } from "./claude-plugins.js";
import { scanSources } from "./scan.js";
import type { DiscoveryMetadata, DiscoveryResult } from "./types.js";

/** Only already resolved active installations reach filesystem skill scanning. */
export async function discoverPluginSkills(
  plugins: readonly ActivePlugin[],
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { skills: [], diagnostics: [] };
  for (const plugin of plugins) {
    const copies: DiscoveryResult["skills"][] = [];
    let invalid = false;
    for (const root of plugin.paths) {
      const sources: { path: string; scope: "user" | "repo" | "admin" }[] = [];
      for (const directory of plugin.skillDirectories) {
        const path = join(root, directory);
        // Reject component-parent symlinks too, including a/alias/b layouts.
        let parent = path;
        try {
          while (parent !== root) {
            if ((await lstat(parent)).isSymbolicLink()) throw new Error();
            parent = dirname(parent);
            if (relative(root, parent).startsWith("..")) throw new Error();
          }
          sources.push({
            path,
            scope:
              plugin.scope === "managed"
                ? "admin"
                : plugin.scope === "user"
                  ? "user"
                  : "repo",
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
            invalid = true;
            claudeDiagnostic(result.diagnostics, "unsafe_plugin_installation");
          }
        }
      }
      const scanned = await scanSources("claude-code", sources, {
        followSymlinks: false,
        parserOptions: (path) => ({
          fallbackName: path === root ? plugin.name : basename(path),
          fallbackDescriptionFromBody: true,
          allowMissingFrontmatter: true,
        }),
      });
      result.diagnostics.push(
        ...scanned.diagnostics.map(({ code, level }) => ({
          code,
          level,
          message:
            "Cannot parse an installed plugin skill; source contents withheld.",
        })),
      );
      for (const skill of scanned.skills) {
        const prefix = `${plugin.name}:`;
        const segment = skill.name.startsWith(prefix)
          ? skill.name.slice(prefix.length)
          : skill.name;
        const name =
          safeInvocationSegment(plugin.name) && safeInvocationSegment(segment)
            ? prefix + segment
            : undefined;
        const provenance = skill.metadata.discovery as DiscoveryMetadata;
        if (!name || relative(root, provenance.path).startsWith("..")) {
          skill.enabled = false;
          claudeDiagnostic(result.diagnostics, "unsupported_native_invocation");
        }
        skill.metadata.commandName = name;
        skill.metadata.claude = {
          origin: "plugin",
          modelInvocable: skill.enabled,
          ...(name ? { nativeInvocationName: name } : {}),
          pluginName: plugin.name,
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          installationScope: plugin.scope,
        };
        // Logical installed identity is independent of disposable cache locations.
        skill.id = createHash("sha256")
          .update(
            JSON.stringify([
              "claude-code",
              plugin.id,
              plugin.version,
              name ?? skill.name,
              skill.contentHash,
            ]),
          )
          .digest("hex");
      }
      copies.push(scanned.skills);
    }
    const signature = (skills: DiscoveryResult["skills"]) =>
      JSON.stringify(
        skills
          .map((s) =>
            JSON.stringify([s.metadata.commandName, s.contentHash, s.enabled]),
          )
          .sort(compareText),
      );
    if (
      invalid ||
      copies.some((copy) => signature(copy) !== signature(copies[0] ?? []))
    ) {
      claudeDiagnostic(result.diagnostics, "ambiguous_plugin_installation");
      continue;
    }
    const first = copies[0] ?? [];
    // Different files mapping to one native name are retained only as non-routable.
    const counts = new Map<string, number>();
    for (const skill of first) {
      const key = invocationIdentity(
        String(skill.metadata.commandName ?? skill.name),
      );
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const skill of first) {
      if (
        (counts.get(
          invocationIdentity(String(skill.metadata.commandName ?? skill.name)),
        ) ?? 0) > 1
      ) {
        skill.enabled = false;
        skill.metadata.disabledReason = "ambiguous_plugin_skill";
        claudeDiagnostic(result.diagnostics, "ambiguous_plugin_skill");
      }
    }
    result.skills.push(
      ...new Map(first.map((skill) => [skill.id, skill])).values(),
    );
  }
  return result;
}

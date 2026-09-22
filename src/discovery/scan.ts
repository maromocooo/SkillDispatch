import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { compareText } from "../core/order.js";
import type { AgentKind } from "../core/types.js";
import { finalizeCatalog } from "./catalog.js";
import { isMissing, readOptional } from "./filesystem.js";
import { type ParseSkillContext, parseSkill } from "./parse-skill.js";
import type { DiscoveryResult, DiscoverySource } from "./types.js";

interface ScanOptions {
  recursive?: boolean;
  followSymlinks?: boolean;
  skipDirectory?: (name: string) => boolean;
  parserOptions?: (path: string) => Partial<ParseSkillContext>;
}

/** Source order breaks canonical-path aliases; distinct paths are never merged by name. */
export async function scanSources(
  agent: AgentKind,
  sources: readonly DiscoverySource[],
  options: ScanOptions = {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { skills: [], diagnostics: [] };
  const seen = new Set<string>();
  const active = new Set<string>();
  const seenFiles = new Set<string>();
  let visited = 0;
  const warn = (code: string, message: string, path: string) =>
    result.diagnostics.push({ code, level: "warning", message, path });
  for (const [sourceIndex, source] of sources.entries()) {
    async function walk(path: string, depth: number): Promise<void> {
      let canonical: string;
      try {
        if (
          options.followSymlinks === false &&
          (await lstat(path)).isSymbolicLink()
        ) {
          warn("unsafe_claude_source", "Symlink source excluded.", path);
          return;
        }
        canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) return;
      } catch (error) {
        if (depth !== 0 || !isMissing(error))
          warn(
            "scan_failed",
            "Cannot access skill directory or symlink target.",
            path,
          );
        return;
      }
      if (active.has(canonical)) {
        warn("symlink_loop", "Skipped a directory symlink cycle.", path);
        return;
      }
      if (seen.has(canonical)) return;
      if (depth > 32 || visited >= 10_000) {
        warn("scan_limit", "Skill discovery traversal limit reached.", path);
        return;
      }
      visited++;
      seen.add(canonical);
      active.add(canonical);
      try {
        const entries = (
          await readdir(canonical, { withFileTypes: true })
        ).sort((a, b) => compareText(a.name, b.name));
        const file = entries.find((entry) => entry.name === "SKILL.md");
        if (file) {
          if (options.followSymlinks === false && file.isSymbolicLink()) {
            warn("unsafe_claude_source", "Symlink skill file excluded.", path);
            return;
          }
          const skillPath = await realpath(join(canonical, "SKILL.md"));
          if (!seenFiles.has(skillPath)) {
            seenFiles.add(skillPath);
            const sourceText = await readOptional(
              skillPath,
              result.diagnostics,
            );
            if (sourceText !== undefined) {
              const parsed = parseSkill(sourceText, {
                ...options.parserOptions?.(path),
                path: skillPath,
                agent,
                scope: source.scope,
              });
              for (const skill of parsed.skills)
                skill.metadata.discovery = {
                  source: source.path,
                  sourceIndex,
                  path: join(path, "SKILL.md"),
                };
              result.skills.push(...parsed.skills);
              result.diagnostics.push(...parsed.diagnostics);
            }
          }
          return; // Supporting scripts/references are not additional skill roots.
        }
        if (depth > 0 && !options.recursive) return;
        for (const entry of entries) {
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            options.skipDirectory?.(entry.name)
          )
            continue;
          if (entry.isDirectory() || entry.isSymbolicLink())
            await walk(join(canonical, entry.name), depth + 1);
        }
      } catch {
        warn(
          "scan_failed",
          "Cannot read skill directory or SKILL.md target.",
          path,
        );
      } finally {
        active.delete(canonical);
      }
    }
    await walk(source.path, 0);
  }
  return finalizeCatalog([result]);
}

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { childDirectories, claudeDiagnostic } from "./claude-files.js";
import { invocationIdentity, safeInvocationSegment } from "./claude-origin.js";
import { scanSources } from "./scan.js";
import type { DiscoveryMetadata, DiscoveryResult } from "./types.js";

export async function discoverSyncedSkills(
  configRoot: string,
): Promise<DiscoveryResult> {
  const diagnostics: DiscoveryResult["diagnostics"] = [];
  const root = join(configRoot, "skills/synced");
  const accounts = await childDirectories(root, diagnostics);
  const result = await scanSources(
    "claude-code",
    accounts.map((account) => ({ path: join(root, account), scope: "user" })),
    {
      followSymlinks: false,
      rootSkill: false,
      parserOptions: (path) => ({
        fallbackName: basename(path),
        fallbackDescriptionFromBody: true,
        allowMissingFrontmatter: true,
      }),
    },
  );
  diagnostics.push(
    ...result.diagnostics.map(({ code, level }) => ({
      code,
      level,
      message: "Cannot parse a synced skill; source contents withheld.",
    })),
  );
  const groups = new Map<string, typeof result.skills>();
  for (const skill of result.skills) {
    const entry = skill.metadata.discovery as DiscoveryMetadata;
    const name = basename(dirname(entry.path));
    const native =
      safeInvocationSegment(name) &&
      dirname(dirname(entry.path)) === entry.source
        ? `anthropic-skills:${name}`
        : undefined;
    // No account identifier or cache path participates in logical synced identity.
    skill.id = createHash("sha256")
      .update(
        JSON.stringify([
          "claude-code",
          "synced",
          native ?? skill.name,
          skill.contentHash,
        ]),
      )
      .digest("hex");
    skill.metadata.claude = {
      origin: "synced",
      modelInvocable: Boolean(native),
      ...(native ? { nativeInvocationName: native } : {}),
    };
    skill.metadata.commandName = native;
    if (!native) {
      skill.enabled = false;
      claudeDiagnostic(diagnostics, "unsupported_native_invocation");
    }
    const key = invocationIdentity(native ?? skill.name);
    const group = groups.get(key) ?? [];
    group.push(skill);
    groups.set(key, group);
  }
  const skills: typeof result.skills = [];
  for (const group of groups.values()) {
    if (group.length > 1) {
      // No public active-account/stale-cache selector: never choose by directory/mtime.
      // Even identical copies might belong to a stale account; keep one disabled version.
      claudeDiagnostic(diagnostics, "ambiguous_synced_skill");
      for (const skill of group) {
        skill.enabled = false;
        skill.metadata.disabledReason = "ambiguous_synced_skill";
        (skill.metadata.claude as { modelInvocable: boolean }).modelInvocable =
          false;
      }
    }
    const unique = new Map(group.map((skill) => [skill.id, skill]));
    skills.push(...unique.values());
  }
  return { skills, diagnostics };
}

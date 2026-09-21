import { compareText } from "../core/order.js";
import type { AgentKind, Diagnostic, SkillDescriptor } from "../core/types.js";
import type { DiscoveryResult } from "./types.js";

export function finalizeCatalog(
  results: readonly DiscoveryResult[],
): DiscoveryResult {
  const byId = new Map<string, SkillDescriptor>();
  const diagnostics: Diagnostic[] = [];
  for (const result of results) {
    for (const skill of result.skills)
      if (!byId.has(skill.id)) byId.set(skill.id, skill);
    diagnostics.push(
      ...result.diagnostics.filter((d) => d.code !== "duplicate_name"),
    );
  }
  const skills = [...byId.values()].sort(
    (a, b) => compareText(a.agent, b.agent) || compareText(a.path, b.path),
  );
  const names = new Map<
    string,
    { agent: AgentKind; name: string; skillIds: string[] }
  >();
  for (const skill of skills) {
    const name = skill.name.replace(/\s+/gu, " ").trim();
    const key = JSON.stringify([skill.agent, name]);
    const group = names.get(key) ?? { agent: skill.agent, name, skillIds: [] };
    group.skillIds.push(skill.id);
    names.set(key, group);
  }
  for (const { agent, name, skillIds } of names.values()) {
    if (skillIds.length > 1)
      diagnostics.push({
        code: "duplicate_name",
        level: "warning",
        message: `Multiple ${agent} skills share the name ${JSON.stringify(name)}; all paths are retained.`,
        skillIds,
      });
  }
  diagnostics.sort(
    (a, b) =>
      compareText(a.path ?? "", b.path ?? "") ||
      compareText(a.code, b.code) ||
      compareText(a.message, b.message),
  );
  return { skills, diagnostics };
}

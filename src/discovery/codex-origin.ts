import { createHash } from "node:crypto";
import type { SkillDescriptor } from "../core/types.js";

export const codexOrigins = [
  "local-user",
  "local-project",
  "system",
  "plugin",
  "admin",
  "unknown",
] as const;
export interface CodexSkillMetadata {
  origin: (typeof codexOrigins)[number];
  nativeName: string;
  configuredEnabled: boolean;
  modelInvocable: boolean;
  sessionAvailability: "unconfirmed";
  pluginIdentity?: string;
  pluginVersion?: string;
}
export function codexMetadata(
  skill: SkillDescriptor,
): CodexSkillMetadata | undefined {
  if (skill.agent !== "codex") return;
  const m = skill.metadata.codex as CodexSkillMetadata | undefined;
  return m &&
    codexOrigins.includes(m.origin) &&
    typeof m.modelInvocable === "boolean"
    ? m
    : undefined;
}
export const safeCodexName = (name: string) =>
  /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?$/u.test(
    name,
  );
export function codexCatalogIdentity(skill: SkillDescriptor): string {
  const m = codexMetadata(skill);
  return createHash("sha256")
    .update(
      JSON.stringify([
        m?.origin,
        m?.nativeName,
        m?.pluginIdentity ?? null,
        m?.pluginVersion ?? null,
        skill.scope,
      ]),
    )
    .digest("hex");
}
export function codexOriginCounts(skills: readonly SkillDescriptor[]) {
  return Object.fromEntries(
    codexOrigins.map((origin) => {
      const found = skills.filter((s) => codexMetadata(s)?.origin === origin);
      return [
        origin,
        {
          discovered: found.length,
          modelRoutable: found.filter((s) => s.enabled).length,
          sessionConfirmed: 0,
        },
      ];
    }),
  );
}

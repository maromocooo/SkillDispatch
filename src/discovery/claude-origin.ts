import { createHash } from "node:crypto";
import type { SkillDescriptor } from "../core/types.js";

export const claudeOrigins = [
  "local-user",
  "local-project",
  "synced",
  "plugin",
  "managed",
  "unknown",
] as const;
export type ClaudeOrigin = (typeof claudeOrigins)[number];
export interface ClaudeSkillMetadata {
  origin: ClaudeOrigin;
  nativeInvocationName?: string;
  modelInvocable: boolean;
  pluginId?: string;
  pluginVersion?: string;
  pluginName?: string;
  installationScope?: "user" | "project" | "local" | "managed";
}

export function claudeMetadata(
  skill: SkillDescriptor,
): ClaudeSkillMetadata | undefined {
  const value = skill.metadata.claude;
  if (skill.agent !== "claude-code" || !value || typeof value !== "object")
    return;
  const metadata = value as ClaudeSkillMetadata;
  return claudeOrigins.includes(metadata.origin) &&
    typeof metadata.modelInvocable === "boolean"
    ? metadata
    : undefined;
}

export function claudeOriginCounts(skills: readonly SkillDescriptor[]) {
  return Object.fromEntries(
    claudeOrigins.map((origin) => {
      const matching = skills.filter(
        (skill) =>
          skill.agent === "claude-code" &&
          (claudeMetadata(skill)?.origin ?? "unknown") === origin,
      );
      return [
        origin,
        {
          discovered: matching.length,
          modelRoutable: matching.filter((s) => s.enabled).length,
        },
      ];
    }),
  );
}

export function safeInvocationSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]{0,127}$/u.test(value)
  );
}

/** Mirrors only documented collision normalization, not native precedence. */
export function invocationIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\p{Cf}]/gu, "")
    .replace(/[‐‑‒–—−]/gu, "-")
    .toLowerCase();
}

/** Adapter-owned path-free digest consumed by the generic fingerprint helper. */
export function claudeCatalogIdentity(skill: SkillDescriptor): string {
  const metadata = claudeMetadata(skill);
  return createHash("sha256")
    .update(
      JSON.stringify([
        metadata?.origin ?? "unknown",
        metadata?.nativeInvocationName ?? null,
        metadata?.pluginId ?? null,
        metadata?.pluginVersion ?? null,
        metadata?.installationScope ?? null,
        metadata?.modelInvocable ?? false,
      ]),
    )
    .digest("hex");
}

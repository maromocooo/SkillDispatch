import { createHash } from "node:crypto";
import { compareText } from "../core/order.js";
import type { SkillDescriptor } from "../core/types.js";

/** Multiset, optionally enriched by an adapter-owned path-free identity digest. */
export function catalogFingerprint(skills: readonly SkillDescriptor[]): string {
  const entries = skills
    .map((skill) =>
      JSON.stringify([
        skill.agent,
        skill.scope,
        skill.name.replace(/\s+/gu, " ").trim(),
        skill.contentHash,
        skill.enabled,
        ...(typeof skill.metadata.catalogIdentity === "string" &&
        /^[a-f0-9]{64}$/u.test(skill.metadata.catalogIdentity)
          ? [skill.metadata.catalogIdentity]
          : []),
      ]),
    )
    .sort(compareText);
  return createHash("sha256")
    .update(JSON.stringify(entries), "utf8")
    .digest("hex");
}

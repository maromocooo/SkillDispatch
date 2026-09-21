import { createHash } from "node:crypto";
import { compareText } from "../core/order.js";
import type { SkillDescriptor } from "../core/types.js";

/** v1 multiset: no path-derived IDs, paths, descriptions or arbitrary metadata. */
export function catalogFingerprint(skills: readonly SkillDescriptor[]): string {
  const entries = skills
    .map((skill) =>
      JSON.stringify([
        skill.agent,
        skill.scope,
        skill.name.replace(/\s+/gu, " ").trim(),
        skill.contentHash,
        skill.enabled,
      ]),
    )
    .sort(compareText);
  return createHash("sha256")
    .update(JSON.stringify(entries), "utf8")
    .digest("hex");
}

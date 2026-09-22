import { basename, dirname, resolve } from "node:path";
import type { SkillDescriptor } from "../core/types.js";
import { claudeMetadata, safeInvocationSegment } from "./claude-origin.js";

export function parseClaudeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  return undefined;
}

/** Local, directly discovered personal/project commands only. Never use display names. */
export function claudeInvocationName(
  skill: SkillDescriptor,
): string | undefined {
  if (skill.agent !== "claude-code" || !["repo", "user"].includes(skill.scope))
    return;
  const claude = claudeMetadata(skill);
  if (claude?.origin === "synced") {
    const name = claude.nativeInvocationName;
    const segment = name?.slice("anthropic-skills:".length);
    return name?.startsWith("anthropic-skills:") &&
      safeInvocationSegment(segment) &&
      skill.metadata.commandName === name
      ? name
      : undefined;
  }
  const discovery = skill.metadata.discovery;
  if (!discovery || typeof discovery !== "object") return;
  const { path, source } = discovery as Record<string, unknown>;
  if (typeof path !== "string" || typeof source !== "string") return;
  if (
    basename(path) !== "SKILL.md" ||
    resolve(dirname(dirname(path))) !== resolve(source)
  )
    return;
  const name = basename(dirname(path));
  // No whitespace, punctuation instructions, namespaces, slashes, controls or bidi marks.
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]{0,127}$/u.test(name)) return;
  return skill.metadata.commandName === name ? name : undefined;
}

export function claudeModelInvocationAllowed(skill: SkillDescriptor): boolean {
  const declared = skill.metadata["disable-model-invocation"];
  return (
    skill.enabled &&
    (declared === undefined || parseClaudeBoolean(declared) === false)
  );
}

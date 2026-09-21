import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { AgentKind, SkillScope } from "../core/types.js";
import type { DiscoveryResult } from "./types.js";

const textField = z
  .string()
  .transform((value) => value.replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1));
const frontmatterSchema = z
  .object({ name: textField, description: textField })
  .catchall(z.unknown());

export interface ParseSkillContext {
  /** Caller resolves symlinks before parsing. */
  path: string;
  scope: SkillScope;
  agent: AgentKind;
  fallbackName?: string;
  fallbackDescriptionFromBody?: boolean;
  allowMissingFrontmatter?: boolean;
}

/** Data-only parser: never evaluates Markdown, tags, or embedded commands. */
export function parseSkill(
  source: string,
  context: ParseSkillContext,
): DiscoveryResult {
  const invalid = (code: string, message: string): DiscoveryResult => ({
    skills: [],
    diagnostics: [{ code, level: "warning", message, path: context.path }],
  });
  const normalized = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  let body = normalized;
  let raw: Record<string, unknown> = {};
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex(
      (line, index) => index > 0 && line.trimEnd() === "---",
    );
    if (end < 0)
      return invalid(
        "invalid_frontmatter",
        "Frontmatter has no closing delimiter.",
      );
    try {
      const document = parseDocument(lines.slice(1, end).join("\n"), {
        uniqueKeys: true,
      });
      if (document.errors.length || document.warnings.length)
        throw new Error("Invalid YAML");
      const value: unknown = document.toJS({ maxAliasCount: 20 });
      if (value !== null && (typeof value !== "object" || Array.isArray(value)))
        throw new Error("Expected mapping");
      JSON.stringify(value); // Reject circular YAML aliases before emitting JSON metadata.
      raw = (value ?? {}) as Record<string, unknown>;
    } catch {
      // Parser errors can contain source excerpts; never expose those in diagnostics.
      return invalid(
        "invalid_yaml",
        "Frontmatter must be a valid YAML mapping with unique keys.",
      );
    }
    body = lines.slice(end + 1).join("\n");
  } else if (!context.allowMissingFrontmatter) {
    return invalid(
      "missing_frontmatter",
      "SKILL.md must start with YAML frontmatter.",
    );
  }
  const candidate = { ...raw };
  if (candidate.name === undefined && context.fallbackName !== undefined)
    candidate.name = context.fallbackName;
  if (
    candidate.description === undefined &&
    context.fallbackDescriptionFromBody
  ) {
    candidate.description = body
      .split("\n")
      .find((line) => line.trim().length > 0);
  }
  const parsed = frontmatterSchema.safeParse(candidate);
  if (!parsed.success)
    return invalid(
      "invalid_metadata",
      "Skill name and description must be non-empty strings.",
    );
  const { name, description, ...metadata } = parsed.data;
  return {
    skills: [
      {
        id: createHash("sha256")
          .update(`${context.agent}\0${context.path}`)
          .digest("hex"),
        name,
        description,
        path: context.path,
        directory: dirname(context.path),
        scope: context.scope,
        agent: context.agent,
        enabled: true,
        metadata,
        contentHash: createHash("sha256").update(source).digest("hex"),
      },
    ],
    diagnostics: [],
  };
}

import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { z } from "zod";

const name = z
  .string()
  .transform((value) => value.replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1));
export const skillSelectorSchema = z.strictObject({
  name,
  agent: z.enum(["codex", "claude-code"]).optional(),
  scope: z.enum(["repo", "user", "admin", "system", "unknown"]).optional(),
});
export type SkillSelector = z.output<typeof skillSelectorSchema>;
const selectorKey = (selector: SkillSelector) =>
  JSON.stringify([
    selector.name,
    selector.agent ?? null,
    selector.scope ?? null,
  ]);
export const evalGatesSchema = z.strictObject({
  min_precision: z.number().min(0).max(1).optional(),
  min_recall: z.number().min(0).max(1).optional(),
});
const caseSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    prompt: z.string().refine((value) => value.trim().length > 0),
    should: z.array(skillSelectorSchema).default([]),
    should_not: z.array(skillSelectorSchema).default([]),
    fully_labeled: z.boolean().default(false),
  })
  .refine((value) => {
    const keys = [...value.should, ...value.should_not].map(selectorKey);
    return new Set(keys).size === keys.length;
  });
const datasetSchema = z
  .strictObject({
    version: z.literal(1),
    cases: z.array(caseSchema).min(1),
    gates: evalGatesSchema.default({}),
  })
  .refine(
    (value) =>
      new Set(value.cases.map((item) => item.id)).size === value.cases.length,
  );

export type EvalDataset = z.output<typeof datasetSchema>;
export type EvalGates = z.output<typeof evalGatesSchema>;
export type EvalCase = EvalDataset["cases"][number];

export type EvalInputErrorCode =
  | "invalid_eval_input"
  | "unreadable_eval_file"
  | "unknown_eval_skill"
  | "ambiguous_eval_skill"
  | "conflicting_eval_labels"
  | "duplicate_eval_label"
  | "invalid_eval_catalog";
export class EvalInputError extends Error {
  constructor(readonly code: EvalInputErrorCode) {
    // No YAML excerpts, parser/Zod errors, file paths or prompts in errors.
    super(
      `${code}: evaluation input is invalid; check the dataset and discovered catalog.`,
    );
    this.name = "EvalInputError";
  }
}

export function validateEvalDataset(value: unknown): EvalDataset {
  const result = datasetSchema.safeParse(value);
  if (!result.success) throw new EvalInputError("invalid_eval_input");
  return result.data;
}

/** Parses data only, with strict fields and bounded YAML aliases. */
export function parseEvalYaml(source: string): EvalDataset {
  try {
    if (Buffer.byteLength(source, "utf8") > 1024 * 1024) throw new Error();
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    const value: unknown = document.toJS({ maxAliasCount: 20 });
    JSON.stringify(value); // Reject circular aliases before schema traversal.
    return validateEvalDataset(value);
  } catch {
    throw new EvalInputError("invalid_eval_input");
  }
}

export async function loadEvalFile(path: string): Promise<EvalDataset> {
  let source: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    source = await readFile(path, "utf8");
  } catch {
    throw new EvalInputError("unreadable_eval_file");
  }
  return parseEvalYaml(source);
}

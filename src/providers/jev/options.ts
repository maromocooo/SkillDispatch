import { z } from "zod";

// Local safety ceiling, not a claimed API question-count limit. See PR2_VALIDATION.
export const MAX_JEV_CHUNK_SIZE = 48;
// SkillDispatch burst/cost guard, not an official TypeSafe API limit.
export const MAX_JEV_CONCURRENCY = 8;
export const jevOptionsSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  chunkSize: z.number().int().min(1).max(MAX_JEV_CHUNK_SIZE),
  concurrency: z.number().int().min(1).max(MAX_JEV_CONCURRENCY),
  requestTimeoutMs: z.number().int().min(1).max(2_147_483_647),
  maxRetries: z.number().int().min(0).max(2),
});

export type ResolvedJevOptions = z.output<typeof jevOptionsSchema>;
export type JevOptions = Partial<ResolvedJevOptions>;

export const defaultJevOptions = (): ResolvedJevOptions => ({
  model: "jev-latest",
  chunkSize: 48,
  concurrency: 2,
  requestTimeoutMs: 1800,
  maxRetries: 0,
});

export function resolveJevOptions(options: JevOptions): ResolvedJevOptions {
  const result = jevOptionsSchema.safeParse({
    ...defaultJevOptions(),
    ...options,
  });
  if (!result.success) throw new Error("Invalid Jev provider options.");
  return result.data;
}

export function validateApiKey(apiKey: string | undefined): string {
  if (apiKey === undefined || !apiKey.trim())
    throw new Error("TYPESAFE_API_KEY is required for the Jev provider.");
  // Bearer credentials must be printable ASCII with no whitespace or controls.
  if (!/^[\x21-\x7e]+$/.test(apiKey))
    throw new Error("TYPESAFE_API_KEY has an invalid format.");
  return apiKey;
}

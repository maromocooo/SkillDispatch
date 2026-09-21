import { z } from "zod";

// Local safety ceiling, not a claimed API question-count limit. See PR2_VALIDATION.
export const MAX_JEV_CHUNK_SIZE = 48;
export const jevOptionsSchema = z.object({
  model: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
    .default("jev-latest"),
  chunkSize: z.number().int().min(1).max(MAX_JEV_CHUNK_SIZE).default(48),
  concurrency: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  requestTimeoutMs: z.number().int().min(1).max(2_147_483_647).default(1800),
  maxRetries: z.number().int().min(0).max(2).default(0),
});

export type JevOptions = z.input<typeof jevOptionsSchema>;
export type ResolvedJevOptions = z.output<typeof jevOptionsSchema>;

export function resolveJevOptions(options: JevOptions): ResolvedJevOptions {
  const result = jevOptionsSchema.safeParse(options);
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

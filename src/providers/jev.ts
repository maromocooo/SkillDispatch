import { z } from "zod";
import { compareText } from "../core/order.js";
import {
  createJevCall,
  type JevCall,
  type JevFailureCode,
  JevRequestError,
} from "./jev/client.js";
import {
  type JevOptions,
  type ResolvedJevOptions,
  resolveJevOptions,
} from "./jev/options.js";
import { type JevRequest, skillQuestion } from "./jev/questions.js";
import type {
  ProviderDecision,
  ProviderDiagnostic,
  ProviderRouteInput,
  ProviderRouteOutput,
  RouterProvider,
  RoutingCandidate,
} from "./types.js";

export type JevProviderOptions = JevOptions & { apiKey?: string | undefined };
export type { JevCall, JevRequest };

const responseSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  answers: z.record(
    z.string(),
    z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  ),
});

interface ChunkResult {
  decisions: ProviderDecision[];
  failedSkillIds: string[];
  diagnostics: ProviderDiagnostic[];
  model?: string;
}

const failureMessages: Record<JevFailureCode | "jev_not_evaluated", string> = {
  jev_request_failed: "Jev request failed; listed skills were not evaluated.",
  jev_request_timeout:
    "Jev request timed out; listed skills were not evaluated.",
  jev_cancelled:
    "Jev evaluation was cancelled; listed skills were not evaluated.",
  jev_invalid_response:
    "Jev returned an invalid chunk response; listed skills were not evaluated.",
  jev_not_evaluated:
    "Jev scheduling stopped; listed skills were not evaluated.",
};

function failedChunk(
  candidates: readonly RoutingCandidate[],
  code: keyof typeof failureMessages,
): ChunkResult {
  const skillIds = candidates.map((candidate) => candidate.id);
  return {
    decisions: [],
    failedSkillIds: skillIds,
    diagnostics: [
      { code, level: "warning", message: failureMessages[code], skillIds },
    ],
  };
}

/** Independent Noul judgments; scheduling and SDK details stay outside the core. */
export class JevRouterProvider implements RouterProvider {
  readonly name = "jev";
  readonly #options: ResolvedJevOptions;
  readonly #call: JevCall;

  constructor(
    options: JevProviderOptions = {},
    dependencies: { call?: JevCall } = {},
  ) {
    this.#options = resolveJevOptions(options);
    this.#call =
      dependencies.call ??
      createJevCall({
        ...this.#options,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      });
  }

  async judge(input: ProviderRouteInput): Promise<ProviderRouteOutput> {
    const candidates = [...input.candidates].sort((a, b) =>
      compareText(a.id, b.id),
    );
    if (
      new Set(candidates.map((candidate) => candidate.id)).size !==
      candidates.length
    )
      throw new Error("Jev input contains duplicate skill IDs.");
    if (candidates.length === 0)
      return { completeness: "complete", decisions: [] };
    const chunks: RoutingCandidate[][] = [];
    for (
      let offset = 0;
      offset < candidates.length;
      offset += this.#options.chunkSize
    )
      chunks.push(candidates.slice(offset, offset + this.#options.chunkSize));
    const results: ChunkResult[] = new Array(chunks.length);
    let next = 0;
    let stopped = false;
    const worker = async () => {
      while (!stopped && !input.signal?.aborted) {
        const index = next++;
        const chunk = chunks[index];
        if (!chunk) return;
        try {
          // Keys are local to this request; never expose canonical path-derived IDs.
          const entries = chunk.map((candidate, i) => ({
            candidate,
            key: `q${String(i).padStart(3, "0")}`,
          }));
          const request: JevRequest = {
            model: this.#options.model,
            state: { prompt: input.prompt, requestingAgent: input.agent },
            questions: Object.fromEntries(
              entries.map(({ candidate, key }) => [
                key,
                skillQuestion(candidate),
              ]),
            ),
          };
          const response = responseSchema.safeParse(
            await this.#call(request, input.signal),
          );
          if (
            !response.success ||
            Object.keys(response.data.answers).length !== entries.length
          )
            throw new JevRequestError("jev_invalid_response");
          results[index] = {
            decisions: entries.map(({ candidate, key }) => {
              const answer = response.data.answers[key];
              if (
                !Object.hasOwn(response.data.answers, key) ||
                answer === undefined
              )
                throw new JevRequestError("jev_invalid_response");
              return { skillId: candidate.id, probability: answer.noul };
            }),
            failedSkillIds: [],
            diagnostics: [],
            model: response.data.model,
          };
        } catch (error) {
          const code = input.signal?.aborted
            ? "jev_cancelled"
            : error instanceof JevRequestError
              ? error.code
              : "jev_request_failed";
          results[index] = failedChunk(chunk, code);
          if (code === "jev_request_timeout" || code === "jev_cancelled")
            stopped = true;
        }
      }
    };
    // Only a bounded number of workers, never one promise per chunk.
    await Promise.all(
      Array.from(
        { length: Math.min(this.#options.concurrency, chunks.length) },
        worker,
      ),
    );
    for (const [index, chunk] of chunks.entries())
      results[index] ??= failedChunk(
        chunk,
        input.signal?.aborted ? "jev_cancelled" : "jev_not_evaluated",
      );
    const failedSkillIds = results.flatMap((result) => result.failedSkillIds);
    const diagnostics = results.flatMap((result) => result.diagnostics);
    const models = [
      ...new Set(
        results.flatMap((result) =>
          result.model === undefined ? [] : [result.model],
        ),
      ),
    ];
    if (models.length > 1)
      diagnostics.push({
        code: "jev_model_mismatch",
        level: "warning",
        message:
          "Jev chunks used different models; no single model is reported.",
      });
    const model = models.length === 1 ? models[0] : undefined;
    return {
      completeness: failedSkillIds.length ? "partial" : "complete",
      decisions: results.flatMap((result) => result.decisions),
      ...(failedSkillIds.length ? { failedSkillIds } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
      ...(model === undefined ? {} : { model }),
    };
  }
}

import type {
  ProviderRouteInput,
  ProviderRouteOutput,
  RouterProvider,
} from "./types.js";

const stopWords = new Set(
  "a an and are as at be build can do for from have help i implement in is it me of on or please that the this to use with write".split(
    " ",
  ),
);
const tokens = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => word.length >= 3 && !stopWords.has(word),
    ),
  );

export interface MockProviderOptions {
  /** ID takes precedence over name. Same-name skills remain independent decisions. */
  scores?: Readonly<Record<string, number>>;
  /** If set, unmatched candidates use this fixed score instead of token matching. */
  defaultProbability?: number;
}

/** Offline test provider. Scores are deterministic fixtures, not calibrated likelihoods. */
export class MockRouterProvider implements RouterProvider {
  readonly name = "mock";
  private readonly scores: Readonly<Record<string, number>>;
  private readonly defaultProbability: number | undefined;

  constructor(options: MockProviderOptions = {}) {
    this.scores = { ...options.scores };
    this.defaultProbability = options.defaultProbability;
    for (const score of [
      ...Object.values(this.scores),
      ...(this.defaultProbability === undefined
        ? []
        : [this.defaultProbability]),
    ]) {
      if (!Number.isFinite(score) || score < 0 || score > 1)
        throw new RangeError("Mock scores must be between 0 and 1.");
    }
  }

  async judge(input: ProviderRouteInput): Promise<ProviderRouteOutput> {
    input.signal?.throwIfAborted();
    const promptTokens = tokens(input.prompt);
    return {
      decisions: input.candidates.map((candidate) => {
        const configured = Object.hasOwn(this.scores, candidate.id)
          ? this.scores[candidate.id]
          : Object.hasOwn(this.scores, candidate.name)
            ? this.scores[candidate.name]
            : this.defaultProbability;
        if (configured !== undefined)
          return {
            skillId: candidate.id,
            probability: configured,
            reasonCode: "mock_fixture",
          };
        const matches = [
          ...tokens(`${candidate.name} ${candidate.description}`),
        ].some((word) => promptTokens.has(word));
        return {
          skillId: candidate.id,
          probability: matches ? 0.9 : 0.04,
          reasonCode: matches ? "mock_token_match" : "mock_no_match",
        };
      }),
    };
  }
}

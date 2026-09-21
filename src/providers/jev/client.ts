import {
  APITimeoutError,
  APIUserAbortError,
  noul,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { ResolvedJevOptions } from "./options.js";
import { validateApiKey } from "./options.js";
import type { JevRequest } from "./questions.js";

export type JevCall = (
  request: JevRequest,
  signal?: AbortSignal,
) => Promise<unknown>;
export type JevFailureCode =
  | "jev_request_failed"
  | "jev_request_timeout"
  | "jev_cancelled"
  | "jev_invalid_response";

/** Carries no cause, stack from the SDK, request data, or credentials. */
export class JevRequestError extends Error {
  constructor(readonly code: JevFailureCode) {
    super("Jev evaluation unavailable.");
    this.name = "JevRequestError";
  }
}

/**
 * SDK 0.6.0 clones response streams. Native Undici tee cancellation can crash
 * Node 20/22 (typesafe-sdk-js#2). Consume the single native body before the SDK
 * receives it, so SDK cloning/cancellation only touches an in-memory Response.
 * Both caller cancellation and the SDK timeout still abort the native request.
 */
function bufferedFetch(fetchImplementation: typeof fetch): typeof fetch {
  return async (url, init) => {
    const response = await fetchImplementation(url, {
      ...init,
      redirect: "error",
    });
    const body = await response.arrayBuffer();
    return new Response(
      [204, 205, 304].includes(response.status) ? null : body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}

/** Explicit options override SDK environment defaults, including debug logging. */
export function createJevCall(
  options: ResolvedJevOptions & { apiKey?: string },
  fetchImplementation: typeof fetch = globalThis.fetch,
): JevCall {
  const apiKey = validateApiKey(options.apiKey);
  const client = new TypeSafeClient({
    apiKey,
    baseURL: "https://api.typesafe.ai",
    defaultModel: options.model,
    timeout: options.requestTimeoutMs,
    retry: { maxRetries: options.maxRetries },
    logLevel: "off",
    fetch: bufferedFetch(fetchImplementation),
  });
  return async (request, signal) => {
    try {
      return await client.systemOne(
        {
          model: request.model,
          state: request.state,
          questions: Object.fromEntries(
            Object.entries(request.questions).map(([key, question]) => [
              key,
              noul(question.instructions, question.criteria),
            ]),
          ),
        },
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      throw new JevRequestError(
        error instanceof APIUserAbortError
          ? "jev_cancelled"
          : error instanceof APITimeoutError
            ? "jev_request_timeout"
            : "jev_request_failed",
      );
    }
  };
}

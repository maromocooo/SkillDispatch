import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevCall } from "../../src/providers/jev/client.js";
import {
  resolveJevOptions,
  validateApiKey,
} from "../../src/providers/jev/options.js";
import {
  type JevRequest,
  skillQuestion,
} from "../../src/providers/jev/questions.js";

const request: JevRequest = {
  model: "jev-latest",
  state: { prompt: "synthetic request", requestingAgent: "codex" },
  questions: {
    q000: skillQuestion({
      id: "local-id",
      name: "review",
      description: "Review code",
      agent: "codex",
      scope: "repo",
    }),
  },
};
afterEach(() => vi.unstubAllEnvs());

describe("Jev SDK boundary", () => {
  it("honors an explicitly small retry count without forwarding HTTP error bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ detail: "synthetic-test-only private-prompt" }),
          { status: 503, headers: { "retry-after-ms": "0" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "jev-fixture",
            answers: { q000: { type: "noul", noul: 1 } },
          }),
        ),
      );
    const call = createJevCall(
      {
        ...resolveJevOptions({ maxRetries: 1 }),
        apiKey: "synthetic-test-only",
      },
      fetcher,
    );
    expect(await call(request)).toMatchObject({
      answers: { q000: { noul: 1 } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry HTTP failures by default or propagate raw response error text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "synthetic-test-only private-prompt secret-looking-value",
        }),
        { status: 503 },
      ),
    );
    const call = createJevCall(
      { ...resolveJevOptions({}), apiKey: "synthetic-test-only" },
      fetcher,
    );
    await call(request).then(
      () => {
        throw new Error("Expected failure");
      },
      (error: Error) => {
        expect(error.message).toBe("Jev evaluation unavailable.");
        expect(error.cause).toBeUndefined();
        expect(JSON.stringify(error)).not.toMatch(
          /synthetic-test-only|private-prompt|secret-looking-value/,
        );
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined,
    "",
    "   ",
    "synthetic\nkey",
    "synthetic\rkey",
    "synthetic\tkey",
    "synthetic\0key",
    "synthetic\x7fkey",
    "non-ascii-鍵",
  ])(
    "rejects missing or malformed credentials before fetch (%#)",
    async (apiKey) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(() =>
        createJevCall(
          {
            ...resolveJevOptions({}),
            ...(apiKey === undefined ? {} : { apiKey }),
          },
          fetcher,
        ),
      ).toThrow(/TYPESAFE_API_KEY/);
      expect(fetcher).not.toHaveBeenCalled();
      try {
        validateApiKey(apiKey);
      } catch (error) {
        if (apiKey?.trim()) expect(String(error)).not.toContain(apiKey);
      }
    },
  );

  it("uses the SDK Noul payload, explicit endpoint, timeout and no retries by default", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://untrusted.invalid");
    vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-fixture",
          answers: { q000: { type: "noul", noul: 0.5 } },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const call = createJevCall(
      { ...resolveJevOptions({}), apiKey: "synthetic-test-only" },
      fetcher,
    );
    expect(await call(request)).toMatchObject({
      answers: { q000: { noul: 0.5 } },
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(String(init?.body)).not.toContain("synthetic-test-only");
    expect(init?.redirect).toBe("error");
  });

  it("drops SDK error messages/causes and disables SDK debug logs even from the environment", async () => {
    vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
    const logs = ["debug", "info", "warn", "error"] as const;
    const spies = logs.map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new Error("synthetic-test-only synthetic request private-secret"),
        );
      const call = createJevCall(
        { ...resolveJevOptions({}), apiKey: "synthetic-test-only" },
        fetcher,
      );
      await expect(call(request)).rejects.toMatchObject({
        code: "jev_request_failed",
        message: "Jev evaluation unavailable.",
      });
      await call(request).catch((error: Error) => {
        expect(error.cause).toBeUndefined();
        expect(error.stack).not.toMatch(
          /synthetic-test-only|synthetic request|private-secret/,
        );
      });
      expect(fetcher).toHaveBeenCalledTimes(2); // One attempt per call, no retry.
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

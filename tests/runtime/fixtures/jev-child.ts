import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createJevCall } from "../../../src/providers/jev/client.js";
import { resolveJevOptions } from "../../../src/providers/jev/options.js";
import { skillQuestion } from "../../../src/providers/jev/questions.js";

const mode = process.argv[2];
let requests = 0;
const server = createServer((_req, res) => {
  requests++;
  if (mode === "before-headers") return;
  res.writeHead(200, { "content-type": "application/json" });
  if (mode === "healthy")
    res.end(
      JSON.stringify({
        model: "jev-fixture",
        answers: { q000: { type: "noul", noul: 0.9 } },
      }),
    );
  else {
    res.flushHeaders();
    res.write('{"model":');
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
try {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const call = createJevCall(
      {
        ...resolveJevOptions({
          requestTimeoutMs: mode === "cancel" ? 2000 : 150,
        }),
        apiKey: "synthetic-test-only",
      },
      async (url, init) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        const response = await fetch(`http://127.0.0.1:${address.port}`, init);
        if (mode === "cancel") setImmediate(() => controller.abort());
        return response;
      },
    );
    const result = call(
      {
        model: "jev-latest",
        state: { prompt: "synthetic", requestingAgent: "generic" },
        questions: {
          q000: skillQuestion({
            id: "A",
            name: "review",
            description: "Code review",
            scope: "repo",
            agent: "codex",
          }),
        },
      },
      controller.signal,
    );
    if (mode === "healthy")
      assert.equal(
        ((await result) as { answers: { q000: { noul: number } } }).answers.q000
          .noul,
        0.9,
      );
    else
      await assert.rejects(result, {
        code: mode === "cancel" ? "jev_cancelled" : "jev_request_timeout",
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(requests, 3);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
// No unhandledRejection listener: strict native failures must fail the subprocess.
console.log("runtime fixture passed");

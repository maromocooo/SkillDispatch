import { JevRouterProvider, route } from "../dist/index.js";

// Opt-in only. Never import this script from the normal test suite.
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey?.trim()) {
  console.log("SKIP: TYPESAFE_API_KEY is unavailable; no request was sent.");
} else {
  try {
    const names = ["react-patterns", "frontend-testing", "deployment"];
    const result = await route(
      {
        prompt: "Build a React form and write tests.",
        cwd: "/synthetic",
        agent: "generic",
        skills: names.map((name) => ({
          id: name,
          name,
          description: `Guidance for ${name.replaceAll("-", " ")}.`,
          agent: "generic",
          scope: "unknown",
          enabled: true,
          path: "/synthetic/SKILL.md",
          directory: "/synthetic",
          contentHash: "synthetic",
          metadata: {},
        })),
      },
      new JevRouterProvider({ apiKey }),
    );
    if (
      result.allDecisions.length !== names.length ||
      result.diagnostics.length
    )
      throw new Error("Incomplete smoke result");
    // Validates service integration only, not relevance/accuracy.
    console.log("PASS: live Jev returned three valid independent decisions.");
  } catch {
    console.error(
      "FAIL: live Jev smoke did not return a complete valid result.",
    );
    process.exitCode = 1;
  }
}

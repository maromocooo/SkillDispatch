import { route } from "../../core/route.js";
import { JevRouterProvider } from "../../providers/jev.js";
import { MockRouterProvider } from "../../providers/mock.js";
import {
  type CliEnvironment,
  type CliOptions,
  discoverForCommand,
} from "../context.js";
import { type CliIO, printDiagnostics, terminalText } from "../output.js";

export async function routeCommand(
  prompt: string,
  options: CliOptions,
  environment: CliEnvironment,
  io: CliIO,
): Promise<void> {
  if (!prompt.trim()) throw new Error("Prompt must not be empty.");
  const { cwd, config, agents, catalog } = await discoverForCommand(
    options,
    environment,
  );
  const apiKey = environment.env.TYPESAFE_API_KEY;
  const provider =
    config.router.provider === "mock"
      ? new MockRouterProvider(config.router.mock)
      : new JevRouterProvider({
          ...config.router.jev,
          ...(apiKey === undefined ? {} : { apiKey }),
        });
  const result = await route(
    {
      prompt,
      cwd,
      agent: agents.length === 1 ? (agents[0] ?? "generic") : "generic",
      skills: catalog.skills,
    },
    provider,
    config.policy,
    { timeoutMs: config.router.timeoutMs },
  );
  const diagnostics = [...catalog.diagnostics, ...result.diagnostics];
  const paths = new Map(catalog.skills.map((skill) => [skill.id, skill.path]));
  const selected = result.selected.map((decision) => ({
    ...decision,
    path: paths.get(decision.skillId),
  }));
  if (options.json) {
    io.stdout(
      `${JSON.stringify({ ...result, selected, allDecisions: result.allDecisions.map((decision) => ({ ...decision, path: paths.get(decision.skillId) })), diagnostics }, null, 2)}\n`,
    );
    return;
  }
  io.stdout(
    `Provider: ${result.router.provider}${result.router.provider === "mock" ? " (offline mock; scores are not calibrated)" : ""}\n`,
  );
  if (result.router.model !== undefined)
    io.stdout(`Model: ${terminalText(result.router.model)}\n`);
  if (!selected.length) io.stdout("No skills selected.\n");
  for (const decision of selected)
    io.stdout(
      `${terminalText(decision.name)}\t${decision.probability.toFixed(2)}\t${terminalText(decision.path ?? "")}\n`,
    );
  printDiagnostics(diagnostics, io);
}

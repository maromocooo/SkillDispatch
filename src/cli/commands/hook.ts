import type { Readable } from "node:stream";
import { parseClaudeInput } from "../../hooks/claude.js";
import { parseCodexInput } from "../../hooks/codex.js";
import { runShadowHook } from "../../hooks/runtime.js";
import { readHookJson } from "../../hooks/stdin.js";
import type { CliEnvironment } from "../context.js";

export async function hookCommand(
  host: "codex" | "claude",
  environment: CliEnvironment,
  stdin: Readable,
): Promise<void> {
  try {
    const raw = await readHookJson(stdin);
    const input =
      host === "codex" ? parseCodexInput(raw) : parseClaudeInput(raw);
    if (input) await runShadowHook(input, environment);
  } catch {
    /* Empty stdout/stderr and successful exit are the only shadow response. */
  }
}

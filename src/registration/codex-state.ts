import { parse as parseToml } from "smol-toml";
import type { HandlerLocation } from "./document.js";
import { readHostFile } from "./files.js";
import { RegistrationError } from "./types.js";

function table(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
/** User-layer enablement only. Trust hashes are type-checked, never retained or verified. */
export async function readCodexHookState(path: string) {
  const states = new Map<string, boolean | undefined>();
  const file = await readHostFile(path);
  if (!file) return states;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(
      new TextDecoder("utf8", { fatal: true }).decode(file.bytes),
    );
  } catch {
    throw new RegistrationError("malformed_codex_toml");
  }
  const features = parsed.features as { hooks?: unknown } | undefined;
  if (features?.hooks === false)
    throw new RegistrationError("host_hooks_disabled");
  if (features?.hooks !== undefined && typeof features.hooks !== "boolean")
    throw new RegistrationError("malformed_codex_toml");
  if (!Object.hasOwn(parsed, "hooks")) return states;
  const hooks = parsed.hooks;
  if (!table(hooks)) throw new RegistrationError("malformed_codex_toml");
  // Codex separates flattened event definitions from hooks.state. Unknown children
  // may be future event definitions, so only the verified state child is accepted.
  if (Object.keys(hooks).some((key) => key !== "state"))
    throw new RegistrationError("codex_inline_hooks_manual_action_required");
  if (!Object.hasOwn(hooks, "state")) return states;
  if (!table(hooks.state)) throw new RegistrationError("malformed_codex_toml");
  for (const [key, state] of Object.entries(hooks.state)) {
    if (
      !table(state) ||
      Object.keys(state).some(
        (field) => field !== "enabled" && field !== "trusted_hash",
      ) ||
      (state.enabled !== undefined && typeof state.enabled !== "boolean") ||
      (state.trusted_hash !== undefined &&
        typeof state.trusted_hash !== "string")
    )
      throw new RegistrationError("malformed_codex_toml");
    // Match the upstream user-state key normalization; ambiguous aliases fail closed.
    const normalized = key.trim();
    if (!normalized) continue;
    if (states.has(normalized))
      throw new RegistrationError("malformed_codex_toml");
    states.set(normalized, state.enabled as boolean | undefined);
  }
  return states;
}
const eventLabels = {
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
} as const;
/** Pinned Codex hook_key: source path + event label + original group/handler indices.
 * Call only after exact command/args ownership checks; never infer ownership from a key.
 */
export function codexHookDisabled(
  states: ReadonlyMap<string, boolean | undefined>,
  source: string,
  event: string,
  handler: HandlerLocation,
) {
  const label = eventLabels[event as keyof typeof eventLabels];
  return (
    label !== undefined &&
    states.get(`${source}:${label}:${handler.group}:${handler.handler}`) ===
      false
  );
}

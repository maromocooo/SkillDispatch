import { isAbsolute } from "node:path";
import { z } from "zod";
import type { HookInput } from "./types.js";

// Current upstream UserPromptSubmit command input; unknown future fields are stripped.
const schema = z.object({
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  cwd: z.string().refine(isAbsolute),
  hook_event_name: z.literal("UserPromptSubmit"),
  model: z.string(),
  permission_mode: z.string(),
  prompt: z.string(),
  transcript_path: z.string().nullable(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});

export function parseCodexInput(input: unknown): HookInput | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return {
    agent: "codex",
    cwd: value.cwd,
    prompt: value.prompt,
    sessionId: value.session_id,
    turnId: value.turn_id,
    model: value.model,
  };
}

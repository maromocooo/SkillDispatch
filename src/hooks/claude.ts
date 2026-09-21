import { isAbsolute } from "node:path";
import { z } from "zod";
import type { HookInput } from "./types.js";

const schema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().refine(isAbsolute),
  hook_event_name: z.literal("UserPromptSubmit"),
  permission_mode: z.string(),
  prompt: z.string(),
  transcript_path: z.string(),
  // Current optional common fields are type-checked, then deliberately discarded.
  prompt_id: z.string().optional(),
  scratchpad_dir: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  effort: z.object({ level: z.string() }).optional(),
});

export function parseClaudeInput(input: unknown): HookInput | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  // prompt_id is not a turn_id; UserPromptSubmit supplies no current model.
  return {
    agent: "claude-code",
    cwd: value.cwd,
    prompt: value.prompt,
    sessionId: value.session_id,
  };
}

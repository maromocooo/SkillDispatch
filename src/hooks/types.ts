export interface HookInput {
  agent: "codex" | "claude-code";
  cwd: string;
  prompt: string;
  sessionId: string;
  turnId?: string;
  model?: string;
}

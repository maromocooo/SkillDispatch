export interface HookInput {
  agent: "codex" | "claude-code";
  cwd: string;
  prompt: string;
  sessionId: string;
  promptCorrelationId?: string;
  model?: string;
}

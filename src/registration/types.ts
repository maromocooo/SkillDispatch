export const hosts = ["codex", "claude"] as const;
export type Host = (typeof hosts)[number];
export interface CliExecution {
  nodePath: string;
  cliPath: string;
  platform: NodeJS.Platform;
}
export interface RegistrationEnvironment {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}
export interface CommandSpec {
  command: string;
  args?: string[];
}
export interface HookStatus {
  host: Host;
  registration: "installed" | "not-installed" | "conflict";
  execution: "async" | "sync" | "mixed" | null;
  command: CommandSpec | null;
  configSource: string;
  issues: string[];
  registrations: number;
}
export class RegistrationError extends Error {
  constructor(readonly code: string) {
    super(
      `Hook registration unavailable (${code}). ${code === "codex_inline_hooks_manual_action_required" ? "Inline hooks exist in ~/.codex/config.toml. Keep one user hook source; edit the inline registration manually or migrate it yourself before installing hooks.json." : "Inspect the user hook configuration before retrying."}`,
    );
  }
}

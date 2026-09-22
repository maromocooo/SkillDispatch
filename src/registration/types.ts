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
      `Hook registration unavailable (${code}). No unrelated settings were changed.`,
    );
  }
}

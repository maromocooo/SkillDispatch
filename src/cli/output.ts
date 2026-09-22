import type { Diagnostic } from "../core/types.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  terminal?: TerminalContext;
}

/** Captured at the CLI boundary, never read from the process by renderers. */
export interface TerminalContext {
  isTTY: boolean;
  columns?: number | undefined;
  noColor?: boolean;
  term?: string | undefined;
}

/** Keep untrusted skill metadata from controlling the terminal. JSON preserves data. */
export function terminalText(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Cf}]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function printDiagnostics(
  diagnostics: readonly Diagnostic[],
  io: CliIO,
): void {
  for (const diagnostic of diagnostics)
    io.stderr(
      `${terminalText(diagnostic.code)}: ${terminalText(diagnostic.message)}${diagnostic.path ? ` (${terminalText(diagnostic.path)})` : ""}\n`,
    );
}

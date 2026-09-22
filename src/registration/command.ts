import { realpath, stat } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import {
  type CliExecution,
  type CommandSpec,
  type Host,
  RegistrationError,
} from "./types.js";

/** Resolve the actual running CLI, not PATH, cwd or a user-supplied command string. */
export async function resolveExecution(
  execution: CliExecution,
): Promise<CliExecution> {
  try {
    const nodePath = await realpath(execution.nodePath);
    const cliPath = await realpath(execution.cliPath);
    if (!(await stat(nodePath)).isFile() || !(await stat(cliPath)).isFile())
      throw new Error();
    return { ...execution, nodePath, cliPath };
  } catch {
    throw new RegistrationError("cli_unavailable");
  }
}
const posixQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function shadowCommand(
  host: Host,
  execution: CliExecution,
): CommandSpec {
  const absolute =
    execution.platform === "win32" ? win32.isAbsolute : isAbsolute;
  for (const value of [execution.nodePath, execution.cliPath]) {
    if (
      !absolute(value) ||
      /[\p{Cc}\p{Cf}]/u.test(value) ||
      value.includes("${")
    )
      throw new RegistrationError("unsupported_executable_path");
  }
  const args = [execution.cliPath, "hook", host];
  if (host === "claude") return { command: execution.nodePath, args };
  const argv = [execution.nodePath, ...args];
  if (execution.platform === "win32") {
    // Safe tokens in any outer shell; quoted literal paths only inside PowerShell.
    const script = `& ${argv.map(powershellQuote).join(" ")}; exit $LASTEXITCODE`;
    return {
      command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`,
    };
  }
  return { command: argv.map(posixQuote).join(" ") };
}

/** Claude exec-form argv, with no shell interpolation. */
export function skillObserverCommand(execution: CliExecution): CommandSpec {
  const base = shadowCommand("claude", execution);
  return {
    command: base.command,
    args: [execution.cliPath, "hook", "claude-skill"],
  };
}

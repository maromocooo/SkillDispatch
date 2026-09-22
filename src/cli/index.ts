#!/usr/bin/env node
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { terminalText } from "./output.js";
import { createProgram } from "./program.js";

// Bound the dedicated hook process, including stdin, discovery and filesystem I/O.
// Do not install process lifecycle behavior for library users or other commands.
const shadowInvocation =
  process.argv[2] === "hook" &&
  ["codex", "claude"].includes(process.argv[3] ?? "") &&
  process.argv.length === 4;
const hookDeadline = shadowInvocation
  ? setTimeout(() => process.exit(0), 4000)
  : undefined;
try {
  const program = createProgram(
    {
      cwd: process.cwd(),
      execution: {
        nodePath: process.execPath,
        cliPath: fileURLToPath(import.meta.url),
        platform: process.platform,
      },
      home: homedir(),
      env: {
        CODEX_HOME: process.env.CODEX_HOME,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        SKILLDISPATCH_DATA_DIR: process.env.SKILLDISPATCH_DATA_DIR,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      },
    },
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  );
  await program.parseAsync(process.argv);
} catch (error) {
  if (!shadowInvocation) {
    if (error instanceof CommanderError) process.exitCode = error.exitCode;
    else {
      process.stderr.write(
        `skilldispatch: ${terminalText(error instanceof Error ? error.message : "Command failed.")}\n`,
      );
      process.exitCode = 1;
    }
  }
} finally {
  if (hookDeadline !== undefined) clearTimeout(hookDeadline);
  // Storage has been awaited. Do not let a timed-out provider's remaining sockets
  // hold up the host; no AbortSignal is forwarded into the SDK's unsafe transport.
  if (shadowInvocation) process.exit(0);
}

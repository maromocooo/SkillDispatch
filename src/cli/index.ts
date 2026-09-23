#!/usr/bin/env node
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { terminalText } from "./output.js";
import { createProgram } from "./program.js";

// Bound the dedicated hook process, including stdin, discovery and filesystem I/O.
// Do not install process lifecycle behavior for library users or other commands.
const hookInvocation =
  process.argv[2] === "hook" &&
  ["codex", "claude", "claude-skill", "codex-read"].includes(
    process.argv[3] ?? "",
  ) &&
  process.argv.length === 4;
const hookDeadline = hookInvocation
  ? setTimeout(() => process.exit(0), 4000)
  : undefined;
if (hookInvocation) process.stdout.on("error", () => process.exit(0));
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
        CLAUDE_CODE_PLUGIN_CACHE_DIR: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        SKILLDISPATCH_DATA_DIR: process.env.SKILLDISPATCH_DATA_DIR,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      },
    },
    {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      ...(!hookInvocation
        ? {
            terminal: {
              isTTY: process.stdout.isTTY === true,
              columns: process.stdout.columns,
              noColor: process.env.NO_COLOR !== undefined,
              term: process.env.TERM,
            },
          }
        : {}),
    },
  );
  await program.parseAsync(process.argv);
} catch (error) {
  if (!hookInvocation) {
    if (error instanceof CommanderError) process.exitCode = error.exitCode;
    else {
      process.stderr.write(
        `skilldispatch: ${terminalText(error instanceof Error ? error.message : "Command failed.")}\n`,
      );
      process.exitCode = 1;
    }
  }
} finally {
  // Storage has been awaited. Do not let a timed-out provider's remaining sockets
  // hold up the host; no AbortSignal is forwarded into the SDK's unsafe transport.
  if (hookInvocation) {
    // Flush the bounded advisory JSON before forcing pending provider sockets closed.
    await new Promise<void>((resolve) =>
      process.stdout.write("", () => resolve()),
    );
    if (hookDeadline !== undefined) clearTimeout(hookDeadline);
    process.exit(0);
  }
}

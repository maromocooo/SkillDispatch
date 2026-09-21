#!/usr/bin/env node
import { homedir } from "node:os";
import { CommanderError } from "commander";
import { terminalText } from "./output.js";
import { createProgram } from "./program.js";

const program = createProgram(
  {
    cwd: process.cwd(),
    home: homedir(),
    env: {
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    },
  },
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    process.stderr.write(
      `skilldispatch: ${terminalText(error instanceof Error ? error.message : "Command failed.")}\n`,
    );
    process.exitCode = 1;
  }
}

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveExecution,
  shadowCommand,
} from "../../src/registration/command.js";
import { workspace } from "../helpers.js";

const paths = {
  nodePath: "/Node folder/node",
  cliPath: "/App folder/skilldispatch/dist/cli/index.js",
  platform: "darwin" as const,
};
describe("canonical shadow commands", () => {
  it.each(["darwin", "linux"] as const)(
    "quotes %s paths as literal shell words",
    (platform) => {
      expect(shadowCommand("codex", { ...paths, platform })).toEqual({
        command:
          "'/Node folder/node' '/App folder/skilldispatch/dist/cli/index.js' 'hook' 'codex'",
      });
    },
  );
  it("executes a POSIX command with quotes, dollars and shell syntax in its path without injection", async () => {
    const ctx = await workspace();
    const directory = join(
      ctx.root,
      "quote' dollar$(false) semi; `false` space",
    );
    await mkdir(directory);
    const cliPath = join(directory, "index.js");
    await writeFile(
      cliPath,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    const spec = shadowCommand("codex", {
      nodePath: process.execPath,
      cliPath,
      platform: "linux",
    });
    expect(
      execFileSync("/bin/sh", ["-c", spec.command], { encoding: "utf8" }),
    ).toBe('["hook","codex"]');
  });
  it("Claude exec form does not tokenize or quote literal arguments", () => {
    const cliPath = "/user/quotes' ; `$foo`/index.js";
    expect(shadowCommand("claude", { ...paths, cliPath })).toEqual({
      command: paths.nodePath,
      args: [cliPath, "hook", "claude"],
    });
  });
  it("Windows Codex uses a safe encoded payload with literal paths", () => {
    const spec = shadowCommand("codex", {
      nodePath: "C:\\Program Files\\Node\\node.exe",
      cliPath: "C:\\Users\\O'Brien & $x\\skilldispatch\\index.js",
      platform: "win32",
    });
    const prefix = "powershell.exe -NoProfile -NonInteractive -EncodedCommand ";
    expect(spec.command.startsWith(prefix)).toBe(true);
    const encoded = spec.command.slice(prefix.length);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      "& 'C:\\Program Files\\Node\\node.exe' 'C:\\Users\\O''Brien & $x\\skilldispatch\\index.js' 'hook' 'codex'; exit $LASTEXITCODE",
    );
  });
  it("Windows Claude uses the real node.exe and argv, not a .cmd shim", () => {
    expect(
      shadowCommand("claude", {
        nodePath: "C:\\Program Files\\Node\\node.exe",
        cliPath: "C:\\User\\A & B\\index.js",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Program Files\\Node\\node.exe",
      args: ["C:\\User\\A & B\\index.js", "hook", "claude"],
    });
  });
  it.each([
    "relative.js",
    "/bad\npath",
    "/bad\0path",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal host placeholder is the attack input.
    "/${CLAUDE_PROJECT_DIR}/index.js",
  ])("rejects unsafe/host-expanded path %j", (cliPath) => {
    expect(() => shadowCommand("codex", { ...paths, cliPath })).toThrow();
  });
  it("resolves actual executable and entrypoint, refusing absent paths", async () => {
    const ctx = await workspace();
    const cliPath = join(ctx.root, "cli.js");
    await writeFile(cliPath, "");
    expect(
      (
        await resolveExecution({
          nodePath: process.execPath,
          cliPath,
          platform: process.platform,
        })
      ).cliPath,
    ).toBe(cliPath);
    await expect(resolveExecution({ ...paths })).rejects.toThrow(
      "cli_unavailable",
    );
  });
});

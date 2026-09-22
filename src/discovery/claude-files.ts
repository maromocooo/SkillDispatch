import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { type Node, type ParseError, parseTree } from "jsonc-parser";
import { compareText } from "../core/order.js";
import type { Diagnostic } from "../core/types.js";
import { isMissing } from "./filesystem.js";

export function claudeDiagnostic(diagnostics: Diagnostic[], code: string) {
  diagnostics.push({
    code,
    level: "warning",
    message:
      "Claude catalog source could not be resolved safely; no source contents disclosed.",
  });
}
export function absoluteStatePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    !/[\p{Cc}]/u.test(value) &&
    !value.split(/[\\/]/u).includes("..")
  );
}

/** Bounded, data-only reads. No symlink leaf, devices, FIFO, hardlinks or raw errors. */
export async function readClaudeJson(
  path: string,
  diagnostics: Diagnostic[],
  code: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error();
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 1_048_576
    )
      throw new Error();
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await file.stat();
      if (
        info.ino !== before.ino ||
        info.dev !== before.dev ||
        !info.isFile() ||
        info.nlink !== 1
      )
        throw new Error();
      const buffer = Buffer.alloc(1_048_577);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 1_048_576) throw new Error();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
      const errors: ParseError[] = [];
      const tree = parseTree(text, errors, {
        disallowComments: true,
        allowTrailingComma: false,
      });
      if (!tree || errors.length || tree.type !== "object") throw new Error();
      const validate = (node: Node, depth: number) => {
        if (depth > 32) throw new Error();
        if (node.type === "object") {
          const keys = (node.children ?? []).map((p) => p.children?.[0]?.value);
          if (new Set(keys).size !== keys.length) throw new Error();
        }
        for (const child of node.children ?? []) validate(child, depth + 1);
      };
      validate(tree, 0);
      return JSON.parse(text) as Record<string, unknown>;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isMissing(error)) claudeDiagnostic(diagnostics, code);
    return undefined;
  }
}

/** Known roots only, bounded one-level enumeration; never a marketplace/cache walk. */
export async function childDirectories(
  path: string,
  diagnostics: Diagnostic[],
  limit = 256,
): Promise<string[]> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error();
    const names: string[] = [];
    let visited = 0;
    for await (const entry of await opendir(path)) {
      if (++visited > limit) throw new Error();
      if (entry.isSymbolicLink())
        claudeDiagnostic(diagnostics, "unsafe_claude_source");
      else if (entry.isDirectory() && !entry.name.startsWith("."))
        names.push(entry.name);
    }
    return names.sort(compareText);
  } catch (error) {
    if (!isMissing(error))
      claudeDiagnostic(diagnostics, "invalid_claude_source");
    return [];
  }
}
export async function safeDirectory(path: string): Promise<string> {
  if (!absoluteStatePath(path)) throw new Error();
  if (!(await lstat(path)).isDirectory()) throw new Error();
  const canonical = await realpath(path);
  // The leaf cannot be an alias. Platform aliases such as /tmp are allowed upstream.
  if ((await lstat(resolve(path))).isSymbolicLink()) throw new Error();
  return canonical;
}

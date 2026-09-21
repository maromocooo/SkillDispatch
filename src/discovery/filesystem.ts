import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Diagnostic } from "../core/types.js";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function readOptional(
  path: string,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > 1_048_576) throw new Error("File too large");
    return await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error))
      diagnostics.push({
        code: "read_failed",
        level: "warning",
        message: "Cannot read file (maximum size: 1 MiB).",
        path,
      });
    return undefined;
  }
}

/** CWD first; a .git file also marks a worktree/submodule boundary. */
export async function projectDirectories(cwd: string): Promise<string[]> {
  const start = await realpath(resolve(cwd));
  if (!(await stat(start)).isDirectory())
    throw new Error("Working directory must be a directory.");
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    try {
      await access(join(current, ".git"));
      return directories;
    } catch (error) {
      if (!isMissing(error))
        throw new Error("Cannot determine repository boundary.");
    }
    const parent = dirname(current);
    if (parent === current) return [start];
    current = parent;
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

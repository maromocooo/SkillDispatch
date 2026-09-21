import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface StorageContext {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export function dataDirectory({ home, env }: StorageContext): string {
  const explicit = env.SKILLDISPATCH_DATA_DIR;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error("Invalid data directory.");
    return resolve(explicit);
  }
  const xdg = env.XDG_DATA_HOME;
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(home, ".local/share"),
    "skilldispatch",
  );
}

export function tracePath(
  context: StorageContext,
  configured?: string,
): string {
  if (configured === undefined)
    return join(dataDirectory(context), "traces.jsonl");
  if (configured.startsWith("~/"))
    return resolve(context.home, configured.slice(2));
  if (!isAbsolute(configured))
    throw new Error("Trace path must be absolute or home-relative.");
  return resolve(configured);
}

export function assertPrivate(info: { mode: number; uid: number }): void {
  if (process.platform === "win32") return;
  if (
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe telemetry permissions.");
}

/** Create private leaf directories; reject unsafe existing destinations, never chmod user directories. */
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Invalid telemetry directory.");
  assertPrivate(info);
}

const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const privateReadFlags = constants.O_RDONLY | noFollow;
export const privateAppendFlags =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow;

async function readKey(path: string): Promise<Buffer> {
  const file = await open(path, privateReadFlags);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== 32)
      throw new Error("Invalid installation key.");
    assertPrivate(info);
    const key = Buffer.alloc(33);
    const { bytesRead } = await file.read(key, 0, key.length, 0);
    if (bytesRead !== 32) throw new Error("Invalid installation key.");
    return key.subarray(0, 32);
  } finally {
    await file.close();
  }
}

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** Publish a fully written key by exclusive hard link; concurrent processes never replace a winner. */
export async function installationKey(directory: string): Promise<Buffer> {
  await privateDirectory(directory);
  const path = join(directory, "install.key");
  try {
    return await readKey(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = join(directory, `.install-${randomUUID()}.key`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(randomBytes(32));
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return readKey(path);
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkHostDirectory,
  type FileSnapshot,
  readHostFile,
  unchanged,
} from "./files.js";
import { RegistrationError } from "./types.js";

const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
async function checkBackup(path: string): Promise<boolean> {
  const file = await readHostFile(path);
  if (!file) return false;
  if (process.platform !== "win32" && file.info.mode & 0o077)
    throw new RegistrationError("unsafe_backup");
  return true;
}
async function writeTemporary(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const temp = join(dirname(path), `.skilldispatch-${randomUUID()}.tmp`);
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.chmod(mode);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await file.close();
  return temp;
}
async function backup(path: string, original: FileSnapshot) {
  const destination = `${path}.skilldispatch.bak`;
  if (await checkBackup(destination)) return;
  const temp = await writeTemporary(destination, original.bytes, 0o600);
  try {
    await link(temp, destination);
  } finally {
    // Exclusive publish; never replace an existing backup.
    await unlink(temp).catch(() => {});
  }
}

/** All installer instances cooperate via exclusive lock; recheck external edits before rename. */
export async function withRegistrationLock<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const directory = dirname(path);
  // Only the fixed user host directory, never recursive project/config paths.
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new RegistrationError("config_unwritable");
  }
  await checkHostDirectory(directory);
  const lockPath = `${path}.skilldispatch.lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new RegistrationError("registration_locked");
  }
  try {
    return await work();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function atomicRegistrationWrite(
  path: string,
  expected: FileSnapshot | undefined,
  text: string,
  recheck: () => Promise<void>,
  renameFile = rename,
): Promise<void> {
  let temp: string | undefined;
  try {
    await checkHostDirectory(dirname(path));
    await unchanged(path, expected);
    if (expected) await backup(path, expected);
    temp = await writeTemporary(
      path,
      Buffer.from(text),
      expected ? expected.info.mode & 0o777 : 0o600,
    );
    await unchanged(path, expected);
    await recheck();
    await checkHostDirectory(dirname(path));
    await renameFile(temp, path);
    temp = undefined;
    // Directory fsync is best effort (not available on all supported platforms).
    const directory = await open(dirname(path), constants.O_RDONLY).catch(
      () => undefined,
    );
    if (directory) {
      try {
        await directory.sync();
      } catch {
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    throw error instanceof RegistrationError
      ? error
      : new RegistrationError("atomic_write_failed");
  } finally {
    if (temp) await unlink(temp).catch(() => {});
  }
}

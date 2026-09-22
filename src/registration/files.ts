import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissing } from "../discovery/filesystem.js";
import { RegistrationError } from "./types.js";

export const MAX_HOST_CONFIG_BYTES = 1024 * 1024;
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export interface FileSnapshot {
  bytes: Buffer;
  info: Stats;
}
function owned(info: Stats) {
  if (
    process.platform !== "win32" &&
    ((process.getuid && info.uid !== process.getuid()) || info.mode & 0o022)
  )
    throw new RegistrationError("unsafe_config_permissions");
}
export async function checkHostDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RegistrationError("unsafe_config_directory");
  owned(info);
}
export async function readHostFile(
  path: string,
): Promise<FileSnapshot | undefined> {
  try {
    try {
      await checkHostDirectory(dirname(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MAX_HOST_CONFIG_BYTES
    )
      throw new RegistrationError("unsafe_config_file");
    owned(before);
    const file = await open(path, constants.O_RDONLY | noFollow);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size > MAX_HOST_CONFIG_BYTES
      )
        throw new RegistrationError("config_changed");
      owned(info);
      const bytes = Buffer.alloc(MAX_HOST_CONFIG_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_HOST_CONFIG_BYTES)
        throw new RegistrationError("config_too_large");
      return { bytes: bytes.subarray(0, length), info };
    } finally {
      await file.close();
    }
  } catch (error) {
    throw error instanceof RegistrationError
      ? error
      : new RegistrationError("config_unreadable");
  }
}
export async function unchanged(
  path: string,
  expected: FileSnapshot | undefined,
) {
  const actual = await readHostFile(path);
  if (!actual && !expected) return;
  if (
    !actual ||
    !expected ||
    actual.info.dev !== expected.info.dev ||
    actual.info.ino !== expected.info.ino ||
    actual.info.mode !== expected.info.mode ||
    !actual.bytes.equals(expected.bytes)
  )
    throw new RegistrationError("config_changed");
}

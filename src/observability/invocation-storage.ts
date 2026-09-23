import { constants } from "node:fs";
import { access, lstat, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissing } from "../discovery/filesystem.js";
import {
  assertTraceDestination,
  checkPrivateDirectory,
  openPrivateFile,
  PrivateJsonlReader,
} from "../telemetry/reader.js";
import {
  assertPrivate,
  dataDirectory,
  privateAppendFlags,
  privateDirectory,
  type StorageContext,
} from "../telemetry/storage.js";
import {
  type InvocationSink,
  invocationSchema,
  type SkillInvocationEvent,
} from "./invocation-types.js";

export const MAX_INVOCATION_BYTES = 16 * 1024;
export const invocationPath = (environment: StorageContext) =>
  join(dataDirectory(environment), "invocations.jsonl");
export class InvocationReader extends PrivateJsonlReader<SkillInvocationEvent> {
  constructor(path: string, protectedPaths: readonly string[]) {
    super(path, protectedPaths, invocationSchema, ["1.0"]);
  }
}

/** Fixed stream destination; never taken from project configuration. */
export class PrivateEventSink<T> {
  constructor(
    private readonly path: string,
    private readonly protectedPaths: readonly string[],
    private readonly schema: {
      safeParse(raw: unknown): { success: true; data: T } | { success: false };
    },
  ) {}
  async write(event: T): Promise<void> {
    try {
      const parsed = this.schema.safeParse(event);
      if (!parsed.success) return;
      const line = Buffer.from(`${JSON.stringify(parsed.data)}\n`);
      if (line.length > MAX_INVOCATION_BYTES) return;
      await assertTraceDestination(this.path, this.protectedPaths);
      await privateDirectory(dirname(this.path));
      let before: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        before = await lstat(this.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (
        before &&
        (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      )
        return;
      const file = await open(this.path, privateAppendFlags, 0o600);
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (before && (info.ino !== before.ino || info.dev !== before.dev))
        )
          return;
        const after = await lstat(this.path);
        if (
          after.isSymbolicLink() ||
          after.dev !== info.dev ||
          after.ino !== info.ino
        )
          return;
        assertPrivate(info);
        await checkPrivateDirectory(dirname(this.path));
        await file.write(line); // One append; no retry of partial writes.
      } finally {
        await file.close();
      }
    } catch {
      /* Silent best effort. */
    }
  }
}

export class JsonlInvocationSink
  extends PrivateEventSink<SkillInvocationEvent>
  implements InvocationSink
{
  constructor(path: string, protectedPaths: readonly string[]) {
    super(path, protectedPaths, invocationSchema);
  }
}

/** Read-only readiness probe: absent files are healthy if their parent can be created. */
export async function invocationStorageReady(
  path: string,
  protectedPaths: readonly string[],
): Promise<boolean> {
  try {
    await assertTraceDestination(path, protectedPaths);
    const file = await openPrivateFile(path);
    if (file) {
      try {
        if (process.platform !== "win32" && !((await file.stat()).mode & 0o200))
          return false;
        await access(path, constants.R_OK | constants.W_OK);
      } finally {
        await file.close();
      }
    }
    let parent = dirname(path);
    try {
      await checkPrivateDirectory(parent);
    } catch (error) {
      if (!isMissing(error)) return false;
    }
    while (true) {
      try {
        if (!(await stat(parent)).isDirectory()) return false;
        await access(parent, constants.W_OK | constants.X_OK);
        return true;
      } catch (error) {
        if (!isMissing(error) || dirname(parent) === parent) return false;
        parent = dirname(parent);
      }
    }
  } catch {
    return false;
  }
}

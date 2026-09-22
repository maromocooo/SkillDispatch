import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isMissing } from "../discovery/filesystem.js";
import { assertPrivate, privateReadFlags } from "./storage.js";
import { type RouteTrace, routeTraceSchema } from "./types.js";

export const MAX_TRACE_LINE_BYTES = 2 * 1024 * 1024;
export class TraceReadError extends Error {
  constructor() {
    super("Trace destination is unsafe or unreadable.");
  }
}
export type JsonlReadResult<T> =
  | { kind: "valid"; line: number; trace: T }
  | {
      kind: "invalid";
      line: number;
      code: "invalid_json" | "invalid_trace" | "line_too_large";
    };
export type RouteTraceReadResult = JsonlReadResult<RouteTrace>;
export interface TraceReader {
  read(): AsyncIterable<RouteTraceReadResult>;
}

/** Read-only counterpart of privateDirectory: never mkdir/chmod. */
export async function checkPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TraceReadError();
  assertPrivate(info);
}

/** Resolve existing parent aliases without reading file contents. */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(await canonicalDestination(parent), basename(path));
  }
}

export async function assertTraceDestination(
  path: string,
  protectedPaths: readonly string[],
): Promise<void> {
  // There is no API-key file in SkillDispatch: credentials are environment-only.
  // Callers can reserve additional credential/config files, including aliases.
  if (basename(path) === "install.key") throw new TraceReadError();
  const canonical = await canonicalDestination(resolve(path));
  for (const protectedPath of protectedPaths) {
    if (canonical === (await canonicalDestination(resolve(protectedPath))))
      throw new TraceReadError();
  }
}

/** lstat + no-follow open + descriptor identity/permissions, including platforms lacking O_NOFOLLOW. */
export async function openPrivateFile(
  path: string,
): Promise<FileHandle | undefined> {
  let file: FileHandle | undefined;
  try {
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Missing dataset is fine, but an existing unsafe leaf directory is not.
      try {
        await checkPrivateDirectory(dirname(path));
      } catch (parentError) {
        if (!isMissing(parentError)) throw parentError;
      }
      return undefined;
    }
    await checkPrivateDirectory(dirname(path));
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new TraceReadError();
    assertPrivate(before);
    file = await open(path, privateReadFlags);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.dev !== before.dev ||
      info.ino !== before.ino
    )
      throw new TraceReadError();
    assertPrivate(info);
    await checkPrivateDirectory(dirname(path));
    return file;
  } catch {
    await file?.close().catch(() => {});
    throw new TraceReadError();
  }
}

/** Bounded line buffer and a byte-size snapshot: concurrent appends wait for the next read. */
export class PrivateJsonlReader<T> {
  constructor(
    private readonly path: string,
    private readonly protectedPaths: readonly string[],
    private readonly schema: {
      safeParse(raw: unknown): { success: true; data: T } | { success: false };
    },
  ) {}
  async *read(): AsyncIterable<JsonlReadResult<T>> {
    let file: FileHandle | undefined;
    try {
      await assertTraceDestination(this.path, this.protectedPaths);
      file = await openPrivateFile(this.path);
      if (!file) return;
      const size = (await file.stat()).size;
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      let parts: Buffer[] = [];
      let length = 0;
      let oversized = false;
      let line = 0;
      const consume = (part: Buffer) => {
        length += part.length;
        if (length > MAX_TRACE_LINE_BYTES) {
          oversized = true;
          parts = [];
        } else if (!oversized) parts.push(Buffer.from(part));
      };
      const finish = (): JsonlReadResult<T> => {
        line++;
        let result: JsonlReadResult<T>;
        if (oversized)
          result = { kind: "invalid", line, code: "line_too_large" };
        else {
          try {
            const raw: unknown = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(parts, length),
              ),
            );
            const parsed = this.schema.safeParse(raw);
            result = parsed.success
              ? { kind: "valid", line, trace: parsed.data }
              : { kind: "invalid", line, code: "invalid_trace" };
          } catch {
            result = { kind: "invalid", line, code: "invalid_json" };
          }
        }
        parts = [];
        length = 0;
        oversized = false;
        return result;
      };
      while (position < size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position,
        );
        if (!bytesRead) break;
        position += bytesRead;
        let start = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 10) {
            consume(buffer.subarray(start, i));
            yield finish();
            start = i + 1;
          }
        }
        consume(buffer.subarray(start, bytesRead));
      }
      if (length || oversized) yield finish();
    } catch {
      throw new TraceReadError();
    } finally {
      await file?.close();
    }
  }
}

export class JsonlTraceReader
  extends PrivateJsonlReader<RouteTrace>
  implements TraceReader
{
  constructor(path: string, protectedPaths: readonly string[]) {
    super(path, protectedPaths, routeTraceSchema);
  }
}

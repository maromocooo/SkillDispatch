import { open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertPrivate,
  privateAppendFlags,
  privateDirectory,
} from "./storage.js";
import { type RouteTrace, routeTraceSchema, type TraceSink } from "./types.js";

/** Best effort only: one O_APPEND write per event, no output or propagated failures. */
export class JsonlTraceSink implements TraceSink {
  constructor(private readonly path: string) {}
  async write(trace: RouteTrace): Promise<void> {
    try {
      const parsed = routeTraceSchema.safeParse(trace);
      if (!parsed.success) return;
      const line = Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
      await privateDirectory(dirname(this.path));
      const file = await open(this.path, privateAppendFlags, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) return;
        assertPrivate(info);
        // Do not retry a short write: splitting an event could interleave concurrent writers.
        await file.write(line);
      } finally {
        await file.close();
      }
    } catch {
      /* Observability must never interrupt the host's prompt path. */
    }
  }
}

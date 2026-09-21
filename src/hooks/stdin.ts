import type { Readable } from "node:stream";

export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
export const HOOK_STDIN_TIMEOUT_MS = 1000;

/** Bound both bytes and wait time; invalid input is a silent no-op, never a host decision. */
export function readHookJson(
  input: Readable,
  timeoutMs = HOOK_STDIN_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const buffers: Buffer[] = [];
    let finished = false;
    const finish = (value: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onError);
      input.pause();
      if (!input.readableEnded) input.destroy();
      resolve(value);
    };
    const onError = () => finish(undefined);
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, "utf8");
      size += buffer.byteLength;
      if (size > MAX_HOOK_INPUT_BYTES) {
        finish(undefined);
        return;
      }
      buffers.push(buffer);
    };
    const onEnd = () => {
      try {
        finish(JSON.parse(Buffer.concat(buffers).toString("utf8")));
      } catch {
        finish(undefined);
      }
    };
    const timer = setTimeout(onError, timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onError);
    if (input.destroyed || input.readableEnded) finish(undefined);
  });
}

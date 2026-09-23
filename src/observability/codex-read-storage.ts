import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { supportedCodexContract } from "../hosts/codex-contract.js";
import type { RuntimeEnvironment } from "../runtime/context.js";
import { openPrivateFile, PrivateJsonlReader } from "../telemetry/reader.js";
import {
  dataDirectory,
  type StorageContext,
  tracePath,
} from "../telemetry/storage.js";
import { type CodexReadEvent, codexReadSchema } from "./codex-read-types.js";
import {
  invocationPath,
  invocationStorageReady,
  PrivateEventSink,
} from "./invocation-storage.js";
export const codexReadPath = (environment: StorageContext) =>
  join(dataDirectory(environment), "codex-instruction-reads.jsonl");
export class CodexReadReader extends PrivateJsonlReader<CodexReadEvent> {
  constructor(path: string, reserved: readonly string[]) {
    super(path, reserved, codexReadSchema, ["1.0"]);
  }
}
export class CodexReadSink extends PrivateEventSink<CodexReadEvent> {
  constructor(path: string, reserved: readonly string[]) {
    super(path, reserved, codexReadSchema);
  }
}
export async function codexReadStorageContext(environment: RuntimeEnvironment) {
  const { config } = await loadConfig({ ...environment, mode: "user" });
  const keyPath = join(dataDirectory(environment), "install.key");
  return {
    enabled:
      config.telemetry.enabled &&
      supportedCodexContract(config.hook.codexContract),
    path: codexReadPath(environment),
    keyPath,
    protectedPaths: [
      keyPath,
      tracePath(environment, config.telemetry.tracePath),
      invocationPath(environment),
      join(environment.home, ".config/skilldispatch/config.yaml"),
    ],
  };
}
export async function codexReadPersistenceReady(
  environment: RuntimeEnvironment,
) {
  try {
    const c = await codexReadStorageContext(environment);
    if (!c.enabled || !(await invocationStorageReady(c.path, c.protectedPaths)))
      return false;
    const file = await openPrivateFile(c.keyPath);
    if (file) {
      try {
        if ((await file.stat()).size !== 32) return false;
      } finally {
        await file.close();
      }
    }
    return true;
  } catch {
    return false;
  }
}

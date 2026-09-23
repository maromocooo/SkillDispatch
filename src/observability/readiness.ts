import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { RuntimeEnvironment } from "../runtime/context.js";
import { openPrivateFile } from "../telemetry/reader.js";
import { dataDirectory, tracePath } from "../telemetry/storage.js";
import {
  invocationPath,
  invocationStorageReady,
} from "./invocation-storage.js";

export async function invocationStorageContext(
  environment: RuntimeEnvironment,
) {
  const { config } = await loadConfig({ ...environment, mode: "user" });
  const keyPath = join(dataDirectory(environment), "install.key");
  return {
    enabled: config.telemetry.enabled,
    path: invocationPath(environment),
    keyPath,
    protectedPaths: [
      keyPath,
      join(dataDirectory(environment), "codex-instruction-reads.jsonl"),
      tracePath(environment, config.telemetry.tracePath),
      join(environment.home, ".config/skilldispatch/config.yaml"),
    ],
  };
}
export async function invocationPersistenceReady(
  environment: RuntimeEnvironment,
): Promise<boolean> {
  try {
    const context = await invocationStorageContext(environment);
    if (
      !context.enabled ||
      !(await invocationStorageReady(context.path, context.protectedPaths))
    )
      return false;
    const key = await openPrivateFile(context.keyPath);
    if (key) {
      try {
        if ((await key.stat()).size !== 32) return false;
      } finally {
        await key.close();
      }
    }
    return true;
  } catch {
    return false;
  }
}

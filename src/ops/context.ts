import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import {
  CodexReadReader,
  codexReadPath,
  codexReadStorageContext,
} from "../observability/codex-read-storage.js";
import { InvocationReader } from "../observability/invocation-storage.js";
import { invocationStorageContext } from "../observability/readiness.js";
import type { RuntimeEnvironment } from "../runtime/context.js";
import { JsonlTraceReader } from "../telemetry/reader.js";
import { dataDirectory, tracePath } from "../telemetry/storage.js";

/** Operational commands inspect the same trusted configuration as shadow hooks. */
export async function loadOperations(environment: RuntimeEnvironment) {
  const { config, diagnostics } = await loadConfig({
    ...environment,
    mode: "hook",
  });
  const directory = dataDirectory(environment);
  const path = tracePath(environment, config.telemetry.tracePath);
  const protectedPaths = [
    join(directory, "install.key"),
    codexReadPath(environment),
    join(environment.home, ".config/skilldispatch/config.yaml"),
  ];
  const invocation = await invocationStorageContext(environment);
  const codex = await codexReadStorageContext(environment);
  return {
    codexReadReader: new CodexReadReader(codex.path, [
      ...codex.protectedPaths,
      path,
    ]),
    invocationReader: new InvocationReader(invocation.path, [
      ...invocation.protectedPaths,
      path,
    ]),
    config,
    diagnostics,
    directory,
    path,
    protectedPaths,
    reader: new JsonlTraceReader(path, protectedPaths),
  };
}

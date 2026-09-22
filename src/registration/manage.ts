import { atomicRegistrationWrite, withRegistrationLock } from "./atomic.js";
import { resolveExecution, shadowCommand } from "./command.js";
import { ownsHandler, planDocument, possibleOtherInstall } from "./document.js";
import { MAX_HOST_CONFIG_BYTES, unchanged } from "./files.js";
import { checkCodexInline, loadRegistration } from "./inspect.js";
import { registrationMode } from "./mode.js";
import {
  type CliExecution,
  type Host,
  type RegistrationEnvironment,
  RegistrationError,
} from "./types.js";

export async function manageRegistration(
  host: Host,
  action: "install" | "uninstall",
  environment: RegistrationEnvironment,
  execution: CliExecution,
  options: { sync?: boolean; dryRun?: boolean } = {},
  write = atomicRegistrationWrite,
) {
  try {
    if (host === "codex" && action === "install" && options.sync)
      throw new RegistrationError("codex_sync_not_supported");
    const mode =
      action === "install" ? await registrationMode(host, environment) : null;
    const sync =
      mode === "advisory" || (host === "claude" && options.sync === true);
    const resolved = await resolveExecution(execution);
    const command = shadowCommand(host, resolved);
    const prepare = async () => {
      const loaded = await loadRegistration(
        host,
        environment,
        action === "install",
      );
      if (
        action === "install" &&
        loaded.document
          .handlers()
          .some(
            (h) =>
              !ownsHandler(h.value, command) &&
              possibleOtherInstall(h.value, host),
          )
      )
        throw new RegistrationError(
          "other_skilldispatch_command_manual_action_required",
        );
      if (
        action === "install" &&
        loaded.document
          .handlers()
          .some(
            (h) =>
              ownsHandler(h.value, command) && h.value.asyncRewake === true,
          )
      )
        throw new RegistrationError(
          "modified_registration_manual_action_required",
        );
      const plan = planDocument(loaded.document, command, action, sync);
      if (Buffer.byteLength(plan.text) > MAX_HOST_CONFIG_BYTES)
        throw new RegistrationError("config_too_large");
      return { ...loaded, plan };
    };
    let planned = await prepare();
    const changed = () => planned.plan.text !== planned.document.text;
    if (!options.dryRun && changed()) {
      await withRegistrationLock(planned.paths.config, async () => {
        planned = await prepare();
        if (!changed()) return;
        await write(
          planned.paths.config,
          planned.snapshot,
          planned.plan.text,
          async () => {
            if (host === "codex" && action === "install")
              await checkCodexInline(planned.paths.toml);
            await unchanged(planned.paths.config, planned.snapshot);
          },
        );
      });
    }
    return {
      version: 1 as const,
      host,
      mode,
      action: planned.plan.action,
      dryRun: options.dryRun === true,
      changed: changed() && !options.dryRun,
      execution: action === "install" ? (sync ? "sync" : "async") : null,
      command,
      configSource: planned.paths.config,
      backup:
        planned.snapshot && changed()
          ? `${planned.paths.config}.skilldispatch.bak`
          : null,
    };
  } catch (error) {
    throw error instanceof RegistrationError
      ? error
      : new RegistrationError("registration_failed");
  }
}

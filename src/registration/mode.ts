import { loadConfig } from "../config/load.js";
import type { HookModes } from "../config/schema.js";
import {
  type Host,
  type RegistrationEnvironment,
  RegistrationError,
} from "./types.js";

/** Installation policy is user-owned even when runtime project config is trusted. */
export async function registrationMode(
  host: Host,
  environment: RegistrationEnvironment,
): Promise<HookModes[Host]> {
  try {
    const { config } = await loadConfig({
      home: environment.home,
      cwd: environment.home,
      mode: "user",
    });
    return config.hook.modes[host];
  } catch {
    throw new RegistrationError("invalid_user_hook_mode_config");
  }
}

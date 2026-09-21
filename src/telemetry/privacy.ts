import { createHmac } from "node:crypto";
import type { PromptStorage, RouteTrace } from "./types.js";

export function keyedHash(
  key: Uint8Array,
  domain: "prompt" | "session" | "host-prompt",
  value: string,
): string {
  if (key.byteLength < 32) throw new Error("Invalid installation key.");
  return createHmac("sha256", key)
    .update(`${domain}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function privatePrompt(
  prompt: string,
  storage: PromptStorage,
  key: Uint8Array,
): RouteTrace["prompt"] {
  if (storage === "none") return { storage };
  if (storage === "raw") return { storage, raw: prompt };
  return { storage, hash: keyedHash(key, "prompt", prompt) };
}

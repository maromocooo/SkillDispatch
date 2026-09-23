/** Source-verified wire contracts, not a claim about a running session's configuration. */
export const codexContracts = [
  "0.155.1",
  "0.156.1",
  "0.155.0-alpha.9.2",
] as const;
export function supportedCodexContract(value: unknown): boolean {
  return codexContracts.some((version) => version === value);
}
export const codexReadEvents = ["PreToolUse", "PostToolUse"] as const;

import type {
  Diagnostic,
  SkillDecision,
  SkillDescriptor,
} from "../core/types.js";
import { codexMetadata, safeCodexName } from "../discovery/codex-origin.js";
import { MAX_ADVISORY_BYTES } from "./advisory.js";

const introduction =
  "SkillDispatch suggestions supporting the current user request, not a new task. When useful and permitted, consider these available Codex skills by their native names:\n";
const conclusion =
  "\nLoad a skill's instructions using Codex's normal skill-loading behavior only if needed. If unavailable, continue normally. Continue the original task rather than replying only to acknowledge this context. The user's intent and host safety constraints take priority.";
export function buildCodexAdvisory(
  selected: readonly SkillDecision[],
  catalog: readonly SkillDescriptor[],
) {
  const lines: string[] = [],
    injectedSkillIds: string[] = [],
    diagnostics: Diagnostic[] = [];
  for (const decision of selected) {
    const skill = catalog.find((s) => s.id === decision.skillId);
    const metadata = skill && codexMetadata(skill);
    const name = metadata?.nativeName;
    let code: string | undefined;
    if (
      !skill?.enabled ||
      !metadata?.modelInvocable ||
      !name ||
      !safeCodexName(name)
    )
      code = "advisory_invocation_disabled";
    else if (
      catalog.filter((s) => codexMetadata(s)?.nativeName === name).length !== 1
    )
      code = "advisory_ambiguous_skill_invocation";
    else if (
      Buffer.byteLength(
        `${introduction}${lines.join("")}- ${name}\n${conclusion}`,
      ) > MAX_ADVISORY_BYTES
    )
      code = "advisory_context_limit";
    if (code) {
      diagnostics.push({
        code,
        level: "warning",
        message: "Codex recommendation omitted.",
        skillIds: [decision.skillId],
      });
      continue;
    }
    lines.push(`- ${name}\n`);
    injectedSkillIds.push(decision.skillId);
  }
  return {
    output: lines.length
      ? JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: introduction + lines.join("") + conclusion,
          },
        })
      : undefined,
    injectedSkillIds,
    diagnostics,
  };
}

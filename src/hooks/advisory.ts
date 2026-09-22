import type {
  Diagnostic,
  SkillDecision,
  SkillDescriptor,
} from "../core/types.js";
import {
  claudeInvocationName,
  claudeModelInvocationAllowed,
} from "../discovery/claude-invocation.js";
import { invocationIdentity } from "../discovery/claude-origin.js";

export const MAX_ADVISORY_BYTES = 4096;
const introduction =
  "SkillDispatch recommendations for this turn (the user's request takes priority).\nConsider invoking these Claude Code skills with the native Skill tool if available, permitted, and still applicable:\n";
const conclusion =
  "\nUse native skill invocation rather than reproducing or guessing skill instructions. If a recommendation cannot be invoked, continue the task normally.";

/** Safe identifiers only, in routing policy order. No routing or host I/O here. */
export function buildClaudeAdvisory(
  selected: readonly SkillDecision[],
  catalog: readonly SkillDescriptor[],
) {
  const byId = new Map(catalog.map((skill) => [skill.id, skill]));
  const counts = new Map<string, number>();
  for (const skill of catalog) {
    const name = claudeInvocationName(skill);
    if (name) {
      const key = invocationIdentity(name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const diagnostics: Diagnostic[] = [];
  const injectedSkillIds: string[] = [];
  const lines: string[] = [];
  let full = false;
  const skip = (code: string, id: string) =>
    diagnostics.push({
      code,
      level: "warning",
      message: "Advisory recommendation omitted.",
      skillIds: [id],
    });
  for (const decision of selected) {
    const skill = byId.get(decision.skillId);
    const name = skill && claudeInvocationName(skill);
    if (!skill || !name) {
      skip("advisory_invalid_skill_invocation", decision.skillId);
      continue;
    }
    if (!claudeModelInvocationAllowed(skill)) {
      skip("advisory_invocation_disabled", skill.id);
      continue;
    }
    if (counts.get(invocationIdentity(name)) !== 1) {
      skip("advisory_ambiguous_skill_invocation", skill.id);
      continue;
    }
    const line = `- ${name}\n`;
    if (
      full ||
      Buffer.byteLength(introduction + lines.join("") + line + conclusion) >
        MAX_ADVISORY_BYTES
    ) {
      full = true;
      skip("advisory_context_limit", skill.id);
      continue;
    }
    lines.push(line);
    injectedSkillIds.push(skill.id);
  }
  const output = lines.length
    ? JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: introduction + lines.join("") + conclusion,
        },
      })
    : undefined;
  return { output, injectedSkillIds, diagnostics };
}

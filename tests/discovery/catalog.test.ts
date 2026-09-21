import { describe, expect, it } from "vitest";
import type {
  AgentKind,
  SkillDescriptor,
  SkillScope,
} from "../../src/core/types.js";
import { finalizeCatalog } from "../../src/discovery/catalog.js";
import { parseSkill } from "../../src/discovery/parse-skill.js";

function skill(
  agent: AgentKind,
  path: string,
  scope: SkillScope = "repo",
): SkillDescriptor {
  const parsed = parseSkill(
    "---\nname: security-review\ndescription: Review security.\n---",
    { agent, path, scope },
  ).skills[0];
  if (!parsed) throw new Error("Invalid test fixture");
  return parsed;
}

describe("cross-agent catalog identity", () => {
  it("retains same-name skills from different agents without a duplicate diagnostic", () => {
    const codex = skill("codex", "/shared/security-review/SKILL.md");
    const claude = skill("claude-code", codex.path);
    const result = finalizeCatalog([
      { skills: [codex, claude], diagnostics: [] },
    ]);
    expect(result.skills).toHaveLength(2);
    expect(new Set(result.skills.map((entry) => entry.id)).size).toBe(2);
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps repo and user paths within one agent and diagnoses that conflict only", () => {
    const repo = skill(
      "codex",
      "/repo/.agents/skills/security-review/SKILL.md",
    );
    const user = skill(
      "codex",
      "/home/.agents/skills/security-review/SKILL.md",
      "user",
    );
    const claude = skill(
      "claude-code",
      "/repo/.claude/skills/security-review/SKILL.md",
    );
    const result = finalizeCatalog([
      { skills: [repo, user, claude], diagnostics: [] },
    ]);
    expect(result.skills).toHaveLength(3);
    expect(new Set(result.skills.map((entry) => entry.id)).size).toBe(3);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "duplicate_name",
      skillIds: [user.id, repo.id],
    });
    expect(result.diagnostics[0]?.message).toContain("codex");
  });

  it("normalizes whitespace for name conflicts without merging skills or agents", () => {
    const first = {
      ...skill("codex", "/a/SKILL.md"),
      name: " security  review ",
    };
    const second = {
      ...skill("codex", "/b/SKILL.md"),
      name: "security review",
    };
    const third = {
      ...skill("claude-code", "/c/SKILL.md"),
      name: "security review",
    };
    const result = finalizeCatalog([
      { skills: [first, second, third], diagnostics: [] },
    ]);
    expect(result.skills).toHaveLength(3);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.skillIds).toEqual([first.id, second.id]);
    expect(first.name).toBe(" security  review ");
  });

  it("recomputes stable agent-scoped diagnostics regardless of catalog input order", () => {
    const a = {
      skills: [
        skill("codex", "/a/SKILL.md"),
        skill("claude-code", "/b/SKILL.md"),
      ],
      diagnostics: [],
    };
    const b = {
      skills: [
        skill("codex", "/c/SKILL.md"),
        skill("claude-code", "/d/SKILL.md"),
      ],
      diagnostics: [],
    };
    const result = finalizeCatalog([a, b]);
    expect(result.diagnostics).toHaveLength(2);
    expect(finalizeCatalog([b, a])).toEqual(result);
    expect(finalizeCatalog([result, a, b])).toEqual(result);
  });
});

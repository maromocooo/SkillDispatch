import type { SkillDescriptor } from "../../src/core/types.js";
export const skill = (
  id: string,
  overrides: Partial<SkillDescriptor> = {},
): SkillDescriptor => ({
  id,
  name: id,
  description: `Workflow ${id}`,
  path: `/skills/${id}/SKILL.md`,
  directory: `/skills/${id}`,
  scope: "repo",
  agent: "codex",
  enabled: true,
  metadata: {},
  contentHash: "fixture",
  ...overrides,
});

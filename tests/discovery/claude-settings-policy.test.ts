import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../../src/core/route.js";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import { claudeMetadata } from "../../src/discovery/claude-origin.js";
import { buildClaudeAdvisory } from "../../src/hooks/advisory.js";
import { MockRouterProvider } from "../../src/providers/mock.js";
import { skillText, workspace, write } from "../helpers.js";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("NETWORK_FORBIDDEN"),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

type Layer =
  | "user"
  | "project"
  | "local"
  | "repo-local"
  | "managed"
  | "managed-fragment";
async function fixture() {
  const ctx = await workspace();
  const config = join(ctx.root, "config");
  const managed = join(ctx.root, "managed");
  const paths: Record<Layer, string> = {
    user: join(config, "settings.json"),
    project: join(ctx.cwd, ".claude/settings.json"),
    local: join(ctx.cwd, ".claude/settings.local.json"),
    "repo-local": join(ctx.repo, ".claude/settings.local.json"),
    managed: join(managed, "managed-settings.json"),
    "managed-fragment": join(managed, "managed-settings.d/20-policy.json"),
  };
  await write(
    join(config, "skills/synced/account/pdf/SKILL.md"),
    skillText("pdf"),
  );
  return {
    ...ctx,
    config,
    managed,
    configure: async (
      layers: Partial<Record<Layer, Record<string, unknown>>>,
    ) => {
      for (const [layer, data] of Object.entries(layers))
        await write(paths[layer as Layer], JSON.stringify(data));
    },
    run: () =>
      new ClaudeDiscoveryAdapter({ managedDirectory: managed }).discover({
        ...ctx,
        env: { CLAUDE_CONFIG_DIR: config },
      }),
  };
}

describe("restrictive Claude synced-skill settings", () => {
  const cases: [string, Partial<Record<Layer, unknown>>, boolean][] = [
    ["unset", {}, true],
    [
      "true only",
      { user: true, project: true, local: true, managed: true },
      true,
    ],
    ["user false", { user: false }, false],
    ["user false + project true", { user: false, project: true }, false],
    ["user false + managed true", { user: false, managed: true }, false],
    ["shared project false only", { project: false }, true],
    ["local false", { local: false }, false],
    ["managed false", { managed: false }, false],
    ["user true + local false", { user: true, local: false }, false],
    [
      "managed false + lower true",
      { user: true, project: true, local: true, managed: false },
      false,
    ],
    [
      "managed false + later fragment true",
      { managed: false, "managed-fragment": true },
      false,
    ],
    [
      "managed fragment false",
      { managed: true, "managed-fragment": false },
      false,
    ],
    [
      "ignored shared project malformed value",
      { project: "PRIVATE_IGNORED_VALUE" },
      true,
    ],
  ];
  it.each(cases)(
    "%s controls cached synced catalog eligibility",
    async (_name, layers, included) => {
      const f = await fixture();
      await f.configure(
        Object.fromEntries(
          Object.entries(layers).map(([source, value]) => [
            source,
            { syncClaudeAiSkills: value },
          ]),
        ),
      );
      const result = await f.run();
      const synced = result.skills.filter(
        (s) => claudeMetadata(s)?.origin === "synced",
      );
      expect(synced).toHaveLength(included ? 1 : 0);
      expect(
        synced.every((s) => s.enabled && claudeMetadata(s)?.modelInvocable),
      ).toBe(true);
      expect(
        result.diagnostics.some((d) => d.code === "invalid_claude_settings"),
      ).toBe(false);
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        "PRIVATE_IGNORED_VALUE",
      );
    },
  );
  it.skipIf(process.platform === "win32")(
    "keeps the legacy local opt-out across a repo-root local true",
    async () => {
      const f = await fixture();
      await f.configure({
        local: { syncClaudeAiSkills: false },
        "repo-local": { syncClaudeAiSkills: true },
      });
      expect(
        (await f.run()).skills.some(
          (s) => claudeMetadata(s)?.origin === "synced",
        ),
      ).toBe(false);
    },
  );
});

describe("managed Claude skills-surface policy", () => {
  async function catalogFixture() {
    const f = await fixture();
    await write(
      join(f.config, "skills/personal/SKILL.md"),
      skillText("personal"),
    );
    await write(
      join(f.cwd, ".claude/skills/project/SKILL.md"),
      skillText("project"),
    );
    await write(
      join(f.managed, ".claude/skills/enterprise/SKILL.md"),
      skillText("enterprise"),
    );
    const installed = join(f.root, "installed");
    await write(
      join(installed, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "trusted" }),
    );
    await write(join(installed, "skills/review/SKILL.md"), skillText("review"));
    await write(
      join(f.config, "plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "trusted@fixture": [
            { scope: "user", version: "1.0", installPath: installed },
          ],
        },
      }),
    );
    await f.configure({
      user: { enabledPlugins: { "trusted@fixture": true } },
    });
    return f;
  }
  const cases: [string, Partial<Record<Layer, unknown>>, boolean][] = [
    ["unset", {}, false],
    ["managed true", { managed: true }, true],
    ["managed false", { managed: false }, false],
    ["managed skills array", { managed: ["skills"] }, true],
    ["managed hooks array", { managed: ["hooks"] }, false],
    ["managed skills and hooks", { managed: ["skills", "hooks"] }, true],
    ["managed empty array", { managed: [] }, false],
    ["user true ignored", { user: true }, false],
    ["project true ignored", { project: true }, false],
    ["local true ignored", { local: true }, false],
    ["unknown surface ignored", { managed: ["future-surface"] }, false],
    [
      "skills plus unknown surface",
      { managed: ["skills", "future-surface"] },
      true,
    ],
    [
      "managed hooks overrides non-managed skills",
      { user: true, project: ["skills"], local: true, managed: ["hooks"] },
      false,
    ],
    [
      "managed lock despite lower false",
      { user: false, local: false, managed: ["skills"] },
      true,
    ],
    ["managed fragment lock", { "managed-fragment": ["skills"] }, true],
    [
      "managed arrays merge across fragments",
      { managed: ["skills"], "managed-fragment": ["hooks"] },
      true,
    ],
    [
      "non-managed malformed values ignored",
      { user: { PRIVATE: "INVALID" }, project: "PRIVATE_INVALID", local: [99] },
      false,
    ],
  ];
  it.each(cases)(
    "%s preserves the expected origin eligibility",
    async (_name, layers, locked) => {
      const f = await catalogFixture();
      await f.configure(
        Object.fromEntries(
          Object.entries(layers).map(([source, value]) => [
            source,
            { strictPluginOnlyCustomization: value },
          ]),
        ),
      );
      const result = await f.run();
      expect(
        result.diagnostics.some((d) => d.code === "invalid_claude_settings"),
      ).toBe(false);
      const origins = [
        "local-user",
        "local-project",
        "synced",
        "plugin",
        "managed",
      ] as const;
      for (const origin of origins) {
        const skills = result.skills.filter(
          (s) => claudeMetadata(s)?.origin === origin,
        );
        if (origin === "synced" && locked) {
          // The host does not load synced skills under this policy; neither do we.
          expect(skills).toEqual([]);
          continue;
        }
        expect(skills.length).toBeGreaterThan(0);
        const allowed = !locked || origin === "plugin" || origin === "managed";
        for (const skill of skills) {
          expect(skill.enabled).toBe(allowed);
          expect(claudeMetadata(skill)?.modelInvocable).toBe(allowed);
        }
      }
    },
  );
  it("retains managed/plugin provider and advisory candidates under the skills lock", async () => {
    const f = await catalogFixture();
    await f.configure({
      managed: { strictPluginOnlyCustomization: ["skills"] },
    });
    const catalog = await f.run();
    const provider = new MockRouterProvider({
      scores: {
        enterprise: 0.99,
        review: 0.98,
        personal: 0.97,
        project: 0.96,
        pdf: 0.95,
      },
    });
    const judge = vi.spyOn(provider, "judge");
    const result = await route(
      {
        prompt: "harmless fixture",
        agent: "claude-code",
        cwd: f.cwd,
        skills: catalog.skills,
      },
      provider,
    );
    expect(
      judge.mock.calls[0]?.[0].candidates.map((s) => s.name).sort(),
    ).toEqual(["enterprise", "review"]);
    const advisory = buildClaudeAdvisory(result.selected, catalog.skills);
    expect(advisory.injectedSkillIds).toEqual(
      result.selected.map((s) => s.skillId),
    );
    expect(
      JSON.parse(advisory.output ?? "{}").hookSpecificOutput.additionalContext,
    ).toContain("- enterprise\n- trusted:review\n");
    expect(advisory.output).not.toMatch(/personal|anthropic-skills:pdf/);
  });
  it.each(["PRIVATE_INVALID", null, 42, { skills: true }, ["skills", 42]])(
    "keeps conservative handling for malformed managed policy: %j",
    async (value) => {
      const f = await catalogFixture();
      await f.configure({ managed: { strictPluginOnlyCustomization: value } });
      const result = await f.run();
      expect(result.diagnostics.map((d) => d.code)).toContain(
        "invalid_claude_settings",
      );
      expect(result.skills.every((s) => !s.enabled)).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        "PRIVATE_INVALID",
      );
    },
  );
  it("ignores unrelated future settings without invalidating the catalog", async () => {
    const f = await catalogFixture();
    await f.configure({
      managed: {
        futurePolicy: { PRIVATE: "VALUE" },
        strictPluginOnlyCustomization: ["future-surface"],
      },
    });
    const result = await f.run();
    expect(
      result.diagnostics.some((d) => d.code === "invalid_claude_settings"),
    ).toBe(false);
    expect(result.skills.every((s) => s.enabled)).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE");
  });
});

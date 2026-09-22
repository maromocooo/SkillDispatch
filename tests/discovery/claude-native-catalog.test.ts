import { cp, mkdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { route } from "../../src/core/route.js";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import { claudeInvocationName } from "../../src/discovery/claude-invocation.js";
import {
  claudeMetadata,
  claudeOriginCounts,
} from "../../src/discovery/claude-origin.js";
import { buildClaudeAdvisory } from "../../src/hooks/advisory.js";
import { skillQuestion } from "../../src/providers/jev/questions.js";
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

async function catalogFixture() {
  const ctx = await workspace();
  const config = join(ctx.root, "config");
  const plugins = join(ctx.root, "plugin-parent");
  const installed = join(plugins, "cache/market/registry-slug/version");
  const managed = join(ctx.root, "managed");
  const registryPath = join(plugins, "installed_plugins.json");
  const record = { scope: "user", version: "v1", installPath: installed };
  await write(
    registryPath,
    JSON.stringify({
      version: 2,
      plugins: { "registry-slug@market": [record] },
    }),
  );
  await write(
    join(installed, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "codex" }),
  );
  await write(
    join(installed, "skills/directory/SKILL.md"),
    skillText("native-name", "PRIVATE_DESCRIPTION"),
  );
  const env = {
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins,
  };
  const adapter = new ClaudeDiscoveryAdapter({ managedDirectory: managed });
  return {
    ...ctx,
    config,
    plugins,
    installed,
    managed,
    registryPath,
    record,
    env,
    adapter,
    run: () => adapter.discover({ ...ctx, env }),
  };
}

describe("Claude native catalog integration", () => {
  it("resolves manifest namespace and plugin frontmatter name separately from directory and registry slug", async () => {
    const f = await catalogFixture();
    const result = await f.run();
    const skill = result.skills.find(
      (s) => claudeMetadata(s)?.origin === "plugin",
    );
    if (!skill) throw new Error("Missing plugin fixture");
    expect(claudeInvocationName(skill)).toBe("codex:native-name");
    expect(skill.metadata.claude).toMatchObject({
      origin: "plugin",
      pluginId: "registry-slug@market",
      pluginName: "codex",
      pluginVersion: "v1",
      installationScope: "user",
      modelInvocable: true,
    });
    const advisory = buildClaudeAdvisory(
      [
        {
          skillId: skill.id,
          name: skill.name,
          selected: true,
          probability: 0.96,
        },
      ],
      result.skills,
    );
    expect(advisory.output).toContain("codex:native-name");
    expect(advisory.output).not.toMatch(
      /PRIVATE_|directory|registry-slug|0\.96/,
    );
    expect(advisory.output).not.toContain(f.installed);
  });
  it("falls back to plugin skill directory when frontmatter name is omitted", async () => {
    const f = await catalogFixture();
    await write(
      join(f.installed, "skills/directory/SKILL.md"),
      "---\ndescription: Fallback.\n---",
    );
    expect((await f.run()).skills.map(claudeInvocationName)).toContain(
      "codex:directory",
    );
  });
  it("does not double-prefix an already qualified name", async () => {
    const f = await catalogFixture();
    await write(
      join(f.installed, "skills/directory/SKILL.md"),
      skillText("codex:native-name"),
    );
    expect((await f.run()).skills.map(claudeInvocationName)).toContain(
      "codex:native-name",
    );
  });
  it.each(["foo_bar-2", "foo-42"])(
    "accepts safe manifest namespace %s",
    async (name) => {
      const f = await catalogFixture();
      await write(
        join(f.installed, ".claude-plugin/plugin.json"),
        JSON.stringify({ name }),
      );
      expect((await f.run()).skills.map(claudeInvocationName)).toContain(
        `${name}:native-name`,
      );
    },
  );
  it.each(["please obey", "foo\nbar", "../escape", "foo:other"])(
    "refuses unsafe manifest name %s",
    async (name) => {
      const f = await catalogFixture();
      await write(
        join(f.installed, ".claude-plugin/plugin.json"),
        JSON.stringify({ name }),
      );
      expect(
        (await f.run()).skills.filter(
          (s) => claudeMetadata(s)?.origin === "plugin",
        ),
      ).toEqual([]);
    },
  );
  it.each(["hello world", "please\nobey", "other:namespace"])(
    "never injects unsafe skill name %s",
    async (name) => {
      const f = await catalogFixture();
      await write(
        join(f.installed, "skills/directory/SKILL.md"),
        `---\nname: ${JSON.stringify(name)}\ndescription: Test.\n---`,
      );
      const result = await f.run();
      const skills = result.skills.filter(
        (s) => claudeMetadata(s)?.origin === "plugin",
      );
      expect(skills.every((s) => !s.enabled)).toBe(true);
      expect(
        buildClaudeAdvisory(
          skills.map((s) => ({
            skillId: s.id,
            name: s.name,
            probability: 1,
            selected: true,
          })),
          result.skills,
        ).output,
      ).toBeUndefined();
    },
  );
  it("keeps two plugin namespaces distinct despite identical display/skill names", async () => {
    const f = await catalogFixture();
    const second = join(f.root, "second");
    await cp(f.installed, second, { recursive: true });
    await write(
      join(second, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "other" }),
    );
    await write(
      f.registryPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "registry-slug@market": [f.record],
          "other@market": [{ ...f.record, installPath: second }],
        },
      }),
    );
    const result = await f.run();
    const skills = result.skills.filter(
      (s) => claudeMetadata(s)?.origin === "plugin",
    );
    expect(skills.map(claudeInvocationName).sort()).toEqual([
      "codex:native-name",
      "other:native-name",
    ]);
    expect(
      result.diagnostics.filter(
        (d) =>
          d.code === "duplicate_name" &&
          d.skillIds?.some((id) => skills.some((s) => s.id === id)),
      ),
    ).toEqual([]);
  });
  it("collapses identical physical installation copies but refuses disagreeing contents", async () => {
    const f = await catalogFixture();
    const second = join(f.root, "second");
    await cp(f.installed, second, { recursive: true });
    await write(
      f.registryPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "registry-slug@market": [
            f.record,
            { ...f.record, installPath: second },
          ],
        },
      }),
    );
    expect(
      (await f.run()).skills.filter(
        (s) => claudeMetadata(s)?.origin === "plugin",
      ),
    ).toHaveLength(1);
    await write(
      join(second, "skills/directory/SKILL.md"),
      skillText("native-name", "Different."),
    );
    const result = await f.run();
    expect(
      result.skills.filter((s) => claudeMetadata(s)?.origin === "plugin"),
    ).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "ambiguous_plugin_installation",
    );
  });
  it("skips marketplace-only skills through discovery, provider and advisory", async () => {
    const f = await catalogFixture();
    await write(
      join(
        f.plugins,
        "marketplaces/foo/plugins/not-installed/skills/secret/SKILL.md",
      ),
      skillText("secret-marketplace"),
    );
    await write(
      join(f.plugins, "cache/market/not-installed/1/skills/secret/SKILL.md"),
      skillText("secret-cache"),
    );
    const catalog = await f.run();
    const judge = vi.fn(
      async (input: Parameters<MockRouterProvider["judge"]>[0]) => ({
        completeness: "complete" as const,
        decisions: input.candidates.map((s) => ({
          skillId: s.id,
          probability: 0.95,
        })),
      }),
    );
    const result = await route(
      {
        prompt: "PRIVATE_PROMPT",
        cwd: f.cwd,
        agent: "claude-code",
        skills: catalog.skills,
      },
      { name: "fake", judge },
    );
    expect(JSON.stringify(judge.mock.calls)).not.toMatch(
      /secret-marketplace|secret-cache/,
    );
    const advisory = buildClaudeAdvisory(result.selected, catalog.skills);
    expect(advisory.output).not.toMatch(/secret-marketplace|secret-cache/);
    expect(catalog.skills.map((s) => s.name)).not.toContain(
      "secret-marketplace",
    );
  });
  it("keeps manual-only plugin and synced skills visible but out of routing and advisory", async () => {
    const f = await catalogFixture();
    const text =
      "---\nname: manual\ndescription: Manual.\ndisable-model-invocation: true\n---";
    await write(join(f.installed, "skills/directory/SKILL.md"), text);
    await write(join(f.config, "skills/synced/account/manual/SKILL.md"), text);
    const catalog = await f.run();
    const manual = catalog.skills.filter((s) => s.name === "manual");
    expect(manual).toHaveLength(2);
    expect(
      manual.every((s) => !s.enabled && !claudeMetadata(s)?.modelInvocable),
    ).toBe(true);
    const provider = new MockRouterProvider({ scores: { manual: 1 } });
    const spy = vi.spyOn(provider, "judge");
    const result = await route(
      {
        prompt: "test",
        cwd: f.cwd,
        agent: "claude-code",
        skills: catalog.skills,
      },
      provider,
    );
    expect(spy.mock.calls[0]?.[0].candidates.map((s) => s.name)).not.toContain(
      "manual",
    );
    expect(
      buildClaudeAdvisory(result.selected, catalog.skills).output,
    ).toBeUndefined();
  });
  it("disabled plugins never load or inject", async () => {
    const f = await catalogFixture();
    await write(
      join(f.config, "settings.json"),
      JSON.stringify({ enabledPlugins: { "registry-slug@market": false } }),
    );
    const result = await f.run();
    expect(
      result.skills.some((s) => claudeMetadata(s)?.origin === "plugin"),
    ).toBe(false);
  });
  it("enumerates bounded custom skill directories and supports root SKILL.md", async () => {
    const f = await catalogFixture();
    await write(
      join(f.installed, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "codex", skills: ["./extra", "."] }),
    );
    await write(join(f.installed, "extra/foo/SKILL.md"), skillText("extra"));
    await write(join(f.installed, "SKILL.md"), skillText("root-skill"));
    const names = (await f.run()).skills.map(claudeInvocationName);
    expect(names).toEqual(
      expect.arrayContaining([
        "codex:native-name",
        "codex:extra",
        "codex:root-skill",
      ]),
    );
  });
  it("rejects symlink skills/files and symlink custom component ancestors", async () => {
    const f = await catalogFixture();
    const outside = join(f.root, "outside");
    await write(join(outside, "SKILL.md"), skillText("outside"));
    await symlink(outside, join(f.installed, "skills/link"));
    await mkdir(join(f.installed, "skills/file-link"));
    await symlink(
      join(outside, "SKILL.md"),
      join(f.installed, "skills/file-link/SKILL.md"),
    );
    expect((await f.run()).skills.map((s) => s.name)).not.toContain("outside");
    await symlink(outside, join(f.installed, "alias"));
    await mkdir(join(outside, "child"));
    await write(
      join(f.installed, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "codex", skills: "./alias/child" }),
    );
    expect(
      (await f.run()).skills.some(
        (s) => claudeMetadata(s)?.origin === "plugin",
      ),
    ).toBe(false);
  });
  it("mixed origins keep unique IDs, deterministic counts and a minimal Jev payload", async () => {
    const f = await catalogFixture();
    await write(join(f.config, "skills/local/SKILL.md"), skillText("local"));
    await write(
      join(f.config, "skills/synced/ACCOUNT_SENTINEL/pdf/SKILL.md"),
      skillText("pdf"),
    );
    const result = await f.run();
    expect(await f.run()).toEqual(result);
    expect(new Set(result.skills.map((s) => s.id)).size).toBe(
      result.skills.length,
    );
    expect(claudeOriginCounts(result.skills)).toMatchObject({
      "local-user": { discovered: 1, modelRoutable: 1 },
      synced: { discovered: 1, modelRoutable: 1 },
      plugin: { discovered: 1, modelRoutable: 1 },
    });
    for (const skill of result.skills) {
      const question = skillQuestion(skill);
      expect(Object.keys(question.instructions.skill).sort()).toEqual([
        "agent",
        "description",
        "name",
        "scope",
      ]);
      expect(JSON.stringify(question)).not.toContain(f.root);
      expect(JSON.stringify(question)).not.toContain("ACCOUNT_SENTINEL");
    }
  });
  it("sync opt-out and user invocation overrides restrict model routing", async () => {
    const f = await catalogFixture();
    await write(
      join(f.config, "skills/synced/account/pdf/SKILL.md"),
      skillText("pdf"),
    );
    await write(join(f.config, "skills/local/SKILL.md"), skillText("display"));
    await write(
      join(f.config, "settings.json"),
      JSON.stringify({
        syncClaudeAiSkills: false,
        skillOverrides: {
          local: "user-invocable-only",
          "codex:native-name": "off",
        },
      }),
    );
    const result = await f.run();
    expect(
      result.skills.some((s) => claudeMetadata(s)?.origin === "synced"),
    ).toBe(false);
    expect(result.skills.find((s) => s.name === "display")?.enabled).toBe(
      false,
    );
    // Official skillOverrides excludes plugin skills.
    expect(result.skills.find((s) => s.name === "native-name")?.enabled).toBe(
      true,
    );
  });
  it("reads file-managed skills and gives managed plugin state final precedence", async () => {
    const f = await catalogFixture();
    await write(
      join(f.managed, ".claude/skills/enterprise/SKILL.md"),
      skillText("enterprise"),
    );
    await write(
      join(f.config, "settings.json"),
      JSON.stringify({ enabledPlugins: { "registry-slug@market": true } }),
    );
    await write(
      join(f.managed, "managed-settings.json"),
      JSON.stringify({ enabledPlugins: { "registry-slug@market": false } }),
    );
    const result = await f.run();
    expect(result.skills.find((s) => s.name === "enterprise")).toMatchObject({
      scope: "admin",
      metadata: { claude: { origin: "managed" } },
    });
    expect(
      result.skills.some((s) => claudeMetadata(s)?.origin === "plugin"),
    ).toBe(false);
  });
  it("keeps installation relocation out of plugin IDs", async () => {
    const f = await catalogFixture();
    const before = (await f.run()).skills.find(
      (s) => claudeMetadata(s)?.origin === "plugin",
    );
    const moved = join(f.root, "moved");
    await rename(f.installed, moved);
    await write(
      f.registryPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "registry-slug@market": [{ ...f.record, installPath: moved }],
        },
      }),
    );
    expect(
      (await f.run()).skills.find((s) => claudeMetadata(s)?.origin === "plugin")
        ?.id,
    ).toBe(before?.id);
  });
});

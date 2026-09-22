import { link, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/core/types.js";
import { resolveClaudePlugins } from "../../src/discovery/claude-plugins.js";
import {
  type ClaudeCatalogSettings,
  loadClaudeCatalogSettings,
} from "../../src/discovery/claude-settings.js";
import { workspace, write } from "../helpers.js";

const settings = (): ClaudeCatalogSettings => ({
  valid: true,
  enabledPlugins: new Map(),
  skillOverrides: new Map(),
  syncClaudeAiSkills: true,
  strictPluginOnlySkills: false,
});
async function fixture() {
  const ctx = await workspace();
  const root = join(ctx.home, ".claude/plugins");
  const installed = join(ctx.root, "installed");
  await write(
    join(installed, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "native-name" }),
  );
  const record = { scope: "user", version: "1.0.0", installPath: installed };
  const registry = (records: unknown = [record]) =>
    write(
      join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "registry-name@market": records },
      }),
    );
  const config = settings();
  const diagnostics: Diagnostic[] = [];
  const run = () =>
    resolveClaudePlugins(root, config, [ctx.cwd, ctx.repo], diagnostics);
  await registry();
  return {
    ...ctx,
    root,
    installed,
    record,
    registry,
    config,
    diagnostics,
    run,
  };
}

describe("Claude plugin installation state", () => {
  it("requires a valid installed manifest, not just the registry, and uses its namespace", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject([
      {
        id: "registry-name@market",
        name: "native-name",
        scope: "user",
        version: "1.0.0",
        paths: [f.installed],
      },
    ]);
    await write(join(f.installed, ".claude-plugin/plugin.json"), "{}");
    expect(await f.run()).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "invalid_plugin_manifest",
    );
  });
  it.each([true, false])(
    "honors explicit enabledPlugins=%s",
    async (enabled) => {
      const f = await fixture();
      f.config.enabledPlugins.set("registry-name@market", enabled);
      await write(
        join(f.installed, ".claude-plugin/plugin.json"),
        JSON.stringify({ name: "foo", defaultEnabled: !enabled }),
      );
      expect((await f.run()).length).toBe(enabled ? 1 : 0);
    },
  );
  it.each([true, false])(
    "honors installed manifest defaultEnabled=%s when absent",
    async (enabled) => {
      const f = await fixture();
      await write(
        join(f.installed, ".claude-plugin/plugin.json"),
        JSON.stringify({ name: "foo", defaultEnabled: enabled }),
      );
      expect((await f.run()).length).toBe(enabled ? 1 : 0);
    },
  );
  it("uses a targeted marketplace entry default before manifest default", async () => {
    const f = await fixture();
    const market = join(f.root, "marketplaces/only-this");
    await write(
      join(f.root, "known_marketplaces.json"),
      JSON.stringify({ market: { installLocation: market } }),
    );
    await write(
      join(market, ".claude-plugin/marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "registry-name", defaultEnabled: false }],
      }),
    );
    expect(await f.run()).toEqual([]);
    f.config.enabledPlugins.set("registry-name@market", true);
    expect(await f.run()).toHaveLength(1);
  });
  it("reports an enabled but missing installation without scanning caches", async () => {
    const f = await fixture();
    f.config.enabledPlugins.set("missing@market", true);
    await write(
      join(f.root, "cache/market/missing/1.0/skills/hidden/SKILL.md"),
      "Must not load.",
    );
    expect(await f.run()).toHaveLength(1);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "plugin_install_missing",
    );
  });

  it.each([
    { scope: "user", version: "v1" },
    { scope: "unknown", version: "v1", installPath: "/fixture" },
  ])("rejects missing or unsupported installation fields", async (record) => {
    const f = await fixture();
    await f.registry([record]);
    expect(await f.run()).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "invalid_plugin_registry",
    );
  });
  it("reports an enabled empty installation and malformed marketplace state", async () => {
    const f = await fixture();
    f.config.enabledPlugins.set("registry-name@market", true);
    await f.registry([]);
    expect(await f.run()).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "plugin_install_missing",
    );
    await f.registry();
    await write(join(f.root, "known_marketplaces.json"), "{INVALID_PRIVATE");
    expect(await f.run()).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "invalid_plugin_marketplace",
    );
    expect(JSON.stringify(f.diagnostics)).not.toContain("INVALID_PRIVATE");
  });
  it("missing registry gives an empty catalog", async () => {
    const f = await fixture();
    expect(
      await resolveClaudePlugins(
        join(f.root, "absent"),
        f.config,
        [f.repo],
        f.diagnostics,
      ),
    ).toEqual([]);
    expect(f.diagnostics).toEqual([]);
  });
  it.each([
    "{broken",
    '{"version":1,"plugins":{}}',
    '{"version":2,"plugins":[]}',
    '{"version":2,"version":2,"plugins":{}}',
  ])("rejects malformed registry %s", async (body) => {
    const f = await fixture();
    await write(join(f.root, "installed_plugins.json"), body);
    expect(await f.run()).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "invalid_plugin_registry",
    );
  });
  it.each(["project", "local"])(
    "limits %s scope to matching projectPath",
    async (scope) => {
      const f = await fixture();
      await f.registry([{ ...f.record, scope, projectPath: f.repo }]);
      expect(await f.run()).toHaveLength(1);
      await f.registry([{ ...f.record, scope, projectPath: f.home }]);
      expect(await f.run()).toEqual([]);
      await f.registry([{ ...f.record, scope }]);
      expect(await f.run()).toEqual([]);
    },
  );
  it("accepts managed installations with managed enablement", async () => {
    const f = await fixture();
    await f.registry([{ ...f.record, scope: "managed" }]);
    expect(await f.run()).toMatchObject([{ scope: "managed" }]);
  });
  it("deduplicates registry records and canonical installed paths", async () => {
    const f = await fixture();
    await f.registry([f.record, f.record]);
    expect(await f.run()).toMatchObject([{ paths: [f.installed] }]);
    expect(await f.run()).toHaveLength(1);
  });
  it("does not guess among applicable versions or let irrelevant projects shadow user installs", async () => {
    const f = await fixture();
    await f.registry([
      { ...f.record, version: "old", scope: "project", projectPath: f.home },
      f.record,
    ]);
    expect(await f.run()).toHaveLength(1);
    await f.registry([{ ...f.record, version: "old" }, f.record]);
    expect(await f.run()).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "ambiguous_plugin_installation",
    );
  });
  it.each(["missing", "relative", "symlink", "directory-file"])(
    "rejects unsafe installPath %s",
    async (kind) => {
      const f = await fixture();
      let path = join(f.root, kind);
      if (kind === "relative") path = "../outside";
      if (kind === "symlink") {
        await mkdir(f.root, { recursive: true });
        await symlink(f.installed, path);
      }
      if (kind === "directory-file") await write(path, "not directory");
      await f.registry([{ ...f.record, installPath: path }]);
      expect(await f.run()).toEqual([]);
      expect(f.diagnostics.length).toBeGreaterThan(0);
      expect(JSON.stringify(f.diagnostics)).not.toContain(f.root);
    },
  );
  it.each(["symlink", "hardlink"])("refuses %s registry", async (kind) => {
    const f = await fixture();
    const root = join(f.root, "other");
    await mkdir(root);
    const operation = kind === "symlink" ? symlink : link;
    await operation(
      join(f.root, "installed_plugins.json"),
      join(root, "installed_plugins.json"),
    );
    expect(
      await resolveClaudePlugins(root, f.config, [f.repo], f.diagnostics),
    ).toEqual([]);
    expect(f.diagnostics.map((d) => d.code)).toContain(
      "invalid_plugin_registry",
    );
  });
  it.each(["./../../outside", "/absolute", "./bad\npath", "$" + "{SECRET}"])(
    "rejects unsafe component path %s",
    async (skills) => {
      const f = await fixture();
      await write(
        join(f.installed, ".claude-plugin/plugin.json"),
        JSON.stringify({ name: "foo", skills }),
      );
      expect(await f.run()).toEqual([]);
    },
  );
});

describe("Claude catalog settings precedence", () => {
  it("merges user < cwd project < cwd legacy local < owned repo local < file managed, per plugin key", async () => {
    const ctx = await workspace();
    const root = join(ctx.home, ".claude");
    const managed = join(ctx.root, "managed");
    const diagnostics: Diagnostic[] = [];
    const paths = [
      join(root, "settings.json"),
      join(ctx.cwd, ".claude/settings.json"),
      join(ctx.cwd, ".claude/settings.local.json"),
      join(ctx.repo, ".claude/settings.local.json"),
      join(managed, "managed-settings.json"),
    ];
    for (const [index, path] of paths.entries()) {
      await write(
        path,
        JSON.stringify({
          enabledPlugins: {
            "foo@market": index % 2 === 0,
            [`plugin-${index}@market`]: true,
          },
        }),
      );
      const state = await loadClaudeCatalogSettings(
        ctx,
        root,
        [ctx.cwd, ctx.repo],
        managed,
        diagnostics,
      );
      expect(state.enabledPlugins.get("foo@market")).toBe(index % 2 === 0);
      expect(state.enabledPlugins.size).toBe(index + 2);
    }
    expect(diagnostics).toEqual([]);
  });
  it("reads ordered managed fragments and overrides without exposing unrelated config", async () => {
    const ctx = await workspace();
    const managed = join(ctx.root, "managed");
    const diagnostics: Diagnostic[] = [];
    await write(
      join(managed, "managed-settings.d/10-on.json"),
      JSON.stringify({
        enabledPlugins: { "a@b": true },
        env: { SECRET: "not-to-copy" },
      }),
    );
    await write(
      join(managed, "managed-settings.d/20-off.json"),
      JSON.stringify({
        enabledPlugins: { "a@b": false },
        syncClaudeAiSkills: false,
        skillOverrides: { deploy: "off" },
      }),
    );
    const state = await loadClaudeCatalogSettings(
      ctx,
      join(ctx.home, ".claude"),
      [ctx.cwd, ctx.repo],
      managed,
      diagnostics,
    );
    expect(state.enabledPlugins.get("a@b")).toBe(false);
    expect(state.syncClaudeAiSkills).toBe(false);
    expect(state.skillOverrides.get("deploy")).toBe("off");
    expect(JSON.stringify(state)).not.toContain("not-to-copy");
  });
  it.each([
    "{",
    '{"enabledPlugins":{"x@y":"yes"}}',
    '{"skillOverrides":{"x":"invalid"}}',
    '{"syncClaudeAiSkills":"no"}',
  ])("makes malformed settings non-authoritative: %s", async (text) => {
    const ctx = await workspace();
    const root = join(ctx.home, ".claude");
    const diagnostics: Diagnostic[] = [];
    await write(join(root, "settings.json"), text);
    expect(
      (
        await loadClaudeCatalogSettings(
          ctx,
          root,
          [ctx.cwd, ctx.repo],
          null,
          diagnostics,
        )
      ).valid,
    ).toBe(false);
    expect(diagnostics.map((d) => d.code)).toContain("invalid_claude_settings");
  });
});

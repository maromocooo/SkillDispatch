import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/core/types.js";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import {
  childDirectories,
  readClaudeJson,
} from "../../src/discovery/claude-files.js";
import { skillText, workspace, write } from "../helpers.js";

describe("bounded Claude source reads", () => {
  it("never parses an account directory itself as a skill or masks its child skills", async () => {
    const ctx = await workspace();
    const config = join(ctx.root, "config");
    await write(
      join(config, "skills/synced/ACCOUNT_SENTINEL/SKILL.md"),
      skillText("ACCOUNT_SENTINEL"),
    );
    await write(
      join(config, "skills/synced/ACCOUNT_SENTINEL/pdf/SKILL.md"),
      skillText("pdf"),
    );
    const result = await new ClaudeDiscoveryAdapter({
      managedDirectory: null,
    }).discover({ ...ctx, env: { CLAUDE_CONFIG_DIR: config } });
    expect(result.skills.map((s) => s.name)).toContain("pdf");
    expect(result.skills.map((s) => s.name)).not.toContain("ACCOUNT_SENTINEL");
  });
  it("canonicalizes config-root aliases before deriving local and synced invocation names", async () => {
    const ctx = await workspace();
    const config = join(ctx.root, "config");
    await write(join(config, "skills/local/SKILL.md"), skillText("local"));
    await write(
      join(config, "skills/synced/account/pdf/SKILL.md"),
      skillText("pdf"),
    );
    const alias = join(ctx.root, "config-alias");
    await symlink(config, alias);
    const adapter = new ClaudeDiscoveryAdapter({ managedDirectory: null });
    const result = await adapter.discover({
      ...ctx,
      env: { CLAUDE_CONFIG_DIR: alias },
    });
    expect(result.skills.find((s) => s.name === "pdf")).toMatchObject({
      enabled: true,
      metadata: { commandName: "anthropic-skills:pdf" },
    });
    expect(result).toEqual(
      await adapter.discover({ ...ctx, env: { CLAUDE_CONFIG_DIR: config } }),
    );
  });
  it("bounds sync directory enumeration without returning an arbitrary truncated subset", async () => {
    const ctx = await workspace();
    const diagnostics: Diagnostic[] = [];
    await mkdir(join(ctx.root, "sources/a"), { recursive: true });
    await mkdir(join(ctx.root, "sources/b"));
    expect(
      await childDirectories(join(ctx.root, "sources"), diagnostics, 1),
    ).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toContain("invalid_claude_source");
  });
  it.each(["oversized", "duplicate", "depth", "bad-utf8"])(
    "rejects %s state safely",
    async (kind) => {
      const ctx = await workspace();
      const path = join(ctx.root, "state.json");
      const diagnostics: Diagnostic[] = [];
      const value =
        kind === "oversized"
          ? JSON.stringify({ huge: "x".repeat(1_048_576) })
          : kind === "duplicate"
            ? '{"x":false,"x":true}'
            : kind === "depth"
              ? '"x"'
              : "\ud800";
      await write(
        path,
        kind === "depth" ? '{"x":'.repeat(40) + value + "}".repeat(40) : value,
      );
      if (kind === "bad-utf8") await writeFile(path, Buffer.from([0xff]));
      expect(
        await readClaudeJson(path, diagnostics, "invalid_state"),
      ).toBeUndefined();
      expect(diagnostics).toEqual([
        {
          code: "invalid_state",
          level: "warning",
          message: expect.any(String),
        },
      ]);
    },
  );
  it("does not follow a symlink manifest directory", async () => {
    const ctx = await workspace();
    const diagnostics: Diagnostic[] = [];
    await write(join(ctx.root, "target/plugin.json"), '{"name":"foo"}');
    await symlink(join(ctx.root, "target"), join(ctx.root, "manifest"));
    expect(
      await readClaudeJson(
        join(ctx.root, "manifest/plugin.json"),
        diagnostics,
        "invalid_plugin_manifest",
      ),
    ).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toContain("invalid_plugin_manifest");
  });
  it("frontmatter cannot spoof origin or invocation provenance", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.repo, ".claude/skills/safe/SKILL.md"),
      '---\nname: display\ndescription: A skill.\nclaude: {origin: plugin, nativeInvocationName: "evil:injected", modelInvocable: true}\ncommandName: evil:injected\ncatalogIdentity: forged\n---',
    );
    const result = await new ClaudeDiscoveryAdapter({
      managedDirectory: null,
    }).discover(ctx);
    const skill = result.skills.find((s) => s.name === "display");
    expect(skill?.metadata.claude).toMatchObject({
      origin: "local-project",
      nativeInvocationName: "safe",
    });
    expect(skill?.metadata.commandName).toBe("safe");
    expect(skill?.metadata.catalogIdentity).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not route any Claude skills when catalog visibility settings are malformed", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".claude/settings.json"),
      '{"enabledPlugins":"INVALID_PRIVATE_SETTINGS"}',
    );
    const result = await new ClaudeDiscoveryAdapter({
      managedDirectory: null,
    }).discover(ctx);
    expect(result.skills.length).toBeGreaterThan(0);
    expect(result.skills.every((s) => !s.enabled)).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "INVALID_PRIVATE_SETTINGS",
    );
  });
});

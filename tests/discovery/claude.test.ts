import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeCatalog } from "../../src/discovery/catalog.js";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import { CodexDiscoveryAdapter } from "../../src/discovery/codex.js";
import { skillText, workspace, write } from "../helpers.js";

describe("Claude Code discovery", () => {
  it("keeps a symlink's local command name while canonicalizing its identity", async () => {
    const ctx = await workspace();
    const target = join(ctx.root, "external-implementation");
    await write(
      join(target, "SKILL.md"),
      "---\ndescription: A linked skill.\n---\n",
    );
    await symlink(target, join(ctx.repo, ".claude/skills/local-command"));
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(result.skills.find((s) => s.name === "local-command")).toMatchObject(
      {
        path: join(target, "SKILL.md"),
        directory: target,
        metadata: { commandName: "local-command" },
      },
    );
  });
  it("reads personal, project and CWD skills, retaining duplicate names", async () => {
    const ctx = await workspace();
    const adapter = new ClaudeDiscoveryAdapter();
    const result = await adapter.discover(ctx);
    expect(result.skills).toHaveLength(5);
    expect(result.skills.every((s) => s.agent === "claude-code")).toBe(true);
    expect(
      result.skills
        .filter((s) => s.name === "shared-name")
        .map((s) => s.scope)
        .sort(),
    ).toEqual(["repo", "user"]);
    expect(result.diagnostics.some((d) => d.code === "duplicate_name")).toBe(
      true,
    );
    expect(
      result.skills.find((s) => s.name === "accessibility-review")?.scope,
    ).toBe("repo");
    expect(await adapter.discover(ctx)).toEqual(result);
  });
  it("uses current native fallbacks for omitted name, description and frontmatter", async () => {
    const ctx = await workspace();
    const root = join(ctx.repo, ".claude/skills");
    await write(
      join(root, "without-name/SKILL.md"),
      "---\ndescription: A named directory.\n---\n",
    );
    await write(
      join(root, "without-description/SKILL.md"),
      "---\nname: display-name\n---\n\nFirst non-empty line.\nMore content.\n",
    );
    await write(
      join(root, "plain/SKILL.md"),
      "Plain Markdown description.\nInstructions.\n",
    );
    await write(join(root, "empty/SKILL.md"), "---\nname: empty\n---\n");
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(
      result.skills.find((s) => s.name === "without-name")?.description,
    ).toBe("A named directory.");
    expect(result.skills.find((s) => s.name === "display-name")).toMatchObject({
      description: "First non-empty line.",
      metadata: { commandName: "without-description" },
    });
    expect(result.skills.find((s) => s.name === "plain")?.description).toBe(
      "Plain Markdown description.",
    );
    expect(result.skills.some((s) => s.name === "empty")).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "invalid_metadata")).toBe(
      true,
    );
  });
  it.each([true, "YES", "on", 1])(
    "does not automatically route explicit-only skills (%s)",
    async (value) => {
      const ctx = await workspace();
      await write(
        join(ctx.repo, ".claude/skills/manual/SKILL.md"),
        `---\nname: manual\ndescription: Manual workflow.\ndisable-model-invocation: ${JSON.stringify(value)}\n---\n`,
      );
      const result = await new ClaudeDiscoveryAdapter().discover(ctx);
      expect(result.skills.find((s) => s.name === "manual")?.enabled).toBe(
        false,
      );
      expect(result.skills.find((s) => s.name === "background")?.enabled).toBe(
        true,
      );
    },
  );
  it("respects CLAUDE_CONFIG_DIR and does not also include the default home", async () => {
    const ctx = await workspace();
    const config = join(ctx.root, "custom-claude");
    await write(join(config, "skills/custom/SKILL.md"), skillText("custom"));
    const result = await new ClaudeDiscoveryAdapter().discover({
      ...ctx,
      env: { CLAUDE_CONFIG_DIR: config },
    });
    expect(
      result.skills.filter((s) => s.scope === "user").map((s) => s.name),
    ).toEqual(["custom"]);
  });
  it("deduplicates canonical aliases, handles symlink loops, skips synced and descendant projects", async () => {
    const ctx = await workspace();
    const root = join(ctx.repo, ".claude/skills");
    await symlink(join(root, "auth"), join(root, "alias"));
    await symlink(root, join(root, "cycle"));
    await symlink(join(root, "self"), join(root, "self"));
    await write(
      join(root, "synced/ignored/SKILL.md"),
      skillText("synced-skill"),
    );
    await write(
      join(ctx.cwd, "child/.claude/skills/ignored/SKILL.md"),
      skillText("descendant"),
    );
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(
      result.skills.filter((s) => s.name === "authentication-review"),
    ).toHaveLength(1);
    expect(
      result.skills.some((s) =>
        ["synced-skill", "descendant"].includes(s.name),
      ),
    ).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["symlink_loop", "scan_failed"]),
    );
  });
  it("continues after invalid YAML and invalid invocation policy", async () => {
    const ctx = await workspace();
    const root = join(ctx.repo, ".claude/skills");
    await write(join(root, "broken/SKILL.md"), "---\nname: [invalid\n---");
    await write(
      join(root, "policy/SKILL.md"),
      "---\nname: policy\ndescription: Test.\ndisable-model-invocation: perhaps\n---",
    );
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(result.skills.find((s) => s.name === "policy")?.enabled).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["invalid_yaml", "invalid_invocation_policy"]),
    );
  });
  it("merges cross-agent catalogs deterministically with distinct source identities", async () => {
    const ctx = await workspace();
    await mkdir(join(ctx.root, "shared"));
    await write(join(ctx.root, "shared/SKILL.md"), skillText("cross-agent"));
    await symlink(
      join(ctx.root, "shared"),
      join(ctx.repo, ".agents/skills/cross"),
    );
    await symlink(
      join(ctx.root, "shared"),
      join(ctx.repo, ".claude/skills/cross"),
    );
    const codex = await new CodexDiscoveryAdapter({ adminRoots: [] }).discover(
      ctx,
    );
    const claude = await new ClaudeDiscoveryAdapter().discover(ctx);
    const result = finalizeCatalog([codex, claude]);
    expect(finalizeCatalog([claude, codex])).toEqual(result);
    const shared = result.skills.filter((s) => s.name === "cross-agent");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((s) => s.id)).size).toBe(2);
  });
});

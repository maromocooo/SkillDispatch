import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexDiscoveryAdapter } from "../../src/discovery/codex.js";
import { skillText, workspace, write } from "../helpers.js";

const adapter = () => new CodexDiscoveryAdapter({ adminRoots: [] });

describe("Codex discovery", () => {
  it("finds CWD, ancestor and user scopes, keeps duplicates and isolates invalid YAML", async () => {
    const ctx = await workspace();
    const result = await adapter().discover(ctx);
    expect(result.skills).toHaveLength(5);
    expect(
      result.skills.find((s) => s.name === "frontend-testing")?.scope,
    ).toBe("repo");
    const duplicates = result.skills.filter((s) => s.name === "shared-name");
    expect(duplicates.map((s) => s.scope).sort()).toEqual(["repo", "user"]);
    expect(new Set(duplicates.map((s) => s.id)).size).toBe(2);
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["duplicate_name", "invalid_yaml"]),
    );
    expect(result.skills.map((s) => s.path)).toEqual(
      result.skills.map((s) => s.path).sort(),
    );
    expect(await adapter().discover(ctx)).toEqual(result);
  });
  it("excludes configured paths and explicit-only skills from automatic routing", async () => {
    const ctx = await workspace();
    const target = join(ctx.repo, ".agents/skills/react/SKILL.md");
    const configHome = join(ctx.root, "custom-codex");
    await write(
      join(configHome, "config.toml"),
      `unrelated_key = "private-value"\n[[skills.config]]\npath = ${JSON.stringify(target)}\nenabled = false\n`,
    );
    const result = await adapter().discover({
      ...ctx,
      env: { CODEX_HOME: configHome },
    });
    expect(
      result.skills.find((s) => s.name === "react-patterns")?.enabled,
    ).toBe(false);
    expect(result.skills.find((s) => s.name === "manual-only")?.enabled).toBe(
      false,
    );
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
  it("canonicalizes symlink aliases and disabled paths and stops cycles", async () => {
    const ctx = await workspace();
    const root = join(ctx.repo, ".agents/skills");
    await symlink(join(root, "react"), join(root, "alias"));
    await symlink(root, join(root, "cycle"));
    await symlink(join(root, "missing"), join(root, "broken-link"));
    await write(
      join(ctx.home, ".codex/config.toml"),
      `[[skills.config]]\npath = ${JSON.stringify(join(root, "alias/SKILL.md"))}\nenabled = false\n`,
    );
    const result = await adapter().discover(ctx);
    expect(
      result.skills.filter((s) => s.name === "react-patterns"),
    ).toHaveLength(1);
    expect(
      result.skills.find((s) => s.name === "react-patterns"),
    ).toMatchObject({ path: join(root, "react/SKILL.md"), enabled: false });
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["symlink_loop", "scan_failed"]),
    );
  });
  it("honors worktree .git files, and does not load sibling or above-root skills", async () => {
    const ctx = await workspace();
    await write(join(ctx.cwd, ".git"), "gitdir: /not-used-for-reading\n");
    const result = await adapter().discover(ctx);
    expect(result.skills.some((s) => s.name === "react-patterns")).toBe(false);
    expect(result.skills.some((s) => s.name === "frontend-testing")).toBe(true);
  });
  it("outside Git scans only CWD and optional admin/system sources", async () => {
    const ctx = await workspace();
    const cwd = join(ctx.root, "outside/subdir");
    await mkdir(cwd);
    const admin = join(ctx.root, "admin");
    const system = join(ctx.root, "system");
    await write(join(admin, "admin/SKILL.md"), skillText("admin"));
    await write(join(system, "system/SKILL.md"), skillText("system"));
    const result = await new CodexDiscoveryAdapter({
      adminRoots: [admin],
      systemRoots: [system],
    }).discover({ ...ctx, cwd });
    expect(result.skills.some((s) => s.name === "outside-repo")).toBe(false);
    expect(result.skills.find((s) => s.name === "admin")?.scope).toBe("admin");
    expect(result.skills.find((s) => s.name === "system")?.scope).toBe(
      "system",
    );
  });
  it("diagnoses malformed config without disclosing source text", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".codex/config.toml"),
      'private = "secret-value"\ninvalid = [',
    );
    const result = await adapter().discover(ctx);
    expect(
      result.diagnostics.some((d) => d.code === "invalid_codex_config"),
    ).toBe(true);
    expect(result.skills.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
  it("invalid policy disables only that skill and supporting directories are not scanned", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.repo, ".agents/skills/react/agents/openai.yaml"),
      "policy: [broken",
    );
    await write(
      join(ctx.repo, ".agents/skills/react/references/nested/SKILL.md"),
      skillText("not-a-skill"),
    );
    const result = await adapter().discover(ctx);
    expect(
      result.skills.find((s) => s.name === "react-patterns")?.enabled,
    ).toBe(false);
    expect(result.skills.some((s) => s.name === "not-a-skill")).toBe(false);
    expect(
      result.diagnostics.some((d) => d.code === "invalid_invocation_policy"),
    ).toBe(true);
  });
});

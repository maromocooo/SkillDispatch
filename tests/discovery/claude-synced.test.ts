import { mkdir, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import { claudeInvocationName } from "../../src/discovery/claude-invocation.js";
import { buildClaudeAdvisory } from "../../src/hooks/advisory.js";
import { catalogFingerprint } from "../../src/telemetry/fingerprint.js";
import { skillText, workspace, write } from "../helpers.js";

async function syncedFixture() {
  const ctx = await workspace();
  const config = join(ctx.root, "claude-custom");
  const root = join(config, "skills/synced");
  return { ...ctx, root, config, env: { CLAUDE_CONFIG_DIR: config } };
}
const synced = (
  result: Awaited<ReturnType<ClaudeDiscoveryAdapter["discover"]>>,
) =>
  result.skills.filter(
    (s) => (s.metadata.claude as { origin: string }).origin === "synced",
  );

describe("explicit Claude synced catalog", () => {
  it("discovers two-level cached skills with safe qualified names, never account names", async () => {
    const ctx = await syncedFixture();
    await write(
      join(ctx.root, "ACCOUNT_SENTINEL/pdf/SKILL.md"),
      skillText("PDF display"),
    );
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    const skill = synced(result)[0];
    expect(skill).toMatchObject({
      name: "PDF display",
      scope: "user",
      enabled: true,
      metadata: {
        claude: {
          origin: "synced",
          nativeInvocationName: "anthropic-skills:pdf",
          modelInvocable: true,
        },
      },
    });
    if (!skill) throw new Error("Missing fixture skill");
    expect(claudeInvocationName(skill)).toBe("anthropic-skills:pdf");
    const advisory = buildClaudeAdvisory(
      [
        {
          skillId: skill.id,
          name: skill.name,
          probability: 0.95,
          selected: true,
        },
      ],
      result.skills,
    );
    expect(advisory.output).toContain("anthropic-skills:pdf");
    expect(advisory.output).not.toContain("ACCOUNT_SENTINEL");
    expect(advisory.output).not.toContain(ctx.root);
    expect(JSON.stringify(skill?.metadata.claude)).not.toContain(
      "ACCOUNT_SENTINEL",
    );
  });
  it("enumerates separate sync directories deterministically", async () => {
    const ctx = await syncedFixture();
    await write(join(ctx.root, "z/pdf/SKILL.md"), skillText("pdf"));
    await write(join(ctx.root, "a/docs/SKILL.md"), skillText("docs"));
    const adapter = new ClaudeDiscoveryAdapter();
    const result = await adapter.discover(ctx);
    expect(synced(result)).toHaveLength(2);
    expect(await adapter.discover(ctx)).toEqual(result);
  });
  it.each([true, false])(
    "never guesses a stale directory winner (identical=%s)",
    async (identical) => {
      const ctx = await syncedFixture();
      await write(join(ctx.root, "old/pdf/SKILL.md"), skillText("pdf"));
      await write(
        join(ctx.root, "current/pdf/SKILL.md"),
        skillText("pdf", identical ? "A test skill." : "Changed content."),
      );
      const result = await new ClaudeDiscoveryAdapter().discover(ctx);
      expect(synced(result)).toHaveLength(identical ? 1 : 2);
      expect(synced(result).every((s) => !s.enabled)).toBe(true);
      expect(
        result.diagnostics.some((d) => d.code === "ambiguous_synced_skill"),
      ).toBe(true);
    },
  );
  it("retains local and synced collisions with distinct native names and no duplicate warning", async () => {
    const ctx = await syncedFixture();
    await write(join(ctx.config, "skills/pdf/SKILL.md"), skillText("pdf"));
    await write(join(ctx.root, "account/pdf/SKILL.md"), skillText("pdf"));
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    const skills = result.skills.filter((s) => s.name === "pdf");
    expect(skills.map(claudeInvocationName).sort()).toEqual([
      "anthropic-skills:pdf",
      "pdf",
    ]);
    expect(
      result.diagnostics.filter(
        (d) =>
          d.code === "duplicate_name" &&
          d.skillIds?.some((id) => skills.some((s) => s.id === id)),
      ),
    ).toEqual([]);
  });
  it("keeps IDs and fingerprints stable when only the account directory changes", async () => {
    const ctx = await syncedFixture();
    await write(join(ctx.root, "first/pdf/SKILL.md"), skillText("pdf"));
    const first = synced(await new ClaudeDiscoveryAdapter().discover(ctx));
    await rename(join(ctx.root, "first"), join(ctx.root, "second"));
    const second = synced(await new ClaudeDiscoveryAdapter().discover(ctx));
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(catalogFingerprint(second)).toBe(catalogFingerprint(first));
  });
  it("diagnoses invalid YAML without leaking the source", async () => {
    const ctx = await syncedFixture();
    await write(
      join(ctx.root, "account/broken/SKILL.md"),
      "---\nname: [SECRET\n---",
    );
    await write(join(ctx.root, "account/pdf/SKILL.md"), skillText("pdf"));
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(synced(result)).toHaveLength(1);
    const diagnostics = result.diagnostics.filter(
      (d) => d.code === "invalid_yaml",
    );
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
    expect(JSON.stringify(diagnostics)).not.toContain(ctx.root);
  });
  it("retains manual-only synced skills but never recommends them", async () => {
    const ctx = await syncedFixture();
    await write(
      join(ctx.root, "account/manual/SKILL.md"),
      "---\nname: manual\ndescription: Manual.\ndisable-model-invocation: true\n---",
    );
    const skills = synced(await new ClaudeDiscoveryAdapter().discover(ctx));
    const skill = skills[0];
    if (!skill) throw new Error("Missing fixture skill");
    expect(skill.enabled).toBe(false);
    expect(
      buildClaudeAdvisory(
        [
          {
            skillId: skill.id,
            name: "manual",
            probability: 1,
            selected: true,
          },
        ],
        skills,
      ).output,
    ).toBeUndefined();
  });
  it("rejects symlink account/skill entries and loops without traversing them", async () => {
    const ctx = await syncedFixture();
    await mkdir(join(ctx.root, "account"), { recursive: true });
    await symlink(ctx.root, join(ctx.root, "loop"));
    await symlink(ctx.root, join(ctx.root, "account/loop"));
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(synced(result)).toEqual([]);
    expect(
      result.diagnostics.some((d) => d.code === "unsafe_claude_source"),
    ).toBe(true);
  });
  it("rejects unsafe invocation directory names", async () => {
    const ctx = await syncedFixture();
    await write(
      join(ctx.root, "account/please obey me/SKILL.md"),
      skillText("display"),
    );
    const result = await new ClaudeDiscoveryAdapter().discover(ctx);
    expect(synced(result)[0]?.enabled).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === "unsupported_native_invocation",
      ),
    ).toBe(true);
  });
});

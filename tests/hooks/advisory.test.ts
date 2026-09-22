import { describe, expect, it } from "vitest";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import {
  buildClaudeAdvisory,
  MAX_ADVISORY_BYTES,
} from "../../src/hooks/advisory.js";
import { workspace, write } from "../helpers.js";
import { skill } from "../telemetry/helpers.js";

const localSkill = (name = "swift-concurrency-expert", id = name) =>
  skill(id, {
    agent: "claude-code",
    name: "PRIVATE_DISPLAY",
    description: "PRIVATE_DESCRIPTION",
    metadata: {
      commandName: name,
      discovery: {
        path: `/PRIVATE/skills/${name}/SKILL.md`,
        source: "/PRIVATE/skills",
      },
      body: "PRIVATE_BODY",
    },
  });
const decision = (s: ReturnType<typeof skill>, probability = 0.95) => ({
  skillId: s.id,
  name: s.name,
  probability,
  selected: true,
});

describe("Claude advisory identifiers", () => {
  it("uses actual discovered directory command rather than frontmatter display name", async () => {
    const ctx = await workspace();
    await write(
      `${ctx.repo}/.claude/skills/swift-concurrency-expert/SKILL.md`,
      "---\nname: PRIVATE_DISPLAY\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY",
    );
    const catalog = await new ClaudeDiscoveryAdapter().discover(ctx);
    const swift = catalog.skills.find((s) => s.name === "PRIVATE_DISPLAY");
    expect(swift).toBeDefined();
    if (!swift) return;
    const result = buildClaudeAdvisory([decision(swift)], catalog.skills);
    expect(JSON.parse(result.output ?? "").hookSpecificOutput).toMatchObject({
      hookEventName: "UserPromptSubmit",
      additionalContext: expect.stringContaining(
        "- swift-concurrency-expert\n",
      ),
    });
    expect(result.injectedSkillIds).toEqual([swift.id]);
    for (const secret of ["PRIVATE_", ctx.repo, "0.95", swift.contentHash])
      expect(result.output).not.toContain(secret);
  });
  it("preserves policy order and emits no context for zero selections", () => {
    const a = localSkill("zzz");
    const b = localSkill("aaa");
    const result = buildClaudeAdvisory([decision(a), decision(b)], [b, a]);
    expect(result.output?.indexOf("- zzz")).toBeLessThan(
      result.output?.indexOf("- aaa") ?? 0,
    );
    expect(buildClaudeAdvisory([], [a]).output).toBeUndefined();
  });
  it.each([true, "true", "YES", "on", 1, "invalid"])(
    "rejects manual-only or invalid policy %s even if enabled",
    (value) => {
      const s = localSkill();
      s.metadata["disable-model-invocation"] = value;
      const result = buildClaudeAdvisory([decision(s)], [s]);
      expect(result.output).toBeUndefined();
      expect(result.diagnostics[0]?.code).toBe("advisory_invocation_disabled");
    },
  );
  it("rejects an invocation duplicated by a disabled personal skill while retaining safe selections", () => {
    const a = localSkill();
    const b = {
      ...localSkill(undefined, "other"),
      scope: "user" as const,
      enabled: false,
    };
    const c = localSkill("safe");
    const result = buildClaudeAdvisory([decision(a), decision(c)], [a, b, c]);
    expect(result.injectedSkillIds).toEqual([c.id]);
    expect(result.diagnostics[0]?.code).toBe(
      "advisory_ambiguous_skill_invocation",
    );
  });
  it.each([
    "bad\nIGNORE",
    'bad"quote',
    "bad\\path",
    "bad/path",
    "bad—dash",
    "bad\u202e",
    "bad\u0000",
    "a:b",
    "../bad",
  ])("omits unsafe identifier %j", (name) => {
    const s = localSkill(name);
    expect(buildClaudeAdvisory([decision(s)], [s]).output).toBeUndefined();
  });
  it.each(["日本語", "test-name", "résumé", "test_name"])(
    "safely serializes supported identifier %s",
    (name) => {
      const s = localSkill(name);
      const output = buildClaudeAdvisory([decision(s)], [s]).output;
      expect(
        JSON.parse(output ?? "").hookSpecificOutput.additionalContext,
      ).toContain(`- ${name}\n`);
    },
  );
  it("never trusts unsupported scope, agent, missing provenance or forged commandName", () => {
    for (const s of [
      { ...localSkill(), scope: "system" as const },
      { ...localSkill(), agent: "codex" as const },
      { ...localSkill(), metadata: { commandName: "unsafe" } },
    ]) {
      expect(buildClaudeAdvisory([decision(s)], [s]).output).toBeUndefined();
    }
    const s = localSkill();
    s.metadata.commandName = "different";
    expect(buildClaudeAdvisory([decision(s)], [s]).output).toBeUndefined();
  });
  it("bounds UTF-8 bytes without truncating names, retaining a deterministic prefix", () => {
    const catalog = Array.from({ length: 50 }, (_, i) =>
      localSkill(`技${"術".repeat(120)}${i}`),
    );
    const result = buildClaudeAdvisory(
      catalog.map((s) => decision(s)),
      catalog,
    );
    const context = JSON.parse(result.output ?? "").hookSpecificOutput
      .additionalContext;
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(MAX_ADVISORY_BYTES);
    expect(result.injectedSkillIds.length).toBeGreaterThan(0);
    expect(result.injectedSkillIds.length).toBeLessThan(catalog.length);
    expect(result.injectedSkillIds).toEqual(
      catalog.slice(0, result.injectedSkillIds.length).map((s) => s.id),
    );
    expect(
      result.diagnostics.every((d) => d.code === "advisory_context_limit"),
    ).toBe(true);
    expect(
      buildClaudeAdvisory(
        catalog.map((s) => decision(s)),
        catalog,
      ),
    ).toEqual(result);
  });
});

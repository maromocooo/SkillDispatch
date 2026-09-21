import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkill } from "../../src/discovery/parse-skill.js";

const context = {
  path: "/skills/react/SKILL.md",
  scope: "repo",
  agent: "generic",
} as const;
const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`../fixtures/parser/${name}.md`, import.meta.url)),
    "utf8",
  );

describe("SKILL.md parser", () => {
  it("normalizes metadata while hashing the original source", async () => {
    const source = await fixture("valid");
    const { skills, diagnostics } = parseSkill(source, context);
    expect(diagnostics).toEqual([]);
    expect(skills[0]).toMatchObject({
      name: "react-patterns",
      description: "Build React forms and components.",
      metadata: { license: "MIT", metadata: { category: "frontend" } },
      enabled: true,
    });
    expect(skills[0]?.contentHash).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    expect(parseSkill(`${source}\n`, context).skills[0]?.id).toBe(
      skills[0]?.id,
    );
    expect(
      parseSkill(source, { ...context, path: "/other/SKILL.md" }).skills[0]?.id,
    ).not.toBe(skills[0]?.id);
  });
  it.each([
    "missing-name",
    "missing-description",
    "invalid-yaml",
    "duplicate-key",
    "no-frontmatter",
  ])("rejects %s with a diagnostic", async (name) => {
    const result = parseSkill(await fixture(name), context);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });
  it.each([
    "name: 123\ndescription: hi",
    "name: ' '\ndescription: hi",
    "name: hi\ndescription: []",
    "[hello]",
    "name: hi\ndescription: !execute secret",
    "name: &a [*a]\ndescription: loop",
  ])("rejects unsafe or invalid metadata without echoing it", (yaml) => {
    const result = parseSkill(`---\n${yaml}\n---`, context);
    expect(result.skills).toEqual([]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret");
  });
  it("supports BOM and CRLF, and ignores body YAML and commands", async () => {
    const source = `\uFEFF${(await fixture("valid")).replaceAll("\n", "\r\n")}`;
    expect(parseSkill(source, context).skills[0]?.name).toBe("react-patterns");
  });
  it("can use adapter-provided fallbacks without weakening the default parser", () => {
    const source = "---\nlicense: MIT\n---\n\nBody description\n!`do-not-run`";
    expect(parseSkill(source, context).skills).toHaveLength(0);
    expect(
      parseSkill(source, {
        ...context,
        fallbackName: "directory",
        fallbackDescriptionFromBody: true,
      }).skills[0],
    ).toMatchObject({ name: "directory", description: "Body description" });
  });
});

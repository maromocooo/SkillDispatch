import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import { claudeMetadata } from "../../src/discovery/claude-origin.js";
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

import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexDiscoveryAdapter } from "../../src/discovery/codex.js";
import { codexMetadata } from "../../src/discovery/codex-origin.js";
import { catalogFingerprint } from "../../src/telemetry/fingerprint.js";
import { skillText, workspace, write } from "../helpers.js";

const adapter = () => new CodexDiscoveryAdapter({ adminRoots: [] });
async function fixture() {
  const c = await workspace();
  const home = join(c.root, "codex");
  const root = join(home, "plugins/cache/market/foo/1.0.0");
  await write(
    join(root, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "foo", skills: "./skills" }),
  );
  await write(join(root, "skills/review/SKILL.md"), skillText("review"));
  await write(
    join(home, "skills/.system/built-in/SKILL.md"),
    skillText("built-in"),
  );
  await write(join(home, "skills/user/SKILL.md"), skillText("user-skill"));
  await write(
    join(home, "config.toml"),
    '[plugins."foo@market"]\nenabled=true\n',
  );
  return { ...c, env: { CODEX_HOME: home }, codex: home, pluginRoot: root };
}
describe("Codex native local state", () => {
  it("rejects a relative configuration root without guessing against process cwd", async () => {
    const c = await workspace();
    await expect(
      adapter().discover({ ...c, env: { CODEX_HOME: "PRIVATE_RELATIVE" } }),
    ).rejects.toThrow("Invalid Codex configuration root.");
  });
  it("finds user/system/plugins alongside existing sources with origins and unconfirmed session availability", async () => {
    const c = await fixture();
    const a = await adapter().discover(c);
    expect(a.skills.find((s) => s.name === "foo:review")).toMatchObject({
      enabled: true,
      scope: "user",
      metadata: {
        codex: {
          origin: "plugin",
          pluginVersion: "1.0.0",
          sessionAvailability: "unconfirmed",
        },
      },
    });
    expect(a.skills.filter((s) => s.name === "built-in")).toHaveLength(1);
    expect(
      a.skills.find((s) => s.name === "built-in")?.metadata.codex,
    ).toMatchObject({ origin: "system" });
    expect(a.skills.some((s) => s.name === "user-skill")).toBe(true);
    expect(await adapter().discover(c)).toEqual(a);
  });
  it("default CODEX_HOME includes system and user skills without system aliases counted twice", async () => {
    const c = await workspace();
    const root = join(c.home, ".codex/skills");
    await write(join(root, ".system/a/SKILL.md"), skillText("system-a"));
    await symlink(join(root, ".system/a"), join(root, "alias"));
    const a = await adapter().discover(c);
    expect(a.skills.filter((s) => s.name === "system-a")).toHaveLength(1);
    expect(a.skills.find((s) => s.name === "system-a")?.scope).toBe("system");
  });
  it.each([
    "disabled",
    "cache-only",
    "marketplace-only",
    "missing",
    "ambiguous",
    "unsafe",
    "symlink",
  ])("does not activate %s plugin state", async (kind) => {
    const c = await fixture();
    if (kind === "disabled")
      await write(
        join(c.codex, "config.toml"),
        '[plugins."foo@market"]\nenabled=false',
      );
    if (kind === "cache-only" || kind === "marketplace-only")
      await write(join(c.codex, "config.toml"), "");
    if (kind === "marketplace-only")
      await write(
        join(c.codex, "plugins/marketplaces/x/skills/secret/SKILL.md"),
        skillText("secret"),
      );
    if (kind === "missing")
      await write(
        join(c.codex, "config.toml"),
        '[plugins."missing@market"]\nenabled=true',
      );
    if (kind === "ambiguous")
      await mkdir(join(c.codex, "plugins/cache/market/foo/2.0.0"));
    if (kind === "unsafe")
      await write(
        join(c.pluginRoot, ".codex-plugin/plugin.json"),
        '{"name":"foo","skills":"./../../escape"}',
      );
    if (kind === "symlink") {
      await symlink(join(c.pluginRoot, "skills"), join(c.pluginRoot, "alias"));
      await write(
        join(c.pluginRoot, ".codex-plugin/plugin.json"),
        '{"name":"foo","skills":"./alias"}',
      );
    }
    const result = await adapter().discover(c);
    expect(
      result.skills.some((s) => s.name === "foo:review" || s.name === "secret"),
    ).toBe(false);
    expect(result.skills.find((s) => s.name === "built-in")?.enabled).toBe(
      true,
    );
  });
  it("uses documented local preference, never maximum opaque version or mtime", async () => {
    const c = await fixture();
    const root = join(c.codex, "plugins/cache/market/foo/local");
    await write(join(root, ".codex-plugin/plugin.json"), '{"name":"foo"}');
    await write(join(root, "skills/a/SKILL.md"), skillText("local"));
    const result = await adapter().discover(c);
    expect(
      result.skills
        .filter((s) => codexMetadata(s)?.origin === "plugin")
        .map((s) => s.name),
    ).toEqual(["foo:local"]);
  });
  it.each([
    "broken-config",
    "broken-skill-policy",
    "implicit-false",
    "name-disable",
    "instructions-disabled",
    "profile",
  ])("excludes uncertain or prohibited routing: %s", async (kind) => {
    const c = await fixture();
    const texts: Record<string, string> = {
      "broken-config": "broken=[",
      "name-disable": "[[skills.config]]\nname='user-skill'\nenabled=false",
      "instructions-disabled": "[skills]\ninclude_instructions=false",
      profile: "profile='unobserved'",
    };
    if (texts[kind])
      await write(join(c.codex, "config.toml"), texts[kind] ?? "");
    else
      await write(
        join(c.codex, "skills/user/agents/openai.yaml"),
        kind === "implicit-false"
          ? "policy:\n  allow_implicit_invocation: false"
          : "policy: [broken",
      );
    const result = await adapter().discover(c);
    expect(result.skills.find((s) => s.name === "user-skill")?.enabled).toBe(
      false,
    );
  });
  it("ignores untrusted project plugins, honors trusted plugin false without applying project skill selectors", async () => {
    const c = await fixture();
    await write(
      join(c.repo, ".codex/config.toml"),
      '[plugins."foo@market"]\nenabled=false\n[[skills.config]]\nname="user-skill"\nenabled=false',
    );
    expect(
      (await adapter().discover(c)).skills.find((s) => s.name === "foo:review")
        ?.enabled,
    ).toBe(true);
    await write(
      join(c.codex, "config.toml"),
      `[projects.${JSON.stringify(c.repo)}]\ntrust_level="trusted"\n[plugins."foo@market"]\nenabled=true`,
    );
    const r = await adapter().discover(c);
    expect(r.skills.some((s) => s.name === "foo:review")).toBe(false);
    expect(r.skills.find((s) => s.name === "user-skill")?.enabled).toBe(true);
  });
  it("keeps fingerprint independent of home/cache movement and sensitive config contents", async () => {
    const a = await fixture(),
      b = await fixture();
    const x = await adapter().discover(a),
      y = await adapter().discover(b);
    expect(catalogFingerprint(x.skills)).toBe(catalogFingerprint(y.skills));
    expect(x.skills.find((s) => s.name === "foo:review")?.id).not.toBe(
      y.skills.find((s) => s.name === "foo:review")?.id,
    );
    await write(
      join(b.codex, "skills/user/SKILL.md"),
      skillText("user-skill", "Changed"),
    );
    expect(catalogFingerprint((await adapter().discover(b)).skills)).not.toBe(
      catalogFingerprint(x.skills),
    );
  });
});

it("does not let cache aliases bypass disabled plugin state, and deduplicates active aliases", async () => {
  const c = await fixture();
  await symlink(
    join(c.pluginRoot, "skills/review"),
    join(c.codex, "skills/alias"),
  );
  const active = await adapter().discover(c);
  expect(
    active.skills.filter((s) => s.path.endsWith("skills/review/SKILL.md")),
  ).toHaveLength(1);
  expect(active.skills.find((s) => s.name === "foo:review")?.enabled).toBe(
    true,
  );
  await write(
    join(c.codex, "config.toml"),
    '[plugins."foo@market"]\nenabled=false',
  );
  expect(
    (await adapter().discover(c)).skills
      .filter((s) => s.path.endsWith("skills/review/SKILL.md"))
      .every((s) => !s.enabled),
  ).toBe(true);
});
it("keeps malformed plugin policy from disabling healthy local sources", async () => {
  const c = await fixture();
  await write(
    join(c.codex, "config.toml"),
    '[plugins."foo@market"]\nenabled="bad"',
  );
  const r = await adapter().discover(c);
  expect(r.skills.some((s) => s.name === "foo:review")).toBe(false);
  expect(r.skills.find((s) => s.name === "user-skill")?.enabled).toBe(true);
});
it("loads trusted legacy project skills and ignores explicitly untrusted child settings", async () => {
  const c = await fixture();
  await write(
    join(c.repo, ".codex/skills/legacy/SKILL.md"),
    skillText("legacy"),
  );
  await write(
    join(c.cwd, ".codex/config.toml"),
    '[plugins."foo@market"]\nenabled=false',
  );
  await write(
    join(c.codex, "config.toml"),
    `[projects.${JSON.stringify(c.repo)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(c.cwd)}]\ntrust_level="untrusted"\n[plugins."foo@market"]\nenabled=true`,
  );
  const r = await adapter().discover(c);
  expect(r.skills.some((s) => s.name === "legacy")).toBe(true);
  expect(r.skills.some((s) => s.name === "foo:review")).toBe(true);
});
it.each(["../escape", "./../../escape", "/outside"])(
  "rejects manifest component traversal %s",
  async (skills) => {
    const c = await fixture();
    await write(
      join(c.pluginRoot, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: "foo", skills }),
    );
    expect(
      (await adapter().discover(c)).skills.some((s) => s.name === "foo:review"),
    ).toBe(false);
  },
);
it("supports portable direct-child skills and does not promote unsupported extension state", async () => {
  const c = await fixture();
  await write(
    join(c.pluginRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "portable",
    }),
  );
  await write(
    join(c.pluginRoot, "skills/nested/deeper/SKILL.md"),
    skillText("deep"),
  );
  let r = await adapter().discover(c);
  expect(r.skills.some((s) => s.name === "portable:review")).toBe(true);
  expect(r.skills.some((s) => s.name === "portable:deep")).toBe(false);
  await write(
    join(c.pluginRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "portable",
      extensions: { future: {} },
    }),
  );
  r = await adapter().discover(c);
  expect(r.skills.some((s) => s.name === "portable:review")).toBe(false);
  expect(
    r.diagnostics.some((d) => d.code === "unsupported_codex_plugin_extension"),
  ).toBe(true);
});
it("applies file-managed marketplace restrictions conservatively without losing local catalog", async () => {
  const c = await fixture(),
    admin = join(c.root, "admin/skills");
  await mkdir(admin, { recursive: true });
  await write(
    join(admin, "../requirements.toml"),
    "[marketplaces]\nrestrict_to_allowed_sources=true",
  );
  const r = await new CodexDiscoveryAdapter({ adminRoots: [admin] }).discover(
    c,
  );
  expect(r.skills.some((s) => s.name === "foo:review")).toBe(false);
  expect(r.skills.find((s) => s.name === "user-skill")?.enabled).toBe(true);
});

it.each(["directory", "symlink", "malformed"])(
  "does not fall back past an invalid portable manifest: %s",
  async (kind) => {
    const c = await fixture();
    const path = join(c.pluginRoot, "plugin.json");
    if (kind === "directory") await mkdir(path);
    else if (kind === "symlink")
      await symlink(join(c.pluginRoot, ".codex-plugin/plugin.json"), path);
    else await write(path, "{");
    const result = await adapter().discover(c);
    expect(
      result.skills.some((s) => codexMetadata(s)?.origin === "plugin"),
    ).toBe(false);
    expect(result.skills.find((s) => s.name === "user-skill")?.enabled).toBe(
      true,
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
  },
);
it("preserves lower plugin false when a trusted higher entry omits enabled", async () => {
  const c = await fixture();
  await write(
    join(c.codex, "config.toml"),
    `[projects.${JSON.stringify(c.repo)}]\ntrust_level="trusted"\n[plugins."foo@market"]\nenabled=false`,
  );
  const path = join(c.repo, ".codex/config.toml");
  await write(path, '[plugins."foo@market"]');
  expect(
    (await adapter().discover(c)).skills.some((s) => s.name === "foo:review"),
  ).toBe(false);
  await write(path, '[plugins."foo@market"]\nenabled=true');
  expect(
    (await adapter().discover(c)).skills.find((s) => s.name === "foo:review")
      ?.enabled,
  ).toBe(true);
});
it("excludes plugins when the authoritative features table is malformed", async () => {
  const c = await fixture();
  await write(
    join(c.codex, "config.toml"),
    'features="PRIVATE_INVALID"\n[plugins."foo@market"]\nenabled=true',
  );
  const result = await adapter().discover(c);
  expect(result.skills.some((s) => codexMetadata(s)?.origin === "plugin")).toBe(
    false,
  );
  expect(result.skills.find((s) => s.name === "user-skill")?.enabled).toBe(
    true,
  );
  expect(
    result.diagnostics.some((d) => d.code === "invalid_codex_plugin_policy"),
  ).toBe(true);
  expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE_INVALID");
});

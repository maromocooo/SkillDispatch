import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeDiscoveryAdapter } from "../../src/discovery/claude.js";
import { claudeMetadata } from "../../src/discovery/claude-origin.js";
import { catalogFingerprint } from "../../src/telemetry/fingerprint.js";
import { skillText, workspace, write } from "../helpers.js";

async function fixture() {
  const ctx = await workspace();
  const config = join(ctx.root, "config");
  const root = join(config, "plugins/cache/market/foo/v1");
  await write(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "foo" }),
  );
  await write(join(root, "skills/review/SKILL.md"), skillText("review"));
  const registry = (path = root, version = "v1") =>
    write(
      join(config, "plugins/installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "foo@market": [{ scope: "user", installPath: path, version }],
        },
      }),
    );
  await registry();
  const read = async () =>
    (
      await new ClaudeDiscoveryAdapter({ managedDirectory: null }).discover({
        ...ctx,
        env: { CLAUDE_CONFIG_DIR: config },
      })
    ).skills.filter((s) => claudeMetadata(s)?.origin === "plugin");
  return { ...ctx, config, root, registry, read };
}
describe("native catalog fingerprint", () => {
  it("ignores physical cache relocation and input ordering", async () => {
    const f = await fixture();
    const first = await f.read();
    const moved = join(f.root, "../../other-copy");
    await rename(f.root, moved);
    await f.registry(moved);
    const second = await f.read();
    expect(second).toHaveLength(1);
    expect(catalogFingerprint(second)).toBe(catalogFingerprint(first));
    expect(catalogFingerprint([...second, ...first].reverse())).toBe(
      catalogFingerprint([...first, ...second]),
    );
  });
  it("changes when registry version changes even with identical content", async () => {
    const f = await fixture();
    const first = catalogFingerprint(await f.read());
    await f.registry(f.root, "v2");
    expect(catalogFingerprint(await f.read())).not.toBe(first);
  });
  it("changes when content or invocation eligibility changes", async () => {
    const f = await fixture();
    const first = catalogFingerprint(await f.read());
    await write(
      join(f.root, "skills/review/SKILL.md"),
      skillText("review", "Updated content."),
    );
    const second = await f.read();
    expect(catalogFingerprint(second)).not.toBe(first);
    expect(
      catalogFingerprint(second.map((s) => ({ ...s, enabled: false }))),
    ).not.toBe(catalogFingerprint(second));
  });
  it("changes when native namespace changes without adding paths", async () => {
    const f = await fixture();
    const first = await f.read();
    await write(
      join(f.root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "other" }),
    );
    const second = await f.read();
    expect(first[0]?.contentHash).toBe(second[0]?.contentHash);
    expect(catalogFingerprint(second)).not.toBe(catalogFingerprint(first));
    expect(second[0]?.metadata.catalogIdentity).toMatch(/^[a-f0-9]{64}$/);
  });
  it("retains multiplicity and ignores arbitrary metadata", async () => {
    const f = await fixture();
    const skills = await f.read();
    expect(catalogFingerprint([...skills, ...skills])).not.toBe(
      catalogFingerprint(skills),
    );
    expect(
      catalogFingerprint(
        skills.map((s) => ({
          ...s,
          metadata: { ...s.metadata, privatePath: "/PRIVATE/ACCOUNT" },
        })),
      ),
    ).toBe(catalogFingerprint(skills));
  });
});

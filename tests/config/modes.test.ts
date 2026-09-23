import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { workspace, write } from "../helpers.js";

it("defaults both hosts to shadow", async () => {
  const ctx = await workspace();
  expect(
    (await loadConfig({ ...ctx, mode: "hook" })).config.hook.modes,
  ).toEqual({ claude: "shadow", codex: "shadow" });
});
it("only explicit user config enables Claude advisory", async () => {
  const ctx = await workspace();
  await write(
    join(ctx.home, ".config/skilldispatch/config.yaml"),
    "hook:\n  modes: {claude: advisory}\n",
  );
  expect(
    (await loadConfig({ ...ctx, mode: "hook" })).config.hook.modes,
  ).toEqual({ claude: "advisory", codex: "shadow" });
});
it.each([
  "{claude: enforce}",
  "{codex: enforce}",
  "{claude: true}",
  "advisory",
  "{claude: null}",
])("rejects invalid user modes %s", async (modes) => {
  const ctx = await workspace();
  await write(
    join(ctx.home, ".config/skilldispatch/config.yaml"),
    `hook:\n  modes: ${modes}\n`,
  );
  await expect(loadConfig({ ...ctx, mode: "hook" })).rejects.toThrow(
    "Invalid SkillDispatch config",
  );
});
it.each([false, true])(
  "project cannot enable advisory with trust=%s",
  async (trust) => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      `hook:\n  trustProjectConfig: ${trust}\n`,
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "hook:\n  modes: {claude: advisory}\n",
    );
    const result = await loadConfig({ ...ctx, mode: "hook" });
    expect(result.config.hook.modes.claude).toBe("shadow");
    if (trust)
      expect(result.diagnostics.map((d) => d.code)).toContain(
        "ignored_config_setting",
      );
  },
);
it.each(["cli", "hook", "user"] as const)(
  "user mode wins over project/explicit mode for %s",
  async (mode) => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".config/skilldispatch/config.yaml"),
      "hook:\n  trustProjectConfig: true\n  modes: {claude: advisory}\n",
    );
    await write(
      join(ctx.cwd, ".skilldispatch.yaml"),
      "hook:\n  modes: {claude: shadow}\n",
    );
    const explicit = join(ctx.root, "explicit.yaml");
    await write(explicit, "hook:\n  modes: {claude: shadow}\n");
    expect(
      (await loadConfig({ ...ctx, mode, configPath: explicit })).config.hook
        .modes.claude,
    ).toBe("advisory");
  },
);
it("user-only loading never parses even a trusted project config", async () => {
  const ctx = await workspace();
  await write(
    join(ctx.home, ".config/skilldispatch/config.yaml"),
    "hook: {trustProjectConfig: true}\n",
  );
  await write(join(ctx.cwd, ".skilldispatch.yaml"), "invalid: [");
  expect(
    (await loadConfig({ ...ctx, mode: "user" })).config.hook.modes.claude,
  ).toBe("shadow");
});

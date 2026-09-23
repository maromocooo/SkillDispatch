import { chmod, link, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { shadowCommand } from "../../src/registration/command.js";
import { HookDocument, planDocument } from "../../src/registration/document.js";
import { inspectRegistration } from "../../src/registration/inspect.js";
import type { CliExecution } from "../../src/registration/types.js";
import { workspace, write } from "../helpers.js";

const execution: CliExecution = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/opt/skilldispatch/dist/cli/index.js",
  platform: "linux",
};

describe.each(["codex", "claude"] as const)(
  "%s registration inspection",
  (host) => {
    const target = (home: string) =>
      join(
        home,
        host === "codex" ? ".codex/hooks.json" : ".claude/settings.json",
      );
    it("reports absence and installed async/sync, never leaking unrelated settings", async () => {
      const ctx = await workspace();
      const absent = await inspectRegistration(host, ctx, execution);
      expect(absent.registration).toBe("not-installed");
      expect(absent.command).toBeNull();
      const command = shadowCommand(host, execution);
      for (const sync of [false, true]) {
        const doc = new HookDocument(
          '{"env":{"TOKEN":"PRIVATE_CONFIG"},"hooks":{"Stop":[{"hooks":[{"command":"PRIVATE_OTHER_COMMAND"}]}]}}',
        );
        const planned = planDocument(doc, command, "install", sync);
        await write(target(ctx.home), planned.text);
        const result = await inspectRegistration(host, ctx, execution);
        expect(result).toMatchObject({
          registration: "installed",
          execution: sync ? "sync" : "async",
          registrations: 1,
          command,
        });
        expect(JSON.stringify(result)).not.toMatch(
          /PRIVATE_CONFIG|PRIVATE_OTHER_COMMAND/,
        );
      }
    });
    it.each([
      "[]",
      "{invalid PRIVATE_SECRET",
      '{"hooks":[]}',
      '{"hooks":{"UserPromptSubmit":{}}}',
      '{"hooks":{"UserPromptSubmit":[{}]}}',
      '{"x":1,"x":2}',
    ])("rejects malformed structure %s safely", async (text) => {
      const ctx = await workspace();
      await write(target(ctx.home), text);
      const result = await inspectRegistration(host, ctx, execution);
      expect(result.registration).toBe("conflict");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SECRET");
    });
    it.each(["symlink", "hardlink", "unsafe"])(
      "rejects %s destination",
      async (kind) => {
        const ctx = await workspace();
        const path = target(ctx.home);
        const other = join(ctx.root, "other");
        await write(other, "{}");
        await mkdir(dirname(path), { recursive: true });
        if (kind === "symlink") await symlink(other, path);
        if (kind === "hardlink") await link(other, path);
        if (kind === "unsafe") {
          await write(path, "{}");
          await chmod(path, 0o666);
        }
        if (process.platform !== "win32" || kind !== "unsafe")
          expect(
            (await inspectRegistration(host, ctx, execution)).registration,
          ).toBe("conflict");
      },
    );
    it("detects duplicate owned registrations and manual legacy commands", async () => {
      const ctx = await workspace();
      const command = shadowCommand(host, execution);
      await write(
        target(ctx.home),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", ...command },
                  { type: "command", ...command },
                ],
              },
            ],
          },
        }),
      );
      expect(
        (await inspectRegistration(host, ctx, execution)).issues,
      ).toContain("duplicate_registration");
      await write(
        target(ctx.home),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", command: `skilldispatch hook ${host}` },
                ],
              },
            ],
          },
        }),
      );
      const result = await inspectRegistration(host, ctx, execution);
      expect(result.registration).toBe("conflict");
      expect(result.command).toBeNull();
    });
    it("refuses custom host roots instead of editing a project override", async () => {
      const ctx = await workspace();
      const env = {
        [host === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: ctx.repo,
      };
      const status = await inspectRegistration(
        host,
        { ...ctx, env },
        execution,
      );
      if (host === "claude")
        expect(status.issues).toContain(
          "custom_host_directory_manual_action_required",
        );
      else expect(status.registration).toBe("not-installed");
    });
  },
);
describe("Codex inline hook conflicts", () => {
  it.each([
    "[hooks]\n",
    "hooks = {}",
    "[[hooks.UserPromptSubmit]]\n",
    "hooks.UserPromptSubmit = []",
  ])("detects TOML hooks with %s", async (toml) => {
    const ctx = await workspace();
    await write(join(ctx.home, ".codex/config.toml"), toml);
    expect((await inspectRegistration("codex", ctx, execution)).issues).toEqual(
      ["codex_inline_hooks_manual_action_required"],
    );
  });
  it("does not confuse comments/quoted strings/nested keys with top-level hooks", async () => {
    const ctx = await workspace();
    await write(
      join(ctx.home, ".codex/config.toml"),
      '# [hooks]\nmodel = "hooks"\n[other.hooks]\n',
    );
    expect(
      (await inspectRegistration("codex", ctx, execution)).registration,
    ).toBe("not-installed");
  });
  it("malformed TOML refuses safely without raw content", async () => {
    const ctx = await workspace();
    await write(join(ctx.home, ".codex/config.toml"), "[SECRET");
    const result = await inspectRegistration("codex", ctx, execution);
    expect(result.issues).toEqual(["malformed_codex_toml"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

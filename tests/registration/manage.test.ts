import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { atomicRegistrationWrite } from "../../src/registration/atomic.js";
import {
  resolveExecution,
  shadowCommand,
} from "../../src/registration/command.js";
import { HookDocument, ownsHandler } from "../../src/registration/document.js";
import { readHostFile } from "../../src/registration/files.js";
import { inspectRegistration } from "../../src/registration/inspect.js";
import { manageRegistration } from "../../src/registration/manage.js";
import type { Host } from "../../src/registration/types.js";
import { workspace, write } from "../helpers.js";

async function fixture(host: Host) {
  const ctx = await workspace();
  const cliPath = join(ctx.root, "installed skilldispatch", "cli.js");
  await write(cliPath, "// isolated executable fixture\n");
  const execution = await resolveExecution({
    nodePath: process.execPath,
    cliPath,
    platform: process.platform,
  });
  const path = join(
    ctx.home,
    host === "codex" ? ".codex/hooks.json" : ".claude/settings.json",
  );
  const manage = (action: "install" | "uninstall", options = {}) =>
    manageRegistration(host, action, ctx, execution, options);
  return { ...ctx, execution, path, manage };
}

describe.each(["codex", "claude"] as const)(
  "%s registration mutation",
  (host) => {
    it("installs async in a new private file, is idempotent, updates sync, uninstalls and reinstalls", async () => {
      const ctx = await fixture(host);
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("NO_NETWORK"));
      try {
        expect((await ctx.manage("install")).action).toBe("install");
        const first = await readFile(ctx.path, "utf8");
        expect(new HookDocument(first).handlers()[0]?.value).toEqual({
          type: "command",
          ...shadowCommand(host, ctx.execution),
          async: true,
          timeout: 5,
        });
        if (process.platform !== "win32")
          expect((await lstat(ctx.path)).mode & 0o777).toBe(0o600);
        expect((await ctx.manage("install")).action).toBe("already-installed");
        expect(await readFile(ctx.path, "utf8")).toBe(first);
        await expect(
          lstat(`${ctx.path}.skilldispatch.bak`),
        ).rejects.toMatchObject({ code: "ENOENT" });
        if (host === "codex")
          await expect(ctx.manage("install", { sync: true })).rejects.toThrow(
            "codex_sync_not_supported",
          );
        else
          expect((await ctx.manage("install", { sync: true })).action).toBe(
            "update",
          );
        expect(
          (await inspectRegistration(host, ctx, ctx.execution)).execution,
        ).toBe(host === "claude" ? "sync" : "async");
        expect((await ctx.manage("uninstall")).action).toBe("uninstall");
        expect(
          new HookDocument(await readFile(ctx.path, "utf8")).handlers(),
        ).toHaveLength(0);
        const removed = await readFile(ctx.path, "utf8");
        expect((await ctx.manage("uninstall")).action).toBe("not-installed");
        expect(await readFile(ctx.path, "utf8")).toBe(removed);
        expect((await ctx.manage("install")).action).toBe("install");
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    });
    it("preserves unrelated settings/hooks, numeric lexemes, permissions and first backup", async () => {
      const ctx = await fixture(host);
      const text =
        '{\n  "large": 900719925474099312345,\n  "models":{"secret":"PRIVATE_CONFIG"},\n  "permissions": ["allow"],\n  "plugins":{},"mcpServers":{},"env":{"SECRET":"PRIVATE_ENV"},\n  "hooks":{"Stop":[{"hooks":[{"type":"command","command":"other stop"}]}],"UserPromptSubmit":[{"matcher":"", "hooks":[{"type":"command","command":"other prompt"}]}]}\n}\n';
      await write(ctx.path, text);
      await chmod(ctx.path, 0o640);
      await ctx.manage("install");
      const installed = await readFile(ctx.path, "utf8");
      expect(installed).toContain('"large": 900719925474099312345');
      const before = JSON.parse(text),
        after = JSON.parse(installed);
      expect(after.hooks.UserPromptSubmit[0]).toEqual(
        before.hooks.UserPromptSubmit[0],
      );
      after.hooks.UserPromptSubmit.pop();
      if (host === "claude")
        for (const event of [
          "PreToolUse",
          "PostToolUse",
          "PostToolUseFailure",
        ]) {
          expect(after.hooks[event]).toHaveLength(1);
          expect(after.hooks[event][0].matcher).toBe("Skill");
          delete after.hooks[event];
        }
      expect(after).toEqual(before);
      expect(await readFile(`${ctx.path}.skilldispatch.bak`, "utf8")).toBe(
        text,
      );
      if (process.platform !== "win32") {
        expect((await lstat(ctx.path)).mode & 0o777).toBe(0o640);
        expect(
          (await lstat(`${ctx.path}.skilldispatch.bak`)).mode & 0o777,
        ).toBe(0o600);
      }
      await ctx.manage("install", { sync: host === "claude" });
      await ctx.manage("uninstall");
      expect(JSON.parse(await readFile(ctx.path, "utf8"))).toEqual(before);
      expect(await readFile(`${ctx.path}.skilldispatch.bak`, "utf8")).toBe(
        text,
      );
    });
    it("removes only its exact handler inside a shared matcher group", async () => {
      const ctx = await fixture(host);
      const other = { type: "command", command: "other" };
      await write(
        ctx.path,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                matcher: "",
                hooks: [
                  other,
                  { type: "command", ...shadowCommand(host, ctx.execution) },
                  other,
                ],
              },
            ],
          },
        }),
      );
      await ctx.manage("uninstall");
      expect(
        JSON.parse(await readFile(ctx.path, "utf8")).hooks.UserPromptSubmit,
      ).toEqual([{ matcher: "", hooks: [other, other] }]);
    });
    it("absent uninstall and dry-run do not create directories, files or backups", async () => {
      const ctx = await fixture(host);
      await rm(dirname(ctx.path), { recursive: true, force: true });
      expect((await ctx.manage("uninstall")).changed).toBe(false);
      expect(await ctx.manage("install", { dryRun: true })).toMatchObject({
        action: "install",
        changed: false,
        dryRun: true,
      });
      await expect(lstat(dirname(ctx.path))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await ctx.manage("install");
      const original = await readFile(ctx.path, "utf8");
      expect(await ctx.manage("uninstall", { dryRun: true })).toMatchObject({
        action: "uninstall",
        changed: false,
      });
      expect(await readFile(ctx.path, "utf8")).toBe(original);
      await expect(
        lstat(`${ctx.path}.skilldispatch.bak`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each([
      "{PRIVATE_CONFIG",
      "[]",
      '{"hooks":null}',
      '{"hooks":{"UserPromptSubmit":[{}]}}',
    ])("refuses malformed input unchanged: %s", async (text) => {
      const ctx = await fixture(host);
      await write(ctx.path, text);
      for (const action of ["install", "uninstall"] as const)
        await expect(ctx.manage(action)).rejects.toThrow(/malformed/);
      expect(await readFile(ctx.path, "utf8")).toBe(text);
      await expect(
        lstat(`${ctx.path}.skilldispatch.bak`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each(["symlink", "hardlink", "directory"])(
      "refuses %s config without touching target",
      async (kind) => {
        const ctx = await fixture(host);
        const privatePath = join(ctx.root, "private");
        await write(privatePath, "PRIVATE_EXISTING_FILE");
        await mkdir(dirname(ctx.path), { recursive: true });
        if (kind === "symlink") await symlink(privatePath, ctx.path);
        if (kind === "hardlink") await link(privatePath, ctx.path);
        if (kind === "directory") await mkdir(ctx.path);
        for (const action of ["install", "uninstall"] as const)
          await expect(ctx.manage(action)).rejects.toThrow(/unsafe/);
        expect(await readFile(privatePath, "utf8")).toBe(
          "PRIVATE_EXISTING_FILE",
        );
      },
    );
    it("refuses a symlink host directory", async () => {
      const ctx = await fixture(host);
      await rm(dirname(ctx.path), { recursive: true, force: true });
      await symlink(ctx.repo, dirname(ctx.path));
      await expect(ctx.manage("install")).rejects.toThrow(
        /unsafe_config_directory/,
      );
      await expect(
        lstat(
          join(ctx.repo, host === "codex" ? "hooks.json" : "settings.json"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.each(["symlink", "hardlink", "unsafe"])(
      "refuses unsafe %s backup without changing original",
      async (kind) => {
        const ctx = await fixture(host);
        await write(ctx.path, "{}");
        const backup = `${ctx.path}.skilldispatch.bak`,
          target = join(ctx.root, "private-backup");
        await write(target, "PRIVATE_BACKUP");
        if (kind === "symlink") await symlink(target, backup);
        if (kind === "hardlink") await link(target, backup);
        if (kind === "unsafe") {
          await write(backup, "BACKUP");
          await chmod(backup, 0o644);
        }
        if (kind !== "unsafe" || process.platform !== "win32") {
          await expect(ctx.manage("install")).rejects.toThrow(/unsafe/);
          expect(await readFile(ctx.path, "utf8")).toBe("{}");
        }
        expect(await readFile(target, "utf8")).toBe("PRIVATE_BACKUP");
      },
    );
    it("reuses an existing private backup without overwriting it", async () => {
      const ctx = await fixture(host);
      await write(ctx.path, "{}");
      await write(`${ctx.path}.skilldispatch.bak`, "ORIGINAL_FIRST_BACKUP");
      await chmod(`${ctx.path}.skilldispatch.bak`, 0o600);
      await ctx.manage("install");
      expect(await readFile(`${ctx.path}.skilldispatch.bak`, "utf8")).toBe(
        "ORIGINAL_FIRST_BACKUP",
      );
    });
    it("failed atomic rename leaves original intact and cleans temporary/lock files", async () => {
      const ctx = await fixture(host);
      await write(ctx.path, '{"original":true}');
      const writer: typeof atomicRegistrationWrite = (
        path,
        expected,
        text,
        recheck,
      ) =>
        atomicRegistrationWrite(path, expected, text, recheck, async () => {
          throw new Error("PRIVATE_RAW_ERROR");
        });
      await expect(
        manageRegistration(host, "install", ctx, ctx.execution, {}, writer),
      ).rejects.toThrow("atomic_write_failed");
      expect(await readFile(ctx.path, "utf8")).toBe('{"original":true}');
      expect(
        (await readdir(dirname(ctx.path))).some(
          (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
        ),
      ).toBe(false);
    });
    it("refuses stale lock and does not steal it", async () => {
      const ctx = await fixture(host);
      await write(`${ctx.path}.skilldispatch.lock`, "LOCK");
      await expect(ctx.manage("install")).rejects.toThrow(
        "registration_locked",
      );
      expect(await readFile(`${ctx.path}.skilldispatch.lock`, "utf8")).toBe(
        "LOCK",
      );
    });
    it("does not touch project config despite project cwd", async () => {
      const ctx = await fixture(host);
      const paths = [
        join(ctx.repo, ".codex/hooks.json"),
        join(ctx.repo, ".codex/config.toml"),
        join(ctx.repo, ".claude/settings.json"),
      ];
      for (const path of paths) await write(path, "PROJECT_SENTINEL");
      await ctx.manage("install");
      await ctx.manage("uninstall");
      for (const path of paths)
        expect(await readFile(path, "utf8")).toBe("PROJECT_SENTINEL");
    });
    it("does not claim an altered command or different installation", async () => {
      const ctx = await fixture(host);
      const command = {
        type: "command",
        command: `skilldispatch hook ${host}`,
      };
      await write(
        ctx.path,
        JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [command] }] } }),
      );
      const before = await readFile(ctx.path, "utf8");
      await expect(ctx.manage("install")).rejects.toThrow(
        "other_skilldispatch_command_manual_action_required",
      );
      expect((await ctx.manage("uninstall")).changed).toBe(false);
      expect(await readFile(ctx.path, "utf8")).toBe(before);
      expect(ownsHandler(command, shadowCommand(host, ctx.execution))).toBe(
        false,
      );
    });
  },
);

it("Codex inline hooks refuse installation without rewriting TOML or JSON; uninstall remains targeted", async () => {
  const ctx = await fixture("codex");
  await write(join(ctx.home, ".codex/config.toml"), 'model = "test"\n');
  await ctx.manage("install");
  const before = await readFile(ctx.path, "utf8");
  await write(
    join(ctx.home, ".codex/config.toml"),
    '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "PRIVATE_TOML"\n',
  );
  await expect(ctx.manage("install")).rejects.toThrow(
    "codex_inline_hooks_manual_action_required",
  );
  expect(await readFile(ctx.path, "utf8")).toBe(before);
  await ctx.manage("uninstall");
  expect(await readFile(join(ctx.home, ".codex/config.toml"), "utf8")).toBe(
    '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "PRIVATE_TOML"\n',
  );
});
it("external config edits abort atomic replacement", async () => {
  const ctx = await fixture("claude");
  await write(ctx.path, "{}");
  const expected = await readHostFile(ctx.path);
  await write(ctx.path, '{"external":true}');
  await expect(
    atomicRegistrationWrite(ctx.path, expected, "{}", async () => {}),
  ).rejects.toThrow("config_changed");
  expect(await readFile(ctx.path, "utf8")).toBe('{"external":true}');
});

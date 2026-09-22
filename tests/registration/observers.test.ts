import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invocationPath } from "../../src/observability/invocation-storage.js";
import { invocationEvents } from "../../src/observability/invocation-types.js";
import { runDoctor } from "../../src/ops/doctor.js";
import {
  resolveExecution,
  shadowCommand,
  skillObserverCommand,
} from "../../src/registration/command.js";
import { inspectRegistration } from "../../src/registration/inspect.js";
import { manageRegistration } from "../../src/registration/manage.js";
import { workspace, write } from "../helpers.js";

async function fixture() {
  const w = await workspace();
  const cliPath = join(w.root, "skilldispatch/cli.js");
  await write(cliPath, "// fixture");
  const execution = await resolveExecution({
    nodePath: process.execPath,
    cliPath,
    platform: process.platform,
  });
  const path = join(w.home, ".claude/settings.json");
  return {
    ...w,
    execution,
    path,
    manage: (action: "install" | "uninstall", options = {}) =>
      manageRegistration("claude", action, w, execution, options),
  };
}
describe("Claude observer registration set", () => {
  it("doctor separates observer readiness and refuses unsafe storage without mutation", async () => {
    const w = await fixture();
    await write(
      join(w.home, ".config/skilldispatch/config.yaml"),
      "router: {provider: mock}\n",
    );
    const check = async () =>
      (await runDoctor(w, w.execution)).checks.find(
        (c) => c.code === "skill_invocation_telemetry_ready",
      );
    expect(await check()).toMatchObject({ status: "WARN", value: false });
    await w.manage("install");
    expect(await check()).toMatchObject({ status: "PASS", value: true });
    await write(invocationPath(w), "PRIVATE_EXISTING");
    await chmod(invocationPath(w), 0o644);
    if (process.platform !== "win32")
      expect(await check()).toMatchObject({ status: "WARN", value: false });
    expect(await readFile(invocationPath(w), "utf8")).toBe("PRIVATE_EXISTING");
  });

  it.each(["shadow", "advisory"])(
    "upgrades %s routing without touching unrelated hooks",
    async (mode) => {
      const w = await fixture();
      await write(
        join(w.home, ".config/skilldispatch/config.yaml"),
        `hook:\n  modes:\n    claude: ${mode}\n`,
      );
      const old = {
        permissions: { deny: ["secret"] },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  ...shadowCommand("claude", w.execution),
                  async: mode === "shadow",
                  timeout: 5,
                },
              ],
            },
          ],
          PreToolUse: [
            {
              matcher: "Skill",
              hooks: [{ type: "command", command: "other" }],
            },
          ],
        },
      };
      await write(w.path, JSON.stringify(old));
      expect((await w.manage("install", { dryRun: true })).action).toBe(
        "update",
      );
      expect(JSON.parse(await readFile(w.path, "utf8"))).toEqual(old);
      await w.manage("install");
      const first = await readFile(w.path, "utf8");
      const installed = JSON.parse(first);
      expect(installed.hooks.UserPromptSubmit).toEqual(
        old.hooks.UserPromptSubmit,
      );
      expect(installed.hooks.PreToolUse[0]).toEqual(old.hooks.PreToolUse[0]);
      for (const event of invocationEvents)
        expect(installed.hooks[event].at(-1)).toEqual({
          matcher: "Skill",
          hooks: [
            {
              type: "command",
              ...skillObserverCommand(w.execution),
              async: true,
              timeout: 5,
            },
          ],
        });
      const status = await inspectRegistration("claude", w, w.execution);
      expect(status.skillObservers?.ready).toBe(true);
      expect((await w.manage("install")).action).toBe("already-installed");
      expect(await readFile(w.path, "utf8")).toBe(first);
      await w.manage("uninstall");
      const after = JSON.parse(await readFile(w.path, "utf8"));
      expect(after.hooks.PreToolUse).toEqual(old.hooks.PreToolUse);
      expect(after.permissions).toEqual(old.permissions);
      expect(after.hooks.PostToolUse).toBeUndefined();
    },
  );
  it.each(invocationEvents)(
    "detects missing %s and reconciles without duplicates",
    async (event) => {
      const w = await fixture();
      await w.manage("install");
      const raw = JSON.parse(await readFile(w.path, "utf8"));
      delete raw.hooks[event];
      await write(w.path, JSON.stringify(raw));
      expect(
        (await inspectRegistration("claude", w, w.execution)).issues,
      ).toContain("skill_invocation_telemetry_incomplete");
      await w.manage("install");
      expect(
        (await inspectRegistration("claude", w, w.execution)).skillObservers
          ?.ready,
      ).toBe(true);
    },
  );
  it.each([{ matcher: ".*" }, { asyncRewake: true }, { if: "Skill(review)" }])(
    "refuses modified observer %# atomically",
    async (extra) => {
      const w = await fixture();
      const { matcher, ...handler } = extra;
      const raw = {
        hooks: {
          PreToolUse: [
            {
              matcher: matcher ?? "Skill",
              hooks: [
                {
                  type: "command",
                  ...skillObserverCommand(w.execution),
                  async: true,
                  ...handler,
                },
              ],
            },
          ],
        },
      };
      await write(w.path, JSON.stringify(raw));
      const original = await readFile(w.path, "utf8");
      await expect(w.manage("install")).rejects.toThrow("modified_observer");
      expect(await readFile(w.path, "utf8")).toBe(original);
      expect(
        (await inspectRegistration("claude", w, w.execution)).skillObservers
          ?.ready,
      ).toBe(false);
    },
  );
  it("atomic failure never leaves half of registration set installed", async () => {
    const w = await fixture();
    await write(w.path, '{"env":{"PRIVATE":"value"}}');
    const original = await readFile(w.path, "utf8");
    await expect(
      manageRegistration("claude", "install", w, w.execution, {}, async () => {
        throw new Error("fixture");
      }),
    ).rejects.toThrow();
    expect(await readFile(w.path, "utf8")).toBe(original);
  });
});

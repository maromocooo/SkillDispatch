import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/ops/doctor.js";
import { resolveExecution } from "../../src/registration/command.js";
import { inspectRegistration } from "../../src/registration/inspect.js";
import { manageRegistration } from "../../src/registration/manage.js";
import { workspace, write } from "../helpers.js";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const ctx = await workspace();
  const path = join(ctx.home, ".claude/settings.json");
  const config = join(ctx.home, ".config/skilldispatch/config.yaml");
  const cliPath = join(ctx.root, "installed skilldispatch/cli.js");
  await write(cliPath, "// fixture");
  const execution = await resolveExecution({
    nodePath: process.execPath,
    cliPath,
    platform: process.platform,
  });
  const mode = (value: string) =>
    write(
      config,
      `router: {provider: mock}\nhook:\n  trustProjectConfig: true\n  modes: {claude: ${value}}\n`,
    );
  return {
    ...ctx,
    path,
    execution,
    config,
    mode,
    install: (dryRun = false) =>
      manageRegistration("claude", "install", ctx, execution, { dryRun }),
    inspect: () => inspectRegistration("claude", ctx, execution),
  };
}
describe("user-owned registration execution", () => {
  it("reconciles both directions, stays idempotent, preserves unrelated data and first backup", async () => {
    const f = await fixture();
    const original =
      '{"env":{"PRIVATE":"VALUE"},"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"unrelated"}]}]}}';
    await write(f.path, original);
    await f.mode("shadow");
    expect(await f.install()).toMatchObject({
      execution: "async",
      mode: "shadow",
    });
    const asyncFile = await readFile(f.path, "utf8");
    await f.mode("advisory");
    expect(await f.inspect()).toMatchObject({
      mode: "advisory",
      expectedExecution: "sync",
      execution: "async",
      registration: "installed",
      issues: ["hook_execution_mismatch"],
    });
    expect(await readFile(f.path, "utf8")).toBe(asyncFile);
    expect(await f.install(true)).toMatchObject({
      action: "update",
      execution: "sync",
      changed: false,
    });
    expect(await readFile(f.path, "utf8")).toBe(asyncFile);
    expect(await f.install()).toMatchObject({
      action: "update",
      execution: "sync",
    });
    expect(await f.install()).toMatchObject({
      action: "already-installed",
      changed: false,
    });
    expect(await f.inspect()).toMatchObject({
      mode: "advisory",
      execution: "sync",
      registrations: 1,
      issues: [],
    });
    const current = JSON.parse(await readFile(f.path, "utf8"));
    expect(current.env).toEqual({ PRIVATE: "VALUE" });
    expect(current.hooks.UserPromptSubmit[0]).toEqual(
      JSON.parse(original).hooks.UserPromptSubmit[0],
    );
    expect(current.hooks.UserPromptSubmit[1].hooks[0].timeout).toBe(5);
    await f.mode("shadow");
    expect((await f.inspect()).issues).toContain("hook_execution_mismatch");
    expect(await f.install()).toMatchObject({
      action: "update",
      execution: "async",
    });
    expect((await f.inspect()).issues).toEqual([]);
    expect(await readFile(`${f.path}.skilldispatch.bak`, "utf8")).toBe(
      original,
    );
    await manageRegistration("claude", "uninstall", f, f.execution);
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(
      JSON.parse(original),
    );
  });
  it("never uses even trusted project settings to choose execution", async () => {
    const f = await fixture();
    await f.mode("shadow");
    await write(
      join(f.cwd, ".skilldispatch.yaml"),
      "hook: {modes: {claude: advisory}}",
    );
    expect(await f.install()).toMatchObject({
      mode: "shadow",
      execution: "async",
    });
    await f.mode("advisory");
    await write(join(f.cwd, ".skilldispatch.yaml"), "malformed: [");
    expect(await f.install()).toMatchObject({
      mode: "advisory",
      execution: "sync",
    });
  });
  it("refuses invalid user config safely but still permits targeted uninstall", async () => {
    const f = await fixture();
    await f.install();
    const before = await readFile(f.path, "utf8");
    await f.mode("PRIVATE_INVALID");
    await expect(f.install()).rejects.toThrow("invalid_user_hook_mode_config");
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(JSON.stringify(await f.inspect())).not.toContain("PRIVATE_INVALID");
    expect((await f.inspect()).registration).toBe("conflict");
    expect(
      await manageRegistration("claude", "uninstall", f, f.execution),
    ).toMatchObject({ action: "uninstall" });
  });
  it("doctor distinguishes mode/execution/advisory readiness without mutations or network", async () => {
    const f = await fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("NO_NETWORK"));
    await f.mode("shadow");
    await f.install();
    await f.mode("advisory");
    const before = await readFile(f.path, "utf8");
    const check = async (code: string) =>
      (await runDoctor(f, f.execution)).checks.find((c) => c.code === code);
    expect(await check("hook_mode_claude")).toMatchObject({
      status: "PASS",
      value: "advisory",
    });
    expect(await check("hook_execution_claude")).toMatchObject({
      status: "WARN",
      value: "async",
    });
    expect(await check("advisory_ready")).toMatchObject({
      status: "WARN",
      value: false,
    });
    expect(await readFile(f.path, "utf8")).toBe(before);
    await f.install();
    expect(await check("advisory_ready")).toMatchObject({
      status: "PASS",
      value: true,
    });
    await write(
      f.config,
      "hook: {modes: {claude: advisory}}\nrouter: {provider: jev}",
    );
    expect(await check("routing_ready")).toMatchObject({
      status: "WARN",
      value: false,
    });
    expect(await check("advisory_ready")).toMatchObject({
      status: "WARN",
      value: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

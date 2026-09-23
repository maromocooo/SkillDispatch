import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveExecution } from "../../src/registration/command.js";
import {
  inspectRegistration,
  routingRegistrationIssues,
} from "../../src/registration/inspect.js";
import { manageRegistration } from "../../src/registration/manage.js";
import { workspace, write } from "../helpers.js";

async function fixture(contract = "0.156.1") {
  const c = await workspace();
  const codex = join(c.root, "custom-codex");
  const env = {
    ...c,
    env: { CODEX_HOME: codex, SKILLDISPATCH_DATA_DIR: join(c.root, "data") },
  };
  const cliPath = join(c.root, "candidate/cli.js");
  await write(cliPath, "// fixture");
  const execution = await resolveExecution({
    nodePath: process.execPath,
    cliPath,
    platform: process.platform,
  });
  await write(
    join(c.home, ".config/skilldispatch/config.yaml"),
    `hook: {codexContract: "${contract}", modes: {codex: advisory}}\nrouter: {provider: mock}`,
  );
  await manageRegistration("codex", "install", env, execution);
  return {
    env,
    execution,
    config: join(codex, "config.toml"),
    hooks: join(codex, "hooks.json"),
    inspect: () => inspectRegistration("codex", env, execution),
  };
}
const state = (path: string, event = "user_prompt_submit", extra = "") =>
  `[hooks.state]\n[hooks.state.${JSON.stringify(`${path}:${event}:0:0`)}]\ntrusted_hash = "sha256:synthetic"\n${extra}\n`;
function ready(result: Awaited<ReturnType<typeof inspectRegistration>>) {
  expect(result).toMatchObject({
    mode: "advisory",
    registration: "installed",
    execution: "sync",
    instructionObservers: { ready: true },
  });
  expect(result.instructionObservers?.events).toEqual([
    {
      event: "PreToolUse",
      matcher: "Bash",
      registration: "installed",
      execution: "async",
      registrations: 1,
    },
    {
      event: "PostToolUse",
      matcher: "Bash",
      registration: "installed",
      execution: "async",
      registrations: 1,
    },
  ]);
  expect(routingRegistrationIssues(result)).toEqual([]);
  expect(result.issues).toContain("codex_host_trust_not_verified");
}
it.each(["0.155.1", "0.156.1"])(
  "%s install -> user trust metadata -> registration remains ready without mutating state",
  async (contract) => {
    const f = await fixture(contract);
    ready(await f.inspect());
    const beforeHooks = await readFile(f.hooks, "utf8");
    const trusted = state(f.hooks);
    await write(f.config, trusted);
    ready(await f.inspect());
    expect(
      (await manageRegistration("codex", "install", f.env, f.execution))
        .changed,
    ).toBe(false);
    expect(await readFile(f.config, "utf8")).toBe(trusted);
    expect(await readFile(f.hooks, "utf8")).toBe(beforeHooks);
  },
);

it.each(["[hooks]\n", "hooks = {}\n", "[hooks.state]\n", "hooks.state = {}\n"])(
  "accepts empty metadata tables: %s",
  async (toml) => {
    const f = await fixture();
    await write(f.config, toml);
    ready(await f.inspect());
  },
);
it("allows enabled=true without claiming that a synthetic hash verifies host trust", async () => {
  const f = await fixture();
  await write(f.config, state(f.hooks, "user_prompt_submit", "enabled = true"));
  const result = await f.inspect();
  ready(result);
  expect(JSON.stringify(result)).not.toContain("sha256:synthetic");
});
it.each([
  ["user_prompt_submit", "codex_hook_disabled_by_host", true],
  ["pre_tool_use", "codex_pre_tool_use_disabled_by_host", false],
  ["post_tool_use", "codex_post_tool_use_disabled_by_host", false],
] as const)(
  "honors own %s disablement without overwriting host state",
  async (event, issue, routing) => {
    const f = await fixture();
    const disabled = state(f.hooks, event, "enabled = false");
    await write(f.config, disabled);
    const result = await f.inspect();
    expect(result.issues).toContain(issue);
    expect(result.issues).not.toContain(
      "codex_inline_hooks_manual_action_required",
    );
    expect(result.instructionObservers?.ready).toBe(routing);
    expect(routingRegistrationIssues(result)).toEqual(routing ? [issue] : []);
    expect(
      (await manageRegistration("codex", "install", f.env, f.execution))
        .changed,
    ).toBe(false);
    expect(await readFile(f.config, "utf8")).toBe(disabled);
  },
);
it.each([
  "other-path",
  "other-event",
  "other-index",
  "legacy-prefix",
  "unrelated-handler",
])("does not guess own state from %s", async (kind) => {
  const f = await fixture();
  let key = `${f.hooks}:user_prompt_submit:0:0`;
  if (kind === "other-path") key = `${f.hooks}.other:user_prompt_submit:0:0`;
  if (kind === "other-event") key = `${f.hooks}:stop:0:0`;
  if (kind === "other-index") key = `${f.hooks}:user_prompt_submit:9:9`;
  if (kind === "legacy-prefix") key = `file:${key}`;
  if (kind === "unrelated-handler") {
    const hooks = JSON.parse(await readFile(f.hooks, "utf8"));
    hooks.hooks.UserPromptSubmit[0].hooks.unshift({
      type: "command",
      command: "unrelated",
      async: false,
    });
    await write(f.hooks, JSON.stringify(hooks));
  }
  await write(
    f.config,
    `[hooks.state.${JSON.stringify(key)}]\nenabled=false\n`,
  );
  ready(await f.inspect());
});
it("uses original group and handler indices with upstream key trimming", async () => {
  const f = await fixture();
  const hooks = JSON.parse(await readFile(f.hooks, "utf8"));
  hooks.hooks.UserPromptSubmit.unshift({
    hooks: [{ type: "command", command: "unrelated-group" }],
  });
  hooks.hooks.UserPromptSubmit[1].hooks.unshift({
    type: "command",
    command: "unrelated-handler",
  });
  await write(f.hooks, JSON.stringify(hooks));
  await write(
    f.config,
    `[hooks.state.${JSON.stringify(` ${f.hooks}:user_prompt_submit:1:1 `)}]\nenabled=false\n`,
  );
  expect((await f.inspect()).issues).toContain("codex_hook_disabled_by_host");
});
// HookEventsToml at the pinned CLI sources. Presence of any event source stays manual.
it.each([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "FutureEvent",
])(
  "refuses actual or unknown inline %s even alongside state",
  async (event) => {
    const f = await fixture();
    const inline = `[[hooks.${event}]]\nmatcher="Bash"\n[[hooks.${event}.hooks]]\ntype="command"\ncommand="PRIVATE_COMMAND"\n`;
    for (const text of [inline, state(f.hooks) + inline]) {
      await write(f.config, text);
      const before = await readFile(f.hooks, "utf8");
      expect((await f.inspect()).issues).toEqual([
        "codex_inline_hooks_manual_action_required",
      ]);
      await expect(
        manageRegistration("codex", "install", f.env, f.execution),
      ).rejects.toMatchObject({
        code: "codex_inline_hooks_manual_action_required",
      });
      expect(await readFile(f.hooks, "utf8")).toBe(before);
    }
  },
);
it.each([
  'hooks = "PRIVATE_TOML"',
  "hooks = []",
  "hooks = 1",
  'hooks.state = "PRIVATE_STATE"',
  "hooks.state = []",
  "hooks.state = 1",
  'hooks.state.PRIVATE_PATH = "PRIVATE_HASH"',
  "hooks.state.PRIVATE_PATH = []",
  '[hooks.state.PRIVATE_PATH]\nenabled="false"',
  "[hooks.state.PRIVATE_PATH]\ntrusted_hash=42",
  '[hooks.state.PRIVATE_PATH]\ntrusted_hash={secret="PRIVATE_HASH"}',
  '[hooks.state.PRIVATE_PATH]\nfuture_field="PRIVATE_UNKNOWN"',
  '[hooks.state."key"]\nenabled=true\n[hooks.state." key "]\nenabled=false',
  '[hooks.state."PRIVATE_UNCLOSED',
])("rejects malformed/ambiguous state safely %#", async (toml) => {
  const f = await fixture();
  await write(f.config, toml);
  const status = await f.inspect();
  expect(status.registration).toBe("conflict");
  expect(status.issues).toEqual(["malformed_codex_toml"]);
  expect(JSON.stringify(status)).not.toMatch(/PRIVATE_|sha256:/);
  expect(await readFile(f.config, "utf8")).toBe(toml);
});
it("uninstall preserves Codex-managed trust and enablement state byte-for-byte", async () => {
  const f = await fixture();
  const text = state(f.hooks, "pre_tool_use", "enabled=false");
  await write(f.config, text);
  await manageRegistration("codex", "uninstall", f.env, f.execution);
  expect(await readFile(f.config, "utf8")).toBe(text);
});

import { describe, expect, it } from "vitest";
import {
  HookDocument,
  ownsHandler,
  planDocument,
  possibleOtherInstall,
} from "../../src/registration/document.js";

describe("installation ownership is not automatic migration", () => {
  const old = {
    type: "command",
    command:
      "'/usr/bin/node' '/synthetic/review-checkout/dist/cli/index.js' 'hook' 'codex'",
    async: true,
  };
  const candidate = {
    command:
      "'/usr/bin/node' '/synthetic/candidate/node_modules/skilldispatch/dist/cli/index.js' 'hook' 'codex'",
  };
  it("does not infer ownership from an old neutral checkout path", () => {
    expect(old.command).not.toMatch(/skilldispatch/i);
    expect(ownsHandler(old, candidate)).toBe(false);
    expect(possibleOtherInstall(old, "codex")).toBe(false);
  });
  it("documents duplicate routing risk when installations share host settings", () => {
    const document = new HookDocument(
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [old] }] },
      }),
    );
    const installed = new HookDocument(
      planDocument(document, candidate, "install", true).text,
    );
    expect(installed.handlers()).toHaveLength(2);
    expect(installed.handlers()[0]?.value).toEqual(old);
    expect(installed.handlers()[1]?.value.command).toBe(candidate.command);
    expect(
      new HookDocument(
        planDocument(installed, candidate, "uninstall").text,
      ).handlers()[0]?.value,
    ).toEqual(old);
  });
  it("keeps the old definition unchanged when the candidate has its own document", () => {
    const oldDocument = new HookDocument(
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [old] }] },
      }),
    );
    const original = oldDocument.text;
    const isolated = new HookDocument(
      planDocument(new HookDocument("{}"), candidate, "install", true).text,
    );
    expect(isolated.handlers()).toHaveLength(1);
    expect(oldDocument.text).toBe(original);
    expect(oldDocument.handlers()[0]?.value).toEqual(old);
  });
});

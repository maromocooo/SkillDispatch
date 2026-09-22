import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  type Node,
  type ParseError,
  parseTree,
} from "jsonc-parser";
import { type CommandSpec, type Host, RegistrationError } from "./types.js";

export interface HandlerLocation {
  matcher?: unknown;
  group: number;
  handler: number;
  value: Record<string, unknown>;
}
export class HookDocument {
  readonly root: Node;
  constructor(readonly text: string) {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
    });
    if (!root || errors.length || root.type !== "object")
      throw new RegistrationError("malformed_host_json");
    const visit = (node: Node, depth: number) => {
      if (depth > 100) throw new RegistrationError("malformed_host_json");
      if (node.type === "object") {
        const keys = node.children?.map((p) => p.children?.[0]?.value) ?? [];
        if (new Set(keys).size !== keys.length)
          throw new RegistrationError("duplicate_json_key");
      }
      for (const child of node.children ?? []) visit(child, depth + 1);
    };
    visit(root, 0);
    this.root = root;
    const hooks = this.node(["hooks"]);
    for (const name of [
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
    ]) {
      const event = this.node(["hooks", name]);
      if (
        (hooks && hooks.type !== "object") ||
        (event && event.type !== "array")
      )
        throw new RegistrationError("malformed_hook_structure");
      for (const group of event?.children ?? []) {
        const handlers = findNodeAtLocation(group, ["hooks"]);
        if (
          group.type !== "object" ||
          !handlers ||
          handlers.type !== "array" ||
          handlers.children?.some((h) => h.type !== "object")
        )
          throw new RegistrationError("malformed_hook_structure");
      }
    }
  }
  node(path: (string | number)[]) {
    return findNodeAtLocation(this.root, path);
  }
  handlers(event = "UserPromptSubmit"): HandlerLocation[] {
    return (this.node(["hooks", event])?.children ?? []).flatMap((group, i) =>
      (findNodeAtLocation(group, ["hooks"])?.children ?? []).map(
        (handler, j) => ({
          matcher: findNodeAtLocation(group, ["matcher"])?.value,
          group: i,
          handler: j,
          value: getNodeValue(handler) as Record<string, unknown>,
        }),
      ),
    );
  }
}
export function ownsHandler(
  value: Record<string, unknown>,
  command: CommandSpec,
): boolean {
  return (
    value.type === "command" &&
    value.command === command.command &&
    JSON.stringify(value.args) === JSON.stringify(command.args) &&
    value.commandWindows === undefined &&
    value.command_windows === undefined
  );
}
export function possibleOtherInstall(
  value: Record<string, unknown>,
  host: Host,
): boolean {
  // Conservative conflict only, never use a heuristic to delete a handler or print it.
  if (value.type !== "command") return false;
  const source = JSON.stringify([
    value.command,
    value.args,
    value.commandWindows,
  ]);
  return (
    /skilldispatch/i.test(source) &&
    source.includes("hook") &&
    source.includes(host)
  );
}
function edit(
  text: string,
  path: (string | number)[],
  value: unknown,
  insertion = false,
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      isArrayInsertion: insertion,
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}
export function planDocument(
  document: HookDocument,
  command: CommandSpec,
  action: "install" | "uninstall",
  sync = false,
  event = "UserPromptSubmit",
  matcher?: string,
) {
  const owned = document
    .handlers(event)
    .filter(
      (h) =>
        ownsHandler(h.value, command) &&
        (matcher === undefined || h.matcher === matcher),
    );
  let text = document.text;
  if (action === "install") {
    if (owned.length > 1) throw new RegistrationError("duplicate_registration");
    const handler = owned[0];
    if (handler) {
      // Only update our execution/timeout fields; preserve all unrelated fields byte-for-byte.
      for (const [key, value] of [
        ["async", !sync],
        ["timeout", 5],
      ] as const) {
        if (handler.value[key] !== value)
          text = edit(
            text,
            ["hooks", event, handler.group, "hooks", handler.handler, key],
            value,
          );
      }
      return {
        text,
        action: text === document.text ? "already-installed" : "update",
      };
    }
    const group = {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", ...command, async: !sync, timeout: 5 }],
    };
    if (document.node(["hooks", event]))
      text = edit(text, ["hooks", event, -1], group, true);
    else text = edit(text, ["hooks", event], [group]);
    return { text, action: "install" };
  }
  for (const entry of [...owned].reverse()) {
    const current = new HookDocument(text);
    const group = current.node(["hooks", event, entry.group]);
    const handlers = current.node(["hooks", event, entry.group, "hooks"]);
    if (
      group?.children?.length === (matcher === undefined ? 1 : 2) &&
      handlers?.children?.length === 1
    )
      text = edit(text, ["hooks", event, entry.group], undefined);
    else
      text = edit(
        text,
        ["hooks", event, entry.group, "hooks", entry.handler],
        undefined,
      );
  }
  if (
    matcher !== undefined &&
    owned.length &&
    new HookDocument(text).node(["hooks", event])?.children?.length === 0
  )
    text = edit(text, ["hooks", event], undefined);
  return {
    text,
    action: text === document.text ? "not-installed" : "uninstall",
  };
}

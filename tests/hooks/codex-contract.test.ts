import { describe, expect, it } from "vitest";
import { parseCodexInput } from "../../src/hooks/codex.js";
import { supportedCodexContract } from "../../src/hosts/codex-contract.js";
import {
  createCodexReadEvent,
  parseCodexRead,
} from "../../src/observability/codex-read-hook.js";
import { createRouteTrace } from "../../src/telemetry/trace.js";
import { traceInput } from "../telemetry/helpers.js";

it.each(["0.155.1", "0.156.1", "0.155.0-alpha.9.2"])(
  "accepts source-verified exact contract %s",
  (contract) => {
    expect(supportedCodexContract(contract)).toBe(true);
  },
);
it.each([
  "0.157.0",
  "0.157.1",
  "0.157.x",
  "0.156.2",
  ">=0.155",
  "latest",
  "0.155.0-alpha.9.3",
  "codex-cli 0.156.1",
  undefined,
])("rejects unverified contract %s", (contract) => {
  expect(supportedCodexContract(contract)).toBe(false);
});

// Both pinned CLI sources serialize the same fields; the host supplies no version field.
describe.each(["0.155.1", "0.156.1"])(
  "source-verified CLI %s wire projection",
  () => {
    it("preserves exact session/turn/tool correlation and ignores unconsumed fields", () => {
      const common = {
        session_id: "PRIVATE_SESSION",
        turn_id: "PRIVATE_TURN",
        cwd: "/fixture",
        model: "fixture",
        permission_mode: "default",
        transcript_path: null,
        future_field: { secret: "PRIVATE_FUTURE" },
      };
      const prompt = parseCodexInput({
        ...common,
        hook_event_name: "UserPromptSubmit",
        prompt: "synthetic",
      });
      expect(prompt).toEqual({
        agent: "codex",
        cwd: "/fixture",
        prompt: "synthetic",
        sessionId: common.session_id,
        promptCorrelationId: common.turn_id,
        model: "fixture",
      });
      if (!prompt?.promptCorrelationId)
        throw new Error("Invalid synthetic user-prompt fixture");
      const trace = createRouteTrace({
        ...traceInput(),
        schemaVersion: "2.0",
        sessionId: prompt.sessionId,
        promptCorrelationId: prompt.promptCorrelationId,
      });
      const events = ["PreToolUse", "PostToolUse"].map((phase) => {
        const input = parseCodexRead({
          ...common,
          hook_event_name: phase,
          tool_use_id: "PRIVATE_TOOL",
          tool_name: "Bash",
          tool_input: {
            command: "cat /fixture/SKILL.md",
            future_field: "PRIVATE_ARGS",
          },
          tool_response: "PRIVATE_OUTPUT",
        });
        expect(input).toBeDefined();
        if (!input) throw new Error("Invalid synthetic wire fixture");
        expect(input).not.toHaveProperty("future_field");
        expect(input).not.toHaveProperty("tool_response");
        expect(input.tool_input).toEqual({ command: "cat /fixture/SKILL.md" });
        return createCodexReadEvent(input, traceInput().key, [], input.path);
      });
      expect(events.map((e) => e.phase)).toEqual([
        "attempted",
        "terminal-observed",
      ]);
      expect(events[0]?.toolUseKey).toBe(events[1]?.toolUseKey);
      for (const e of events) {
        expect(e.sessionKey).toBe(trace.host.sessionKey);
        expect(e.promptKey).toBe(trace.host.promptKey);
        expect(e.outcome).toBe("unknown");
        expect(JSON.stringify(e)).not.toMatch(
          /PRIVATE_|fixture|command|response/,
        );
      }
    });
  },
);

import {
  createInvocationEvent,
  parseSkillHook,
} from "../../src/observability/claude-skill-hook.js";
export const hostInput = (extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Skill",
  tool_input: { skill: "jira-ticket", args: "PRIVATE_ARGS" },
  session_id: "PRIVATE_SESSION",
  prompt_id: "PRIVATE_PROMPT_ID",
  tool_use_id: "PRIVATE_TOOL_ID",
  cwd: "/PRIVATE_CWD",
  transcript_path: "/PRIVATE_TRANSCRIPT",
  error: "PRIVATE_ERROR",
  tool_response: { text: "PRIVATE_RESPONSE" },
  ...extra,
});
export const eventFixture = (extra = {}) => {
  const input = parseSkillHook(hostInput(extra));
  if (!input) throw new Error("Invalid fixture");
  return createInvocationEvent(input, Buffer.alloc(32, 1), []);
};

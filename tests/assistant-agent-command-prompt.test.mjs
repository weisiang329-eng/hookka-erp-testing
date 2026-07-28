// ---------------------------------------------------------------------------
// assistant-agent-command-prompt.test.mjs — pins the fix for "the agent
// refuses to work" (owner 2026-07-28). The Hookka AI chat already HAD the
// write-capable agent tools (agent_control / teach_agent, v1.9) but its system
// prompt + tool-lib header still declared "STRICTLY READ-ONLY / never expose a
// write tool", so the model self-refused when told to command or teach an
// agent. These pins keep the prompt honest so the refusal can't silently return.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const assistantSrc = readFileSync(
  new URL("../src/api/routes/assistant.ts", import.meta.url),
  "utf8",
);
const toolsSrc = readFileSync(
  new URL("../src/api/lib/assistant-tools.ts", import.meta.url),
  "utf8",
);

// Isolate the SYSTEM_PROMPT template literal.
function systemPrompt() {
  const i = assistantSrc.indexOf("export const SYSTEM_PROMPT = `");
  assert.ok(i >= 0, "SYSTEM_PROMPT must exist");
  const end = assistantSrc.indexOf("`;", i);
  return assistantSrc.slice(i, end);
}

test("system prompt no longer declares a blanket STRICTLY READ-ONLY refusal", () => {
  const p = systemPrompt();
  assert.doesNotMatch(
    p,
    /You are STRICTLY READ-ONLY\. You cannot create, update, or delete anything\./,
    "the blanket read-only line caused the model to refuse commanding/teaching agents",
  );
  // It should still say it's read-only for ERP DATA (scoped, not blanket).
  assert.match(p, /READ-ONLY for ERP DATA/, "must still be read-only for ERP data");
});

test("system prompt tells the model it CAN command + teach agents", () => {
  const p = systemPrompt();
  assert.match(p, /agent_control/, "prompt must mention agent_control");
  assert.match(p, /teach_agent/, "prompt must mention teach_agent");
  assert.match(
    p,
    /DO IT via these tools — don't say you can't/,
    "prompt must instruct the model to act (not refuse) on agent command/teach requests",
  );
});

test("tool-lib header no longer claims it never exposes a write tool", () => {
  const header = toolsSrc.slice(0, 900);
  assert.doesNotMatch(
    header,
    /we never even\s*\n?\s*\/\/\s*EXPOSE a write tool/,
    "the stale 'never expose a write tool' claim contradicts agent_control/teach_agent",
  );
  assert.match(
    header,
    /agent_control` \+ `teach_agent` DO write/,
    "header must acknowledge the agent-management write tools",
  );
});

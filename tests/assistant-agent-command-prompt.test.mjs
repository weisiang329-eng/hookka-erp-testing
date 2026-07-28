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

// --- Access RBAC (owner 2026-07-28: open command/teach to staff, data stays owner) ---

test("chat is open to logged-in staff (no blanket super-admin reject)", () => {
  assert.doesNotMatch(
    assistantSrc,
    /if \(role !== "SUPER_ADMIN"\) \{\s*\n\s*return c\.json\(\{ success: false, error: "forbidden" \}, 403\);/,
    "the blanket SUPER_ADMIN-only chat gate must be removed",
  );
  assert.match(assistantSrc, /STAFF_TOOL_NAMES = new Set/, "must define the staff-allowed tool set");
});

test("non-super-admins get ONLY the agent tools — data/SQL/finance stay owner-only", () => {
  // Schema filter + dispatch guard both key off the same set.
  assert.match(
    assistantSrc,
    /getToolSchemas\(\)\.filter\(\(t\) => STAFF_TOOL_NAMES\.has\(t\.name\)\)/,
    "tool schemas must be filtered to STAFF_TOOL_NAMES for non-super-admins",
  );
  assert.match(
    assistantSrc,
    /isSuperAdminRole \|\| STAFF_TOOL_NAMES\.has\(tu\.name\)/,
    "the dispatcher must refuse non-staff tools for non-super-admins (defense-in-depth)",
  );
  // The staff set must contain ONLY the agent tools — never a data/SQL tool.
  const i = assistantSrc.indexOf("STAFF_TOOL_NAMES = new Set");
  const setBlock = assistantSrc.slice(i, i + 220);
  for (const t of ["agent_overview", "agent_control", "teach_agent"]) {
    assert.match(setBlock, new RegExp(t), `staff set must include ${t}`);
  }
  for (const forbidden of ["run_select_query", "list_sales_orders", "get_invoice", "payslip"]) {
    assert.doesNotMatch(setBlock, new RegExp(forbidden), `staff set must NOT include ${forbidden}`);
  }
});

test("global kill switch stays owner-only even though staff can command agents", () => {
  assert.match(
    toolsSrc,
    /\(action === "kill_all_on" \|\| action === "kill_all_off"\) && !isSuperAdmin\(c\)/,
    "the global kill switch must remain super-admin-only",
  );
  // The old blanket 'only super-admin can command agents' gate must be gone.
  assert.doesNotMatch(
    toolsSrc,
    /Only the SUPER_ADMIN can command agents/,
    "staff may command agents now (kill switch aside)",
  );
});

test("teach_agent is open to staff (no super-admin gate on add/retire)", () => {
  assert.doesNotMatch(
    toolsSrc,
    /Only the SUPER_ADMIN can teach or retire agent rules/,
    "staff may teach/retire agent rules",
  );
});

test("chat button shows for any logged-in user, not just super-admin", () => {
  const fe = readFileSync(
    new URL("../src/components/assistant/FloatingChatButton.tsx", import.meta.url),
    "utf8",
  );
  assert.match(fe, /if \(!user\) return null;/, "button gates only on logged-in");
  assert.doesNotMatch(
    fe,
    /user\.role !== "SUPER_ADMIN"/,
    "the super-admin-only button gate must be removed",
  );
});

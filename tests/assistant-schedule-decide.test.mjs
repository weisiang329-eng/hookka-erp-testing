// ---------------------------------------------------------------------------
// assistant-schedule-decide.test.mjs — structural pins for the chat-write
// phase 1 (owner ruling 2026-07-27 「聊天全部可以更改的」) and for
// BUG-2026-07-27-003 (the SYSTEM_PROMPT predated the v1.9 agent tools, so
// the model refused every scheduling/teaching request although the tools
// existed).
//
// Pins:
//   1. The prompt no longer contains the absolute read-only doctrine and
//      documents the agent/scheduling exception + the consent flow.
//   2. Both new tools are registered; decide enforces SUPER_ADMIN + the
//      confirmed:true consent contract and reuses the shared lib core.
//   3. The Planning route delegates to the same shared core (no divergent
//      inline write path left behind).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const prompt = readFileSync(
  new URL("../src/api/routes/assistant.ts", import.meta.url),
  "utf8",
);
const tools = readFileSync(
  new URL("../src/api/lib/assistant-tools.ts", import.meta.url),
  "utf8",
);
const lib = readFileSync(
  new URL("../src/api/lib/schedule-proposals.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../src/api/routes/schedule-proposals.ts", import.meta.url),
  "utf8",
);

test("prompt: absolute read-only doctrine replaced by the agent exception", () => {
  assert.doesNotMatch(
    prompt,
    /STRICTLY READ-ONLY/,
    "the blanket refusal clause must stay gone (BUG-2026-07-27-003)",
  );
  assert.match(prompt, /THE ONE EXCEPTION — the AI agent workforce/);
  assert.match(prompt, /list_schedule_proposals/);
  assert.match(prompt, /decide_schedule_proposals/);
  assert.match(prompt, /teach_agent/, "teaching must be documented to the model");
  assert.match(
    prompt,
    /confirmed:true/,
    "the consent contract must be spelled out in the prompt",
  );
});

test("tools: both proposal tools registered; decide enforces consent + role", () => {
  assert.match(tools, /name: "list_schedule_proposals"/);
  assert.match(tools, /name: "decide_schedule_proposals"/);
  assert.match(
    tools,
    /listScheduleProposalsTool,\s*\n\s*decideScheduleProposalsTool,\s*\n\];/,
    "both tools must be in the TOOLS registry",
  );
  assert.match(
    tools,
    /args\.confirmed !== true/,
    "decide must hard-require confirmed:true",
  );
  // The consent check + role check live inside the decide executor.
  const decideIdx = tools.indexOf('name: "decide_schedule_proposals"');
  const decideSlice = tools.slice(decideIdx, decideIdx + 4000);
  assert.match(decideSlice, /isSuperAdmin\(c\)/, "decide is SUPER_ADMIN-gated");
  assert.match(
    decideSlice,
    /decideProposals\(db, \{ action, ids, decidedBy: userId \}\)/,
    "decide must reuse the shared lib core",
  );
});

test("shared core: lib exports decideProposals; route delegates to it", () => {
  assert.match(lib, /export async function decideProposals\(/);
  assert.match(lib, /kind: "PROPOSALS_APPLIED"/, "batch snapshot stays rollbackable");
  assert.match(route, /decideProposals\(c\.var\.DB, \{\s*\n\s*action: "approve"/);
  assert.match(route, /decideProposals\(c\.var\.DB, \{\s*\n\s*action: "reject"/);
  assert.doesNotMatch(
    route,
    /UPDATE job_cards SET dueDate/,
    "the route must not keep a divergent inline write path",
  );
});

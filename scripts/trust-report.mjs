#!/usr/bin/env node
// ---------------------------------------------------------------------------
// trust-report — answer "can I trust the docs?" with a NUMBER, not a paragraph.
//
// WHY THIS EXISTS
// On 2026-08-14 the owner asked, repeatedly, whether the documentation could be
// trusted. Every answer was prose — mine — and prose is exactly what had failed:
// that same day I wrote a wrong section into the file everyone is told to read
// first, and left a table contradicting its own paragraph five lines below.
// He caught it by asking again. The next time he does not ask, nothing catches it.
//
// So this replaces the question "do you trust it?" with "run the command."
// It reports three separable things, because collapsing them is the lie:
//
//   1. MECHANICAL   — gated, cannot silently rot (paths, line refs, symbol
//                     anchors, stamps, unique ids, generated API.md, secrets)
//   2. PROSE        — how many docs a human has actually READ against the source.
//                     No script can check a sentence; this only reports coverage.
//   3. DECLARED GAPS— UNMEASURED markers and open owner decisions. These are not
//                     failures. An honestly-labelled gap is the safe state; the
//                     dangerous state is a gap that looks like an answer.
//
// A green MECHANICAL result does NOT mean the docs are true. It means they point
// where they say they point. That distinction is the whole lesson of the day.
//
// USAGE
//   node scripts/trust-report.mjs
//   node scripts/trust-report.mjs --strict   # exit 1 if prose coverage < 100%
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const strict = process.argv.includes("--strict");

const run = (cmd) => {
  try {
    execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return { ok: true };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
};

// ---- 1. MECHANICAL --------------------------------------------------------
const GATES = [
  ["file paths, line refs, symbol anchors", "node scripts/check-codebase-map.mjs"],
  ["doc stamps + unique bug ids", "node scripts/check-docs-freshness.mjs"],
  ["no credentials in tracked files", "node scripts/check-secrets.mjs"],
  ["API.md is generated, not hand-written", "node scripts/gen-api-docs.mjs --check"],
];

console.log("\n=== 1. MECHANICAL — gated, cannot silently rot ===\n");
let mechFail = 0;
for (const [label, cmd] of GATES) {
  const r = run(cmd);
  if (!r.ok) mechFail++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${label}`);
}

// ---- 2. PROSE COVERAGE ----------------------------------------------------
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (e.name !== "archive") walk(p, out);
    } else if (p.endsWith(".md")) out.push(p);
  }
  return out;
};

const live = walk("docs");
if (existsSync("CLAUDE.md")) live.push("CLAUDE.md");

const AUDIT = "docs/DOCS-VS-CODE-AUDIT.md";
let audited = new Set();
if (existsSync(AUDIT)) {
  let t = readFileSync(AUDIT, "utf8");

  // Expand brace notation before matching. The audit writes
  // `docs/context-packs/{architecture,backend,core-flow,security}.md` for four
  // files it opened; a literal match missed all four and this report said
  // "69 of 82" while the audit said 81 of 81. The audit was right.
  //
  // Worth stating: the tool built to stop me guessing was itself guessing, and
  // it erred toward "less verified than reality" — the safe direction, but a
  // number that is wrong either way is a number nobody can act on.
  t = t.replace(/([A-Za-z0-9/._-]*)\{([^}]+)\}([A-Za-z0-9._-]*)/g, (_m, pre, inner, post) =>
    inner
      .split(",")
      .map((x) => `${pre}${x.trim()}${post}`)
      .join(" "),
  );

  for (const f of live) if (t.includes(f)) audited.add(f);
}
const unread = live.filter((f) => !audited.has(f) && f !== AUDIT);

console.log("\n=== 2. PROSE — has a human read it against the source? ===\n");
console.log(`  ${audited.size} of ${live.length} live docs appear in the audit`);
console.log(`  ${unread.length} NOT yet read against the source:`);
unread.slice(0, 15).forEach((f) => console.log(`      ${f}`));
if (unread.length > 15) console.log(`      … and ${unread.length - 15} more`);
console.log(
  "\n  NOTE: no script can check a sentence. This is COVERAGE, not correctness —\n" +
    "  it says who has been read, never that what they say is true.",
);

// ---- 3. DECLARED GAPS -----------------------------------------------------
let unmeasured = 0;
let decisions = 0;
for (const f of live) {
  let t;
  try {
    t = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  unmeasured += (t.match(/UNMEASURED/g) ?? []).length;

}

// Open decisions come from ONE register, counted as ROWS — not by grepping prose
// across the tree. Pattern-matching wording gave 53, then 8, then ~30 for the
// same question inside one conversation: the ledger's closed rulings inflated it,
// and scattering the real ones across six files deflated it. A backlog nobody can
// count is a backlog nobody can clear.
const REGISTER = "docs/OWNER-DECISIONS.md";
let registerFound = false;
let resolvedCount = 0;
if (existsSync(REGISTER)) {
  registerFound = true;
  const t = readFileSync(REGISTER, "utf8");
  // Rows are `| **A1** | …`. Count only the ones still OPEN — a row the owner
  // has ruled on carries ✅ DECIDED / ✅ DONE / ⏸️ PARKED right after the id.
  // The first version counted every row and kept reporting 23 after three were
  // settled, which is the same defect as counting the ledger's closed rulings:
  // a backlog figure that does not fall when work is done teaches people to
  // ignore it.
  const rows = t.split(/\r?\n/).filter((l) => /^\|\s*\*\*[A-D]\d+\*\*\s*\|/.test(l));

  // A row counts as settled ONLY when the ruling marker is the first thing in
  // the description cell, right after the id — the shape every closure here
  // uses: `| **A4** | ✅ **DECIDED 2026-08-14 — …`.
  //
  // It used to match those words ANYWHERE in the row, which quietly hid live
  // questions whose prose happened to contain one: B3 ("already shipped"),
  // C5 ("if both parts shipped"), C3, D2. Four open decisions were invisible,
  // and the register exists precisely because the owner could not get a
  // straight count. A counter that under-reports is worse than no counter —
  // it reads as "nothing waiting on me" and the work simply stops being seen.
  //
  // The narrow anchor also means a row cannot be closed by wording alone: to
  // settle one you must put the marker where a reader sees it too.
  const SETTLED_MARKER =
    /^\|\s*\*\*[A-D]\d+\*\*\s*\|\s*(?:✅|⏸️|❌)\s*\*\*(DECIDED|DONE|PARKED|CLOSED|SHIPPED)\b/i;
  const settled = rows.filter((l) => SETTLED_MARKER.test(l));
  decisions = rows.length - settled.length;
  resolvedCount = settled.length;
}

console.log("\n=== 3. DECLARED GAPS — labelled, not hidden ===\n");
console.log(`  ${unmeasured} UNMEASURED markers (need a live query to resolve)`);
console.log(registerFound
    ? `  ${decisions} open owner decisions (${resolvedCount} already settled) — see docs/OWNER-DECISIONS.md`
    : "  owner decisions: NO REGISTER FOUND (docs/OWNER-DECISIONS.md missing)");
console.log(
  "\n  These are the SAFE state. A gap that is labelled can be acted on;\n" +
    "  a gap that looks like an answer is what does the damage.",
);

// ---- VERDICT --------------------------------------------------------------
console.log("\n=== VERDICT ===\n");
if (mechFail) {
  console.log(`  MECHANICAL: ${mechFail} gate(s) FAILING — fix before trusting any pointer.`);
} else {
  console.log("  MECHANICAL: every pointer resolves. Docs point where they say they point.");
}
console.log(
  unread.length === 0
    ? "  PROSE:      every live doc has been read against the source at least once."
    : `  PROSE:      ${unread.length} doc(s) unread. Their SENTENCES are unverified.`,
);
console.log(
  "\n  'Trustworthy' is not one number. Mechanical green + prose 100% + gaps labelled\n" +
    "  is the most any repo can honestly claim — and it still means 'nobody has\n" +
    "  found a contradiction', not 'there is none'.\n",
);

process.exit(mechFail || (strict && unread.length) ? 1 : 0);

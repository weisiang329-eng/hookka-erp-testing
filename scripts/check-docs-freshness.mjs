#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-docs-freshness — make the docs rule mechanical instead of advisory.
//
// WHY THIS EXISTS
// "Update-on-touch" has been written in CLAUDE.md for months. Measured on
// 2026-08-13 over the last 40 commits on main: 26 touched src/, and 11 of those
// (42%) shipped with no docs/ change at all. A convention nobody is stopped by
// is not a rule, it is a wish.
//
// The cost is not tidiness. A README told every reader "Every API route trusts
// the caller" while the app had had auth since April; docs/API.md documented 4
// endpoints out of 136; SYMBOLS.md's file:line index was 75% wrong. Ask such a
// repo the same question three times and you get three different answers,
// because each reader weights the stale doc against the live code differently.
//
// WHAT IT CHECKS
//   1. STAMPS   every doc under docs/ carries "Last verified: YYYY-MM-DD"
//   2. PAIRING  a change under src/ comes with a docs/ change, or an explicit
//               opt-out in the commit message
//   3. STALE    (advisory) stamps older than STALE_DAYS
//
// THE OPT-OUT IS DELIBERATE
// Plenty of real changes need no doc edit — a typo, a test, a dependency bump.
// Blocking those would train people to bypass the check, which is worse than
// not having it. So the escape hatch is one line in the commit message:
//     [no-docs] <reason>
// It is cheap, but it is a RECORD: `git log --grep="\[no-docs\]"` shows every
// time someone decided a change needed no documentation, and why. An
// unexplained skip is what rots a repo; an explained one is a decision.
//
// USAGE
//   node scripts/check-docs-freshness.mjs            # working tree vs origin/main
//   node scripts/check-docs-freshness.mjs --stamps   # stamp coverage only
//   node scripts/check-docs-freshness.mjs --base <ref>
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const STALE_DAYS = 120;
// "Last generated:" counts. For a file derived from the source by a script it
// is a STRONGER claim than "verified" — a human asserted the latter, a
// generator guarantees it — so demanding the weaker word would be backwards.
const STAMP_RE = /Last (?:verified|generated):\s*(\d{4}-\d{2}-\d{2})/;

// Docs that are records of the past, not descriptions of the present. A dated
// ledger entry SHOULD stay as written — restamping it would be a lie about
// when it was checked. Append-only history is not stale, it is finished.
const STAMP_EXEMPT = [
  /^docs\/archive\//,
  /^docs\/BUG-HISTORY\.md$/,
  /CHANGELOG(-\w+)?\.md$/,
];

const args = process.argv.slice(2);
const stampsOnly = args.includes("--stamps");
const baseIdx = args.indexOf("--base");
const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

let failed = false;
const warn = (m) => console.log(`  ${m}`);

// ---- 1. STAMPS -----------------------------------------------------------
const docs = walk("docs").filter((f) => !STAMP_EXEMPT.some((re) => re.test(f)));
const unstamped = [];
const stale = [];
const today = new Date();

for (const f of docs) {
  const m = STAMP_RE.exec(readFileSync(f, "utf8").slice(0, 4000));
  if (!m) {
    unstamped.push(f);
    continue;
  }
  const age = Math.floor((today - new Date(m[1])) / 86400000);
  if (age > STALE_DAYS) stale.push(`${f} (${age}d)`);
}

console.log(`\ndocs stamped: ${docs.length - unstamped.length}/${docs.length}`);
if (unstamped.length) {
  failed = true;
  console.log(`\nFAIL — ${unstamped.length} doc(s) have no "Last verified:" stamp.`);
  console.log("  Without it a four-month-old doc is indistinguishable from a fresh one,");
  console.log("  so readers trust both equally. Add under the title:");
  console.log("    > **Last verified: YYYY-MM-DD** against `<the file(s) you checked>`");
  unstamped.slice(0, 20).forEach(warn);
  if (unstamped.length > 20) warn(`… and ${unstamped.length - 20} more`);
}
if (stale.length) {
  console.log(`\nadvisory — ${stale.length} doc(s) stamped over ${STALE_DAYS} days ago:`);
  stale.slice(0, 10).forEach(warn);
}

// ---- 1b. UNIQUE BUG IDS --------------------------------------------------
// A bug id is a REFERENCE — code comments, commit messages and other entries
// cite it. Two entries sharing one id makes every citation ambiguous: the
// reader cannot tell which bug `BUG-2026-07-29-001` in a code comment means.
//
// This is not hypothetical and not rare. Five collisions accumulated unnoticed
// between June and August 2026, and I then created two more IN ONE DAY by
// resolving BUG-HISTORY rebase conflicts with keep-both — the right default for
// an append-only ledger, and exactly wrong for the one line that must be
// unique. Twice. Hence a check rather than a resolution to be careful.
//
// The `b` suffix (BUG-2026-06-24-009b) is the repo's existing convention for a
// deliberate second entry on a date, so it is a distinct id, not a collision.
{
  const LEDGER = "docs/BUG-HISTORY.md";
  if (existsSync(LEDGER)) {
    // An ADDENDUM deliberately reuses its parent's id — BUG-2026-07-17-001 has a
    // dated `完成注记` follow-up recording that the backfill ran. That is the same
    // bug, so sharing the id is correct, and flagging it would train people to
    // disable this check. Only headings that claim to be a NEW bug are compared.
    const ADDENDUM = /完成注记|addendum|follow-?up|后续|補記|補记/i;
    const ids = [...readFileSync(LEDGER, "utf8").matchAll(/^## (BUG-\d{4}-\d{2}-\d{2}-\d+[a-z]?)(.*)$/gm)]
      .filter((m) => !ADDENDUM.test(m[2]))
      .map((m) => m[1]);
    const seen = new Set();
    const dupes = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
    if (dupes.length) {
      failed = true;
      console.log(`\nFAIL — ${dupes.length} duplicate bug id(s) in ${LEDGER}:`);
      dupes.forEach((d) => console.log(`  ${d}`));
      console.log("  Every citation of a duplicated id is ambiguous. Give the entry with the");
      console.log("  FEWER inbound references a `b` suffix (the existing convention), and update");
      console.log("  those references — renaming the well-cited one leaves pointers aiming wrong.");
    }
  }
}

// ---- 2. PAIRING ----------------------------------------------------------
if (!stampsOnly) {
  const range = sh(`git rev-parse --verify ${base}`) ? `${base}...HEAD` : "";
  const changed = range ? sh(`git diff --name-only ${range}`).split("\n").filter(Boolean) : [];

  if (changed.length) {
    const srcChanged = changed.filter((f) => f.startsWith("src/"));
    const docsChanged = changed.filter((f) => f.startsWith("docs/") || f === "CLAUDE.md");
    const msgs = sh(`git log --format=%B ${range}`);
    const optOut = /\[no-docs\]/i.test(msgs);

    console.log(`\nchanged vs ${base}: ${srcChanged.length} src, ${docsChanged.length} docs`);

    if (srcChanged.length && !docsChanged.length && !optOut) {
      failed = true;
      console.log("\nFAIL — source changed, no doc changed, and no opt-out recorded.");
      console.log("  Either update the docs this touches (docs/CODEBASE-MAP.md, the module");
      console.log("  guide, docs/BUG-HISTORY.md for a fix), or put one line in a commit:");
      console.log("      [no-docs] <why this needs no documentation>");
      console.log("  The opt-out is fine and expected. Skipping SILENTLY is what rots the repo —");
      console.log("  `git log --grep=\"\\[no-docs\\]\"` should read as a list of decisions.");
      srcChanged.slice(0, 12).forEach(warn);
    } else if (optOut) {
      console.log("  opt-out recorded in a commit message — OK");
    }
  }
}

console.log(failed ? "\ncheck-docs-freshness: FAIL\n" : "\ncheck-docs-freshness: OK\n");
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------
// labour-posting-split.test.mjs — the month-end labour posting splits the
// employer's statutory contributions onto their own accounts.
//
// Owner 2026-08-06, looking at July's posting: 「然后没有分 epf socso 等等」 →
// 「拆」. Every ringgit — gross pay plus employer EPF/SOCSO/EIS — went to the
// department's salary account as one all-in cost, which left 750-0020 / 0030 /
// 0040 permanently empty and made the wage bill impossible to reconcile against
// an EPF or SOCSO statement.
//
// The payslips carried the four components separately all along
// (grossPaySen / epfEmployerSen / socsoEmployerSen / eisEmployerSen);
// aggregateLabour was collapsing them before anyone could post them apart.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/accounting.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

test("the three contributions have their own configurable accounts", () => {
  assert.match(SRC, /epf: "750-0020"/);
  assert.match(SRC, /socso: "750-0030"/);
  assert.match(SRC, /eis: "750-0040"/);
  // Overridable through the same kv map the department accounts use.
  assert.match(SRC, /epf: parsed\.epf \|\| DEFAULT_LABOUR_MAP\.epf/);
  assert.match(SRC, /socso: parsed\.socso \|\| DEFAULT_LABOUR_MAP\.socso/);
  assert.match(SRC, /eis: parsed\.eis \|\| DEFAULT_LABOUR_MAP\.eis/);
});

test("the aggregate keeps them apart instead of folding them into one cost", () => {
  assert.match(SRC, /cur\.epfSen \+= epf;/);
  assert.match(SRC, /cur\.socsoSen \+= socso;/);
  assert.match(SRC, /cur\.eisSen \+= eis;/);
});

test("gross goes to the DEPARTMENT's account, contributions to their own", () => {
  const fn = SRC.slice(SRC.indexOf("function labourDebitLines"));
  assert.match(fn.slice(0, 900), /for \(const d of byDept\) add\(d\.account, d\.grossSen\);/);
  assert.match(fn.slice(0, 900), /add\(map\.epf, byDept\.reduce\(\(s, d\) => s \+ d\.epfSen, 0\)\)/);
  assert.match(fn.slice(0, 900), /add\(map\.socso, byDept\.reduce\(\(s, d\) => s \+ d\.socsoSen, 0\)\)/);
  assert.match(fn.slice(0, 900), /add\(map\.eis, byDept\.reduce\(\(s, d\) => s \+ d\.eisSen, 0\)\)/);
});

test("preview and post derive their lines from the SAME function", () => {
  // Two roll-ups would let the owner approve one entry and post another.
  const uses = SRC.match(/labourDebitLines\(byDept, labourMap(Post)?\)/g) ?? [];
  assert.equal(uses.length, 2, "expected exactly one use in the preview and one in the post");
  assert.doesNotMatch(SRC, /for \(const d of byDept\) byAccount\.set\(d\.account, .*d\.costSen\)/);
});

test("the credit side still equals the FULL cost, so the entry balances", () => {
  // Debits are now gross + epf + socso + eis, which is exactly costSen summed.
  assert.match(SRC, /cur\.costSen \+= gross \+ employer;/);
  assert.match(SRC, /creditSen: totalSen,/);
  assert.match(SRC, /accountCode: LABOUR_ACCRUAL_ACCT,/);
});

test("a zero component posts no leg", () => {
  const fn = SRC.slice(SRC.indexOf("function labourDebitLines"));
  assert.match(fn.slice(0, 600), /if \(sen === 0\) return;/);
});

// --------------------------------------------------------------------------
// Re-posting after an unpost. The ledger enforces
// UNIQUE(orgId, sourceType, sourceId, legNo), and the first posting's legs are
// still there — the journal is append-only, an unpost appends a reversal rather
// than deleting. Restarting legNo at 1 therefore collided, and the handler's
// blanket catch reported it as "Invalid request body".
// --------------------------------------------------------------------------
test("legNo continues past the existing legs instead of restarting at 1", () => {
  assert.match(SRC, /async function nextLegNo/);
  assert.match(SRC, /COALESCE\(MAX\(legNo\), 0\) AS n FROM ledger_journal_entries/);
  assert.match(SRC, /let legNo = await nextLegNo\(c\.var\.DB, orgId, "labor_post", sourceId\);/);
  assert.match(SRC, /let legNo = await nextLegNo\(c\.var\.DB, orgId, "labor_post_reversal", sourceId\);/);
});

test("the labour handlers report the REAL failure, not 'Invalid request body'", () => {
  // Checks what is RETURNED, not the phrase — the comment above the fix names
  // the old message deliberately, and should stay readable.
  const post = SRC.slice(SRC.indexOf('app.post("/labor/post"'), SRC.indexOf('app.post("/labor/unpost"'));
  assert.doesNotMatch(post, /error: "Invalid request body"/);
  assert.match(post, /Labour posting failed: \$\{msg\}/);
  const unpost = SRC.slice(SRC.indexOf('app.post("/labor/unpost"'));
  assert.doesNotMatch(unpost.slice(0, 2500), /error: "Invalid request body"/);
  assert.match(unpost, /Labour unpost failed: \$\{msg\}/);
});

test("unpost is idempotent — a month with nothing outstanding reverses nothing", () => {
  assert.match(SRC, /if \(!labourIsPosted\(net\)\) \{/);
  assert.match(SRC, /alreadyUnposted: true/);
});

test("'already posted' is read from the NET, so an unposted month re-posts", () => {
  assert.match(SRC, /labourIsPosted\(await labourLedgerNet\(c\.var\.DB, orgId, sourceId\)\)/);
  assert.match(SRC, /sourceType LIKE 'labor_post%'/);
});

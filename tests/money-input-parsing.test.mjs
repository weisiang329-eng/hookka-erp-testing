// ---------------------------------------------------------------------------
// BUG-2026-08-13-095 — `parseFloat` on a money field, applied.
//
// `src/lib/parse-money.ts` (landed in 3c52fd56, tested separately in
// `tests/parse-money.test.mjs`) proves the PARSER is correct. This file proves
// the parser is USED: that the money fields which fed `parseFloat` now go
// through it, and — the part that actually protects the ledger — that a value
// it cannot read is REFUSED rather than booked as some other number.
//
// The measured defect: the accounting page has 119 money inputs and not one is
// `type="number"`, so a comma reaches the parser. A fixed asset entered as
// "12,000" was created at RM 12.00 and depreciates off that figure forever.
//
// TWO failure shapes are guarded here, because fixing the first invites the
// second:
//   1. `parseFloat` truncating at the comma      → 12,000 becomes 12
//   2. `parseMoneyToSen(x) ?? 0` at a call site  → 12,000 becomes 0
// Shape 2 is the same bug wearing a different hat: a plausible number nobody
// typed, posted without a word. So the structural half below does not merely
// check that `parseFloat` is gone; it checks that each converted submit path
// carries a refusal, and that every surviving `?? 0` on a money parse sits at a
// site that is listed here with a reason.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── source loading ─────────────────────────────────────────────────────────
const read = (p) => readFileSync(p, "utf8");

/**
 * Strip comments before matching.
 *
 * DELIBERATELY NOT the stripper the older `no-fabricated-*` guards use. That
 * one runs `/\/\*[\s\S]*?\*\//g` unanchored over the whole file and therefore
 * treats an `accept="image/*"` attribute — which ends in star-slash-star — as a
 * block-comment OPENER. It silently ate ~200 lines of the accounting page (see
 * BUG-CLASSES.md, C15 header). Here a block comment must BEGIN a line, which is
 * true of every block comment in this repo's source and false of every JSX
 * attribute value.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split(/\r?\n/)) {
    const st = line.trim();
    if (inBlock) {
      if (line.includes("*/")) {
        inBlock = false;
        out.push(line.slice(line.indexOf("*/") + 2));
      } else {
        out.push("");
      }
      continue;
    }
    if (st.startsWith("//")) { out.push(""); continue; }
    if (st.startsWith("/*")) {
      if (st.slice(2).includes("*/")) out.push(line.slice(line.indexOf("*/") + 2));
      else { inBlock = true; out.push(""); }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const code = (p) => stripComments(read(p));

// The two modules under test, loaded the way `tests/parse-money.test.mjs` loads
// the parser: strip the TS types rather than add a build step for two files.
function loadModule(path) {
  return (
    read(path)
      .replace(/^import .*$/gm, "")
      .replace(/export function/g, "function")
      // Type annotations, MOST SPECIFIC FIRST — the object-literal parameter
      // has to go before the scalar rules, or they chew its interior and leave
      // an un-parseable `Array<{ label; value }>` behind.
      .replace(/fields:\s*Array<\{[^>]*\}>,/g, "fields,")
      .replace(/: string \| null \| undefined/g, "")
      .replace(/: number \| null/g, "")
      .replace(/: string \| null/g, "")
      .replace(/: boolean/g, "")
  );
}

const parseMoneySrc = loadModule("src/lib/parse-money.ts");
const moneyFieldSrc = loadModule("src/lib/money-field.ts");
const M = new Function(
  `${parseMoneySrc}\n${moneyFieldSrc}\n` +
    "return { parseMoneyInput, parseMoneyToSen, moneyFieldToSen, moneyFieldToRinggit, isUnreadableMoney, firstMoneyFieldError };",
)();

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — BEHAVIOUR: the contract every converted call site relies on
// ═══════════════════════════════════════════════════════════════════════════

test("the reported bug: a fixed asset typed 12,000 is twelve thousand ringgit", () => {
  // What the old code did, kept as the reference point:
  assert.equal(parseFloat("12,000"), 12, "sanity: this is why the asset was RM 12.00");
  assert.equal(M.moneyFieldToSen("12,000"), 1200000);
  assert.equal(M.moneyFieldToRinggit("12,000"), 12000);
});

test("BLANK is zero; UNREADABLE is null — and the two never collapse", () => {
  // Every form converted here treats an empty box as "nothing entered" = 0.
  // That rule lives in ONE place so a call site cannot re-derive it slightly
  // differently, which is how `parseFloat(s) || 0` swallowed both cases.
  assert.equal(M.moneyFieldToSen(""), 0);
  assert.equal(M.moneyFieldToSen("   "), 0);
  assert.equal(M.moneyFieldToSen(null), 0);
  assert.equal(M.moneyFieldToSen(undefined), 0);

  assert.equal(M.moneyFieldToSen("oops"), null);
  assert.equal(M.moneyFieldToSen("12abc"), null);
  assert.equal(M.moneyFieldToSen("1.2.3"), null);

  assert.notEqual(M.moneyFieldToSen("oops"), M.moneyFieldToSen(""));
  assert.notEqual(M.moneyFieldToSen("oops"), 0);
});

test("isUnreadableMoney: blank is NOT invalid, garbage is", () => {
  assert.equal(M.isUnreadableMoney(""), false, "an empty box is zero, not an error");
  assert.equal(M.isUnreadableMoney("0"), false);
  assert.equal(M.isUnreadableMoney("12,000.50"), false);
  assert.equal(M.isUnreadableMoney("12.000,50"), true, "European grouping is refused, not guessed");
  assert.equal(M.isUnreadableMoney("abc"), true);
});

test("firstMoneyFieldError names the FIRST unreadable field and quotes it back", () => {
  assert.equal(
    M.firstMoneyFieldError([
      { label: "Cost (RM)", value: "12,000" },
      { label: "Residual (RM)", value: "" },
    ]),
    null,
    "a readable set produces no error",
  );

  const err = M.firstMoneyFieldError([
    { label: "Cost (RM)", value: "12,000" },
    { label: "Residual (RM)", value: "1o0" },
    { label: "Opening accum (RM)", value: "also bad" },
  ]);
  assert.ok(err, "an unreadable field must produce an error");
  assert.match(err, /Residual \(RM\)/, "names the field the operator must fix");
  assert.match(err, /1o0/, "quotes the value back — 'Amount' alone sends people hunting");
  assert.doesNotMatch(err, /also bad/, "reports the FIRST one, not a wall of them");
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — STRUCTURAL: the sites, and their refusals
// ═══════════════════════════════════════════════════════════════════════════

// Files whose money parsing is now 100% through the shared parser. A single
// `parseFloat` reappearing in executable code here is the regression.
const NO_PARSEFLOAT = [
  ["src/pages/accounting/index.tsx", "the 119-money-input page — Fixed Assets, Landed Cost, Fund Transfer, Opening Balance, bills, vouchers, receipts, bank CSV"],
  ["src/pages/accounting/cash-flow.tsx", "bank transaction amount"],
  ["src/pages/accounting/tabs/TradeFinanceBlock.tsx", "draw interest"],
  ["src/pages/rd/index.tsx", "project budget + clone source price"],
  ["src/pages/rd/maintenance.tsx", "hourly rate + monthly fixed cost"],
  ["src/pages/invoices/payments.tsx", "customer receipt + per-invoice allocation"],
  ["src/pages/invoices/credit-notes.tsx", "CN line unit price"],
  ["src/pages/invoices/debit-notes.tsx", "DN line unit price"],
  ["src/pages/leads/index.tsx", "lead est. value + credit limit"],
  ["src/pages/inventory/stock-value.tsx", "physical stock count value"],
  ["src/pages/procurement/sku-form-dialog.tsx", "supplier SKU unit price"],
  ["src/pages/procurement/create.tsx", "PO line unit price"],
  ["src/pages/procurement/detail.tsx", "PO line unit price"],
  ["src/pages/customers.tsx", "customer price list — base / P1 / seat-height"],
  ["src/components/scan-po-modal.tsx", "custom-special surcharge"],
  ["src/components/ui/money-input.tsx", "the shared money input"],
  ["src/components/ui/batch-import-dialog.tsx", "the money import column"],
];

for (const [file, what] of NO_PARSEFLOAT) {
  test(`${file} parses money with the shared parser only (${what})`, () => {
    const src = code(file);
    assert.equal(
      src.includes("parseFloat"),
      false,
      `${file} is back on parseFloat. parseFloat("12,000") === 12 — it stops at the comma and returns what it has, silently.`,
    );
    assert.ok(
      /from "@\/lib\/(money-field|parse-money)"/.test(src),
      `${file} must import the shared parser`,
    );
  });
}

// Files that legitimately keep `parseFloat` for NON-money values. Each names the
// identifiers that are allowed to reach it; anything else means a money field
// slipped back onto the unsafe parser.
const NON_MONEY_PARSEFLOAT = [
  ["src/pages/invoices/supplier-payments.tsx", ["row.rateStr"], "FX rate — not money, has no thousands separator, and must not accept RM/parentheses syntax"],
  ["src/pages/procurement/PurchaseInvoiceDetail.tsx", ["l.qty"], "line quantity"],
  ["src/components/employee-drawer.tsx", ["e.target.value"], "hours/day, OT multiplier, efficiency threshold % — all non-money, all on `e.target.value`"],
  ["src/pages/purchase-returns/index.tsx", ["l.retQty"], "return quantity"],
  ["src/pages/forecast.tsx", ["s"], "strToBp — a PERCENTAGE to basis points"],
];

for (const [file, allowed, why] of NON_MONEY_PARSEFLOAT) {
  test(`${file} keeps parseFloat only for non-money values (${why})`, () => {
    const src = code(file);
    const calls = [...src.matchAll(/parseFloat\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(calls.length > 0, `expected ${file} to still hold non-money parseFloat calls`);
    for (const arg of calls) {
      assert.ok(
        allowed.includes(arg),
        `${file}: parseFloat(${arg}) is not in the non-money allow-list [${allowed.join(", ")}]. ` +
          `If this IS money it must go through @/lib/money-field; if it is not, add it here with a reason.`,
      );
    }
  });
}

// The refusals. Each entry is a submit/commit path that must REFUSE on an
// unreadable amount rather than post a substitute figure. `gate` is the
// expression that decides; `refusal` is the code that must sit next to it.
/**
 * The body of the `if (...) { ... }` that `gate` opens — brace-matched, so the
 * span examined is exactly the one a "delete the return" regression empties,
 * and no wider. Returns "" when the gate has no block (which fails the caller's
 * assertion, correctly).
 */
function guardBlock(src, gate) {
  const at = src.indexOf(gate);
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

const REFUSALS = [
  ["src/pages/accounting/index.tsx", "if (amountSen === null) { toast.error(", "Landed Cost — spreading import charges over batch costs", 2],
  ["src/pages/accounting/index.tsx", "badGroup !== undefined", "Stock Take — closing stock value", 1],
  ["src/pages/accounting/index.tsx", "if (billMoneyError)", "Other-party bill lines + tax", 1],
  ["src/pages/accounting/index.tsx", "if (allocMoneyError)", "Other-party payment allocation", 1],
  ["src/pages/accounting/index.tsx", "if (pvMoneyError)", "Payment voucher lines", 1],
  ["src/pages/accounting/index.tsx", "if (orMoneyError)", "Official receipt lines", 1],
  ["src/pages/accounting/index.tsx", "if (ftMoneyError)", "Fund transfer amount", 1],
  ["src/pages/accounting/index.tsx", "if (faMoneyError)", "FIXED ASSET cost / residual / opening accum — the reported instance", 1],
  ["src/pages/accounting/index.tsx", "if (openingMoneyError)", "Opening trial balance Dr/Cr", 1],
  ["src/pages/accounting/cash-flow.tsx", "if (cfMoneyError)", "Bank transaction amount", 1],
  ["src/pages/accounting/tabs/TradeFinanceBlock.tsx", "if (tfMoneyError)", "Trade-finance draw interest", 1],
  ["src/pages/rd/detail.tsx", "if (rdMoneyError)", "R&D target selling price / material cost / source price", 1],
  ["src/pages/rd/index.tsx", "if (rdCreateMoneyError)", "R&D project budget", 1],
  ["src/pages/invoices/supplier-payments.tsx", "if (moneyErr)", "Supplier payment voucher", 1],
  ["src/pages/invoices/supplier-payments.tsx", "if (koErr)", "Advance knock-off", 1],
  ["src/pages/purchase-returns/index.tsx", "if (costErr)", "Purchase-return unit cost", 1],
];

for (const [file, gate, what, times] of REFUSALS) {
  test(`refuses rather than posts a substitute figure: ${what}`, () => {
    const src = code(file);
    const n = src.split(gate).length - 1;
    assert.equal(
      n,
      times,
      `${file}: expected the guard \`${gate}\` ${times}×, found ${n}. ` +
        `Without it the handler posts whatever the parser fell back to.`,
    );
    // A gate that does not stop the handler is decoration.
    //
    // The first draft of this assertion searched a fixed 400-character window
    // after the gate — and PASSED with the `return` deleted, because a handler
    // has other `return`s within 400 characters. It was caught by putting the
    // bug back (see the mutation log in BUG-HISTORY). It now reads only the
    // guard's OWN block, brace-matched, which is the span the bug empties.
    assert.match(
      guardBlock(src, gate),
      /\breturn\b/,
      `${file}: the guard \`${gate}\` must RETURN from inside its own block — surfacing an error and then posting anyway is the bug with a toast on top.`,
    );
  });
}

// The on-screen figure must not state a total it cannot compute. BUG-2026-08-13-094
// established that the displayed figure and the posted payload cannot come from
// different expressions; an unreadable cell breaks that unless the figure
// abstains.
test("a form with an unreadable amount does not STATE a total", () => {
  const src = code("src/pages/accounting/index.tsx");
  for (const v of ["billMoneyError", "allocMoneyError", "pvMoneyError", "orMoneyError"]) {
    assert.match(
      src,
      new RegExp(`${v} \\? "\\u2014" : formatCurrency\\(totalSen\\)`),
      `${v}: while an amount is unreadable the Total must read "—", not a number computed from a 0 substituted for it.`,
    );
  }
});

// Shape 2 — the `?? 0` regression. Every place a money parse is allowed to fall
// back to 0 is listed here WITH its reason, so a new one has to be argued for.
// The rule: a `?? 0` is acceptable only where the value is DISPLAY-ONLY and the
// submit path carrying it is separately gated by a refusal above.
test("every `?? 0` on a money parse is a listed display fallback, not a payload", () => {
  const ALLOWED = new Map([
    ["src/pages/accounting/index.tsx", 7],   // 5 form `toSen` helpers + bank-CSV parseAmt + opening-balance toSen
    ["src/pages/forecast.tsx", 3],           // calc() sales + amt(), and the derived-% hint
    ["src/pages/invoices/payments.tsx", 1],  // receivedSen preview; `canSubmit` blocks the post
    ["src/pages/invoices/index.tsx", 1],     // the Record Payment button predicate
    ["src/pages/invoices/detail.tsx", 1],    // the Record Payment button predicate
    ["src/pages/procurement/PurchaseInvoiceDetail.tsx", 7], // draft subtotal / tax / discount-base previews
    ["src/pages/invoices/supplier-payments.tsx", 1], // advanceSen preview; handlePost refuses first
  ]);
  const FILES = [...new Set([...NO_PARSEFLOAT.map((r) => r[0]), ...NON_MONEY_PARSEFLOAT.map((r) => r[0]),
    "src/pages/invoices/index.tsx", "src/pages/invoices/detail.tsx", "src/pages/rd/detail.tsx",
    "src/pages/procurement/PurchaseInvoiceDetail.tsx", "src/pages/products/index.tsx",
    "src/pages/inventory/index.tsx", "src/pages/employees.tsx"])];

  for (const file of FILES) {
    const src = code(file);
    const n = (src.match(/money(?:FieldToSen|FieldToRinggit|ToSen)\([^;]*?\)\s*\?\?\s*0/g) ?? []).length;
    const budget = ALLOWED.get(file) ?? 0;
    assert.equal(
      n,
      budget,
      `${file}: ${n} money parses fall back to 0, ${budget} are accounted for. ` +
        `A \`?? 0\` on a money parse silently books RM 0.00 — that is the original bug in a new shape. ` +
        `If the new one is display-only and its submit path refuses, add it to ALLOWED with a reason.`,
    );
  }
});

// The shared adapter must keep delegating. If it ever grows its own arithmetic
// there are two parsers again, which is the condition this whole change removed.
test("money-field delegates to parse-money — it is an adapter, not a second parser", () => {
  const src = code("src/lib/money-field.ts");
  assert.match(src, /from "\.\/parse-money"/);
  assert.equal(src.includes("parseFloat"), false, "the adapter must never parse for itself");
  assert.equal(/replace\(\s*\/[^/]*,[^/]*\/g/.test(src), false, "no hand-rolled separator stripping");
  assert.ok(src.includes("parseMoneyToSen(raw)") && src.includes("parseMoneyInput(raw)"));
});

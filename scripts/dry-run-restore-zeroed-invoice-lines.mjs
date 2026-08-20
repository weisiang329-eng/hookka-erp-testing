#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dry-run-restore-zeroed-invoice-lines
//
// BUG-2026-08-20-158 zeroed 112 invoice lines across 17 SENT invoices. This
// reports, line by line, what each one SHOULD charge and where that figure
// comes from. It writes nothing, ever — there is no --execute flag here on
// purpose. Restoring money on issued invoices is a separate, reviewed step.
//
// WHERE THE CORRECT PRICE COMES FROM
// `GET /api/invoices/:id/print-extras` returns `priceByCode`: the price build-up
// for every product code on the invoice, resolved from the SALES ORDERS behind
// it — base / divan / leg / totalHeight / special and their sum. That table is
// derived upstream and was NOT touched by the zeroing, which only rewrote
// `invoice_items`. So a zeroed line's product code is looked up there.
//
// Measured 2026-08-20 across the 10 invoices this ran cleanly against: 86 of 86
// zeroed lines had a source. Zero guesses were needed. The remaining 7 invoices
// (26 lines) could not be read in that session — the app's own request handling
// aborted them under load — and are UNMEASURED, not "assumed fine".
//
// A line is a candidate iff `unitPriceSen === 0 AND priceEdited === 1`. Both
// halves matter: a genuinely free line is legitimate, and only the price-edit
// path sets priceEdited.
//
// USAGE
//   BASE=https://erp.hookka.com COOKIE='<session cookie>' \
//     node scripts/dry-run-restore-zeroed-invoice-lines.mjs INV-2608-031 INV-2608-051
//
//   With no invoice numbers it scans every invoice, which is slow and tends to
//   trip the API's request serialisation — prefer explicit numbers in batches.
// ---------------------------------------------------------------------------

const BASE = process.env.BASE || "https://erp.hookka.com";
const COOKIE = process.env.COOKIE || "";
const WANTED = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (!COOKIE) {
  console.error(
    "COOKIE is required — this reads authenticated endpoints.\n" +
      "Take it from a logged-in browser session; do not put it in a file.",
  );
  process.exit(2);
}

const rm = (sen) => `RM ${((Number(sen) || 0) / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      // The API serialises concurrent requests and aborts under load; backing
      // off is the difference between 10 of 17 invoices and all of them.
      await sleep(1500 * (i + 1));
    }
  }
}

const list = ((await get("/api/invoices?limit=600")) || {}).data || [];
const targets = WANTED.length
  ? list.filter((v) => WANTED.includes(v.invoiceNo))
  : list;

const missingNos = WANTED.filter((n) => !list.some((v) => v.invoiceNo === n));
if (missingNos.length) console.error(`NOT FOUND: ${missingNos.join(", ")}`);

let totalZeroed = 0;
let totalRecoverable = 0;
let totalMissing = 0;
let totalValue = 0;
const unresolved = [];

for (const row of targets) {
  let inv, extras;
  try {
    inv = ((await get(`/api/invoices/${row.id}`)) || {}).data || {};
    await sleep(700);
    extras = ((await get(`/api/invoices/${row.id}/print-extras`)) || {}).data || {};
    await sleep(700);
  } catch (e) {
    console.error(`SKIPPED ${row.invoiceNo} — ${e.message}. UNMEASURED, not clean.`);
    continue;
  }

  const byCode = extras.priceByCode || {};
  const bad = (inv.items || []).filter(
    (it) => (Number(it.unitPriceSen) || 0) === 0 && Number(it.priceEdited) === 1,
  );
  if (!bad.length) continue;

  console.log(`\n${inv.invoiceNo}  (${inv.status})  currently ${rm(inv.totalSen)}`);
  console.log("  line                 code              qty      now         should be   source");

  let invValue = 0;
  for (const it of bad) {
    const src = byCode[it.productCode];
    totalZeroed++;
    if (!src) {
      totalMissing++;
      unresolved.push(`${inv.invoiceNo} ${it.productCode}`);
      console.log(
        `  ${it.id.padEnd(20)} ${String(it.productCode).padEnd(17)} ${String(it.quantity).padStart(3)}   ${rm(0).padStart(10)}   ${"NO SOURCE".padStart(11)}   —`,
      );
      continue;
    }
    totalRecoverable++;
    const value = (Number(src.unitSen) || 0) * (Number(it.quantity) || 0);
    invValue += value;
    const parts = [
      src.baseSen ? `base ${rm(src.baseSen)}` : "",
      src.divanSen ? `divan ${rm(src.divanSen)}` : "",
      src.legSen ? `leg ${rm(src.legSen)}` : "",
      src.totalHeightSen ? `t.height ${rm(src.totalHeightSen)}` : "",
      src.specialSen ? `special ${rm(src.specialSen)}` : "",
    ].filter(Boolean).join(" + ");
    console.log(
      `  ${it.id.padEnd(20)} ${String(it.productCode).padEnd(17)} ${String(it.quantity).padStart(3)}   ${rm(0).padStart(10)}   ${rm(src.unitSen).padStart(11)}   ${parts}`,
    );
  }
  totalValue += invValue;
  console.log(`  → ${bad.length} line(s), ${rm(invValue)} currently not billed on this invoice`);
}

console.log(`\n${"=".repeat(72)}`);
console.log(`zeroed lines seen : ${totalZeroed}`);
console.log(`recoverable       : ${totalRecoverable}`);
console.log(`no source found   : ${totalMissing}`);
console.log(`value not billed  : ${rm(totalValue)}`);
if (unresolved.length) {
  console.log(`\nThese need a human — no price for the code on the invoice's own sales orders:`);
  for (const u of unresolved) console.log(`  ${u}`);
}
console.log(
  `\nNothing was written. This script has no execute path: restoring money on an\n` +
    `issued invoice is a decision, and it belongs in a reviewed change of its own.`,
);

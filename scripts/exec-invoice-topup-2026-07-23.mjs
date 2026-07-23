// EXECUTOR for the invoice top-up (option A). Raises 65 SENT/unpaid invoices to
// their sales-order price and marks each edited line so it is not touched twice.
//
// Uses the TESTED path — PUT /api/invoices/:id {priceEdits} — which restates
// the GL (AR + revenue) in lockstep. NOT raw SQL (that would move the invoice
// total without the ledger).
//
// ─── THE priceEdits CONTRACT (invoices.ts:1659) — READ THIS ───────────────
// The backend does NOT accept a unit price. Each edit is:
//     { id, baseSen, divanSen, legSen, specialSen, discountSen }
// and the server computes  unit = base + divan + leg + special , then
//     lineTotal = max(0, unit*qty - discount) ,  and sets priceEdited = 1.
// Sending `unitPriceSen` (as an earlier draft of this file did) makes the
// server read id="" and SKIP the edit — a silent no-op. Worse, sending a bare
// component would ZERO the others. So we mirror the SO line's FULL breakdown,
// which the plan below already carries, and we preserve the invoice line's
// existing discount. (Same "priceEdits replaces the whole split" trap the
// 2026-07-17 correction hit. Verified end-to-end via a canary on 2026-07-23:
// INV-2606-095 line 72500 -> 85500, priceEdited 0 -> 1, invoice total +130.)
//
// The plan `_plan-invoice-topup-components-2026-07-23.json` is:
//   { invoiceId: { no, e: [ { id, baseSen, divanSen, legSen, specialSen } ] } }
// built from the SO lines (each verified base+divan+leg+special == SO unit).
//
// Re-verifies EVERY line live before writing: invoice still SENT + unpaid, the
// line still under-bills, and price_edited is 0. Idempotent — a re-run skips
// anything already at target (priceEdited=1), so a mid-run stop is safe.
//
//   $env:HOOKKA_EMAIL="…"; $env:HOOKKA_PASSWORD="…"
//   node scripts/exec-invoice-topup-2026-07-23.mjs            # dry run
//   node scripts/exec-invoice-topup-2026-07-23.mjs --execute
import fs from "node:fs";

const BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const EXECUTE = process.argv.includes("--execute");
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

const PLAN = JSON.parse(
  fs.readFileSync(new URL("./_plan-invoice-topup-components-2026-07-23.json", import.meta.url), "utf8"),
);

if (!EMAIL || !PASSWORD) {
  console.error("BLOCKED: set HOOKKA_EMAIL / HOOKKA_PASSWORD (the committed password was rotated).");
  process.exit(1);
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status} — password still wrong?`);
  const cookies = (r.headers.get("set-cookie") || "")
    .split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
  const j = await r.json();
  return { cookies, csrf: j?.data?.csrfToken || j?.csrfToken || "" };
}

const auth = await login();
console.log(EXECUTE ? "MODE: EXECUTE\n" : "MODE: DRY RUN\n");

let appliedInv = 0, appliedLines = 0, addSen = 0;
const skipped = [], errors = [];
for (const [id, inv] of Object.entries(PLAN)) {
  const before = (await fetch(`${BASE}/api/invoices/${id}`, { headers: { cookie: auth.cookies } })
    .then((r) => r.json()).catch(() => null))?.data;
  if (!before) { errors.push(`${inv.no}: fetch failed`); continue; }
  if (before.status !== "SENT" || Number(before.paidAmount) > 0) {
    skipped.push(`${inv.no}: ${before.status}/paid${before.paidAmount}`);
    continue;
  }
  const edits = [];
  for (const e of inv.e) {
    const it = (before.items ?? []).find((x) => x.id === e.id);
    if (!it) { errors.push(`${inv.no} ${e.id} missing`); continue; }
    const target = e.baseSen + e.divanSen + e.legSen + e.specialSen;
    if (Number(it.priceEdited) === 1 || Number(it.unitPriceSen) >= target) continue; // done / not under
    edits.push({ ...e, discountSen: Number(it.discountSen) || 0 });
    addSen += (target - Number(it.unitPriceSen)) * (Number(it.quantity) || 1);
  }
  if (!edits.length) { skipped.push(`${inv.no}: no-op`); continue; }
  if (!EXECUTE) { console.log(`  ${inv.no}: would raise ${edits.length} line(s)`); appliedInv++; appliedLines += edits.length; continue; }
  const put = await fetch(`${BASE}/api/invoices/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify({ priceEdits: edits }),
  });
  const pj = await put.json().catch(() => ({}));
  if (put.ok && pj.success !== false) { console.log(`✅ ${inv.no}: ${edits.length} line(s)`); appliedInv++; appliedLines += edits.length; }
  else { errors.push(`${inv.no}: ${put.status} ${pj.error ?? ""}`); }
}

console.log(`\n${EXECUTE ? "APPLIED" : "WOULD APPLY"}: ${appliedInv} invoices / ${appliedLines} lines / +${rm(addSen)}`);
if (skipped.length) console.log(`skipped: ${skipped.join(" | ")}`);
if (errors.length) console.log(`ERRORS: ${errors.join(" | ")}`);
console.log("\nThen re-run scripts/audit-billable-2026-07-22.mjs to confirm, and RE-SEND the corrected invoices (owner's step).");

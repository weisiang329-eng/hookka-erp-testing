// EXECUTOR for the invoice top-up (option A). Reads the frozen plan
// scripts/_plan-invoice-topup-2026-07-23.json (154 lines / 65 invoices /
// RM 15,480) and raises each invoice line to its sales-order price.
//
// Goes through the TESTED path — PUT /api/invoices/:id {priceEdits} — NOT raw
// SQL, because that route restates the GL (AR + revenue) in lockstep. A raw
// UPDATE on invoice_items would change the invoice total while leaving the GL
// behind — the books would not balance. This is the same path the 2026-07-17
// correction used for exactly this reason.
//
// BLOCKED until a working login exists: the committed script password was
// rotated (it 401s). Provide HOOKKA_EMAIL / HOOKKA_PASSWORD in the environment.
//
//   $env:HOOKKA_EMAIL="…"; $env:HOOKKA_PASSWORD="…"
//   node scripts/exec-invoice-topup-2026-07-23.mjs            # dry run
//   node scripts/exec-invoice-topup-2026-07-23.mjs --execute
//
// Re-verifies EVERY line live before writing: the invoice is still live and
// unpaid, the item still under-bills, and the line was not deliberately
// revised (price_edited=1). Anything that no longer matches is skipped and
// reported, never forced.
import fs from "node:fs";

const BASE = "https://hookka-erp-testing.pages.dev";
const EMAIL = process.env.HOOKKA_EMAIL ?? "";
const PASSWORD = process.env.HOOKKA_PASSWORD ?? "";
const EXECUTE = process.argv.includes("--execute");
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

const plan = JSON.parse(
  fs.readFileSync(new URL("./_plan-invoice-topup-2026-07-23.json", import.meta.url), "utf8"),
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

// Group plan lines by invoice — one PUT per invoice carries all its edits.
const byInvoice = new Map();
for (const p of plan) {
  if (!byInvoice.has(p.invoiceId)) byInvoice.set(p.invoiceId, { invoiceNo: p.invoiceNo, lines: [] });
  byInvoice.get(p.invoiceId).lines.push(p);
}

let done = 0, skipped = 0, applied = 0;
for (const [invoiceId, { invoiceNo, lines }] of byInvoice) {
  const cur = await fetch(`${BASE}/api/invoices/${invoiceId}`, { headers: { cookie: auth.cookies } })
    .then((r) => r.json()).catch(() => null);
  const inv = cur?.data;
  if (!inv || inv.status === "CANCELLED" || Number(inv.paidAmount) > 0) {
    console.log(`⏭  ${invoiceNo}: ${!inv ? "not found" : inv.status === "CANCELLED" ? "cancelled" : "part-paid"} — skipped`);
    skipped += lines.length;
    continue;
  }
  const priceEdits = [];
  for (const l of lines) {
    const item = (inv.items ?? []).find((it) => it.id === l.itemId);
    if (!item) { console.log(`   ${invoiceNo} ${l.so} L${l.lineNo}: item gone — skip`); skipped++; continue; }
    if (Number(item.priceEdited) === 1) { console.log(`   ${invoiceNo} ${l.so} L${l.lineNo}: revised (price_edited) — skip`); skipped++; continue; }
    if (Number(item.unitPriceSen) >= l.soUnitSen) { console.log(`   ${invoiceNo} ${l.so} L${l.lineNo}: already ≥ SO — skip`); skipped++; continue; }
    priceEdits.push({ itemId: l.itemId, unitPriceSen: l.soUnitSen });
  }
  if (!priceEdits.length) continue;
  if (!EXECUTE) {
    console.log(`   ${invoiceNo}: would raise ${priceEdits.length} line(s), +${rm(lines.reduce((t, x) => t + x.deltaSen, 0))}`);
    done += priceEdits.length;
    continue;
  }
  const r = await fetch(`${BASE}/api/invoices/${invoiceId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: auth.cookies, "x-csrf-token": auth.csrf },
    body: JSON.stringify({ priceEdits }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.success !== false) { console.log(`✅ ${invoiceNo}: ${priceEdits.length} line(s) raised`); applied += priceEdits.length; }
  else { console.log(`⛔ ${invoiceNo}: ${r.status} ${j.error ?? ""}`); skipped += priceEdits.length; }
}

console.log(`\n${EXECUTE ? "APPLIED" : "WOULD APPLY"}: ${EXECUTE ? applied : done} lines | skipped: ${skipped}`);
console.log("After executing, re-run scripts/audit-billable-2026-07-22.mjs to confirm the gap closed,");
console.log("then RE-SEND the corrected invoices to the customer (that step is the owner's).");

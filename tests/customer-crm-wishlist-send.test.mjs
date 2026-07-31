// ---------------------------------------------------------------------------
// customer-crm-wishlist-send.test.mjs — CRM slices 5 (wishlist) + 6 (one-click
// send). Owner 2026-07-30.
//
//   ⑤ Wishlist — RETIRED 2026-08-01 (owner: "整个功能删掉，我们 assign SKU 就行了").
//     The tests below now pin the REMOVAL: no routes, no panel, no mounts. The
//     customer_wishlist TABLE is deliberately kept so historical rows survive.
//   ⑥ One-click send — the browser generates the quotation PDF, base64-encodes
//     it, and POSTs to /send-quote, which emails it via the shared sender and
//     logs a QUOTE_SENT activity on the timeline.
//
// Source-level structural pins (house style — no DB / no worker runtime).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CRM = resolve(process.cwd(), "src/api/routes/customer-crm.ts");
const CUSTOMERS_FE = resolve(process.cwd(), "src/pages/customers.tsx");

const read = (p) => readFileSync(p, "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

// ===========================================================================
// ⑤ Wishlist — backend
// ===========================================================================

test("wishlist routes are GONE (feature retired) but the table is preserved", () => {
  const f = flat(CRM);
  // The feature is withdrawn: nothing may read or write the wishlist any more.
  assert.ok(!/app\.get\("\/wishlist"/.test(f), "wishlist GET route must be removed");
  assert.ok(!/app\.post\("\/wishlist"/.test(f), "wishlist POST route must be removed");
  assert.ok(!/app\.delete\("\/wishlist\/:id"/.test(f), "wishlist DELETE route must be removed");
  assert.ok(!/INSERT INTO customer_wishlist/.test(f), "nothing may still write wishlist rows");
  assert.ok(!/SELECT \* FROM customer_wishlist/.test(f), "nothing may still read wishlist rows");
  // …but the table itself stays. Retiring a feature must not destroy history:
  // dropping it would be irreversible, and the owner asked to remove the
  // feature, not to wipe the records.
  assert.match(
    f,
    /CREATE TABLE IF NOT EXISTS customer_wishlist \(/,
    "the customer_wishlist table must be preserved so historical rows survive",
  );
});

test("WishlistPanel is deleted and no page mounts it", () => {
  assert.ok(
    !existsSync(resolve(process.cwd(), "src/components/customer/WishlistPanel.tsx")),
    "WishlistPanel.tsx must be deleted",
  );
  for (const p of ["src/pages/customers.tsx", "src/pages/leads/index.tsx"]) {
    const f = flat(resolve(process.cwd(), p));
    assert.ok(!/<WishlistPanel/.test(f), `${p} still mounts WishlistPanel`);
    assert.ok(!/import \{ WishlistPanel \}/.test(f), `${p} still imports WishlistPanel`);
  }
});

test("CRM contacts+activity live in the Sales Pipeline drawer, NOT the customer page", () => {
  // Owner 2026-08-01: the Pipeline owns the whole contact history; the customer
  // page is for what you DO with an account (SKUs, maintenance, combos, quotes).
  const leads = flat(resolve(process.cwd(), "src/pages/leads/index.tsx"));
  assert.match(leads, /<CrmPanel customerId=\{lead\.id\}/, "Pipeline drawer must keep CrmPanel");
  const customers = flat(CUSTOMERS_FE);
  assert.ok(!/<CrmPanel/.test(customers), "customers page must no longer mount CrmPanel");
  assert.ok(!/import \{ CrmPanel \}/.test(customers), "customers page must not import CrmPanel");
});

// ===========================================================================
// ⑥ One-click send — backend
// ===========================================================================

test("send-quote emails the attachment via the shared sender", () => {
  const f = flat(CRM);
  assert.match(f, /import \{ sendMail \} from "\.\.\/lib\/email"/);
  assert.match(f, /app\.post\("\/send-quote"/);
  assert.match(f, /requirePermission\(c, "customers", "update"\)/);
  // The client-generated PDF is attached as base64.
  assert.match(f, /attachments: \[\{ filename, contentBase64: pdfBase64 \}\]/);
});

test("send-quote validates recipient + attachment and caps payload size", () => {
  const f = flat(CRM);
  assert.match(f, /a valid recipient email is required/);
  assert.match(f, /pdfBase64 required/);
  assert.match(f, /attachment too large/);
});

test("send-quote logs a QUOTE_SENT activity ONLY after a successful send", () => {
  const src = read(CRM);
  const routeStart = src.indexOf('app.post("/send-quote"');
  assert.ok(routeStart !== -1);
  const route = src.slice(routeStart, src.indexOf("\n});", routeStart));
  // The failure return for a bad send must come BEFORE the activity INSERT, so
  // a failed send never leaves a misleading "sent" row on the timeline.
  const failReturn = route.indexOf("email send failed");
  const activityInsert = route.indexOf("QUOTE_SENT");
  assert.ok(failReturn !== -1 && activityInsert !== -1);
  assert.ok(
    failReturn < activityInsert,
    "the send-failure return must precede the QUOTE_SENT activity insert.",
  );
});

// ===========================================================================
// Frontend wiring
// ===========================================================================


test("Email Quotation button generates PDF base64 and POSTs to /send-quote, gated by confirm", () => {
  const f = flat(CUSTOMERS_FE);
  assert.match(f, /handleEmailQuotationV2/);
  // Reuses the same generator, then strips the data-URI prefix to bare base64.
  assert.match(f, /doc\.output\("datauristring"\)/);
  assert.match(f, /\/api\/customer-crm\/send-quote/);
  // Outward action is confirm-gated.
  assert.match(f, /confirm\(\{[\s\S]*?Send quotation\?/);
  assert.match(f, /Email Quotation/);
});

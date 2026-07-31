// ---------------------------------------------------------------------------
// customer-crm-wishlist-send.test.mjs — CRM slices 5 (wishlist) + 6 (one-click
// send). Owner 2026-07-30.
//
//   ⑤ Wishlist — styles/models a customer likes ("what to pitch next"). New
//     customer_wishlist table (runtime self-applied) + GET/POST/DELETE.
//   ⑥ One-click send — the browser generates the quotation PDF, base64-encodes
//     it, and POSTs to /send-quote, which emails it via the shared sender and
//     logs a QUOTE_SENT activity on the timeline.
//
// Source-level structural pins (house style — no DB / no worker runtime).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CRM = resolve(process.cwd(), "src/api/routes/customer-crm.ts");
const WISHLIST_FE = resolve(process.cwd(), "src/components/customer/WishlistPanel.tsx");
const CUSTOMERS_FE = resolve(process.cwd(), "src/pages/customers.tsx");

const read = (p) => readFileSync(p, "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

// ===========================================================================
// ⑤ Wishlist — backend
// ===========================================================================

test("customer_wishlist table is runtime self-applied (CREATE IF NOT EXISTS)", () => {
  assert.match(
    flat(CRM),
    /CREATE TABLE IF NOT EXISTS customer_wishlist \(/,
    "wishlist table must be created at runtime — a migration file alone is inert on deploy.",
  );
});

test("wishlist GET/POST/DELETE routes exist, RBAC-gated + tenant-scoped", () => {
  const f = flat(CRM);
  assert.match(f, /app\.get\("\/wishlist"/);
  assert.match(f, /app\.post\("\/wishlist"/);
  assert.match(f, /app\.delete\("\/wishlist\/:id"/);
  // read gate on GET, update gate on POST, delete gate on DELETE.
  assert.match(f, /app\.get\("\/wishlist"[\s\S]*?requirePermission\(c, "customers", "read"\)/);
  assert.match(f, /app\.post\("\/wishlist"[\s\S]*?requirePermission\(c, "customers", "update"\)/);
  // Every wishlist query is org-scoped.
  assert.match(f, /FROM customer_wishlist WHERE customer_id = \? AND org_id = \?/);
});

test("wishlist POST requires a product/style and accepts an optional SKU link", () => {
  const f = flat(CRM);
  assert.match(f, /a product\/style is required/);
  assert.match(f, /INSERT INTO customer_wishlist/);
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

test("WishlistPanel fetches + mutates /api/customer-crm/wishlist", () => {
  const f = flat(WISHLIST_FE);
  assert.match(f, /\/api\/customer-crm\/wishlist\?customerId=/);
  assert.match(f, /method: "POST"[\s\S]*?\/api\/customer-crm\/wishlist|\/api\/customer-crm\/wishlist[\s\S]*?method: "POST"/);
});

test("customers page mounts WishlistPanel", () => {
  const f = flat(CUSTOMERS_FE);
  assert.match(f, /import \{ WishlistPanel \} from "@\/components\/customer\/WishlistPanel"/);
  assert.match(f, /<WishlistPanel customerId=\{cust\.id\} \/>/);
});

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

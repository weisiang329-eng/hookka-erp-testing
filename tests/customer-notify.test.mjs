// ---------------------------------------------------------------------------
// customer-notify.test.mjs — customer goods-movement emails (2026-06-11).
//
// Feature: when a DO is marked Dispatched (→ LOADED) the customer gets a
// dispatch notice with the branded DO PDF attached; when marked Delivered
// (→ DELIVERED) they get the invoice notice with the Invoice PDF attached.
//
// Covered here:
//   * recipient chains (dispatch: hub → customer → skip; invoice:
//     customer → hub → skip) — real unit tests on customer-notify.ts
//   * owner-approved templates render doNo / invoiceNo / breakdown / PO
//     rows (and omit the PO row when there is none)
//   * buildDoComponentBreakdown — the Packing-List-style piece tally that
//     feeds the email's Items row from the SAME print-extras object as the
//     attached PDF
//   * outbox attachment plumbing — 5 MB oversize fallback (enqueue WITHOUT
//     attachment), base64 size math, stored-JSON parsing
//   * structural pins: the drain forwards attachments into the provider
//     payload (Resend `attachments` / Brevo `attachment`), the
//     notify-customer endpoint guards status + idempotency (dual-key reads,
//     atomic claim), and the delivery page's runBulkDoTransition
//     LOADED/DELIVERED paths call the notify flow.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const notify = await import("../src/api/lib/customer-notify.ts");
const outbox = await import("../src/api/lib/email-outbox.ts");
const breakdown = await import("../src/lib/do-component-breakdown.ts");

const {
  resolveDispatchRecipient,
  resolveInvoiceRecipient,
  dispatchNoticeTemplate,
  invoiceNoticeTemplate,
  cnDispatchNoticeTemplate,
  fmtEmailDate,
  fmtEmailRM,
} = notify;
const {
  sanitizeAttachments,
  base64DecodedBytes,
  MAX_ATTACHMENT_TOTAL_BYTES,
} = outbox;
const { buildDoComponentBreakdown, collectCustomerPOIds } = breakdown;

// ---------------------------------------------------------------------------
// Recipient chains (owner-confirmed rules)
// ---------------------------------------------------------------------------

test("dispatch recipient: hub email wins when present", () => {
  assert.equal(
    resolveDispatchRecipient("hub@houzs.com", "acct@houzs.com"),
    "hub@houzs.com",
  );
});

test("dispatch recipient: blank hub falls back to customer email", () => {
  assert.equal(resolveDispatchRecipient("", "acct@houzs.com"), "acct@houzs.com");
  assert.equal(
    resolveDispatchRecipient(null, " acct@houzs.com "),
    "acct@houzs.com",
  );
  assert.equal(
    resolveDispatchRecipient("   ", "acct@houzs.com"),
    "acct@houzs.com",
  );
});

test("dispatch recipient: both blank → null (skip, record nothing)", () => {
  assert.equal(resolveDispatchRecipient("", ""), null);
  assert.equal(resolveDispatchRecipient(null, undefined), null);
  assert.equal(resolveDispatchRecipient("  ", null), null);
});

test("invoice recipient: customer email first, hub fallback, both blank → null", () => {
  assert.equal(
    resolveInvoiceRecipient("acct@houzs.com", "hub@houzs.com"),
    "acct@houzs.com",
  );
  assert.equal(resolveInvoiceRecipient("", "hub@houzs.com"), "hub@houzs.com");
  assert.equal(resolveInvoiceRecipient("", ""), null);
});

// ---------------------------------------------------------------------------
// Templates — owner-approved wording, real numbers in, no Chinese.
// ---------------------------------------------------------------------------

test("dispatch template: subject + body carry doNo, breakdown, PO list, deliver-to", () => {
  const tpl = dispatchNoticeTemplate({
    doNo: "DO-2606-031",
    customerName: "Houzs Century Sdn Bhd",
    customerPOIds: ["PO-009003", "PO-009010"],
    dispatchedAt: "2026-06-11T03:30:00.000Z",
    deliverTo: "Houzs KL, 12 Jalan Example, 47000 Sungai Buloh",
    itemsBreakdown: "3 × Headboard, 3 × Divan, 2 × Sofa",
    hasAttachment: true,
  });
  assert.equal(
    tpl.subject,
    "Goods Dispatched — Delivery Order DO-2606-031 | HOOKKA INDUSTRIES",
  );
  for (const out of [tpl.html, tpl.text]) {
    assert.match(out, /DO-2606-031/);
    assert.match(out, /Dear Houzs Century Sdn Bhd/);
    assert.match(out, /PO-009003, PO-009010/);
    assert.match(out, /3 × Headboard, 3 × Divan, 2 × Sofa/);
    assert.match(out, /Houzs KL/);
    assert.match(out, /Please find the Delivery Order attached/);
    assert.match(out, /HOOKKA INDUSTRIES SDN BHD/);
  }
  // Owner-approved receiving-team instruction is present.
  assert.match(
    tpl.text,
    /check the goods against the Delivery Order upon arrival/,
  );
});

test("dispatch template: driver block + Malaysia-time dispatch timestamp (owner 2026-06-11)", () => {
  const tpl = dispatchNoticeTemplate({
    doNo: "DO-2606-032",
    customerName: "Houzs Century Sdn Bhd",
    dispatchedAt: "2026-06-11T03:30:00.000Z", // = 11:30 AM in Malaysia (UTC+8)
    deliverTo: "Houzs KL",
    hasAttachment: false,
    driverName: "Ah Seng",
    driverContact: "012-3456789",
    lorryPlate: "BHM9130",
  });
  for (const out of [tpl.html, tpl.text]) {
    assert.match(out, /Ah Seng/);
    assert.match(out, /012-3456789/);
    assert.match(out, /BHM9130/);
    // Date carries the TIME, rendered in Asia/Kuala_Lumpur (not UTC).
    assert.match(out, /11:30\s*AM/i);
  }
  // Blank driver fields omit their rows entirely.
  const bare = dispatchNoticeTemplate({
    doNo: "DO-2606-033",
    customerName: "X",
    dispatchedAt: null,
    deliverTo: "Y",
    hasAttachment: false,
  });
  assert.doesNotMatch(bare.text, /Driver\s*:/);
  assert.doesNotMatch(bare.text, /Lorry Plate/);
});

test("dispatch template: PO row omitted when the DO carries no customer PO", () => {
  const tpl = dispatchNoticeTemplate({
    doNo: "DO-2606-032",
    customerName: "Carress",
    customerPOIds: [],
    dispatchedAt: null,
    deliverTo: "Carress PG",
    itemsBreakdown: "",
    hasAttachment: true,
  });
  assert.doesNotMatch(tpl.html, /Your PO No\./);
  assert.doesNotMatch(tpl.text, /Your PO No\./);
  // Items row also omitted when the breakdown is empty.
  assert.doesNotMatch(tpl.html, />Items</);
});

test("dispatch template: 'attached' line dropped when no PDF made it", () => {
  const tpl = dispatchNoticeTemplate({
    doNo: "DO-2606-033",
    customerName: "Carress",
    customerPOIds: [],
    dispatchedAt: null,
    deliverTo: "Carress PG",
    hasAttachment: false,
  });
  assert.doesNotMatch(tpl.html, /Please find the Delivery Order attached/);
  // The receiving-team check instruction stays either way.
  assert.match(tpl.text, /check the goods against the Delivery Order/);
});

test("invoice template: subject + body carry invoiceNo, doNo, amount, delivered date", () => {
  const tpl = invoiceNoticeTemplate({
    invoiceNo: "INV-2606-014",
    invoiceDate: "2026-06-11T00:00:00.000Z",
    doNo: "DO-2606-031",
    customerName: "Houzs Century Sdn Bhd",
    customerPOIds: ["PO-009003"],
    deliveredAt: "2026-06-11T07:45:00.000Z",
    totalSen: 1234567,
  });
  assert.equal(
    tpl.subject,
    "Invoice INV-2606-014 — Goods Delivered | HOOKKA INDUSTRIES",
  );
  for (const out of [tpl.html, tpl.text]) {
    assert.match(out, /INV-2606-014/);
    assert.match(out, /DO-2606-031/);
    assert.match(out, /RM 12,345\.67/);
    assert.match(out, /PO-009003/);
    assert.match(out, /Kindly arrange payment in accordance with the agreed terms/);
    assert.match(out, /If payment has already been made, please disregard this notice/);
    assert.match(out, /HOOKKA INDUSTRIES SDN BHD/);
  }
});

test("templates: no bank details, no unsubscribe footer, English only", () => {
  const d = dispatchNoticeTemplate({
    doNo: "DO-1",
    customerName: "C",
    dispatchedAt: null,
    deliverTo: "X",
    hasAttachment: true,
  });
  const i = invoiceNoticeTemplate({
    invoiceNo: "INV-1",
    invoiceDate: null,
    doNo: "DO-1",
    customerName: "C",
    deliveredAt: null,
    totalSen: 100,
  });
  for (const out of [d.html, d.text, i.html, i.text]) {
    assert.doesNotMatch(out, /bank|account no/i, "no bank details");
    assert.doesNotMatch(out, /unsubscribe/i, "no unsubscribe footer");
    assert.doesNotMatch(
      out,
      /[\u4E00-\u9FFF]/,
      "UI/email content must be 100% English",
    );
  }
});

// ---------------------------------------------------------------------------
// CN dispatch notice — the CN twin (2026-06-11). DISPATCH ONLY: consignment
// notes never have invoices, so there is no CN invoice template to test.
// ---------------------------------------------------------------------------

test("CN dispatch template: subject + body carry cnNo, items, deliver-to, Malaysia time", () => {
  const tpl = cnDispatchNoticeTemplate({
    cnNo: "CGN-2606-001",
    customerName: "Houzs Century Sdn Bhd",
    dispatchedAt: "2026-06-11T03:30:00.000Z", // = 11:30 AM in Malaysia (UTC+8)
    deliverTo: "Houzs KL, 12 Jalan Example, 47000 Sungai Buloh",
    itemsSummary: "3 × HB Alpha King, 2 × Stool",
    hasAttachment: true,
    driverName: "Ah Seng",
    driverContact: "012-3456789",
    lorryPlate: "BHM9130",
  });
  assert.equal(
    tpl.subject,
    "Goods Dispatched — Consignment Note CGN-2606-001 | HOOKKA INDUSTRIES",
  );
  for (const out of [tpl.html, tpl.text]) {
    assert.match(out, /CGN-2606-001/);
    assert.match(out, /Dear Houzs Century Sdn Bhd/);
    assert.match(out, /3 × HB Alpha King, 2 × Stool/);
    assert.match(out, /Houzs KL/);
    assert.match(out, /Ah Seng/);
    assert.match(out, /012-3456789/);
    assert.match(out, /BHM9130/);
    // Dispatch Date carries the TIME, rendered in Asia/Kuala_Lumpur, not UTC.
    assert.match(out, /11:30\s*AM/i);
    assert.match(out, /Please find the Consignment Note attached/);
    assert.match(out, /HOOKKA INDUSTRIES SDN BHD/);
  }
  // Receiving-team instruction references the Consignment Note, not the DO.
  assert.match(
    tpl.text,
    /check the goods against the Consignment Note upon arrival/,
  );
  assert.doesNotMatch(tpl.text, /Delivery Order/);
});

test("CN dispatch template: carrier rows omitted when blank (CNs often have no 3PL)", () => {
  const bare = cnDispatchNoticeTemplate({
    cnNo: "CGN-2606-002",
    customerName: "Carress",
    dispatchedAt: null,
    deliverTo: "Carress PG",
    itemsSummary: "",
    hasAttachment: false,
  });
  for (const out of [bare.html, bare.text]) {
    assert.doesNotMatch(out, /Driver/);
    assert.doesNotMatch(out, /Contact No\./);
    assert.doesNotMatch(out, /Lorry Plate/);
    assert.doesNotMatch(out, /Items/);
  }
  // The fully-empty carrier block renders cleanly — the core rows survive.
  assert.match(bare.text, /Consignment Note No\. : CGN-2606-002/);
  assert.match(bare.text, /Deliver To           : Carress PG/);
});

test("CN dispatch template: 'attached' line dropped when no PDF made it", () => {
  const tpl = cnDispatchNoticeTemplate({
    cnNo: "CGN-2606-003",
    customerName: "Carress",
    dispatchedAt: null,
    deliverTo: "Carress PG",
    hasAttachment: false,
  });
  assert.doesNotMatch(tpl.html, /Please find the Consignment Note attached/);
  // The receiving-team check instruction stays either way.
  assert.match(tpl.text, /check the goods against the Consignment Note/);
});

test("CN dispatch template: no bank details, no unsubscribe, English only", () => {
  const tpl = cnDispatchNoticeTemplate({
    cnNo: "CGN-1",
    customerName: "C",
    dispatchedAt: null,
    deliverTo: "X",
    hasAttachment: true,
  });
  for (const out of [tpl.html, tpl.text]) {
    assert.doesNotMatch(out, /bank|account no/i, "no bank details");
    assert.doesNotMatch(out, /unsubscribe/i, "no unsubscribe footer");
    assert.doesNotMatch(
      out,
      /[\u4E00-\u9FFF]/,
      "UI/email content must be 100% English",
    );
  }
});

test("fmtEmailDate / fmtEmailRM formatting", () => {
  assert.equal(fmtEmailDate(null), "-");
  assert.equal(fmtEmailDate("not-a-date"), "-");
  assert.match(fmtEmailDate("2026-06-11T00:00:00.000Z"), /^11 Jun 2026$/);
  assert.equal(fmtEmailRM(1234567), "RM 12,345.67");
  assert.equal(fmtEmailRM(0), "RM 0.00");
});

// ---------------------------------------------------------------------------
// Component breakdown — same Packing-List tally that feeds the PDF.
// ---------------------------------------------------------------------------

test("breakdown: bedframe pieces + sofa set → '3 × Headboard, 3 × Divan, 2 × Sofa'", () => {
  const items = [
    { id: "a", quantity: 3 },
    { id: "b", quantity: 1 },
  ];
  const extras = {
    items: {
      a: { itemCategory: "BEDFRAME", pieces: "3 HB + 3 DIVAN" },
      b: { itemCategory: "SOFA", pieces: "1 1A(LHF) + 1 2A" },
    },
  };
  assert.equal(
    buildDoComponentBreakdown(items, extras),
    "3 × Headboard, 3 × Divan, 2 × Sofa",
  );
});

test("breakdown: pieces-less line falls back to quantity × category", () => {
  const items = [
    { id: "a", quantity: 2 },
    { id: "b", quantity: 5 },
  ];
  const extras = {
    items: {
      a: { itemCategory: "ACCESSORY", pieces: null },
      // b has no extras entry at all → generic Item bucket
    },
  };
  assert.equal(
    buildDoComponentBreakdown(items, extras),
    "2 × Accessory, 5 × Item",
  );
});

test("breakdown: single sofa variant without a leading count still counts as 1", () => {
  // generate-do-pdf's fmtPieces drops the leading '1' for digit-led sofa
  // variants ("1A(LHF)"); the tally must not lose those pieces.
  const items = [{ id: "a", quantity: 1 }];
  const extras = { items: { a: { itemCategory: "SOFA", pieces: "1A(LHF)" } } };
  assert.equal(buildDoComponentBreakdown(items, extras), "1 × Sofa");
});

test("breakdown: empty DO → empty string (Items row omitted)", () => {
  assert.equal(buildDoComponentBreakdown([], {}), "");
});

test("collectCustomerPOIds: distinct per-line POs, DO-level fallback", () => {
  const items = [
    { id: "a", quantity: 1 },
    { id: "b", quantity: 1 },
    { id: "c", quantity: 1 },
  ];
  const extras = {
    items: {
      a: { customerPOId: "PO-1" },
      b: { customerPOId: "PO-1" },
      c: { customerPOId: "PO-2" },
    },
  };
  assert.deepEqual(collectCustomerPOIds(items, extras, "PO-9"), ["PO-1", "PO-2"]);
  // No per-line POs → DO-level fallback; nothing anywhere → [].
  assert.deepEqual(collectCustomerPOIds(items, {}, "PO-9"), ["PO-9"]);
  assert.deepEqual(collectCustomerPOIds(items, {}, ""), []);
});

// ---------------------------------------------------------------------------
// Outbox attachments — size cap + parsing.
// ---------------------------------------------------------------------------

test("base64DecodedBytes: exact decoded sizes incl. padding", () => {
  // "AAAA" = 3 bytes, "AAA=" = 2 bytes, "AA==" = 1 byte.
  assert.equal(base64DecodedBytes("AAAA"), 3);
  assert.equal(base64DecodedBytes("AAA="), 2);
  assert.equal(base64DecodedBytes("AA=="), 1);
  assert.equal(base64DecodedBytes(""), 0);
});

test("sanitizeAttachments: valid attachment passes through trimmed", () => {
  const out = sanitizeAttachments([
    { filename: " DO-2606-031.pdf ", contentBase64: "AAAA" },
  ]);
  assert.deepEqual(out, [
    { filename: "DO-2606-031.pdf", contentBase64: "AAAA" },
  ]);
});

test("sanitizeAttachments: oversize (>5 MB decoded) → null (enqueue WITHOUT attachment)", () => {
  // ~6 MB decoded: 8 M base64 chars → 6 M bytes.
  const big = "A".repeat(8 * 1024 * 1024);
  assert.ok(base64DecodedBytes(big) > MAX_ATTACHMENT_TOTAL_BYTES);
  const origWarn = console.warn;
  let warned = "";
  console.warn = (...args) => {
    warned += args.join(" ");
  };
  try {
    assert.equal(sanitizeAttachments([{ filename: "big.pdf", contentBase64: big }]), null);
  } finally {
    console.warn = origWarn;
  }
  assert.match(warned, /attachments dropped/);
});

test("sanitizeAttachments: blank/malformed entries dropped; all-blank → null", () => {
  assert.equal(
    sanitizeAttachments([{ filename: "", contentBase64: "AAAA" }]),
    null,
  );
  assert.equal(
    sanitizeAttachments([{ filename: "x.pdf", contentBase64: "" }]),
    null,
  );
  assert.equal(sanitizeAttachments(undefined), null);
  assert.equal(sanitizeAttachments([]), null);
});

// ---------------------------------------------------------------------------
// Structural pins — source-text assertions in the service-hub-chain.test.mjs
// style, so a refactor can't silently drop a link of the chain.
// ---------------------------------------------------------------------------

const outboxSrc = readFileSync(
  new URL("../src/api/lib/email-outbox.ts", import.meta.url),
  "utf8",
);
const emailSrc = readFileSync(
  new URL("../src/api/lib/email.ts", import.meta.url),
  "utf8",
);
const doRouteSrc = readFileSync(
  new URL("../src/api/routes/delivery-orders.ts", import.meta.url),
  "utf8",
);
const pageSrc = readFileSync(
  new URL("../src/pages/delivery/index.tsx", import.meta.url),
  "utf8",
);

function count(haystack, regex) {
  return (haystack.match(regex) ?? []).length;
}

test("outbox: attachments_json stored on enqueue and read back by the drain", () => {
  assert.match(
    outboxSrc,
    /INSERT INTO outbox_emails \(id, to_address, subject, body_html, body_text, payload_json, attachments_json, org_id\)/,
    "enqueue INSERT must include attachments_json",
  );
  assert.match(
    outboxSrc,
    /attachments_json AS "attachmentsJson"/,
    "drain SELECT must alias attachments_json",
  );
  // Self-apply guard exists and runs on BOTH the enqueue and drain paths.
  assert.match(
    outboxSrc,
    /ALTER TABLE outbox_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT/,
  );
  assert.equal(
    count(outboxSrc, /await ensureOutboxMigrations\(/g),
    2,
    "ensureOutboxMigrations must run at enqueue AND drain",
  );
  // The status CHECK must allow 'SENDING' — the atomic-claim status the drain
  // sets on a row BEFORE sending. Migration 0081 omitted it, so the claim
  // UPDATE violated outbox_emails_status_check and THREW, 500ing the whole
  // drain (2026-06-24: 50 customer notices stuck). Runtime self-apply widens it.
  assert.match(
    outboxSrc,
    /ADD CONSTRAINT outbox_emails_status_check CHECK \(status IN \('PENDING','SENDING','RETRYING','SENT','FAILED'\)\)/,
    "ensureOutboxMigrations must widen the status CHECK to allow 'SENDING'",
  );
  // The drain forwards stored attachments into the provider send. Body +
  // attachments are fetched PER ROW (`full`), NOT in the batch pick, so a queue
  // of PDF-bearing invoices can't OOM the drain (2026-06-24 strand bug: 50
  // customer notices stuck PENDING because the 25-row pick of PDF base64 threw).
  assert.match(
    outboxSrc,
    /attachments: parseStoredAttachments\(full\?\.attachmentsJson/,
    "drain sendMail call must pass the stored attachments (per-row fetch)",
  );
  assert.match(
    outboxSrc,
    /FROM outbox_emails WHERE id = \? LIMIT 1/,
    "drain must fetch each row's body+attachments PER ROW (the batch pick is " +
      "metadata-only) so a PDF-heavy queue can't blow the Worker memory budget",
  );
  assert.match(
    outboxSrc,
    /catch \(rowErr\)/,
    "drain must isolate a poison row (per-row try/catch marks it FAILED/" +
      "RETRYING with the error) so one bad row can never strand the whole batch",
  );
});

test("providers: Resend gets attachments[{filename,content}], Brevo gets attachment[{name,content}]", () => {
  assert.match(
    emailSrc,
    /attachments: args\.attachments\.map\(\(a\) => \(\{\s*filename: a\.filename,\s*content: a\.contentBase64,\s*\}\)\)/,
    "Resend payload must map attachments to {filename, content}",
  );
  assert.match(
    emailSrc,
    /attachment: args\.attachments\.map\(\(a\) => \(\{\s*name: a\.filename,\s*content: a\.contentBase64,\s*\}\)\)/,
    "Brevo payload must map attachments to {name, content}",
  );
});

test("migration 0161 exists and is additive", () => {
  const sql = readFileSync(
    new URL("../migrations-postgres/0161_outbox_attachments.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    /ALTER TABLE outbox_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT;/,
  );
});

test("notify-customer endpoint: RBAC, status guards, no-recipient skip, no-invoice skip", () => {
  assert.match(
    doRouteSrc,
    /app\.post\("\/:id\/notify-customer", async \(c\) => \{\s*\/\/[^\n]*\n\s*const denied = await requirePermission\(c, "delivery-orders", "update"\);/,
    "endpoint must gate on delivery-orders:update",
  );
  // 409 guards for stray calls.
  assert.match(
    doRouteSrc,
    /Dispatch notice requires a dispatched DO \(LOADED\/IN_TRANSIT\)/,
  );
  assert.match(
    doRouteSrc,
    /Invoice notice requires a delivered DO \(DELIVERED\/INVOICED\)/,
  );
  // Both-blank recipients → skip without recording anything.
  assert.match(doRouteSrc, /skipped: true, reason: "no recipient"/);
  // Invoice notice without an invoice row → skip.
  assert.match(doRouteSrc, /skipped: true, reason: "no invoice"/);
  // Numbers come from the DB row, not the caller: the invoice is resolved
  // by deliveryOrderId exactly like loadDoInvoiceMap (live, non-cancelled).
  assert.match(
    doRouteSrc,
    /WHERE deliveryOrderId = \? AND status <> 'CANCELLED'\s*\n\s*ORDER BY createdAt DESC/,
  );
  // Server-rendered fallback invoice PDF via the shared helper.
  assert.match(doRouteSrc, /await buildSimpleTablePdf\(\{/);
});

test("notify-customer idempotency: runtime columns, dual-key reads, atomic claim", () => {
  // Self-applied stamp columns (unquoted camelCase folds lowercase).
  assert.match(
    doRouteSrc,
    /ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS dispatchEmailAt TEXT/,
  );
  assert.match(
    doRouteSrc,
    /ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS deliveredEmailAt TEXT/,
  );
  // Dual-key reads per BUG-2026-06-11-007 (folded-lowercase runtime columns).
  assert.match(
    doRouteSrc,
    /doRow\.dispatchEmailAt \?\? doRow\.dispatchemailat/,
  );
  assert.match(
    doRouteSrc,
    /doRow\.deliveredEmailAt \?\? doRow\.deliveredemailat/,
  );
  // Atomic claim so a double-click can't double-send.
  assert.match(
    doRouteSrc,
    /UPDATE delivery_orders SET \$\{stampCol\} = \? WHERE id = \? AND \$\{stampCol\} IS NULL/,
  );
  assert.match(doRouteSrc, /skipped: true, reason: "already sent"/);
  // Enqueue failure releases the claim (transition itself is never touched).
  assert.match(
    doRouteSrc,
    /UPDATE delivery_orders SET \$\{stampCol\} = NULL WHERE id = \?/,
  );
});

test("frontend: bulk + single transition paths fire the notify flow", () => {
  // The one-DO sender posts to the endpoint with the PDF + breakdown built
  // from ONE print-extras object.
  assert.match(
    pageSrc,
    /async function sendCustomerNotice\(\s*row: DeliveryOrderRow,\s*kind: "DISPATCHED" \| "DELIVERED",/,
  );
  assert.match(pageSrc, /\/notify-customer`,/);
  assert.match(pageSrc, /buildDoComponentBreakdown\(row\.items, extras\)/);
  // The customer email carries the SAME jsPDF the operator prints/downloads
  // (fix 2026-07-04 BUG-...-005: the earlier pdf-lib "unified" render was a
  // second engine that looked different/"歪" → now renders via the print
  // generators generateDoPdfBase64 / generateInvoicePdfBase64).
  assert.match(pageSrc, /generateDoPdfBase64\(/);
  assert.match(pageSrc, /generateInvoicePdfBase64\(/);
  // runBulkDoTransition (bulk buttons + PL-level bulk reuse) notifies every
  // DO that actually transitioned, mapping LOADED→DISPATCHED.
  assert.match(
    pageSrc,
    /notifyCustomersAfterTransition\(\s*deliveryOrders\.filter\(\(d\) => succeededIds\.includes\(d\.id\)\),\s*nextStatus === "LOADED" \? "DISPATCHED" : "DELIVERED",\s*\);/,
  );
  // Single-DO paths: row action + detail modal (dispatch), POD submit
  // (delivered).
  assert.equal(
    count(pageSrc, /notifyCustomersAfterTransition\(\[row\], "DISPATCHED"\)/g),
    1,
    "row-action Mark Dispatched must notify",
  );
  assert.equal(
    count(pageSrc, /notifyCustomersAfterTransition\(\[detailDO\], "DISPATCHED"\)/g),
    1,
    "detail-modal Mark Dispatched must notify",
  );
  assert.equal(
    count(pageSrc, /notifyCustomersAfterTransition\(\[podDialog\], "DELIVERED"\)/g),
    1,
    "POD submit (Mark Delivered) must notify",
  );
  // Summary toast shape from the spec.
  assert.match(pageSrc, /Dispatch notice emailed for \$\{queued\} DO\(s\)/);
  assert.match(pageSrc, /Invoice notice emailed for \$\{queued\} DO\(s\)/);
});

// ---------------------------------------------------------------------------
// CN twin — structural pins (2026-06-11). Same source-text style as the DO
// pins above so a refactor can't silently drop a link of the CN chain.
// ---------------------------------------------------------------------------

const cnRouteSrc = readFileSync(
  new URL("../src/api/routes/consignment-notes.ts", import.meta.url),
  "utf8",
);
const cnPageSrc = readFileSync(
  new URL("../src/pages/consignment/note.tsx", import.meta.url),
  "utf8",
);
const cnPdfSrc = readFileSync(
  new URL("../src/lib/generate-cn-pdf.ts", import.meta.url),
  "utf8",
);

test("CN notify endpoint: RBAC, dispatch-only kind, status guard, no-recipient skip", () => {
  assert.match(
    cnRouteSrc,
    /app\.post\("\/:id\/notify-customer", async \(c\) => \{\s*\/\/[^\n]*\n\s*const denied = await requirePermission\(c, "consignment-notes", "update"\);/,
    "endpoint must gate on consignment-notes:update",
  );
  // Any kind other than "dispatch" is a 400 — CNs never have invoice emails.
  assert.match(cnRouteSrc, /if \(body\.kind !== "dispatch"\) \{/);
  assert.match(
    cnRouteSrc,
    /consignment notes have no invoice emails/,
    "400 message must say CNs have no invoice emails",
  );
  // 409 guard for stray calls (dispatched CN states only).
  assert.match(
    cnRouteSrc,
    /Dispatch notice requires a dispatched CN \(PARTIALLY_SOLD\/IN_TRANSIT\)/,
  );
  // Both-blank recipients → skip without recording anything (DO parity).
  assert.match(cnRouteSrc, /resolveDispatchRecipient\(hubEmail, customer\?\.email\)/);
  assert.match(cnRouteSrc, /skipped: true, reason: "no recipient"/);
  // No invoice / delivered email anywhere on the CN notify path.
  assert.doesNotMatch(cnRouteSrc, /invoiceNoticeTemplate/);
  assert.doesNotMatch(cnRouteSrc, /deliveredEmailAt|deliveredemailat/);
});

test("CN notify idempotency: folded-lowercase runtime column, dual-key read, atomic claim", () => {
  // Self-applied stamp column, spelled folded-lowercase in the DDL.
  assert.match(
    cnRouteSrc,
    /ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS dispatchemailat TEXT/,
  );
  // Dual-key read per BUG-2026-06-11-007 (runtime columns live folded).
  assert.match(cnRouteSrc, /cn\.dispatchEmailAt \?\? cn\.dispatchemailat/);
  // Atomic claim so a double-click can't double-send.
  assert.match(
    cnRouteSrc,
    /UPDATE consignment_notes SET dispatchemailat = \? WHERE id = \? AND dispatchemailat IS NULL/,
  );
  assert.match(cnRouteSrc, /skipped: true, reason: "already sent"/);
  // Enqueue failure releases the claim (transition itself is never touched).
  assert.match(
    cnRouteSrc,
    /UPDATE consignment_notes SET dispatchemailat = NULL WHERE id = \?/,
  );
});

test("CN notify: 5 MB pre-check runs BEFORE templating; hasAttachment never lies", () => {
  const capIdx = cnRouteSrc.indexOf(
    "const PDF_ATTACH_CAP_BYTES = 5 * 1024 * 1024;",
  );
  const tplIdx = cnRouteSrc.indexOf("cnDispatchNoticeTemplate({");
  assert.ok(capIdx > 0, "5 MB cap must exist on the CN notify path");
  assert.ok(tplIdx > capIdx, "5 MB cap must be computed before templating");
  // Same decoded-size math as the DO endpoint.
  assert.match(
    cnRouteSrc,
    /Math\.floor\(pdfBase64\.length \* 0\.75\) > PDF_ATTACH_CAP_BYTES/,
  );
  // The template's "attached" line follows the actual attachments value.
  assert.match(cnRouteSrc, /hasAttachment: !!attachments/);
});

test("CN PDF: base64 export reuses the shared render/stamp path (no layout fork)", () => {
  assert.match(
    cnPdfSrc,
    /export function generateCnPdfBase64\(data: CNPdfData\): string \{\s*\n\s*const doc = new jsPDF\(\{ orientation: "portrait", unit: "mm", format: "a4", compress: true \}\);\s*\n\s*renderCnInto\(doc, data\);\s*\n\s*stampCnFooters\(doc\);/,
    "base64 export must render via renderCnInto + stampCnFooters",
  );
});

test("CN page: single + bulk dispatch paths fire the notify flow (dispatch only)", () => {
  // The fire-and-forget sender posts kind "dispatch" with the PDF from the
  // SAME buildCnPdfData payload the Print buttons use.
  assert.match(cnPageSrc, /\/notify-customer`,/);
  assert.match(
    cnPageSrc,
    /JSON\.stringify\(\{ kind: "dispatch", pdfBase64, pdfFilename \}\)/,
  );
  assert.match(cnPageSrc, /generateCnPdfBase64\(buildCnPdfData\(row\)\)/);
  // Single path: the Mark Dispatched dialog confirm notifies after success.
  assert.equal(
    count(cnPageSrc, /notifyCnCustomersAfterDispatch\(\[\s*\n?\s*\{\s*\n?\s*\.\.\.dispatchDialog,/g),
    1,
    "dialog confirm (single Mark Dispatched) must notify",
  );
  // Bulk path: runBulkCnTransition notifies every CN that actually moved
  // into PARTIALLY_SOLD — and ONLY on the dispatch transition.
  assert.match(
    cnPageSrc,
    /if \(nextStatus === "PARTIALLY_SOLD"\) \{\s*\n\s*notifyCnCustomersAfterDispatch\(\s*\n\s*cnList\.filter\(\(c\) => succeededIds\.includes\(c\.id\)\),\s*\n\s*\);/,
    "bulk Mark Dispatched must notify the succeeded rows only",
  );
  // Summary toast shape mirrors the DO side.
  assert.match(cnPageSrc, /Dispatch notice emailed for \$\{queued\} CN\(s\)/);
  // No invoice/delivered notice anywhere on the CN page.
  assert.doesNotMatch(cnPageSrc, /Invoice notice emailed/);
});

test("migration 0163 exists and is additive (folded-lowercase column)", () => {
  const sql = readFileSync(
    new URL(
      "../migrations-postgres/0163_consignment_notes_dispatch_email.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    sql,
    /ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS dispatchemailat TEXT;/,
  );
  // The folded-lowercase spelling, never camelCase, in the migration SQL
  // statement itself (the header comment may reference the dual-key read).
  assert.match(sql, /dispatchemailat TEXT;/);
});

// ---------------------------------------------------------------------------
// BACKEND choke-point trigger (BUG-2026-06-23). The customer notice used to
// fire ONLY from a handful of React buttons, so any transition driven through
// a path the FE didn't cover (driver-sticker QR scan, bulk/list action with a
// stale row set, the "Generate Invoice" button) sent nothing AND stamped
// nothing — the signature of Houzs's 128 INVOICED DOs with null dispatch/
// delivered stamps. The fix wires queueDoCustomerNotice into the single
// backend transition choke-point (applyDeliveryOrderUpdate) PLUS the manual
// invoice-create path, so every way a DO becomes DISPATCHED/DELIVERED emails
// the customer regardless of which UI/driver path drove it. These pins assert
// the wiring can't be silently dropped by a refactor.
// ---------------------------------------------------------------------------

const invRouteSrc = readFileSync(
  new URL("../src/api/routes/invoices.ts", import.meta.url),
  "utf8",
);

test("backend choke-point: fire-and-forget notice helper is non-blocking + idempotent + error-swallowing", () => {
  // The helper exists and is exported (invoices.ts imports it).
  assert.match(
    doRouteSrc,
    /export function fireCustomerNoticeBestEffort\(\s*c: Context<Env>,\s*deliveryOrderId: string,\s*kind: "DISPATCHED" \| "DELIVERED",\s*\): void \{/,
    "fireCustomerNoticeBestEffort must be exported with the DISPATCHED|DELIVERED kind",
  );
  // It calls the SAME queueDoCustomerNotice the FE endpoint uses — so the
  // recipient chain, no-recipient skip, server PDF fallback and the atomic
  // idempotency claim are all reused (no second, divergent send path).
  assert.match(
    doRouteSrc,
    /const res = await queueDoCustomerNotice\(c, deliveryOrderId, \{ kind \}\);/,
  );
  // Non-blocking: queued via executionCtx.waitUntil so it never holds, fails,
  // or rolls back the already-committed transition.
  assert.match(doRouteSrc, /if \(ctx\?\.waitUntil\) \{\s*\n\s*ctx\.waitUntil\(run\);/);
  // Error-swallowing: a notice hiccup must never escape onto the transition's
  // response path (it warns, the FE trigger / cron stay as backups).
  assert.match(
    doRouteSrc,
    /backend \$\{kind\} customer notice failed/,
  );
});

test("backend choke-point: applyDeliveryOrderUpdate fires DISPATCHED on →LOADED and DELIVERED on →DELIVERED/INVOICED", () => {
  // DISPATCH boundary — any transition that lands the DO in LOADED (covers the
  // driver QR scan and bulk dispatch, not just the DRAFT→LOADED office click).
  assert.match(
    doRouteSrc,
    /if \(existing\.status !== "LOADED" && nextStatus === "LOADED"\) \{\s*\n\s*fireCustomerNoticeBestEffort\(c, id, "DISPATCHED"\);/,
  );
  // DELIVERED boundary — the move into DELIVERED (invoice notice via the
  // auto-created invoice) AND a direct DELIVERED→INVOICED bare flip
  // ("Convert to Invoice"), so that path also notifies.
  assert.match(
    doRouteSrc,
    /if \(\s*\n\s*existing\.status !== "DELIVERED" &&\s*\n\s*existing\.status !== "INVOICED" &&\s*\n\s*\(nextStatus === "DELIVERED" \|\| nextStatus === "INVOICED"\)\s*\n\s*\) \{\s*\n\s*fireCustomerNoticeBestEffort\(c, id, "DELIVERED"\);/,
  );
  // The firing happens AFTER the batch commits (the transition is durable
  // before any email work) and inside applyDeliveryOrderUpdate, the single
  // choke-point the office PUT and the public QR scan both funnel through.
  const batchIdx = doRouteSrc.indexOf("await c.var.DB.batch(statements);");
  const dispatchFireIdx = doRouteSrc.indexOf(
    'fireCustomerNoticeBestEffort(c, id, "DISPATCHED");',
  );
  assert.ok(batchIdx > 0 && dispatchFireIdx > batchIdx);
});

test("backend choke-point: manual 'Generate Invoice' (invoices.ts POST) also fires the DELIVERED notice", () => {
  // The DELIVERED→INVOICED manual path does NOT pass through
  // applyDeliveryOrderUpdate, so it imports + calls the same helper itself.
  assert.match(
    invRouteSrc,
    /const \{ ensureDeliveryIncompleteColumn, fireCustomerNoticeBestEffort \} =\s*\n\s*await import\("\.\/delivery-orders"\);/,
    "invoices.ts must pull fireCustomerNoticeBestEffort via the call-time import (cycle-safe)",
  );
  assert.match(
    invRouteSrc,
    /fireCustomerNoticeBestEffort\(c, doRow\.id, "DELIVERED"\);/,
  );
  // Fired AFTER the batch commits (DO is now INVOICED + the invoice row exists,
  // so queueDoCustomerNotice can resolve it) and BEFORE the success return.
  const invBatchIdx = invRouteSrc.indexOf("await c.var.DB.batch(statements);");
  const invFireIdx = invRouteSrc.indexOf(
    'fireCustomerNoticeBestEffort(c, doRow.id, "DELIVERED");',
  );
  const invReturnIdx = invRouteSrc.indexOf(
    "return c.json({ success: true, data: created }, 201);",
  );
  assert.ok(invBatchIdx > 0 && invFireIdx > invBatchIdx && invReturnIdx > invFireIdx);
});

test("backend choke-point: double-send is prevented by the SAME idempotency claim the FE trigger uses", () => {
  // There is exactly ONE atomic claim UPDATE in the route — both the backend
  // choke-point call and the surviving FE notify endpoint go through
  // queueDoCustomerNotice, so whichever wins the claim sends once and the
  // loser's claim matches zero rows and no-ops.
  assert.equal(
    count(
      doRouteSrc,
      /UPDATE delivery_orders SET \$\{stampCol\} = \? WHERE id = \? AND \$\{stampCol\} IS NULL/g,
    ),
    1,
    "exactly one atomic claim — the single guard both triggers share",
  );
  // The FE trigger is NOT removed (it delivers the nicer branded PDF when it
  // wins the race); the backend call is the catch-all. Both still present.
  assert.match(pageSrc, /\/notify-customer`,/);
  assert.match(doRouteSrc, /fireCustomerNoticeBestEffort\(c, id, /);
});

// ---------------------------------------------------------------------------
// FEATURE A — per-DO Resend notice (2026-06-24). Many DOs were
// delivered/invoiced BEFORE the backend choke-point trigger shipped, so their
// deliveredEmailAt/dispatchEmailAt stamps are null AND the customer was never
// emailed. The normal notice is one-shot (atomic claim on the stamp), so a
// force re-send must FIRST clear the stamp, THEN call the SAME
// queueDoCustomerNotice (no duplicate send path). These pins assert the
// endpoint clears the stamp + re-fires the shared helper, is admin-gated,
// reuses the recipient chain + no-recipient skip, and reports what happened.
// ---------------------------------------------------------------------------

test("resend-notice endpoint: admin-gated, validates kind", () => {
  // Same delivery-orders:update gate every DO mutation uses.
  assert.match(
    doRouteSrc,
    /app\.post\("\/:id\/resend-notice", async \(c\) => \{[\s\S]*?const denied = await requirePermission\(c, "delivery-orders", "update"\);/,
    "resend-notice must gate on delivery-orders:update",
  );
  // kind is validated to the two fixed literals (anything else → 400).
  assert.match(
    doRouteSrc,
    /body\.kind === "DISPATCHED" \|\| body\.kind === "DELIVERED"\s*\?\s*body\.kind\s*:\s*null/,
  );
  assert.match(
    doRouteSrc,
    /kind must be "DISPATCHED" or "DELIVERED"/,
  );
});

test("resend-notice endpoint: clears the stamp THEN re-fires queueDoCustomerNotice (no duplicate send)", () => {
  // stampCol is the same two fixed literals as the auto-notice path.
  assert.match(
    doRouteSrc,
    /const stampCol =\s*\n\s*kind === "DISPATCHED" \? "dispatchEmailAt" : "deliveredEmailAt";\s*\n\s*await c\.var\.DB\.prepare\(\s*\n\s*`UPDATE delivery_orders SET \$\{stampCol\} = NULL WHERE id = \?`,\s*\n\s*\)/,
    "resend must clear the relevant stamp to NULL so the atomic claim can re-fire",
  );
  // The re-fire goes through the SAME helper (recipient chain + server PDF
  // fallback + no-recipient skip + the atomic re-claim) — no second send path.
  // It forwards any client-rendered pdfBase64 so an edited invoice re-sends the
  // exact document the operator sees.
  assert.match(
    doRouteSrc,
    /const res = await queueDoCustomerNotice\(c, id, \{\s*\n\s*kind,\s*\n\s*pdfBase64: body\.pdfBase64,\s*\n\s*pdfFilename: body\.pdfFilename,\s*\n\s*\}\);/,
  );
  // The clear must come BEFORE the queueDoCustomerNotice call (order matters:
  // queue's claim only fires when the column it just cleared is NULL).
  const resendIdx = doRouteSrc.indexOf('app.post("/:id/resend-notice"');
  assert.ok(resendIdx > 0, "resend-notice route must exist");
  const resendBody = doRouteSrc.slice(resendIdx, resendIdx + 3500);
  const clearIdx = resendBody.indexOf(
    "UPDATE delivery_orders SET ${stampCol} = NULL WHERE id = ?",
  );
  const fireIdx = resendBody.indexOf(
    "await queueDoCustomerNotice(c, id, {",
  );
  assert.ok(
    clearIdx > 0 && fireIdx > clearIdx,
    "the stamp clear must precede the queueDoCustomerNotice re-fire",
  );
});

test("resend-notice endpoint: reports sent / skipped-no-email / error", () => {
  const resendIdx = doRouteSrc.indexOf('app.post("/:id/resend-notice"');
  const resendBody = doRouteSrc.slice(resendIdx, resendIdx + 4400);
  // Success → { success:true, sent:true, to }.
  assert.match(resendBody, /return c\.json\(\{ success: true, sent: true, to: j\?\.to \}\);/);
  // queueDoCustomerNotice's skip (no recipient / no invoice) → sent:false +
  // the reason, so the FE can warn "<customer> has no email on file".
  assert.match(
    resendBody,
    /sent: false,\s*\n\s*skipped: true,\s*\n\s*reason: j\?\.reason/,
  );
  // Hard failures surface the helper's error.
  assert.match(resendBody, /success: false, error: j\?\.error \|\| "Failed to re-send notice"/);
  // 404 when the DO does not exist.
  assert.match(resendBody, /"Delivery order not found"/);
  // Columns are guaranteed to exist before clearing one (pre-feature DOs).
  assert.match(resendBody, /await ensureNotifyEmailColumns\(c\.var\.DB\);/);
});

test("resend-notice: deliberately PER-DO — no auto-blast-all endpoint", () => {
  // The spec forbids a bulk auto-blast of the backlog (e.g. Houzs's 128 DOs at
  // once = spam). There must be no "resend-all" / bulk-resend route.
  assert.doesNotMatch(doRouteSrc, /resend-all|resend-notices|bulk-resend/i);
});

test("frontend: Feature A Resend wiring (detail footer + row menu) + Feature B no-email warning", () => {
  // The resend handler force-re-fires via the resend-notice endpoint with the
  // kind in the body, and toasts the outcome.
  assert.match(pageSrc, /\/resend-notice`,/);
  assert.match(
    pageSrc,
    /const resendCustomerNotice = async \(/,
  );
  // Confirm dialog before sending ("Re-send the <noun> email for <doNo> to
  // <email>?"), reusing useConfirm (not window.confirm).
  assert.match(pageSrc, /Re-send the \$\{noun\} email for \$\{row\.doNo\} to \$\{email\}\?/);
  // Success toast carries the recipient; no-email path warns instead.
  assert.match(pageSrc, /email re-sent to \$\{j\.to \|\| email\}/);
  // The customer email is read from the loaded customers list via the ref
  // (correct even from the memoized row-menu closure).
  assert.match(
    pageSrc,
    /customersDataRef\.current\.find\(\(cu\) => cu\.id === row\.customerId\)\?\.email/,
  );
  // Detail footer: Resend button for DELIVERED/INVOICED, disabled when no
  // email (with the "No email on file" label/hint).
  assert.match(
    pageSrc,
    /detailDO\.status === "DELIVERED" \|\|\s*\n\s*detailDO\.status === "INVOICED"/,
  );
  assert.match(pageSrc, /No email on file/);
  assert.match(pageSrc, /resendCustomerNotice\(detailDO, "DELIVERED"\)/);
  // Row context menu: "Resend invoice email" entry, gated to delivered/invoiced.
  assert.match(pageSrc, /label: "Resend invoice email"/);
  assert.match(pageSrc, /resendCustomerNotice\(row, "DELIVERED"\)/);

  // Feature B — no-email warning fires at the moment of each customer-notice
  // transition (dispatch, mark delivered, generate invoice) so the operator
  // learns the email didn't send, without blocking the flow.
  assert.match(
    pageSrc,
    /const warnIfNoCustomerEmail = \(/,
  );
  assert.match(pageSrc, /not emailed —/);
  // Wired into the three success points (POD delivered, generate-invoice,
  // both dispatch paths). At least: delivered + dispatch + invoice.
  assert.match(pageSrc, /warnIfNoCustomerEmail\(podDialog, "DELIVERED"\)/);
  assert.match(pageSrc, /warnIfNoCustomerEmail\(invoiceDialog, "DELIVERED"\)/);
  assert.equal(
    count(pageSrc, /warnIfNoCustomerEmail\([^,]+, "DISPATCHED"\)/g),
    2,
    "both dispatch paths (row action + detail modal) must warn on no-email",
  );
});

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
  // The drain forwards stored attachments into the provider send.
  assert.match(
    outboxSrc,
    /attachments: parseStoredAttachments\(row\.attachmentsJson\)/,
    "drain sendMail call must pass the stored attachments",
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

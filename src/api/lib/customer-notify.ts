// ---------------------------------------------------------------------------
// Customer goods-movement notices — templates + recipient rules.
//
// Used by POST /api/delivery-orders/:id/notify-customer (delivery-orders.ts):
//   * DISPATCHED (DO status → LOADED): dispatch notice with the branded DO
//     PDF attached.
//   * DELIVERED  (DO status → DELIVERED): invoice notice with the Invoice
//     PDF attached (an invoice is auto-created by the DELIVERED cascade).
//
// Recipient rules (owner-confirmed 2026-06-11):
//   * Dispatch email: the DO's delivery hub email first; blank → the
//     customer's email; both blank → don't send, don't record anything.
//   * Invoice email: customer email first; fallback hub email; both blank →
//     silently skip.
//
// Wording below is OWNER-APPROVED — keep it verbatim. No bank details, no
// unsubscribe footer. Sender comes from the configured outbox sender
// (RESEND_FROM_EMAIL), nothing to set here.
//
// Deliberately dependency-free (no hono/db imports) so the unit tests in
// tests/customer-notify.test.mjs can import it straight through tsx.
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

const COMPANY_NAME = "HOOKKA INDUSTRIES SDN BHD";
const COMPANY_SHORT = "HOOKKA INDUSTRIES";

const blank = (v: string | null | undefined): boolean =>
  !v || String(v).trim() === "";

/**
 * Dispatch notice recipient: hub email first, customer email second,
 * null when both are blank (caller skips the send entirely).
 */
export function resolveDispatchRecipient(
  hubEmail: string | null | undefined,
  customerEmail: string | null | undefined,
): string | null {
  if (!blank(hubEmail)) return String(hubEmail).trim();
  if (!blank(customerEmail)) return String(customerEmail).trim();
  return null;
}

/**
 * Invoice notice recipient: customer email first, hub email second,
 * null when both are blank (caller skips the send entirely).
 */
export function resolveInvoiceRecipient(
  customerEmail: string | null | undefined,
  hubEmail: string | null | undefined,
): string | null {
  if (!blank(customerEmail)) return String(customerEmail).trim();
  if (!blank(hubEmail)) return String(hubEmail).trim();
  return null;
}

/** ISO timestamp → "11 Jun 2026" (matches the printed documents' fmtDate). */
export function fmtEmailDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Sen → "RM 12,345.67". */
export function fmtEmailRM(sen: number): string {
  const v = (Number(sen) || 0) / 100;
  return `RM ${v.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Same tiny escaper the invite templates use — enough to stop a customer
// name / reference string from injecting tags.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared clean-HTML wrapper: white card, dark header band, simple
// label/value table — same inline-styled family as the invite / supplier-PO
// templates in email.ts.
function wrapHtml(args: {
  headerKicker: string;
  headerTitle: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.headerTitle)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F0ECE9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F1D1B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F0ECE9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;border:1px solid #E2DDD8;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px;background-color:#1F1D1B;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#8B7A4E;font-weight:600;">${escapeHtml(args.headerKicker)}</div>
                <div style="font-size:22px;font-weight:700;margin-top:8px;">${escapeHtml(args.headerTitle)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
${args.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#F0ECE9;border-top:1px solid #E2DDD8;font-size:11px;line-height:1.5;color:#6B7280;text-align:center;">
                ${escapeHtml(COMPANY_NAME)} &middot; ${new Date().getFullYear()}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// One label/value row of the details table. Value is pre-escaped by callers.
function tableRow(label: string, valueHtml: string): string {
  return `                  <tr>
                    <td style="padding:7px 12px;border:1px solid #E2DDD8;background-color:#F7F5F2;font-size:13px;color:#6B7280;white-space:nowrap;width:35%;">${escapeHtml(label)}</td>
                    <td style="padding:7px 12px;border:1px solid #E2DDD8;font-size:13px;font-weight:600;color:#1F1D1B;">${valueHtml}</td>
                  </tr>`;
}

function detailsTable(rows: string[]): string {
  return `                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:18px 0;">
${rows.join("\n")}
                </table>`;
}

const p = (s: string) =>
  `                <p style="margin:0 0 16px;font-size:14px;line-height:1.65;">${s}</p>`;

export interface DispatchNoticeArgs {
  doNo: string;
  customerName: string;
  /** Customer PO numbers covered by this DO. Row omitted when empty. */
  customerPOIds?: string[];
  /** delivery_orders.dispatchedAt (ISO). */
  dispatchedAt: string | null;
  /** Hub shortName + address joined by the caller; falls back to the DO address. */
  deliverTo: string;
  /** Component breakdown, e.g. "3 x Headboard, 3 x Divan, 2 x Sofa". */
  itemsBreakdown?: string;
  /** Whether the DO PDF is actually attached (drives the "attached" line). */
  hasAttachment: boolean;
}

export function dispatchNoticeTemplate(args: DispatchNoticeArgs): EmailTemplate {
  const subject = `Goods Dispatched — Delivery Order ${args.doNo} | ${COMPANY_SHORT}`;
  const poJoined = (args.customerPOIds ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(", ");
  const dispatchDate = fmtEmailDate(args.dispatchedAt);
  const breakdown = (args.itemsBreakdown ?? "").trim();

  const rows: string[] = [tableRow("Delivery Order No.", escapeHtml(args.doNo))];
  if (poJoined) rows.push(tableRow("Your PO No.", escapeHtml(poJoined)));
  rows.push(tableRow("Dispatch Date", escapeHtml(dispatchDate)));
  rows.push(tableRow("Deliver To", escapeHtml(args.deliverTo || "-")));
  if (breakdown) rows.push(tableRow("Items", escapeHtml(breakdown)));

  const attachedLine = args.hasAttachment
    ? "Please find the Delivery Order attached for your records. Kindly have your receiving team check the goods against the Delivery Order upon arrival and note any discrepancy on the delivery copy at the point of receipt."
    : "Kindly have your receiving team check the goods against the Delivery Order upon arrival and note any discrepancy on the delivery copy at the point of receipt.";

  const bodyHtml = [
    p(`Dear ${escapeHtml(args.customerName)},`),
    p(
      "We are pleased to inform you that the goods under the following order have been dispatched and are on their way to your premises:",
    ),
    detailsTable(rows),
    p(escapeHtml(attachedLine)),
    p(
      "Should you have any questions regarding this delivery, please do not hesitate to contact us.",
    ),
    p("Thank you for your business."),
    p(
      `Best regards,<br /><strong>${escapeHtml(COMPANY_NAME)}</strong>`,
    ),
  ].join("\n");

  const textLines = [
    `Dear ${args.customerName},`,
    "",
    "We are pleased to inform you that the goods under the following order have been dispatched and are on their way to your premises:",
    "",
    `  Delivery Order No. : ${args.doNo}`,
    ...(poJoined ? [`  Your PO No.        : ${poJoined}`] : []),
    `  Dispatch Date      : ${dispatchDate}`,
    `  Deliver To         : ${args.deliverTo || "-"}`,
    ...(breakdown ? [`  Items              : ${breakdown}`] : []),
    "",
    attachedLine,
    "",
    "Should you have any questions regarding this delivery, please do not hesitate to contact us.",
    "",
    "Thank you for your business.",
    "",
    "Best regards,",
    COMPANY_NAME,
  ];

  return {
    subject,
    html: wrapHtml({
      headerKicker: "Dispatch Notice",
      headerTitle: `Delivery Order ${args.doNo}`,
      bodyHtml,
    }),
    text: textLines.join("\n"),
  };
}

export interface InvoiceNoticeArgs {
  invoiceNo: string;
  /** invoices.invoiceDate (ISO). */
  invoiceDate: string | null;
  doNo: string;
  customerName: string;
  /** Customer PO numbers covered by this DO. Row omitted when empty. */
  customerPOIds?: string[];
  /** delivery_orders.deliveredAt (ISO). */
  deliveredAt: string | null;
  /** invoices.totalSen — the grand total from the invoice row. */
  totalSen: number;
}

export function invoiceNoticeTemplate(args: InvoiceNoticeArgs): EmailTemplate {
  const subject = `Invoice ${args.invoiceNo} — Goods Delivered | ${COMPANY_SHORT}`;
  const poJoined = (args.customerPOIds ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(", ");
  const deliveredDate = fmtEmailDate(args.deliveredAt);
  const amount = fmtEmailRM(args.totalSen);

  const rows: string[] = [
    tableRow("Invoice No.", escapeHtml(args.invoiceNo)),
    tableRow("Invoice Date", escapeHtml(fmtEmailDate(args.invoiceDate))),
    tableRow("Delivery Order No.", escapeHtml(args.doNo)),
  ];
  if (poJoined) rows.push(tableRow("Your PO No.", escapeHtml(poJoined)));
  rows.push(tableRow("Amount", escapeHtml(amount)));

  const bodyHtml = [
    p(`Dear ${escapeHtml(args.customerName)},`),
    p(
      `We are pleased to confirm that the goods under Delivery Order ${escapeHtml(args.doNo)} were delivered on ${escapeHtml(deliveredDate)}. Please find our invoice attached:`,
    ),
    detailsTable(rows),
    p(
      "Kindly arrange payment in accordance with the agreed terms. If payment has already been made, please disregard this notice.",
    ),
    p(
      "We thank you for your continued business and look forward to serving you again.",
    ),
    p(
      `Best regards,<br /><strong>${escapeHtml(COMPANY_NAME)}</strong>`,
    ),
  ].join("\n");

  const textLines = [
    `Dear ${args.customerName},`,
    "",
    `We are pleased to confirm that the goods under Delivery Order ${args.doNo} were delivered on ${deliveredDate}. Please find our invoice attached:`,
    "",
    `  Invoice No.        : ${args.invoiceNo}`,
    `  Invoice Date       : ${fmtEmailDate(args.invoiceDate)}`,
    `  Delivery Order No. : ${args.doNo}`,
    ...(poJoined ? [`  Your PO No.        : ${poJoined}`] : []),
    `  Amount             : ${amount}`,
    "",
    "Kindly arrange payment in accordance with the agreed terms. If payment has already been made, please disregard this notice.",
    "",
    "We thank you for your continued business and look forward to serving you again.",
    "",
    "Best regards,",
    COMPANY_NAME,
  ];

  return {
    subject,
    html: wrapHtml({
      headerKicker: "Goods Delivered",
      headerTitle: `Invoice ${args.invoiceNo}`,
      bodyHtml,
    }),
    text: textLines.join("\n"),
  };
}

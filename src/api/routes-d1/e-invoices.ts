// ---------------------------------------------------------------------------
// D1-backed e-invoices route.
//
// Mirrors the old src/api/routes/e-invoices.ts shape so the SPA frontend
// doesn't need any changes. Notes:
//
//   - `invoiceId` is intentionally NOT FK-enforced on the DB side (see
//     schema comment). Some legacy/standalone e-invoices reference invoices
//     that aren't in the live set — POST validates that the invoice exists
//     but list/get never reject rows just because the invoice is missing.
//   - `xmlContent` is a TEXT column storing the full UBL XML payload; it's
//     returned as a string.
//   - The DB column is `created_at` (snake_case) but the API contract
//     exposes `createdAt` (camelCase) — rowToEInvoice handles the mapping.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type EInvoiceRow = {
  id: string;
  invoiceId: string | null;
  invoiceNo: string;
  customerName: string | null;
  customerTIN: string | null;
  submissionId: string | null;
  uuid: string | null;
  status: string | null;
  submittedAt: string | null;
  validatedAt: string | null;
  errorMessage: string | null;
  xmlContent: string | null;
  totalExcludingTax: number;
  taxAmount: number;
  totalIncludingTax: number;
  created_at: string | null;
};

function rowToEInvoice(row: EInvoiceRow) {
  const obj: Record<string, unknown> = {
    id: row.id,
    invoiceId: row.invoiceId ?? "",
    invoiceNo: row.invoiceNo,
    customerName: row.customerName ?? "",
    status: row.status ?? "PENDING",
    totalExcludingTax: row.totalExcludingTax,
    taxAmount: row.taxAmount,
    totalIncludingTax: row.totalIncludingTax,
    createdAt: row.created_at ?? "",
  };
  if (row.customerTIN !== null) obj.customerTIN = row.customerTIN;
  if (row.submissionId !== null) obj.submissionId = row.submissionId;
  if (row.uuid !== null) obj.uuid = row.uuid;
  if (row.submittedAt !== null) obj.submittedAt = row.submittedAt;
  if (row.validatedAt !== null) obj.validatedAt = row.validatedAt;
  if (row.errorMessage !== null) obj.errorMessage = row.errorMessage;
  if (row.xmlContent !== null) obj.xmlContent = row.xmlContent;
  return obj;
}

function genId(): string {
  return `einv-${crypto.randomUUID().slice(0, 8)}`;
}

function generateEInvoiceXml(
  invoiceNo: string,
  issueDate: string,
  customerName: string,
  customerTIN: string | undefined,
  totalExcludingTax: number,
  taxAmount: number,
  totalIncludingTax: number,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>${invoiceNo}</ID>
  <IssueDate>${issueDate}</IssueDate>
  <InvoiceTypeCode listVersionID="1.0">01</InvoiceTypeCode>
  <DocumentCurrencyCode>MYR</DocumentCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification>
        <ID schemeID="TIN">C60515534080</ID>
      </PartyIdentification>
      <PartyIdentification>
        <ID schemeID="BRN">202501060540</ID>
      </PartyIdentification>
      <PartyName>
        <Name>HOOKKA INDUSTRIES SDN BHD</Name>
      </PartyName>
    </Party>
  </AccountingSupplierParty>
  <AccountingCustomerParty>
    <Party>
      <PartyIdentification>
        <ID schemeID="TIN">${customerTIN || "EI00000000010"}</ID>
      </PartyIdentification>
      <PartyName>
        <Name>${customerName}</Name>
      </PartyName>
    </Party>
  </AccountingCustomerParty>
  <TaxTotal>
    <TaxAmount currencyID="MYR">${taxAmount.toFixed(2)}</TaxAmount>
  </TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount currencyID="MYR">${totalExcludingTax.toFixed(2)}</TaxExclusiveAmount>
    <TaxInclusiveAmount currencyID="MYR">${totalIncludingTax.toFixed(2)}</TaxInclusiveAmount>
    <PayableAmount currencyID="MYR">${totalIncludingTax.toFixed(2)}</PayableAmount>
  </LegalMonetaryTotal>
</Invoice>`;
}

// GET /api/e-invoices — list all
app.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM e_invoices ORDER BY created_at DESC",
  ).all<EInvoiceRow>();
  const data = (res.results ?? []).map(rowToEInvoice);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/e-invoices — create (generates XML payload)
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { invoiceId } = body;
    if (!invoiceId) {
      return c.json(
        { success: false, error: "invoiceId is required" },
        400,
      );
    }

    const invoice = await c.env.DB.prepare(
      "SELECT id, invoiceNo, invoiceDate, customerName, totalSen FROM invoices WHERE id = ?",
    )
      .bind(invoiceId)
      .first<{
        id: string;
        invoiceNo: string;
        invoiceDate: string;
        customerName: string;
        totalSen: number;
      }>();
    if (!invoice) {
      return c.json({ success: false, error: "Invoice not found" }, 404);
    }

    const existing = await c.env.DB.prepare(
      "SELECT id FROM e_invoices WHERE invoiceId = ?",
    )
      .bind(invoiceId)
      .first<{ id: string }>();
    if (existing) {
      return c.json(
        { success: false, error: "e-Invoice already exists for this invoice" },
        409,
      );
    }

    const totalIncludingTax = invoice.totalSen / 100;
    const totalExcludingTax = totalIncludingTax;
    const taxAmount = 0;
    const now = new Date().toISOString();

    const xmlContent = generateEInvoiceXml(
      invoice.invoiceNo,
      invoice.invoiceDate,
      invoice.customerName,
      body.customerTIN,
      totalExcludingTax,
      taxAmount,
      totalIncludingTax,
    );

    const id = genId();
    await c.env.DB.prepare(
      `INSERT INTO e_invoices (id, invoiceId, invoiceNo, customerName, customerTIN,
         submissionId, uuid, status, submittedAt, validatedAt, errorMessage,
         xmlContent, totalExcludingTax, taxAmount, totalIncludingTax, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        invoice.id,
        invoice.invoiceNo,
        invoice.customerName,
        body.customerTIN || null,
        null,
        null,
        "PENDING",
        null,
        null,
        null,
        xmlContent,
        totalExcludingTax,
        taxAmount,
        totalIncludingTax,
        now,
      )
      .run();

    const created = await c.env.DB.prepare(
      "SELECT * FROM e_invoices WHERE id = ?",
    )
      .bind(id)
      .first<EInvoiceRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create e-invoice" },
        500,
      );
    }
    return c.json({ success: true, data: rowToEInvoice(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/e-invoices/:id — single
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM e_invoices WHERE id = ?",
  )
    .bind(id)
    .first<EInvoiceRow>();
  if (!row) {
    return c.json({ success: false, error: "e-Invoice not found" }, 404);
  }
  return c.json({ success: true, data: rowToEInvoice(row) });
});

// PUT /api/e-invoices/:id — submit or cancel
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.env.DB.prepare(
      "SELECT * FROM e_invoices WHERE id = ?",
    )
      .bind(id)
      .first<EInvoiceRow>();
    if (!existing) {
      return c.json({ success: false, error: "e-Invoice not found" }, 404);
    }

    const body = await c.req.json();
    const now = new Date().toISOString();

    if (body.action === "submit") {
      if (existing.status !== "PENDING" && existing.status !== "INVALID") {
        return c.json(
          {
            success: false,
            error: "Only PENDING or INVALID e-invoices can be submitted",
          },
          400,
        );
      }

      const submissionId = `LHDN-SUB-${now.slice(0, 10).replace(/-/g, "")}-${String(
        Math.floor(Math.random() * 999),
      ).padStart(3, "0")}`;
      const uuid = Array.from({ length: 15 }, () =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[
          Math.floor(Math.random() * 36)
        ],
      ).join("");

      // Mock auto-validation: SUBMITTED → VALID immediately
      await c.env.DB.prepare(
        `UPDATE e_invoices SET status = ?, submittedAt = ?, validatedAt = ?,
           submissionId = ?, uuid = ?, errorMessage = NULL WHERE id = ?`,
      )
        .bind("VALID", now, now, submissionId, uuid, id)
        .run();

      const updated = await c.env.DB.prepare(
        "SELECT * FROM e_invoices WHERE id = ?",
      )
        .bind(id)
        .first<EInvoiceRow>();
      if (!updated) {
        return c.json({ success: false, error: "e-Invoice not found" }, 404);
      }
      return c.json({ success: true, data: rowToEInvoice(updated) });
    }

    if (body.action === "cancel") {
      if (existing.status !== "VALID" && existing.status !== "SUBMITTED") {
        return c.json(
          {
            success: false,
            error: "Only SUBMITTED or VALID e-invoices can be cancelled",
          },
          400,
        );
      }
      await c.env.DB.prepare(
        "UPDATE e_invoices SET status = ? WHERE id = ?",
      )
        .bind("CANCELLED", id)
        .run();

      const updated = await c.env.DB.prepare(
        "SELECT * FROM e_invoices WHERE id = ?",
      )
        .bind(id)
        .first<EInvoiceRow>();
      if (!updated) {
        return c.json({ success: false, error: "e-Invoice not found" }, 404);
      }
      return c.json({ success: true, data: rowToEInvoice(updated) });
    }

    return c.json(
      { success: false, error: "Invalid action. Use 'submit' or 'cancel'." },
      400,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;

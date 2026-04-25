// ---------------------------------------------------------------------------
// Invoices, payments, credit/debit notes, e-invoices. All transactional.
//
// Invoices and CN/DN endpoints follow standard CRUD; the `e-invoices` route
// is a thin wrapper around invoices for LHDN MyInvois submission, treated
// as a CRUD-ish resource here.
// ---------------------------------------------------------------------------
import { z } from "zod";
import {
  CreditNoteSchema,
  DebitNoteSchema,
  InvoiceSchema,
  PaymentSchema,
} from "../../schemas";
import { makeCrud } from "./_crud";

export const invoices = makeCrud({
  base: "/api/invoices",
  schema: InvoiceSchema,
  bucket: "transactional",
});

export const payments = makeCrud({
  base: "/api/payments",
  schema: PaymentSchema,
  bucket: "transactional",
});

export const creditNotes = makeCrud({
  base: "/api/credit-notes",
  schema: CreditNoteSchema,
  bucket: "transactional",
});

export const debitNotes = makeCrud({
  base: "/api/debit-notes",
  schema: DebitNoteSchema,
  bucket: "transactional",
});

// e-invoices payloads vary by status (queued/submitted/validated); treat as
// loose passthrough rows.
const EInvoiceSchema = z
  .object({
    id: z.string(),
    invoiceId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const eInvoices = makeCrud({
  base: "/api/e-invoices",
  schema: EInvoiceSchema,
  bucket: "transactional",
});

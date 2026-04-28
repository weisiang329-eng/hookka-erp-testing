// ---------------------------------------------------------------------------
// Invoice + payment + credit-note + debit-note schemas. Mirror the
// rowTo* mappers in routes/{invoices,payments,credit-notes,debit-notes}.ts.
// Loose passthrough — extra columns flow through unchanged.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const InvoiceItemSchema = z
  .object({
    id: z.string(),
    productCode: z.string().optional(),
    productName: z.string().optional(),
    sizeLabel: z.string().optional(),
    fabricCode: z.string().optional(),
    quantity: z.number().optional(),
    unitPriceSen: z.number().optional(),
    totalSen: z.number().optional(),
  })
  .passthrough();

export const InvoicePaymentSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    amountSen: z.number().optional(),
    method: z.string().optional(),
    reference: z.string().optional(),
  })
  .passthrough();

export const InvoiceSchema = z
  .object({
    id: z.string(),
    invoiceNo: z.string(),
    deliveryOrderId: z.string().optional(),
    doNo: z.string().optional(),
    salesOrderId: z.string().optional(),
    companySOId: z.string().optional(),
    customerId: z.string(),
    customerName: z.string().optional(),
    customerState: z.string().optional(),
    hubId: z.string().nullable().optional(),
    hubName: z.string().optional(),
    items: z.array(InvoiceItemSchema).optional(),
    subtotalSen: z.number().optional(),
    totalSen: z.number().optional(),
    status: z.string().optional(),
    invoiceDate: z.string().optional(),
    dueDate: z.string().optional(),
    paidAmount: z.number().optional(),
    paymentDate: z.string().nullable().optional(),
    paymentMethod: z.string().optional(),
    payments: z.array(InvoicePaymentSchema).optional(),
    notes: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const PaymentAllocationSchema = z
  .object({
    invoiceId: z.string().optional(),
    invoiceNumber: z.string().optional(),
    amount: z.number().optional(),
  })
  .passthrough();

export const PaymentSchema = z
  .object({
    id: z.string(),
    receiptNumber: z.string().optional(),
    customerId: z.string(),
    customerName: z.string().optional(),
    date: z.string(),
    amount: z.number().optional(),
    method: z.string().optional(),
    reference: z.string().optional(),
    allocations: z.array(PaymentAllocationSchema).optional(),
    status: z.string().optional(),
  })
  .passthrough();

const NoteItemSchema = z
  .object({
    description: z.string().optional(),
    quantity: z.number().optional(),
    unitPrice: z.number().optional(),
    total: z.number().optional(),
  })
  .passthrough();

export const CreditNoteSchema = z
  .object({
    id: z.string(),
    noteNumber: z.string(),
    invoiceId: z.string().optional(),
    invoiceNumber: z.string().optional(),
    customerId: z.string(),
    customerName: z.string().optional(),
    date: z.string(),
    reason: z.string().optional(),
    reasonDetail: z.string().optional(),
    items: z.array(NoteItemSchema).optional(),
    totalAmount: z.number().optional(),
    status: z.string().optional(),
    approvedBy: z.string().nullable().optional(),
  })
  .passthrough();

export const DebitNoteSchema = CreditNoteSchema;

export type InvoiceFromApi = z.infer<typeof InvoiceSchema>;
export type PaymentFromApi = z.infer<typeof PaymentSchema>;
export type CreditNoteFromApi = z.infer<typeof CreditNoteSchema>;
export type DebitNoteFromApi = z.infer<typeof DebitNoteSchema>;

// ---------------------------------------------------------------------------
// note-ledger.ts — double-entry legs for credit notes & debit notes.
//
// Phase 1 (finance) 2026-06: CN/DN previously mutated only the subledger
// (customers.outstandingSen + invoice totals) and never touched the GL, so
// the 300-x debtor control drifted from Σ customer outstanding and revenue
// stayed overstated after a credit note. This module mirrors the sales-
// invoice posting in invoices.ts (buildInvoiceLedgerLegs) so a CN/DN lands
// in ledger_journal_entries in the SAME batch as its subledger cascade.
//
//   Credit note (reduces what the customer owes):
//     DR 510-0000 RETURN INWARDS        amount   (reason RETURN / DAMAGE)
//        — or 520-0000 DISCOUNT ALLOWED          (other reasons)
//     DR 350-0000 GST/SST output        tax      (only if rate > 0)
//     CR <debtor control 300-x>         amount + tax
//
//   Debit note (adds to what the customer owes):
//     DR <debtor control 300-x>         amount + tax
//     CR 500-0000 SALES                 amount
//     CR 350-0000 GST/SST output        tax      (only if rate > 0)
//
// Tax mirrors the invoice posting: operator-configured `gst_rate_pct` in
// kv_config applied to the note amount at posting time (notes store amounts
// excluding tax, same convention as invoices.totalSen / subtotalSen).
//
// Failure model: callers build these statements BEFORE the batch and FAIL
// the request when the build throws — a note must never apply its subledger
// cascade without the matching GL legs (Phase-1 decision: no silent skips).
// ---------------------------------------------------------------------------
import type { Env } from "../worker";
import { parseDebtorCode } from "../../lib/debtor";
import type { LedgerEntryInput } from "./journal-hash";

type Db = Env["Variables"]["DB"];

// Reason → P&L account for the credit-note debit leg. Physical goods coming
// back (RETURN / DAMAGE) hit RETURN INWARDS; pure price concessions
// (PRICE_ADJUSTMENT / OVERCHARGE / OTHER) hit DISCOUNT ALLOWED.
const CN_RETURN_ACCT = "510-0000"; // RETURN INWARDS
const CN_DISCOUNT_ACCT = "520-0000"; // DISCOUNT ALLOWED
const DN_SALES_ACCT = "500-0000"; // SALES (generic)
const TAX_OUTPUT_ACCT = "350-0000"; // GST PAYABLES (output tax)
const FALLBACK_DEBTOR_CONTROL = "300-0000"; // TRADE DEBTORS

function cnDebitAccount(reason: string | null | undefined): string {
  return reason === "RETURN" || reason === "DAMAGE"
    ? CN_RETURN_ACCT
    : CN_DISCOUNT_ACCT;
}

// Operator-configured GST/SST rate — same source as the invoice posting
// (invoices.ts buildInvoiceLedgerLegs step 3). 0 / missing / invalid → 0%.
export async function readGstRatePct(db: Db): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("gst_rate_pct")
    .first<{ value: string }>();
  try {
    const v = JSON.parse(row?.value ?? "null") as { pct?: number } | null;
    if (v && typeof v.pct === "number" && isFinite(v.pct) && v.pct > 0)
      return v.pct;
  } catch {
    /* fall through */
  }
  return 0;
}

// Debtor control account from the customer's debtor code — same resolution
// as the invoice posting so CN/DN legs always hit the SAME control account
// the original invoice debited.
export async function resolveDebtorControl(
  db: Db,
  customerId: string,
): Promise<string> {
  const cust = await db
    .prepare("SELECT code FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ code: string }>();
  const parsed = parseDebtorCode(cust?.code);
  return parsed.ok ? parsed.controlCode : FALLBACK_DEBTOR_CONTROL;
}

export interface NoteForLedger {
  id: string;
  noteNumber: string;
  customerId: string;
  reason: string | null;
}

export async function buildCreditNoteLedgerLegs(
  db: Db,
  orgId: string,
  note: NoteForLedger,
  amountSen: number,
  actorUserId: string | null,
): Promise<LedgerEntryInput[]> {
  const amount = Math.max(0, Math.round(amountSen) || 0);
  if (amount === 0) return [];
  const controlCode = await resolveDebtorControl(db, note.customerId);
  const pct = await readGstRatePct(db);
  const taxSen = Math.max(0, Math.round((amount * pct) / 100));
  const legs: LedgerEntryInput[] = [];
  let legNo = 1;
  legs.push({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: "credit_note",
    sourceId: note.id,
    legNo: legNo++,
    accountCode: cnDebitAccount(note.reason),
    debitSen: amount,
    creditSen: 0,
    description: `CN ${note.noteNumber} · ${note.reason ?? "OTHER"}`,
    actorUserId,
    orgId,
  });
  if (taxSen > 0) {
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "credit_note",
      sourceId: note.id,
      legNo: legNo++,
      accountCode: TAX_OUTPUT_ACCT,
      debitSen: taxSen,
      creditSen: 0,
      description: `CN ${note.noteNumber} · tax reversal`,
      actorUserId,
      orgId,
    });
  }
  legs.push({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: "credit_note",
    sourceId: note.id,
    legNo: legNo++,
    accountCode: controlCode,
    debitSen: 0,
    creditSen: amount + taxSen,
    description: `CN ${note.noteNumber} · AR credit`,
    actorUserId,
    orgId,
  });
  return legs;
}

export async function buildDebitNoteLedgerLegs(
  db: Db,
  orgId: string,
  note: NoteForLedger,
  amountSen: number,
  actorUserId: string | null,
): Promise<LedgerEntryInput[]> {
  const amount = Math.max(0, Math.round(amountSen) || 0);
  if (amount === 0) return [];
  const controlCode = await resolveDebtorControl(db, note.customerId);
  const pct = await readGstRatePct(db);
  const taxSen = Math.max(0, Math.round((amount * pct) / 100));
  const legs: LedgerEntryInput[] = [];
  let legNo = 1;
  legs.push({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: "debit_note",
    sourceId: note.id,
    legNo: legNo++,
    accountCode: controlCode,
    debitSen: amount + taxSen,
    creditSen: 0,
    description: `DN ${note.noteNumber} · AR debit`,
    actorUserId,
    orgId,
  });
  legs.push({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: "debit_note",
    sourceId: note.id,
    legNo: legNo++,
    accountCode: DN_SALES_ACCT,
    debitSen: 0,
    creditSen: amount,
    description: `DN ${note.noteNumber} · ${note.reason ?? "OTHER"}`,
    actorUserId,
    orgId,
  });
  if (taxSen > 0) {
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "debit_note",
      sourceId: note.id,
      legNo: legNo++,
      accountCode: TAX_OUTPUT_ACCT,
      debitSen: 0,
      creditSen: taxSen,
      description: `DN ${note.noteNumber} · output tax`,
      actorUserId,
      orgId,
    });
  }
  return legs;
}

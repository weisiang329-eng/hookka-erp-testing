// ---------------------------------------------------------------------------
// D1-backed accounting route.
//
// Mirrors the old src/api/routes/accounting.ts shape so the SPA frontend
// doesn't need any changes. Covers:
//   - Chart of Accounts  (GET/POST/PUT  /coa)
//   - Journal Entries    (GET/POST/PUT/DELETE  /journals, /journals/:id)
//   - AR/AP Aging        (GET/POST  /aging)
//   - P&L                (GET  /pl)
//
// DB columns are camelCase; response fields are also camelCase. Timestamp
// columns (`created_at`, `updated_at`) are snake_case per repo convention
// and are remapped to camelCase in the response.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import { roundUnitPriceSen } from "../../lib/unit-price";
import type { Env } from "../worker";
import { requirePermission, requireFinance } from "../lib/rbac";
import { monthsOverdue, nextMonthDueDate } from "../../lib/terms";
import { getOrgId, companyFilter } from "../lib/tenant";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
  type LedgerEntryInput,
} from "../lib/journal-hash";
import { getFyeMonth, fyWindowFor } from "../lib/fiscal";
import { emitAudit } from "../lib/audit";
import { parseDebtorCode } from "../../lib/debtor";
import { defaultPnlBucket, pnlBucketFor } from "../../lib/pnl-bucket";
import { bsSectionFor, bsSectionClass } from "../../lib/bs-section";
import type { BsSection } from "../../lib/bs-section";
import { buildStatement, splitByLargestRemainder } from "../../lib/cashflow-engine";
import type { CfMap, ClassifiedLeg, BankLeg, RmSplit, CoaLite } from "../../lib/cashflow-engine";
import { getDocNumberPrefixes, issueDocNumber, issueDocNumberWithPrefix } from "../lib/doc-number-service";
import { computeDiscountAlloc, type PiOpen } from "../../lib/discount-alloc";
import { ensurePartialPaymentColumns } from "../lib/ensure-partial-payment";
import { ensureFinanceOrgColumns } from "../lib/ensure-finance-org";
import { apRowBeforeOpening, legBeforeOpening, rowBeforeOpening } from "../../lib/opening-floor";
import { applyOpeningSlice, windowCoversMonth } from "../../lib/opening-slice";
import { labourInjectMonths } from "../../lib/labour-inject";
import { projectedLabourByDept } from "../lib/labour-projection";
import { groupPayslipsByMonthDept, forecastEntryKind, monthHasDeptForecast, labourMappedAccounts } from "../../lib/salary-dept";
import { ensureTfTables, getTfSources, saveTfSources, loadTfDraws } from "../lib/trade-finance";
import type { TfSource } from "../lib/trade-finance";
import { tfTotals } from "../../lib/trade-finance";
import { buildDeliveredAsOf, fgClosingSen } from "../../lib/fg-closing";
import { costAsOfByPo } from "../../lib/cost-attribution";
import { STOCK_TAKE_ITEM_ALIAS_SEED_2026_05 } from "../lib/stock-take-item-alias-seed-2026-05";
import { DOC_DATE_FAMILIES, stripLegSuffix, stripSourceIdSuffix, parseSourceIdDate } from "../../lib/doc-date";
import {
  prefixForPartyType,
  computeBillTotals,
  validateBillShape,
  buildBillLegs,
  editedBillStatus,
  type PartyType,
  type BillItemInput,
} from "../../lib/other-party-bill";
import {
  computePaymentTotal,
  validateAllocations,
  buildPaymentLegs,
  type PaymentAllocInput,
} from "../../lib/other-party-payment";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import { buildPnlMatrix, type PnlMatrixCol } from "../../lib/pnl-matrix";
import { selectHistoricalWindow, sumPnlWindows, buildHistoricalMap } from "../../lib/pnl-historical";
import { buildHistIdentityRemap } from "../../lib/pnl-hist-remap";
import { rmLineOf, rmScale } from "../../lib/product-line-rm";
import { buildInventoryOpeningSeed, applyOpeningSeed, type InventoryOpeningRow } from "../../lib/inventory-opening";
import { bucketAging } from "../../lib/other-party-aging";
import { applyLifecycle, getDocState } from "../lib/document-lifecycle";
import type { DocState, LifecycleAction } from "../../lib/lifecycle-machine";
import {
  computeMaterialCheckpoints,
  windowFromCheckpoints,
  type MaterialInput,
  type FifoEvent,
  type CheckpointCum,
} from "../../lib/material-cost-fifo";
import {
  buildApReconciliation,
  AR_RECON_CFG,
  type ApReconLeg,
  type ApReconPi,
  type ApReconPaymentRow,
} from "../../lib/ap-recon";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
type CoaRow = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" | "COST";
  parentCode: string | null;
  balanceSen: number;
  isActive: number;
  cashFlowCategory: string | null;
  specialAccountType: string | null;
  // Phase 1 (migration 0154): FIXED | VARIABLE | OTHERS | null (untagged).
  pnlCategory: string | null;
  // Phase 1 (migration 0154): 0 = header/parent account, journals and
  // auto-postings must hit postable (leaf) accounts only.
  isPostable: number;
  created_at: string;
};

type JournalEntryRow = {
  id: string;
  entryNo: string;
  date: string;
  description: string;
  status: "DRAFT" | "POSTED" | "REVERSED";
  createdBy: string;
  // Postgres hands this back as `createdAt` (see rowToJournal). `created_at`
  // is kept only as the SQLite-mirror / defensive spelling — both optional so
  // the dual-key read is honest about which one actually arrives.
  createdAt?: string;
  created_at?: string;
};

type JournalLineRow = {
  id: number;
  journalEntryId: string;
  lineOrder: number;
  accountCode: string;
  accountName: string;
  debitSen: number;
  creditSen: number;
  description: string;
};

// Per-document detail row for the expandable aging (owner rule 2026-07-08:
// 「可以点了展开看 detail」— his old system's Debtor Aging - Detail layout:
// each open document under its party, amount in its aging column). `mo` is
// the bucket index 0..4 (current / 1 / 2 / 3 / 3+ months); advances appear
// as negative current-bucket docs.
type AgingDocRow = { no: string; date: string; mo: number; amountSen: number };

type ArAgingRow = {
  customerId: string;
  customerName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
  docs: AgingDocRow[];
};

type ApAgingRow = {
  supplierId: string;
  supplierName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
  docs: AgingDocRow[];
};

const agingBucketIdx = (mo: number): number => (mo <= 0 ? 0 : mo >= 4 ? 4 : mo);

// ---------------------------------------------------------------------------
// Row mappers — match the legacy mock-data shapes
// ---------------------------------------------------------------------------
function rowToCoa(r: CoaRow) {
  return {
    code: r.code,
    name: r.name,
    type: r.type,
    parentCode: r.parentCode ?? undefined,
    balance: r.balanceSen,
    isActive: r.isActive === 1,
    cashFlowCategory: r.cashFlowCategory ?? undefined,
    specialAccountType: r.specialAccountType ?? undefined,
    pnlCategory: r.pnlCategory ?? undefined,
    // Default 1 — rows predating migration 0154 stay postable.
    isPostable: (r.isPostable ?? 1) === 1,
  };
}

function rowToJournal(e: JournalEntryRow, lines: JournalLineRow[]) {
  return {
    id: e.id,
    entryNo: e.entryNo,
    date: e.date,
    description: e.description,
    status: e.status,
    createdBy: e.createdBy,
    // Dual-keyed. `created_at` alone was ALWAYS undefined: db-pg.ts installs
    // `transform.column.from = columnFrom`, and columnFrom("created_at") is
    // "createdAt" (rename-map entry `createdAt -> created_at`). The shared
    // `JournalEntry` type declares createdAt as a non-optional string, so
    // nothing warned. Same defect, same fix, as the `payment_no` read
    // documented at supplier-payments.ts:60.
    createdAt: e.createdAt ?? e.created_at,
    lines: lines
      .filter((l) => l.journalEntryId === e.id)
      .sort((a, b) => a.lineOrder - b.lineOrder)
      .map((l) => ({
        accountCode: l.accountCode,
        accountName: l.accountName,
        debitSen: l.debitSen,
        creditSen: l.creditSen,
        description: l.description,
      })),
  };
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextJeNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const res = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE entryNo LIKE ?",
    )
    .bind(`JE-${yymm}-%`)
    .first<{ c: number }>();
  const seq = (res?.c ?? 0) + 1;
  return `JE-${yymm}-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Account-code rename aliases (migration 0157). The immutable ledger
// hash-chains accountCode into every row, so a rename can never rewrite
// history — instead old→new mappings live in account_aliases and EVERY
// read surface resolves through this (transitively, for chained renames).
// Identity fallback when the table hasn't been migrated yet.
// ---------------------------------------------------------------------------
async function loadAccountResolver(
  db: Env["Variables"]["DB"],
): Promise<(code: string) => string> {
  try {
    const res = await db
      .prepare("SELECT oldCode, newCode FROM account_aliases")
      .all<{ oldCode: string; newCode: string }>();
    const m = new Map(
      (res.results ?? []).map((r) => [r.oldCode, r.newCode] as const),
    );
    if (m.size === 0) return (c) => c;
    return (code) => {
      let c = code;
      for (let i = 0; i < 10 && m.has(c); i++) c = m.get(c)!;
      return c;
    };
  } catch {
    return (c) => c;
  }
}

// Accounts the POSTING CODE references directly (control accounts, tax,
// sales split, default purchase/stock maps, bank/cash, retained earnings,
// payroll accruals…). Renaming one of these would silently break auto-
// posting, so /coa/rename refuses them.
const PROTECTED_ACCOUNTS = new Set([
  "100-0000", "150-0000",
  "300-0000", "305-0000", "310-0010", "320-0000", "350-0000",
  "400-0000", "405-0000", "410-0000", "410-0010", "410-0020", "410-0030", "410-0040",
  "490-0000",
  "500-0000", "500-0020", "500-0030", "510-0000", "520-0000",
  "600-0000", "620-0000", "700-1015", "700-9005", "700-9010", "706-0000",
  "701-0001", "701-0002", "701-0003", "701-0010", "701-0020", "701-0030",
  "701-9991", "701-9992", "701-9993",
  "702-0001", "702-0002", "702-0010", "702-0030", "702-9991", "702-9992",
  "703-0001", "703-0010", "703-9999",
  "704-0005", "704-0010", "704-0020", "704-0040", "704-0050", "704-9995",
  "705-0001", "705-0020", "705-9999",
  "330-0001", "330-0002", "330-0003", "330-1001", "330-1002", "330-2001",
  "330-3005", "330-4000", "330-8000", "330-9000",
]);

// "Does this account carry any amount?" — gate before promoting a leaf
// account into a parent (drag & drop). Checks the immutable ledger plus
// legacy journal_lines, resolving renamed codes so history posted under
// an old code still counts. A missing table reads as "no postings".
async function accountHasPostings(
  db: Env["Variables"]["DB"],
  code: string,
): Promise<boolean> {
  const resolve = await loadAccountResolver(db);
  const codes = new Set([code]);
  try {
    const res = await db
      .prepare("SELECT oldCode FROM account_aliases")
      .all<{ oldCode: string }>();
    for (const r of res.results ?? []) {
      if (resolve(r.oldCode) === code) codes.add(r.oldCode);
    }
  } catch {
    /* alias table absent — identity resolution only */
  }
  const list = [...codes];
  const marks = list.map(() => "?").join(",");
  for (const table of ["ledger_journal_entries", "journal_lines"]) {
    try {
      const hit = await db
        .prepare(`SELECT 1 AS x FROM ${table} WHERE accountCode IN (${marks}) LIMIT 1`)
        .bind(...list)
        .first<{ x: number }>();
      if (hit) return true;
    } catch {
      /* table absent on pre-migration DBs */
    }
  }
  return false;
}

// Gate before an account gains its FIRST child — via drag re-parenting or
// a new account created under it. A leaf may only become a parent while it
// carries no amount, and it flips non-postable on promotion (AutoCount
// convention) so it can never accumulate its own amount later. Returns the
// rejection message, or null when the parent is fine (already a parent, or
// clean and now promoted). Unknown parent codes keep legacy behaviour.
async function promoteLeafParent(
  db: Env["Variables"]["DB"],
  parentCode: string,
): Promise<string | null> {
  const parent = await db
    .prepare(
      "SELECT balanceSen, isPostable FROM chart_of_accounts WHERE code = ?",
    )
    .bind(parentCode)
    .first<{ balanceSen: number | null; isPostable: number | null }>();
  if (!parent) return null;
  const kidCount = await db
    .prepare("SELECT COUNT(*) AS c FROM chart_of_accounts WHERE parentCode = ?")
    .bind(parentCode)
    .first<{ c: number }>();
  if ((kidCount?.c ?? 0) > 0) return null;
  if (
    (parent.balanceSen ?? 0) !== 0 ||
    (await accountHasPostings(db, parentCode))
  ) {
    return `${parentCode} already has an amount — an account can only become a parent while its balance is zero and it has no transactions`;
  }
  if ((parent.isPostable ?? 1) === 1) {
    await db
      .prepare("UPDATE chart_of_accounts SET isPostable = 0 WHERE code = ?")
      .bind(parentCode)
      .run();
  }
  return null;
}

// ---------------------------------------------------------------------------
// AGING
// ---------------------------------------------------------------------------
// Aging is by the owner's 1-month month-based term (see src/lib/terms.ts):
// bucket by MONTHS overdue, not days. The 5 columns keep their names for
// response/UI compatibility but now mean: current / 1 / 2 / 3 / 3+ months.
function addToBucket(
  b: {
    currentSen: number;
    days30Sen: number;
    days60Sen: number;
    days90Sen: number;
    over90Sen: number;
  },
  mo: number,
  amt: number,
) {
  if (mo <= 0) b.currentSen += amt;
  else if (mo === 1) b.days30Sen += amt;
  else if (mo === 2) b.days60Sen += amt;
  else if (mo === 3) b.days90Sen += amt;
  else b.over90Sen += amt;
}

// Live debtor (AR) & creditor (AP) aging, computed on open from unpaid
// invoices / purchase invoices bucketed by days past due. Replaces the
// dead manual ar_aging/ap_aging snapshot tables (response shape kept so
// the AR/AP/Overview tabs are unchanged).
// Un-knocked supplier advances (owner rule 2026-07-05: the creditor aging must
// INCLUDE unapplied advances as NEGATIVE rows, so the aging total ties the
// 400-0000 control exactly instead of drifting by the advance sum). An advance
// is a supplier_payments row with NO purchaseInvoiceId; knock-off decrements
// its amountSen, so amountSen > 0 = still unapplied. Rows of VOIDED/DELETED
// payments are excluded via document_lifecycle (BUG-2026-07-08-003: a voided
// advance kept its −row in both agings while its GL was correctly hidden,
// skewing the drift card by exactly that amount) — same NOT-EXISTS shape as
// buildPiPaidTruthStatement, pure snake_case so the adapter passes it through.
async function loadUnappliedSupplierAdvances(
  db: Env["Variables"]["DB"],
  orgId: string,
): Promise<Map<string, { supplierName: string; sen: number; items: { paymentNo: string; date: string; sen: number }[] }>> {
  const out = new Map<string, { supplierName: string; sen: number; items: { paymentNo: string; date: string; sen: number }[] }>();
  try {
    const res = await db
      .prepare(
        `SELECT sp.supplier_id AS supplier_id, sp.supplier_name AS supplier_name,
                sp.amount_sen AS amount_sen, sp.payment_no AS payment_no, sp.date AS date
           FROM supplier_payments sp
          WHERE sp.org_id = ? AND sp.purchase_invoice_id IS NULL AND sp.amount_sen > 0
            AND COALESCE(sp.method,'') <> 'TF_REPAYMENT'
            AND NOT EXISTS (
              SELECT 1 FROM document_lifecycle dl
               WHERE dl.source_type = 'supplier_payment'
                 AND dl.source_id = sp.payment_no
                 AND dl.state <> 'ACTIVE'
            )`,
      )
      .bind(orgId)
      .all<{ supplierId?: string; supplier_id?: string; supplierName?: string; supplier_name?: string; amountSen?: number; amount_sen?: number; paymentNo?: string; payment_no?: string; date?: string }>();
    for (const r of res.results ?? []) {
      const id = String(r.supplierId ?? r.supplier_id ?? "");
      if (!id) continue;
      const sen = Math.round(Number(r.amountSen ?? r.amount_sen) || 0);
      if (sen <= 0) continue;
      const item = { paymentNo: String(r.paymentNo ?? r.payment_no ?? ""), date: String(r.date ?? "").slice(0, 10), sen };
      const cur = out.get(id);
      if (cur) { cur.sen += sen; cur.items.push(item); }
      else out.set(id, { supplierName: String(r.supplierName ?? r.supplier_name ?? ""), sen, items: [item] });
    }
  } catch {
    /* supplier_payments unavailable → no advance rows */
  }
  return out;
}

// The customer mirror. A receipt whose allocations don't add up to it is
// holding money on account (owner 2026-08-06 asked to be able to record one:
// 「我要的就类似 advance」). The debtor control is credited in FULL when the
// receipt posts, so unless that remainder is subtracted here the AR card
// reports a drift for every advance — the same false alarm the supplier side
// carried until BUG-2026-07-08-003. Voided / deleted receipts are excluded for
// the same reason they are on the supplier side: they hold nothing.
async function loadUnappliedCustomerAdvances(
  db: Env["Variables"]["DB"],
  orgId: string,
): Promise<Map<string, { customerName: string; sen: number; items: { receiptNumber: string; date: string; sen: number }[] }>> {
  const out = new Map<string, { customerName: string; sen: number; items: { receiptNumber: string; date: string; sen: number }[] }>();
  try {
    const res = await db
      .prepare(
        `SELECT p.id AS id, p.customerId AS customerId, p.customerName AS customerName,
                p.amount AS amount, p.allocations AS allocations,
                p.receiptNumber AS receiptNumber, p.date AS date
           FROM payment_records p
          WHERE NOT EXISTS (
              SELECT 1 FROM document_lifecycle dl
               WHERE dl.source_type = 'payment'
                 AND dl.source_id = p.id
                 AND dl.state <> 'ACTIVE'
            )`,
      )
      .all<{ id: string; customerId?: string; customerName?: string; amount?: number; allocations?: string | null; receiptNumber?: string; date?: string }>();
    for (const r of res.results ?? []) {
      const custId = String(r.customerId ?? "");
      if (!custId) continue;
      let allocated = 0;
      try {
        const parsed = JSON.parse(String(r.allocations ?? "[]")) as { amount?: number }[];
        if (Array.isArray(parsed)) for (const a of parsed) allocated += Math.round(Number(a?.amount) || 0);
      } catch { /* malformed JSON → treat as unallocated, which the card shows */ }
      const sen = Math.round(Number(r.amount) || 0) - allocated;
      if (sen <= 0) continue;
      const item = { receiptNumber: String(r.receiptNumber ?? ""), date: String(r.date ?? "").slice(0, 10), sen };
      const cur = out.get(custId);
      if (cur) { cur.sen += sen; cur.items.push(item); }
      else out.set(custId, { customerName: String(r.customerName ?? ""), sen, items: [item] });
    }
  } catch {
    /* payment_records unavailable → no advance rows */
  }
  void orgId; // payment_records is not org-scoped; kept for signature symmetry
  return out;
}

app.get("/aging", async (c) => {
  // RBAC gate (P3.3-followup) — accounting:read.
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  // Multi-company (Phase 1): OPTIONAL ?orgId= / ?company= scopes the aging to
  // one sister company. Absent → no WHERE change → today's consolidated view.
  // The column it filters on is runtime-ensured so this can never 500 on prod.
  await ensureFinanceOrgColumns(c.var.DB);
  const coFilter = companyFilter(c);
  const arWhere = coFilter.active ? ` WHERE ${coFilter.sql}` : "";
  const apWhere = coFilter.active ? ` WHERE ${coFilter.sql}` : "";
  const { withSnapshot } = await import("../lib/snapshot");
  // PR 7 — cache-aside snapshot. AR/AP aging is computed live from
  // unpaid invoices + purchase invoices, bucketed by months overdue
  // (the prod-correct source — the old ar_aging / ap_aging snapshot
  // tables are dead). The snapshot caches that computed result and
  // rebuilds whenever either source table changes.
  //
  // cacheKey partitions the consolidated ("") result from each per-company
  // ("company:<orgId>") result so a filtered request never poisons the
  // default cache — the default read stays byte-identical to today.
  const cacheKey = coFilter.active ? `company:${coFilter.orgId}` : "";
  const data = await withSnapshot(
    c.var.DB,
    {
      tableName: "accounting_aging_snapshot",
      // kv_config so the snapshot rebuilds when opening_date (the pre-opening
      // floor) is saved — not just when invoices/PIs change.
      // supplier_payments included so knocking off an advance rebuilds the
      // snapshot (advances appear as negative rows below).
      sourceTables: [
        "invoices", "purchase_invoices", "supplier_payments", "kv_config", "opening_ap_excludes",
        // Trade-finance section: a repayment allocation or a due-date edit
        // must rebuild the snapshot (kv_config above covers the Setup save).
        "trade_finance_draws", "trade_finance_repay_allocs",
      ],
    },
    orgId,
    async () => {
      const [invRes, piRes] = await Promise.all([
        c.var.DB.prepare(
          `SELECT customerId, customerName, invoiceNo, totalSen, paidAmount, status, dueDate, invoiceDate, isOpening FROM invoices${arWhere}`,
        )
          .bind(...(coFilter.active ? [coFilter.param] : []))
          .all<{
          customerId: string;
          customerName: string;
          invoiceNo?: string | null;
          invoice_no?: string | null;
          totalSen: number;
          paidAmount: number;
          status: string;
          dueDate: string | null;
          invoiceDate: string | null;
          isOpening: number | null;
        }>(),
        c.var.DB.prepare(
          `SELECT id, supplierId, supplierName, piNo, amountSen, paidAmountSen, status, dueDate, invoiceDate, isOpening FROM purchase_invoices${apWhere}`,
        )
          .bind(...(coFilter.active ? [coFilter.param] : []))
          .all<{
          id: string;
          supplierId: string;
          supplierName: string;
          piNo?: string | null;
          pi_no?: string | null;
          amountSen: number;
          paidAmountSen?: number | null;
          paid_amount_sen?: number | null;
          status: string;
          dueDate: string | null;
          invoiceDate: string | null;
          isOpening: number | null;
        }>(),
      ]);
      const obDateAg = await getOpeningDate(c.var.DB);
      const apExclAg = await loadOpeningApExcludes(c.var.DB);

      const arMap = new Map<string, ArAgingRow>();
      for (const i of invRes.results ?? []) {
        if (rowBeforeOpening(i.invoiceDate, obDateAg, i.isOpening)) continue; // pre-opening: not extracted
        if (["DRAFT", "CANCELLED", "PAID"].includes(i.status)) continue;
        const outstanding =
          (Number(i.totalSen) || 0) - (Number(i.paidAmount) || 0);
        if (outstanding <= 0) continue;
        let row = arMap.get(i.customerId);
        if (!row) {
          row = {
            customerId: i.customerId,
            customerName: i.customerName || "Unknown",
            currentSen: 0,
            days30Sen: 0,
            days60Sen: 0,
            days90Sen: 0,
            over90Sen: 0,
            docs: [],
          };
          arMap.set(i.customerId, row);
        }
        const moAr = monthsOverdue(i.invoiceDate ?? i.dueDate);
        addToBucket(row, moAr, outstanding);
        row.docs.push({
          no: String(i.invoiceNo ?? i.invoice_no ?? ""),
          date: String(i.invoiceDate ?? "").slice(0, 10),
          mo: agingBucketIdx(moAr),
          amountSen: outstanding,
        });
      }

      const apMap = new Map<string, ApAgingRow>();
      for (const p of piRes.results ?? []) {
        // Pre-opening PIs count as opening by default; only excluded ones drop.
        if (apRowBeforeOpening({ id: p.id, date: p.invoiceDate, isOpening: p.isOpening }, obDateAg, apExclAg)) continue;
        if (["DRAFT", "CANCELLED", "PAID"].includes(p.status)) continue;
        // Net outstanding = face − paid (BUG-2026-07-05-001: this tab showed the
        // FULL face amount for partially-paid PIs — the AR loop above always
        // netted, the AP loop didn't).
        const outstanding =
          (Number(p.amountSen) || 0) - (Number(p.paidAmountSen ?? p.paid_amount_sen) || 0);
        if (outstanding <= 0) continue;
        let row = apMap.get(p.supplierId);
        if (!row) {
          row = {
            supplierId: p.supplierId,
            supplierName: p.supplierName || "Unknown",
            currentSen: 0,
            days30Sen: 0,
            days60Sen: 0,
            days90Sen: 0,
            over90Sen: 0,
            docs: [],
          };
          apMap.set(p.supplierId, row);
        }
        const moAp = monthsOverdue(p.invoiceDate ?? p.dueDate);
        addToBucket(row, moAp, outstanding);
        row.docs.push({
          no: String(p.piNo ?? p.pi_no ?? ""),
          date: String(p.invoiceDate ?? "").slice(0, 10),
          mo: agingBucketIdx(moAp),
          amountSen: outstanding,
        });
      }
      // Unapplied supplier advances → NEGATIVE current-bucket rows (owner rule
      // 2026-07-05), so the AP aging total ties the 400-0000 control exactly.
      // Each advance also joins the expandable detail as its own negative doc.
      for (const [supplierId, adv] of await loadUnappliedSupplierAdvances(c.var.DB, orgId)) {
        let row = apMap.get(supplierId);
        if (!row) {
          row = {
            supplierId,
            supplierName: adv.supplierName || "Unknown",
            currentSen: 0,
            days30Sen: 0,
            days60Sen: 0,
            days90Sen: 0,
            over90Sen: 0,
            docs: [],
          };
          apMap.set(supplierId, row);
        }
        // Bucket each advance by ITS payment date (owner 2026-07-08: a May
        // advance belongs in the May column, not Current) — same month-based
        // bucketing as the bills above.
        for (const it of adv.items) {
          const moAdv = monthsOverdue(it.date || null);
          addToBucket(row, moAdv, -it.sen);
          row.docs.push({
            no: `${it.paymentNo} · Advance`,
            date: it.date,
            mo: agingBucketIdx(moAdv),
            amountSen: -it.sen,
          });
        }
      }
      // Unapplied customer advances → NEGATIVE rows, the mirror of the supplier
      // block above, so the AR aging total ties the 300-0000 control exactly.
      for (const [customerId, adv] of await loadUnappliedCustomerAdvances(c.var.DB, orgId)) {
        let row = arMap.get(customerId);
        if (!row) {
          row = {
            customerId,
            customerName: adv.customerName || "Unknown",
            currentSen: 0,
            days30Sen: 0,
            days60Sen: 0,
            days90Sen: 0,
            over90Sen: 0,
            docs: [],
          };
          arMap.set(customerId, row);
        }
        for (const it of adv.items) {
          const moAdv = monthsOverdue(it.date || null);
          addToBucket(row, moAdv, -it.sen);
          row.docs.push({
            no: `${it.receiptNumber} · Advance`,
            date: it.date,
            mo: agingBucketIdx(moAdv),
            amountSen: -it.sen,
          });
        }
      }
      // Owner rule 2026-07-09: within each aging bucket the NEWEST document
      // sits on top (bucket ascending, date descending).
      for (const row of arMap.values()) row.docs.sort((a, b) => a.mo - b.mo || b.date.localeCompare(a.date));
      for (const row of apMap.values()) row.docs.sort((a, b) => a.mo - b.mo || b.date.localeCompare(a.date));

      // Trade-finance section (owner 2026-08-11) — a SEPARATE block, never
      // mixed into the trade-creditor rows above: its subtotal ties the TF
      // account's ledger net, not 400-0000. Buckets run on the DUE date.
      const tfSection = [];
      try {
        const tfSrcs = await getTfSources(c.var.DB);
        const todayIsoTf = new Date().toISOString().slice(0, 10);
        for (const s of tfSrcs) {
          const acctRow = await c.var.DB.prepare("SELECT name FROM chart_of_accounts WHERE code = ?")
            .bind(s.accountCode).first<{ name: string }>();
          const derived = await loadTfDraws(c.var.DB, s);
          const tfDraws = [];
          for (const d of derived.draws) {
            let paidSupplier = "";
            try {
              const rs = await c.var.DB.prepare(
                "SELECT DISTINCT supplierName FROM supplier_payments WHERE paymentNo = ?",
              ).bind(d.drawSourceId).all<{ supplierName: string | null; supplier_name: string | null }>();
              paidSupplier = [...new Set(
                (rs.results ?? []).map((r) => String(r.supplierName ?? r.supplier_name ?? "").trim()).filter(Boolean),
              )].join(", ");
            } catch { /* leave blank */ }
            tfDraws.push({ ...d, paidSupplier });
          }
          tfSection.push({
            lender: s.lenderName,
            lenderSupplierId: s.lenderSupplierId,
            accountCode: s.accountCode,
            accountName: acctRow?.name ?? "",
            tenorDays: s.tenorDays,
            accountNetSen: derived.accountNetSen,
            unallocatedSen: derived.unallocatedSen,
            totals: tfTotals(derived.draws, todayIsoTf),
            draws: tfDraws,
          });
        }
      } catch {
        /* TF unconfigured / tables absent → empty section */
      }

      return {
        data: {
          ar: [...arMap.values()].sort((a, b) =>
            a.customerName.localeCompare(b.customerName),
          ),
          ap: [...apMap.values()].sort((a, b) =>
            a.supplierName.localeCompare(b.supplierName),
          ),
          tf: tfSection,
        },
      };
    },
    cacheKey,
  );
  return c.json({ success: true, ...data });
});

app.post("/aging", async (c) => {
  // RBAC gate (P3.3-followup) — accounting:create (drain aging buckets).
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { type, id, amountSen } = body;
    if (!type || !id || !amountSen || amountSen <= 0) {
      return c.json(
        { success: false, error: "type (ar|ap), id, and amountSen are required" },
        400,
      );
    }

    if (type !== "ar" && type !== "ap") {
      return c.json({ success: false, error: "type must be 'ar' or 'ap'" }, 400);
    }

    const table = type === "ar" ? "ar_aging" : "ap_aging";
    const idCol = type === "ar" ? "customerId" : "supplierId";

    const row = await c.var.DB.prepare(
      `SELECT * FROM ${table} WHERE ${idCol} = ?`,
    )
      .bind(id)
      .first<ArAgingRow | ApAgingRow>();
    if (!row) {
      return c.json(
        { success: false, error: type === "ar" ? "Customer not found in AR" : "Supplier not found in AP" },
        404,
      );
    }

    // Drain oldest → newest buckets.
    const buckets: Array<keyof (ArAgingRow | ApAgingRow)> = [
      "over90Sen",
      "days90Sen",
      "days60Sen",
      "days30Sen",
      "currentSen",
    ];
    let remaining = amountSen;
    const updated: Record<string, number> = {};
    for (const b of buckets) {
      const val = row[b] as number;
      const apply = Math.min(remaining, val);
      updated[b as string] = val - apply;
      remaining -= apply;
      if (remaining <= 0) {
        // fill the rest unchanged
        const idx = buckets.indexOf(b);
        for (let i = idx + 1; i < buckets.length; i++) {
          updated[buckets[i] as string] = row[buckets[i]] as number;
        }
        break;
      }
    }

    await c.var.DB.prepare(
      `UPDATE ${table}
         SET currentSen = ?, days30Sen = ?, days60Sen = ?, days90Sen = ?, over90Sen = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE ${idCol} = ?`,
    )
      .bind(
        updated.currentSen ?? row.currentSen,
        updated.days30Sen ?? row.days30Sen,
        updated.days60Sen ?? row.days60Sen,
        updated.days90Sen ?? row.days90Sen,
        updated.over90Sen ?? row.over90Sen,
        id,
      )
      .run();

    const after = await c.var.DB.prepare(
      `SELECT * FROM ${table} WHERE ${idCol} = ?`,
    )
      .bind(id)
      .first<ArAgingRow | ApAgingRow>();
    return c.json({ success: true, data: after });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// CHART OF ACCOUNTS
// ---------------------------------------------------------------------------
app.get("/coa", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const res = await c.var.DB.prepare(
    "SELECT * FROM chart_of_accounts WHERE isActive = 1 ORDER BY code",
  ).all<CoaRow>();
  const data = (res.results ?? []).map(rowToCoa);
  return c.json({ success: true, data, total: data.length });
});

app.post("/coa", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { code, name, type, parentCode, cashFlowCategory, specialAccountType } =
      body;
    if (!code || !name || !type) {
      return c.json(
        { success: false, error: "code, name, and type are required" },
        400,
      );
    }
    const validTypes = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE", "COST"];
    if (!validTypes.includes(type)) {
      return c.json({ success: false, error: "Invalid account type" }, 400);
    }
    const cfCat =
      cashFlowCategory == null || cashFlowCategory === ""
        ? null
        : String(cashFlowCategory).toUpperCase();
    if (cfCat && !["O", "I", "F"].includes(cfCat)) {
      return c.json(
        { success: false, error: "cashFlowCategory must be O, I, or F" },
        400,
      );
    }
    const satType =
      specialAccountType == null || specialAccountType === ""
        ? null
        : String(specialAccountType).trim();
    const pnlCat =
      body.pnlCategory == null || body.pnlCategory === ""
        ? null
        : String(body.pnlCategory).toUpperCase();
    if (pnlCat && !["FIXED", "VARIABLE", "OTHERS"].includes(pnlCat)) {
      return c.json(
        {
          success: false,
          error: "pnlCategory must be FIXED, VARIABLE, or OTHERS",
        },
        400,
      );
    }
    const isPostable = body.isPostable === false ? 0 : 1;
    const dup = await c.var.DB.prepare(
      "SELECT code FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first();
    if (dup) {
      return c.json({ success: false, error: "Account code already exists" }, 400);
    }
    // Creating under a LEAF parent promotes that parent — same no-amount
    // gate as drag re-parenting, or the rule could be bypassed from here.
    if (parentCode) {
      const promoErr = await promoteLeafParent(c.var.DB, parentCode);
      if (promoErr) {
        return c.json({ success: false, error: promoErr }, 400);
      }
    }

    await c.var.DB.prepare(
      `INSERT INTO chart_of_accounts (code, name, type, parentCode, balanceSen, isActive, cashFlowCategory, specialAccountType, pnlCategory, isPostable)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
    )
      .bind(code, name, type, parentCode ?? null, cfCat, satType, pnlCat, isPostable)
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first<CoaRow>();
    return c.json({ success: true, data: rowToCoa(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.put("/coa", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { code } = body;
    if (!code) {
      return c.json({ success: false, error: "code is required" }, 400);
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first<CoaRow>();
    if (!existing) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }
    const merged = {
      name: body.name ?? existing.name,
      parentCode:
        body.parentCode === undefined ? existing.parentCode : body.parentCode ?? null,
      isActive:
        body.isActive === undefined
          ? existing.isActive
          : body.isActive
            ? 1
            : 0,
      cashFlowCategory:
        body.cashFlowCategory === undefined
          ? existing.cashFlowCategory
          : body.cashFlowCategory == null || body.cashFlowCategory === ""
            ? null
            : String(body.cashFlowCategory).toUpperCase(),
      specialAccountType:
        body.specialAccountType === undefined
          ? existing.specialAccountType
          : body.specialAccountType == null || body.specialAccountType === ""
            ? null
            : String(body.specialAccountType).trim(),
      pnlCategory:
        body.pnlCategory === undefined
          ? existing.pnlCategory
          : body.pnlCategory == null || body.pnlCategory === ""
            ? null
            : String(body.pnlCategory).toUpperCase(),
      isPostable:
        body.isPostable === undefined
          ? (existing.isPostable ?? 1)
          : body.isPostable
            ? 1
            : 0,
    };
    if (
      merged.cashFlowCategory &&
      !["O", "I", "F"].includes(merged.cashFlowCategory)
    ) {
      return c.json(
        { success: false, error: "cashFlowCategory must be O, I, or F" },
        400,
      );
    }
    if (
      merged.pnlCategory &&
      !["FIXED", "VARIABLE", "OTHERS"].includes(merged.pnlCategory)
    ) {
      return c.json(
        {
          success: false,
          error: "pnlCategory must be FIXED, VARIABLE, or OTHERS",
        },
        400,
      );
    }
    // Re-parenting (drag & drop) must not create a cycle: walk the new
    // parent's ancestry — hitting the account itself means the drop would
    // put a node inside its own subtree.
    if (merged.parentCode && merged.parentCode !== existing.parentCode) {
      if (merged.parentCode === code) {
        return c.json({ success: false, error: "An account cannot be its own parent" }, 400);
      }
      let cur: string | null = merged.parentCode;
      for (let hops = 0; cur && hops < 20; hops++) {
        if (cur === code) {
          return c.json(
            { success: false, error: "Cannot move an account inside its own sub-accounts" },
            400,
          );
        }
        const p: { parentCode: string | null } | null = await c.var.DB.prepare(
          "SELECT parentCode FROM chart_of_accounts WHERE code = ?",
        )
          .bind(cur)
          .first<{ parentCode: string | null }>();
        cur = p?.parentCode ?? null;
      }
      // Owner (2026-06): dropping onto a LEAF account promotes it into a
      // parent — allowed only when that account carries NO amount.
      const promoErr = await promoteLeafParent(c.var.DB, merged.parentCode);
      if (promoErr) {
        return c.json({ success: false, error: promoErr }, 400);
      }
    }
    await c.var.DB.prepare(
      `UPDATE chart_of_accounts SET name = ?, parentCode = ?, isActive = ?, cashFlowCategory = ?, specialAccountType = ?, pnlCategory = ?, isPostable = ? WHERE code = ?`,
    )
      .bind(
        merged.name,
        merged.parentCode,
        merged.isActive,
        merged.cashFlowCategory,
        merged.specialAccountType,
        merged.pnlCategory,
        merged.isPostable,
        code,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(code)
      .first<CoaRow>();
    return c.json({ success: true, data: rowToCoa(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// POST /api/accounting/coa/rename — change an account's CODE with history
// following (owner request). Ledger legs are hash-protected and never
// rewritten; instead the COA row moves to the new code, children re-parent,
// legacy journal_lines update directly (not hash-protected), and an
// old→new alias makes every report resolve prior transactions to the new
// code. System-posted accounts are refused (PROTECTED_ACCOUNTS).
app.post("/coa/rename", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as { oldCode?: string; newCode?: string };
    const oldCode = String(body.oldCode ?? "").trim();
    const newCode = String(body.newCode ?? "").trim();
    if (!oldCode || !newCode) {
      return c.json({ success: false, error: "oldCode and newCode are required" }, 400);
    }
    if (oldCode === newCode) {
      return c.json({ success: false, error: "New code is the same as the old code" }, 400);
    }
    if (!/^[0-9A-Za-z][0-9A-Za-z-]{2,19}$/.test(newCode)) {
      return c.json({ success: false, error: "New code format invalid (letters, digits, dashes; 3-20 chars)" }, 400);
    }
    if (PROTECTED_ACCOUNTS.has(oldCode)) {
      return c.json(
        {
          success: false,
          error: `${oldCode} is a system-posted account (auto-posting references it directly) — its code cannot be changed.`,
        },
        400,
      );
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM chart_of_accounts WHERE code = ?",
    )
      .bind(oldCode)
      .first<CoaRow>();
    if (!existing) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }
    const clash = await c.var.DB.prepare(
      "SELECT code FROM chart_of_accounts WHERE code = ?",
    )
      .bind(newCode)
      .first();
    if (clash) {
      return c.json({ success: false, error: `${newCode} already exists` }, 400);
    }
    try {
      const aliasClash = await c.var.DB.prepare(
        "SELECT oldCode FROM account_aliases WHERE oldCode = ?",
      )
        .bind(newCode)
        .first();
      if (aliasClash) {
        return c.json(
          { success: false, error: `${newCode} was previously renamed away — pick a different code` },
          400,
        );
      }
    } catch {
      return c.json(
        { success: false, error: "account_aliases table missing — run migration 0157 first" },
        500,
      );
    }
    const now = new Date().toISOString();
    await c.var.DB.batch([
      c.var.DB.prepare(
        `INSERT INTO chart_of_accounts
           (code, name, type, parentCode, balanceSen, isActive, cashFlowCategory, specialAccountType, pnlCategory, isPostable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newCode,
        existing.name,
        existing.type,
        existing.parentCode,
        existing.balanceSen,
        existing.isActive,
        existing.cashFlowCategory,
        existing.specialAccountType,
        existing.pnlCategory,
        existing.isPostable ?? 1,
      ),
      c.var.DB.prepare(
        "UPDATE chart_of_accounts SET parentCode = ? WHERE parentCode = ?",
      ).bind(newCode, oldCode),
      c.var.DB.prepare(
        "UPDATE journal_lines SET accountCode = ? WHERE accountCode = ?",
      ).bind(newCode, oldCode),
      // Collapse chains: anything previously renamed TO oldCode now points
      // straight at newCode (keeps resolution single-hop in practice).
      c.var.DB.prepare(
        "UPDATE account_aliases SET newCode = ? WHERE newCode = ?",
      ).bind(newCode, oldCode),
      c.var.DB.prepare(
        "INSERT INTO account_aliases (oldCode, newCode, renamedAt) VALUES (?, ?, ?)",
      ).bind(oldCode, newCode, now),
      c.var.DB.prepare("DELETE FROM chart_of_accounts WHERE code = ?").bind(
        oldCode,
      ),
    ]);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: newCode,
      action: "update",
      before: { code: oldCode },
      after: { code: newCode, renamedFrom: oldCode },
    });
    return c.json({ success: true, data: { oldCode, newCode } });
  } catch (e) {
    console.error("[coa/rename] failed:", e);
    return c.json({ success: false, error: "Rename failed — nothing was changed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// JOURNALS
// ---------------------------------------------------------------------------
app.get("/journals", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  // T5d: annotate each JV with its lifecycle state and hide DELETED ones.
  // VOID/REVERSED JVs still show (with state); only DELETED is excluded.
  //
  // BUG-2026-08-13-083: this used to carry the comment "journal_entries has no
  // orgId column (it predates multi-tenancy)". That premise was FALSE — both
  // journal_entries and journal_lines have carried `org_id TEXT NOT NULL
  // DEFAULT 'hookka'` since migration 0087, re-applied by 0206 and by the
  // runtime `ensureFinanceOrgColumns`. The orgId was bound into the JOIN
  // condition only, so the manual-journal surface was the one accounting
  // document type with NO tenant boundary at all (C12). Byte-identical today
  // (one org, and every row carries the column default); load-bearing the day a
  // second tenant is seeded.
  const orgId = getOrgId(c);
  const [entries, lines] = await Promise.all([
    c.var.DB.prepare(
      `SELECT journal_entries.*, dl.state AS lifecycleState
         FROM journal_entries
         LEFT JOIN document_lifecycle dl
           ON dl.orgId = ?
          AND dl.sourceType = 'manual'
          AND dl.sourceId = journal_entries.id
        WHERE journal_entries.orgId = ?
          AND (dl.state IS NULL OR dl.state <> 'DELETED')
        ORDER BY date DESC, entryNo DESC`,
    ).bind(orgId, orgId).all<JournalEntryRow & { lifecycleState: string | null }>(),
    c.var.DB.prepare("SELECT * FROM journal_lines WHERE orgId = ?").bind(orgId).all<JournalLineRow>(),
  ]);
  const data = (entries.results ?? []).map((e) => ({
    ...rowToJournal(e, lines.results ?? []),
    lifecycleState: e.lifecycleState ?? null,
  }));
  return c.json({ success: true, data, total: data.length });
});

app.post("/journals", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { date, description, lines } = body;
    if (!date || !description || !lines || !Array.isArray(lines) || lines.length === 0) {
      return c.json(
        { success: false, error: "date, description, and lines are required" },
        400,
      );
    }
    const totalDebit = lines.reduce(
      (s: number, l: { debitSen?: number }) => s + (l.debitSen || 0),
      0,
    );
    const totalCredit = lines.reduce(
      (s: number, l: { creditSen?: number }) => s + (l.creditSen || 0),
      0,
    );
    if (totalDebit !== totalCredit) {
      return c.json(
        { success: false, error: `Debits (${totalDebit}) must equal Credits (${totalCredit})` },
        400,
      );
    }
    if (totalDebit === 0) {
      return c.json({ success: false, error: "Journal entry must have non-zero amounts" }, 400);
    }

    const id = genId("je");
    const entryNo = await nextJeNo(c.var.DB);
    const createdBy = body.createdBy || "admin";
    const orgId = getOrgId(c);

    // orgId is STAMPED, not left to the column DEFAULT (BUG-2026-08-13-083) —
    // read scoping without write stamping is only half a boundary: a second
    // tenant's journals would land labelled 'hookka' and then be hidden from
    // the tenant that created them.
    await c.var.DB.prepare(
      `INSERT INTO journal_entries (id, entryNo, date, description, status, createdBy, orgId)
       VALUES (?, ?, ?, ?, 'DRAFT', ?, ?)`,
    )
      .bind(id, entryNo, date, description, createdBy, orgId)
      .run();

    const inserts = lines.map(
      (l: {
        accountCode: string;
        accountName?: string;
        debitSen?: number;
        creditSen?: number;
        description?: string;
      }, idx: number) =>
        c.var.DB.prepare(
          `INSERT INTO journal_lines
             (journalEntryId, lineOrder, accountCode, accountName, debitSen, creditSen, description, orgId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          idx,
          l.accountCode,
          l.accountName ?? "",
          l.debitSen ?? 0,
          l.creditSen ?? 0,
          l.description ?? "",
          orgId,
        ),
    );
    await c.var.DB.batch(inserts);

    const entry = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ?",
    )
      .bind(id)
      .first<JournalEntryRow>();
    const lineRows = await c.var.DB.prepare(
      "SELECT * FROM journal_lines WHERE journalEntryId = ? ORDER BY lineOrder",
    )
      .bind(id)
      .all<JournalLineRow>();
    return c.json(
      { success: true, data: rowToJournal(entry!, lineRows.results ?? []) },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/journals/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  // Entry-point read → carries the tenant predicate (BUG-2026-08-13-083). The
  // journal_lines read below is keyed off an id this query has already gated,
  // so it is transitively safe and deliberately left unscoped.
  const entry = await c.var.DB.prepare(
    "SELECT * FROM journal_entries WHERE id = ? AND orgId = ?",
  )
    .bind(id, getOrgId(c))
    .first<JournalEntryRow>();
  if (!entry) {
    return c.json({ success: false, error: "Journal entry not found" }, 404);
  }
  const lines = await c.var.DB.prepare(
    "SELECT * FROM journal_lines WHERE journalEntryId = ? ORDER BY lineOrder",
  )
    .bind(id)
    .all<JournalLineRow>();
  return c.json({
    success: true,
    data: rowToJournal(entry, lines.results ?? []),
  });
});

app.put("/journals/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    // Entry-point read → tenant-scoped (BUG-2026-08-13-083). Every journal_lines
    // read/write below is keyed off this already-gated id.
    const entry = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ? AND orgId = ?",
    )
      .bind(id, getOrgId(c))
      .first<JournalEntryRow>();
    if (!entry) {
      return c.json({ success: false, error: "Journal entry not found" }, 404);
    }
    const body = await c.req.json();

    // Status transitions — post or reverse the entry. Phase 1 (2026-06):
    // a manual JV now lands in ledger_journal_entries (sourceType 'manual'
    // / 'manual_reversal') in the SAME batch as the status flip and the
    // legacy balanceSen updates. This ends the dual-GL split where manual
    // entries lived only in journal_entries/balanceSen while every report
    // read the immutable ledger — a posted JV was invisible to the P&L/BS.
    // balanceSen is still maintained for the COA listing, but the ledger
    // is the authoritative source (trial balance & statements read it).
    if (body.status === "POSTED" && entry.status === "DRAFT") {
      const lines = await c.var.DB.prepare(
        "SELECT * FROM journal_lines WHERE journalEntryId = ?",
      )
        .bind(id)
        .all<JournalLineRow>();
      const lineRows = lines.results ?? [];

      // Every line must reference a real account — the old loop silently
      // `continue`d unknown codes, posting a half-balanced delta set.
      const acctByCode = new Map<string, CoaRow>();
      for (const l of lineRows) {
        if (acctByCode.has(l.accountCode)) continue;
        const acct = await c.var.DB.prepare(
          "SELECT * FROM chart_of_accounts WHERE code = ?",
        )
          .bind(l.accountCode)
          .first<CoaRow>();
        if (!acct) {
          return c.json(
            {
              success: false,
              error: `Journal line references unknown account ${l.accountCode} — fix the line before posting.`,
            },
            400,
          );
        }
        if ((acct.isPostable ?? 1) === 0) {
          return c.json(
            {
              success: false,
              error: `Account ${l.accountCode} (${acct.name}) is a header account — post to one of its child accounts instead.`,
            },
            400,
          );
        }
        acctByCode.set(l.accountCode, acct);
      }

      const statements: D1PreparedStatement[] = [
        c.var.DB.prepare(
          "UPDATE journal_entries SET status = 'POSTED' WHERE id = ?",
        ).bind(id),
      ];
      for (const l of lineRows) {
        const acct = acctByCode.get(l.accountCode)!;
        const delta =
          acct.type === "ASSET" ||
          acct.type === "EXPENSE" ||
          acct.type === "COST"
            ? l.debitSen - l.creditSen
            : l.creditSen - l.debitSen;
        statements.push(
          c.var.DB.prepare(
            "UPDATE chart_of_accounts SET balanceSen = balanceSen + ? WHERE code = ?",
          ).bind(delta, l.accountCode),
        );
      }

      try {
        const orgId = getOrgId(c);
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        if (!(await ledgerHasSource(c.var.DB, orgId, "manual", id))) {
          const legs: LedgerEntryInput[] = lineRows.map((l, idx) => ({
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "manual",
            sourceId: id,
            legNo: idx + 1,
            accountCode: l.accountCode,
            debitSen: l.debitSen || 0,
            creditSen: l.creditSen || 0,
            description: l.description || `JV ${entry.entryNo}`,
            actorUserId,
            orgId,
          }));
          const { statements: ledgerStmts } =
            await buildJournalEntryStatements(c.var.DB, orgId, legs);
          statements.push(...ledgerStmts);
        }
      } catch (e) {
        console.error(`[ledger] JV ${id} GL build failed — aborting:`, e);
        return c.json(
          {
            success: false,
            error:
              "Failed to build the ledger posting for this journal — nothing was saved. Retry, and report if it persists.",
          },
          500,
        );
      }

      await c.var.DB.batch(statements);
    } else if (body.status === "REVERSED" && entry.status === "POSTED") {
      const lines = await c.var.DB.prepare(
        "SELECT * FROM journal_lines WHERE journalEntryId = ?",
      )
        .bind(id)
        .all<JournalLineRow>();
      const lineRows = lines.results ?? [];

      const statements: D1PreparedStatement[] = [
        c.var.DB.prepare(
          "UPDATE journal_entries SET status = 'REVERSED' WHERE id = ?",
        ).bind(id),
      ];
      for (const l of lineRows) {
        const acct = await c.var.DB.prepare(
          "SELECT * FROM chart_of_accounts WHERE code = ?",
        )
          .bind(l.accountCode)
          .first<CoaRow>();
        if (!acct) continue;
        const delta =
          acct.type === "ASSET" ||
          acct.type === "EXPENSE" ||
          acct.type === "COST"
            ? -(l.debitSen - l.creditSen)
            : -(l.creditSen - l.debitSen);
        statements.push(
          c.var.DB.prepare(
            "UPDATE chart_of_accounts SET balanceSen = balanceSen + ? WHERE code = ?",
          ).bind(delta, l.accountCode),
        );
      }

      try {
        const orgId = getOrgId(c);
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        if (
          !(await ledgerHasSource(c.var.DB, orgId, "manual_reversal", id))
        ) {
          // Mirror legs with debit/credit swapped — the immutable ledger
          // never deletes; a reversal is a new, opposite entry.
          const legs: LedgerEntryInput[] = lineRows.map((l, idx) => ({
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "manual_reversal",
            sourceId: id,
            legNo: idx + 1,
            accountCode: l.accountCode,
            debitSen: l.creditSen || 0,
            creditSen: l.debitSen || 0,
            description: `REVERSAL · ${l.description || `JV ${entry.entryNo}`}`,
            actorUserId,
            orgId,
          }));
          const { statements: ledgerStmts } =
            await buildJournalEntryStatements(c.var.DB, orgId, legs);
          statements.push(...ledgerStmts);
        }
        // T5d (correctness): legacy reverse rolls back balanceSen + creates the
        // manual_reversal legs but never recorded document_lifecycle. Without
        // this upsert a later /journals/:id/lifecycle call sees getDocState =
        // ACTIVE and rolls balanceSen back a SECOND time (double-rollback bug).
        // Stamp state = VOID (same table/key as applyLifecycle) so the lifecycle
        // machine sees a consistent prior state.
        const now = new Date().toISOString();
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO document_lifecycle (id, sourceType, sourceId, state, actionAt, actorUserId, orgId)
             VALUES (?, ?, ?, 'VOID', ?, ?, ?)
             ON CONFLICT (orgId, sourceType, sourceId) DO UPDATE SET state='VOID', actionAt=?, actorUserId=?`,
          ).bind(`dl-${crypto.randomUUID().slice(0, 10)}`, "manual", id, now, actorUserId, orgId, now, actorUserId),
        );
        // Hide the reversed JV's legs (original + reversal) from the GL — the
        // legacy reverse stamps VOID but, before this, left both legs visible.
        statements.push(
          c.var.DB.prepare(
            "UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceType IN ('manual','manual_reversal') AND sourceId = ? AND orgId = ?",
          ).bind(id, orgId),
        );
      } catch (e) {
        console.error(
          `[ledger] JV ${id} reversal GL build failed — aborting:`,
          e,
        );
        return c.json(
          {
            success: false,
            error:
              "Failed to build the ledger reversal for this journal — nothing was saved. Retry, and report if it persists.",
          },
          500,
        );
      }

      await c.var.DB.batch(statements);
    } else if (entry.status === "DRAFT") {
      // Draft-only edits of header + lines.
      if (body.date !== undefined || body.description !== undefined) {
        await c.var.DB.prepare(
          "UPDATE journal_entries SET date = ?, description = ? WHERE id = ?",
        )
          .bind(body.date ?? entry.date, body.description ?? entry.description, id)
          .run();
      }
      if (body.lines !== undefined && Array.isArray(body.lines)) {
        const totalDebit = body.lines.reduce(
          (s: number, l: { debitSen?: number }) => s + (l.debitSen || 0),
          0,
        );
        const totalCredit = body.lines.reduce(
          (s: number, l: { creditSen?: number }) => s + (l.creditSen || 0),
          0,
        );
        if (totalDebit !== totalCredit) {
          return c.json(
            { success: false, error: "Debits must equal Credits" },
            400,
          );
        }
        await c.var.DB.prepare(
          "DELETE FROM journal_lines WHERE journalEntryId = ?",
        )
          .bind(id)
          .run();
        const inserts = body.lines.map(
          (l: {
            accountCode: string;
            accountName?: string;
            debitSen?: number;
            creditSen?: number;
            description?: string;
          }, idx: number) =>
            c.var.DB.prepare(
              `INSERT INTO journal_lines
                 (journalEntryId, lineOrder, accountCode, accountName, debitSen, creditSen, description, orgId)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              id,
              idx,
              l.accountCode,
              l.accountName ?? "",
              l.debitSen ?? 0,
              l.creditSen ?? 0,
              l.description ?? "",
              getOrgId(c),
            ),
        );
        if (inserts.length) await c.var.DB.batch(inserts);
      }
    }

    const updated = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ?",
    )
      .bind(id)
      .first<JournalEntryRow>();
    const lines = await c.var.DB.prepare(
      "SELECT * FROM journal_lines WHERE journalEntryId = ? ORDER BY lineOrder",
    )
      .bind(id)
      .all<JournalLineRow>();
    return c.json({
      success: true,
      data: rowToJournal(updated!, lines.results ?? []),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// Lifecycle (void | delete | unvoid) for a POSTED/REVERSED JV. JV is the only
// doc that maintains legacy balanceSen, so balanceSen is adjusted ONLY when
// crossing the ACTIVE boundary (prevState vs newState) — a VOID → DELETED
// transition does NOT touch balanceSen (avoids double-rollback). The ledger
// hidden flags + reversal entry are handled by applyLifecycle.
app.post("/journals/:id/lifecycle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  let action: "void" | "delete" | "unvoid";
  try { action = ((await c.req.json()) as { action: string }).action as typeof action; } catch { return c.json({ success: false, error: "Invalid body" }, 400); }
  if (!["void", "delete", "unvoid"].includes(action)) return c.json({ success: false, error: "action must be void|delete|unvoid" }, 400);

  // Entry-point read → tenant-scoped (BUG-2026-08-13-083).
  const entry = await c.var.DB.prepare("SELECT id, entryNo, status FROM journal_entries WHERE id = ? AND orgId = ?").bind(id, orgId).first<{ id: string; entryNo: string; status: string }>();
  if (!entry) return c.json({ success: false, error: "Journal entry not found" }, 404);
  // A DRAFT JV has no ledger posting — there is nothing to void/delete/unvoid.
  if (entry.status === "DRAFT") {
    return c.json({ success: false, error: "Draft journal has no ledger posting — post it first, or delete the draft." }, 400);
  }

  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  let lc: { statements: D1PreparedStatement[]; newState: string; prevState: string };
  try {
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: ["manual"], voidSourceType: "manual_reversal", sourceId: id, action, actorUserId, descriptionTag: `${action.toUpperCase()} · JV ${entry.entryNo}` });
  } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }

  // Boundary-aware: only adjust balanceSen when crossing the ACTIVE boundary.
  const deactivated = lc.prevState === "ACTIVE" && lc.newState !== "ACTIVE";
  const reactivated = lc.prevState !== "ACTIVE" && lc.newState === "ACTIVE";

  const statements: D1PreparedStatement[] = [
    ...lc.statements,
    // doc-specific side effect: sync status column (lifecycle state is source of truth; this is for UI)
    c.var.DB.prepare("UPDATE journal_entries SET status = ? WHERE id = ?").bind(lc.newState === "ACTIVE" ? "POSTED" : "REVERSED", id),
  ];

  if (deactivated || reactivated) {
    const lineRes = await c.var.DB.prepare("SELECT * FROM journal_lines WHERE journalEntryId = ?").bind(id).all<JournalLineRow>();
    for (const l of lineRes.results ?? []) {
      const acct = await c.var.DB.prepare("SELECT * FROM chart_of_accounts WHERE code = ?").bind(l.accountCode).first<CoaRow>();
      if (!acct) continue;
      // Same account-type-aware delta as PUT POST; subtract on deactivate, add on reactivate.
      const delta =
        acct.type === "ASSET" || acct.type === "EXPENSE" || acct.type === "COST"
          ? l.debitSen - l.creditSen
          : l.creditSen - l.debitSen;
      const signed = deactivated ? -delta : delta;
      statements.push(
        c.var.DB.prepare("UPDATE chart_of_accounts SET balanceSen = balanceSen + ? WHERE code = ?").bind(signed, l.accountCode),
      );
    }
  }

  await c.var.DB.batch(statements);
  return c.json({ success: true, data: { state: lc.newState } });
});

app.delete("/journals/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  // Entry-point read → tenant-scoped (BUG-2026-08-13-083); the DELETE below is
  // keyed off the id this read has already gated.
  const entry = await c.var.DB.prepare(
    "SELECT * FROM journal_entries WHERE id = ? AND orgId = ?",
  )
    .bind(id, getOrgId(c))
    .first<JournalEntryRow>();
  if (!entry) {
    return c.json({ success: false, error: "Journal entry not found" }, 404);
  }
  if (entry.status !== "DRAFT") {
    return c.json({ success: false, error: "Only DRAFT entries can be deleted" }, 400);
  }
  await c.var.DB.prepare("DELETE FROM journal_entries WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// AR CONTROL (Phase 2, 2026-06)
//
// "Can the debtor control account be trusted?" in one screen:
//   GET /ar-control          — every SDC control account's ledger balance,
//     the invoice-derived outstanding (gross), the customers.outstandingSen
//     running counter, the drift between them, and per-customer aging
//     buckets (not-due / 1-30 / 31-60 / 61-90 / 91-120 / 120+ by dueDate).
//   GET /customer-statement  — one customer's chronological statement
//     (invoices DR, receipts CR, CN CR, DN DR, bounce reversals) with
//     opening / running / closing balances. Printable from the UI.
// ---------------------------------------------------------------------------
app.get("/ar-control", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  // Multi-company (Phase 1): OPTIONAL ?orgId= / ?company= scopes the control
  // account to one company. Absent → today's consolidated numbers, unchanged.
  const coFilter = companyFilter(c, "orgId");
  const legWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const invWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const custWhere = coFilter.active ? ` WHERE ${coFilter.sql}` : "";
  const [coaRes, legRes, invRes, custRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT code, name, type, specialAccountType FROM chart_of_accounts WHERE specialAccountType = 'SDC'",
    ).all<{ code: string; name: string; type: string; specialAccountType: string }>(),
    c.var.DB.prepare(
      `SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0${legWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{ accountCode: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; sourceType: string }>(),
    c.var.DB.prepare(
      `SELECT customerId, customerName, invoiceNo, totalSen, paidAmount, status, dueDate, invoiceDate, isOpening
         FROM invoices
        WHERE status NOT IN ('DRAFT','CANCELLED')${invWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{
      customerId: string;
      customerName: string;
      invoiceNo: string;
      totalSen: number;
      paidAmount: number;
      status: string;
      dueDate: string | null;
      invoiceDate: string | null;
      isOpening: number | null;
    }>(),
    c.var.DB.prepare(
      `SELECT COALESCE(SUM(outstandingSen),0) AS s FROM customers${custWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .first<{ s: number }>(),
  ]);
  const { docDate, openingDate: obDateAr } = await loadDocDateResolver(c.var.DB);
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  const resolveCtl = await loadAccountResolver(c.var.DB);
  for (const l of legRes.results ?? []) {
    if (legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDateAr)) continue; // pre-opening: not extracted
    const code = resolveCtl(l.accountCode);
    dr.set(code, (dr.get(code) ?? 0) + (Number(l.debitSen) || 0));
    cr.set(code, (cr.get(code) ?? 0) + (Number(l.creditSen) || 0));
  }
  const controls = (coaRes.results ?? [])
    .map((a) => ({
      code: a.code,
      name: a.name,
      balanceSen: (dr.get(a.code) ?? 0) - (cr.get(a.code) ?? 0),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  // Trade controls only — 305-0000 OTHER DEBTOR has its own registry and
  // is reconciled on the Other D/C tab, not against the customers table.
  const tradeControlSen = controls
    .filter((a) => a.code !== "305-0000")
    .reduce((s, a) => s + a.balanceSen, 0);

  const today = new Date().toISOString().slice(0, 10);
  type AgingRow = {
    customerId: string;
    customerName: string;
    notDueSen: number;
    d30Sen: number;
    d60Sen: number;
    d90Sen: number;
    d120Sen: number;
    over120Sen: number;
    totalSen: number;
  };
  const byCustomer = new Map<string, AgingRow>();
  let invoiceOutstandingSen = 0;
  for (const inv of invRes.results ?? []) {
    if (rowBeforeOpening(inv.invoiceDate, obDateAr, inv.isOpening)) continue; // pre-opening: not extracted
    const unpaid = Math.max(
      0,
      (Number(inv.totalSen) || 0) - (Number(inv.paidAmount) || 0),
    );
    if (unpaid === 0) continue;
    invoiceOutstandingSen += unpaid;
    let row = byCustomer.get(inv.customerId);
    if (!row) {
      row = {
        customerId: inv.customerId,
        customerName: inv.customerName || "Unknown",
        notDueSen: 0,
        d30Sen: 0,
        d60Sen: 0,
        d90Sen: 0,
        d120Sen: 0,
        over120Sen: 0,
        totalSen: 0,
      };
      byCustomer.set(inv.customerId, row);
    }
    const due = inv.dueDate || today;
    const overdueDays =
      due >= today
        ? 0
        : Math.floor(
            (new Date(`${today}T00:00:00Z`).getTime() -
              new Date(`${due}T00:00:00Z`).getTime()) /
              86400000,
          );
    if (overdueDays <= 0) row.notDueSen += unpaid;
    else if (overdueDays <= 30) row.d30Sen += unpaid;
    else if (overdueDays <= 60) row.d60Sen += unpaid;
    else if (overdueDays <= 90) row.d90Sen += unpaid;
    else if (overdueDays <= 120) row.d120Sen += unpaid;
    else row.over120Sen += unpaid;
    row.totalSen += unpaid;
  }
  const aging = [...byCustomer.values()].sort(
    (a, b) => b.totalSen - a.totalSen,
  );
  const customerCounterSen = Number(custRes?.s) || 0;
  // Money received but not yet knocked off an invoice. The debtor control was
  // credited in full when the receipt posted, so the subledger only ties once
  // the advance is netted off — mirrors netOutstandingSen on /ap-control. The
  // per-invoice counter deliberately does NOT include it: that number answers
  // "what do the invoices say", and an advance belongs to no invoice yet.
  const advMapAr = await loadUnappliedCustomerAdvances(c.var.DB, getOrgId(c));
  const unappliedAdvanceSen = [...advMapAr.values()].reduce((s, a) => s + a.sen, 0);
  const netOutstandingSen = invoiceOutstandingSen - unappliedAdvanceSen;
  return c.json({
    success: true,
    data: {
      asOf: today,
      controls,
      tradeControlSen,
      invoiceOutstandingSen,
      customerCounterSen,
      unappliedAdvanceSen,
      netOutstandingSen,
      driftControlVsInvoicesSen: tradeControlSen - netOutstandingSen,
      driftCounterVsInvoicesSen: customerCounterSen - invoiceOutstandingSen,
      aging,
    },
  });
});

app.get("/customer-statement", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const customerId = c.req.query("customerId");
  if (!customerId) {
    return c.json({ success: false, error: "customerId is required" }, 400);
  }
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const [cust, invRes, payRes, cnRes, dnRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT id, name, code, outstandingSen FROM customers WHERE id = ?",
    )
      .bind(customerId)
      .first<{ id: string; name: string; code: string; outstandingSen: number }>(),
    c.var.DB.prepare(
      `SELECT invoiceNo, invoiceDate, totalSen, status, isOpening FROM invoices
        WHERE customerId = ? AND status NOT IN ('DRAFT','CANCELLED')`,
    )
      .bind(customerId)
      .all<{ invoiceNo: string; invoiceDate: string; totalSen: number; status: string; isOpening: number | null }>(),
    c.var.DB.prepare(
      // VOID/DELETED receipts are excluded, exactly as /debtor-ledger does it
      // (BUG-2026-08-13-080). The two build the SAME line model — this query was
      // the only difference, so a voided receipt credited the printed statement
      // while the all-party ledger next to it did not.
      `SELECT receiptNumber, date, amount, status, method FROM payment_records
        WHERE customerId = ?
          AND id NOT IN (SELECT sourceId FROM document_lifecycle WHERE sourceType = 'payment' AND state IN ('VOID','DELETED'))`,
    )
      .bind(customerId)
      .all<{ receiptNumber: string; date: string; amount: number; status: string; method: string }>(),
    c.var.DB.prepare(
      `SELECT noteNumber, date, totalAmount, status FROM credit_notes
        WHERE customerId = ? AND status IN ('APPROVED','POSTED')`,
    )
      .bind(customerId)
      .all<{ noteNumber: string; date: string; totalAmount: number; status: string }>(),
    c.var.DB.prepare(
      `SELECT noteNumber, date, totalAmount, status FROM debit_notes
        WHERE customerId = ? AND status = 'POSTED'`,
    )
      .bind(customerId)
      .all<{ noteNumber: string; date: string; totalAmount: number; status: string }>(),
  ]);
  if (!cust) {
    return c.json({ success: false, error: "Customer not found" }, 404);
  }
  type Line = {
    date: string;
    ref: string;
    type: string;
    debitSen: number;
    creditSen: number;
    isOpening?: number | null;
  };
  const lines: Line[] = [];
  for (const i of invRes.results ?? [])
    lines.push({
      date: i.invoiceDate ?? "",
      ref: i.invoiceNo,
      type: "INVOICE",
      debitSen: Number(i.totalSen) || 0,
      creditSen: 0,
      isOpening: i.isOpening,
    });
  for (const p of payRes.results ?? []) {
    lines.push({
      date: p.date ?? "",
      ref: p.receiptNumber,
      type: "RECEIPT",
      debitSen: 0,
      creditSen: Number(p.amount) || 0,
    });
    // A bounced cheque re-opens the debt: show the reversal explicitly.
    if (p.status === "BOUNCED")
      lines.push({
        date: p.date ?? "",
        ref: p.receiptNumber,
        type: "BOUNCED",
        debitSen: Number(p.amount) || 0,
        creditSen: 0,
      });
  }
  for (const n of cnRes.results ?? [])
    lines.push({
      date: n.date ?? "",
      ref: n.noteNumber,
      type: "CREDIT_NOTE",
      debitSen: 0,
      creditSen: Number(n.totalAmount) || 0,
    });
  for (const n of dnRes.results ?? [])
    lines.push({
      date: n.date ?? "",
      ref: n.noteNumber,
      type: "DEBIT_NOTE",
      debitSen: Number(n.totalAmount) || 0,
      creditSen: 0,
    });
  lines.sort((a, b) =>
    a.date === b.date ? a.ref.localeCompare(b.ref) : a.date.localeCompare(b.date),
  );
  const obDateCs = await getOpeningDate(c.var.DB);
  let openingSen = 0;
  const rows: (Line & { runningSen: number })[] = [];
  let running = 0;
  for (const l of lines) {
    if (rowBeforeOpening(l.date, obDateCs, l.isOpening)) continue; // pre-opening: not extracted (not even into B/F)
    const delta = l.debitSen - l.creditSen;
    if (l.date < from) {
      openingSen += delta;
      continue;
    }
    if (l.date > to) continue;
    running = (rows.length === 0 ? openingSen : running) + delta;
    rows.push({ ...l, runningSen: running });
  }
  return c.json({
    success: true,
    data: {
      customer: { id: cust.id, name: cust.name, code: cust.code },
      from: from || null,
      to: to === "9999-12-31" ? null : to,
      openingSen,
      closingSen: rows.length ? rows[rows.length - 1].runningSen : openingSen,
      rows,
    },
  });
});

// ---------------------------------------------------------------------------
// PURCHASE CREDIT NOTES (Phase 2, 2026-06) — supplier CN for purchase
// returns / price credits. Pure finance document (never touches PO/GRN
// operations). POSTED legs mirror the PI APPROVED posting flipped:
//   DR 400-0000 TRADE CREDITORS   gross (we owe less)
//   CR <mapped purchase accounts> per line (TAX lines → 706-0000)
// via the SAME account mapper the PI uses, so a CN always reverses into
// the accounts its PI debited. Supplier outstanding decremented in the
// same batch; idempotent; GL build failure aborts.
// ---------------------------------------------------------------------------
type PcnItem = {
  materialCode?: string | null;
  description: string;
  quantity: number;
  unitPriceSen: number;
  lineType: string;
};
type PcnRow = {
  id: string;
  noteNumber: string;
  supplierId: string;
  supplierName: string;
  purchaseInvoiceId: string | null;
  piNo: string | null;
  date: string;
  reason: string | null;
  reasonDetail: string | null;
  items: string | null;
  totalAmount: number;
  status: string;
};

function rowToPcn(r: PcnRow) {
  let items: PcnItem[] = [];
  try {
    items = JSON.parse(r.items ?? "[]") as PcnItem[];
  } catch {
    items = [];
  }
  return {
    id: r.id,
    noteNumber: r.noteNumber,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    purchaseInvoiceId: r.purchaseInvoiceId ?? "",
    piNo: r.piNo ?? "",
    date: r.date,
    reason: r.reason ?? "",
    reasonDetail: r.reasonDetail ?? "",
    items,
    totalAmount: r.totalAmount,
    status: r.status,
  };
}

async function nextPcnNo(db: Env["Variables"]["DB"]): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PCN-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT noteNumber FROM purchase_credit_notes WHERE noteNumber LIKE ? ORDER BY noteNumber DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ noteNumber: string }>();
  if (!res) return `${prefix}001`;
  const seq = parseInt(res.noteNumber.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

app.get("/purchase-credit-notes", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const res = await c.var.DB.prepare(
    "SELECT * FROM purchase_credit_notes WHERE orgId = ? ORDER BY date DESC",
  )
    .bind(orgId)
    .all<PcnRow>();
  const data = (res.results ?? []).map(rowToPcn);
  return c.json({ success: true, data, total: data.length });
});

app.post("/purchase-credit-notes", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as {
      supplierId?: string;
      purchaseInvoiceId?: string;
      reason?: string;
      reasonDetail?: string;
      items?: Array<{
        materialCode?: string;
        description?: string;
        quantity?: number;
        unitPriceSen?: number;
        lineType?: string;
      }>;
    };
    if (!body.supplierId || !Array.isArray(body.items) || body.items.length === 0) {
      return c.json(
        { success: false, error: "supplierId and items are required" },
        400,
      );
    }
    const supplier = await c.var.DB.prepare(
      "SELECT id, name FROM suppliers WHERE id = ?",
    )
      .bind(body.supplierId)
      .first<{ id: string; name: string }>();
    if (!supplier) {
      return c.json({ success: false, error: "Supplier not found" }, 404);
    }
    let piNo: string | null = null;
    if (body.purchaseInvoiceId) {
      const pi = await c.var.DB.prepare(
        "SELECT id, piNo FROM purchase_invoices WHERE id = ?",
      )
        .bind(body.purchaseInvoiceId)
        .first<{ id: string; piNo: string }>();
      if (!pi) {
        return c.json(
          { success: false, error: "Purchase invoice not found" },
          404,
        );
      }
      piNo = pi.piNo;
    }
    const items: PcnItem[] = [];
    for (const raw of body.items) {
      const quantity = Number(raw.quantity);
      const unitPriceSen = Number(raw.unitPriceSen);
      if (!Number.isInteger(unitPriceSen) || unitPriceSen < 0) {
        return c.json(
          {
            success: false,
            error: `unitPriceSen must be a non-negative integer (got ${raw.unitPriceSen}).`,
          },
          400,
        );
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return c.json(
          { success: false, error: `quantity must be > 0 (got ${raw.quantity}).` },
          400,
        );
      }
      const lt = String(raw.lineType ?? "STOCKED").toUpperCase();
      items.push({
        materialCode: raw.materialCode ?? null,
        description: String(raw.description ?? ""),
        quantity,
        unitPriceSen,
        lineType: ["STOCKED", "FEE", "TAX", "REBATE", "DISCOUNT", "OTHER"].includes(lt)
          ? lt
          : "OTHER",
      });
    }
    const totalAmount = items.reduce(
      (s, it) => s + Math.round(it.quantity * it.unitPriceSen),
      0,
    );
    if (totalAmount <= 0) {
      return c.json({ success: false, error: "Total must be > 0" }, 400);
    }
    const orgId = getOrgId(c);
    const id = `pcn-${crypto.randomUUID().slice(0, 8)}`;
    const noteNumber = await nextPcnNo(c.var.DB);
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO purchase_credit_notes
         (id, noteNumber, supplierId, supplierName, purchaseInvoiceId, piNo,
          date, reason, reasonDetail, items, totalAmount, status, orgId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
    )
      .bind(
        id,
        noteNumber,
        supplier.id,
        supplier.name,
        body.purchaseInvoiceId ?? null,
        piNo,
        now.slice(0, 10),
        body.reason ?? "",
        body.reasonDetail ?? "",
        JSON.stringify(items),
        totalAmount,
        orgId,
        now,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM purchase_credit_notes WHERE id = ?",
    )
      .bind(id)
      .first<PcnRow>();
    return c.json({ success: true, data: rowToPcn(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.put("/purchase-credit-notes/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const existing = await c.var.DB.prepare(
      "SELECT * FROM purchase_credit_notes WHERE id = ?",
    )
      .bind(id)
      .first<PcnRow>();
    if (!existing) {
      return c.json({ success: false, error: "Purchase CN not found" }, 404);
    }
    const body = (await c.req.json()) as {
      status?: string;
      // #6 Supplier Discount: optionally knock the credit off specific unpaid
      // PIs (one / many / none). Each reduces that PI's outstanding.
      allocations?: { piId: string; amountSen: number }[];
    };
    if (body.status !== "POSTED") {
      return c.json(
        { success: false, error: "Only status: 'POSTED' is supported" },
        400,
      );
    }
    if (existing.status === "POSTED") {
      return c.json({ success: true, data: rowToPcn(existing) });
    }
    const orgId = getOrgId(c);
    const gross = Number(existing.totalAmount) || 0;
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        "UPDATE purchase_credit_notes SET status = 'POSTED', updatedAt = ? WHERE id = ?",
      ).bind(new Date().toISOString(), id),
      c.var.DB.prepare(
        "UPDATE suppliers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?",
      ).bind(gross, existing.supplierId),
    ];
    try {
      if (
        !(await ledgerHasSource(c.var.DB, orgId, "purchase_credit_note", id))
      ) {
        const { mapPurchaseLinesToAccounts } = await import(
          "./purchase-invoices"
        );
        let items: PcnItem[] = [];
        try {
          items = JSON.parse(existing.items ?? "[]") as PcnItem[];
        } catch {
          items = [];
        }
        const { bucket, pdefault } = await mapPurchaseLinesToAccounts(
          c.var.DB,
          items.map((it) => ({
            mc: it.materialCode ?? null,
            amt: Math.round(it.quantity * it.unitPriceSen),
            lt: it.lineType,
          })),
        );
        const sumLines = Object.values(bucket).reduce((s, v) => s + v, 0);
        if (sumLines !== gross)
          bucket[pdefault] = (bucket[pdefault] ?? 0) + (gross - sumLines);
        const actorUserId =
          (
            c as unknown as { get: (k: string) => string | undefined }
          ).get("userId") ?? null;
        const legs: LedgerEntryInput[] = [];
        let legNo = 1;
        legs.push({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: "purchase_credit_note",
          sourceId: id,
          legNo: legNo++,
          accountCode: "400-0000",
          debitSen: gross,
          creditSen: 0,
          description: `Purchase CN ${existing.noteNumber} · ${existing.supplierName}`,
          actorUserId,
          orgId,
        });
        for (const [acct, amt] of Object.entries(bucket)) {
          if (amt === 0) continue;
          legs.push({
            id: `lje-${crypto.randomUUID().slice(0, 12)}`,
            sourceType: "purchase_credit_note",
            sourceId: id,
            legNo: legNo++,
            accountCode: acct,
            debitSen: 0,
            creditSen: amt,
            description: `Purchase CN ${existing.noteNumber} · return/credit`,
            actorUserId,
            orgId,
          });
        }
        const { statements: ledgerStmts } = await buildJournalEntryStatements(
          c.var.DB,
          orgId,
          legs,
        );
        statements.push(...ledgerStmts);
      }
    } catch (e) {
      console.error(`[ledger] PCN ${id} GL build failed — aborting:`, e);
      return c.json(
        {
          success: false,
          error:
            "Failed to build the GL posting for this purchase CN — nothing was saved. Retry, and report if it persists.",
        },
        500,
      );
    }
    // ── #6 Supplier Discount — optionally knock the credit off specific PIs ──
    // Validate server-side (don't trust the client): each allocated PI must be
    // this supplier's, payable, and the amount ≤ its outstanding; Σ ≤ gross.
    // Each applied amount reduces that PI's paid_amount_sen (subledger) + leaves
    // a supplier_payments marker (method=CREDIT_NOTE, NO bank/GL leg — the GL
    // 400-0000 was already reduced by the CN posting above; the markers just
    // attribute it to PIs and let Void reverse it). Joins the same atomic batch.
    const allocs = (body.allocations ?? []).filter(
      (a) => Math.round(a.amountSen) > 0,
    );
    if (allocs.length) {
      // Migration 7 (paid_amount_sen / booked_sen) may be unapplied on prod —
      // ensure the columns exist before the allocation writes them.
      await ensurePartialPaymentColumns(c.var.DB);
      const open: PiOpen[] = [];
      for (const a of allocs) {
        const pi = await c.var.DB.prepare(
          "SELECT id, supplierId, amountSen, paid_amount_sen, status FROM purchase_invoices WHERE id = ?",
        )
          .bind(a.piId)
          .first<Record<string, unknown>>();
        if (!pi) {
          return c.json({ success: false, error: `Invoice ${a.piId} not found` }, 400);
        }
        if (String(pi.supplierId ?? pi.supplier_id ?? "") !== existing.supplierId) {
          return c.json({ success: false, error: `Invoice ${a.piId} is not this supplier's` }, 400);
        }
        const st = String(pi.status ?? "");
        if (st !== "CONFIRMED" && st !== "APPROVED" && st !== "PARTIAL_PAID") {
          return c.json({ success: false, error: `Invoice ${a.piId} is not in a payable status` }, 400);
        }
        const amount = Number(pi.amountSen ?? pi.amount_sen) || 0;
        const paid = Number(pi.paid_amount_sen ?? pi.paidAmountSen) || 0;
        open.push({ piId: a.piId, outstandingSen: amount - paid });
      }
      const alloc = computeDiscountAlloc({ discountTotalSen: gross, open, allocations: allocs });
      if (!alloc.ok) {
        return c.json({ success: false, error: alloc.error }, 400);
      }
      const today = new Date().toISOString().slice(0, 10);
      for (const ap of alloc.applied) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO supplier_payments (
               id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
               date, amountSen, bookedSen, foreignSen, payFxRate,
               method, reference, notes, orgId
             ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, 'CREDIT_NOTE', ?, ?, ?)`,
          ).bind(
            `sp-${crypto.randomUUID().slice(0, 8)}`,
            existing.noteNumber,
            existing.supplierId,
            existing.supplierName,
            ap.piId,
            today,
            ap.appliedSen,
            existing.noteNumber,
            `Supplier discount ${existing.noteNumber}`,
            orgId,
          ),
        );
        statements.push(
          c.var.DB.prepare(
            `UPDATE purchase_invoices
               SET paid_amount_sen = paid_amount_sen + ?,
                   status = CASE
                     WHEN paid_amount_sen + ? >= amount_sen THEN 'PAID'
                     WHEN paid_amount_sen + ? > 0 THEN 'PARTIAL_PAID'
                     ELSE status
                   END
             WHERE id = ?`,
          ).bind(ap.appliedSen, ap.appliedSen, ap.appliedSen, ap.piId),
        );
      }
    }

    await c.var.DB.batch(statements);
    const updated = await c.var.DB.prepare(
      "SELECT * FROM purchase_credit_notes WHERE id = ?",
    )
      .bind(id)
      .first<PcnRow>();
    return c.json({ success: true, data: rowToPcn(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// POST /purchase-credit-notes/:id/void — reverse a posted supplier discount:
// mirror its GL legs, undo the supplier AP counter, and unwind any PI
// allocations (add the credited amount back to each PI's outstanding + drop the
// CREDIT_NOTE markers). Idempotent (re-void blocked by status; GL guarded). (#6)
app.post("/purchase-credit-notes/:id/void", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM purchase_credit_notes WHERE id = ?",
  )
    .bind(id)
    .first<PcnRow>();
  if (!existing) {
    return c.json({ success: false, error: "Purchase CN not found" }, 404);
  }
  if (existing.status !== "POSTED") {
    return c.json(
      { success: false, error: "Only a posted credit note can be voided" },
      400,
    );
  }
  const orgId = getOrgId(c);
  const gross = Number(existing.totalAmount) || 0;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    c.var.DB.prepare(
      "UPDATE purchase_credit_notes SET status = 'CANCELLED', updatedAt = ? WHERE id = ?",
    ).bind(now, id),
    c.var.DB.prepare(
      "UPDATE suppliers SET outstandingSen = outstandingSen + ? WHERE id = ?",
    ).bind(gross, existing.supplierId),
  ];
  // Reverse the GL once: read the original legs, post their mirror.
  if (
    (await ledgerHasSource(c.var.DB, orgId, "purchase_credit_note", id)) &&
    !(await ledgerHasSource(c.var.DB, orgId, "purchase_credit_note_void", id))
  ) {
    const orig =
      (
        await c.var.DB.prepare(
          "SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries WHERE sourceType = 'purchase_credit_note' AND sourceId = ? AND orgId = ?",
        )
          .bind(id, orgId)
          .all<Record<string, unknown>>()
      ).results ?? [];
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get(
        "userId",
      ) ?? null;
    const revLegs: LedgerEntryInput[] = orig.map((l, i) => ({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "purchase_credit_note_void",
      sourceId: id,
      legNo: i + 1,
      accountCode: String(l.accountCode ?? l.account_code ?? ""),
      debitSen: Number(l.creditSen ?? l.credit_sen) || 0,
      creditSen: Number(l.debitSen ?? l.debit_sen) || 0,
      description: `VOID Purchase CN ${existing.noteNumber}`,
      actorUserId,
      orgId,
    }));
    const { statements: ls } = await buildJournalEntryStatements(
      c.var.DB,
      orgId,
      revLegs,
    );
    statements.push(...ls);
  }
  // Unwind PI allocations: every CREDIT_NOTE marker under this CN's number.
  const markers =
    (
      await c.var.DB.prepare(
        "SELECT id, purchase_invoice_id, booked_sen FROM supplier_payments WHERE paymentNo = ? AND method = 'CREDIT_NOTE' AND orgId = ?",
      )
        .bind(existing.noteNumber, orgId)
        .all<Record<string, unknown>>()
    ).results ?? [];
  for (const mk of markers) {
    const piId = String(mk.purchase_invoice_id ?? mk.purchaseInvoiceId ?? "");
    const booked = Number(mk.booked_sen ?? mk.bookedSen) || 0;
    if (piId && booked > 0) {
      statements.push(
        c.var.DB.prepare(
          `UPDATE purchase_invoices
             SET paid_amount_sen = GREATEST(0, paid_amount_sen - ?),
                 status = CASE
                   WHEN paid_amount_sen - ? <= 0 THEN 'CONFIRMED'
                   WHEN paid_amount_sen - ? < amount_sen THEN 'PARTIAL_PAID'
                   ELSE 'PAID'
                 END
           WHERE id = ?`,
        ).bind(booked, booked, booked, piId),
      );
    }
    statements.push(
      c.var.DB.prepare("DELETE FROM supplier_payments WHERE id = ?").bind(
        String(mk.id),
      ),
    );
  }
  await c.var.DB.batch(statements);
  const updated = await c.var.DB.prepare(
    "SELECT * FROM purchase_credit_notes WHERE id = ?",
  )
    .bind(id)
    .first<PcnRow>();
  return c.json({ success: true, data: rowToPcn(updated!) });
});

// ---------------------------------------------------------------------------
// AP CONTROL (Phase 2, 2026-06) — mirror of /ar-control for the payable
// side: SCC creditor-control ledger balances vs Σ booked-unpaid purchase
// invoices (APPROVED), supplier aging by due date, and a supplier statement
// (PI CR / payment DR). The suppliers.outstandingSen counter is still computed
// below but no longer surfaced — its card was removed (2026-06-25) as a dead
// metric (the counter was never maintained); the control-vs-PI drift is the
// real reconciliation. `ensurePartialPaymentColumns` self-applies the
// migration-7 schema so reading paid_amount_sen here never 500s.
// ---------------------------------------------------------------------------
app.get("/ap-control", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  await ensurePartialPaymentColumns(c.var.DB);
  // Multi-company (Phase 1): OPTIONAL ?orgId= / ?company= scopes the payable
  // control to one company. Absent → today's consolidated numbers, unchanged.
  // Runtime-ensure org_id on suppliers / purchase_invoices so the filter cannot
  // 500 on a prod where the migration file hasn't been applied.
  await ensureFinanceOrgColumns(c.var.DB);
  const coFilter = companyFilter(c, "orgId");
  const legWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const supWhere = coFilter.active ? ` WHERE ${coFilter.sql}` : "";
  const piWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const [coaRes, legRes, supRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT code, name FROM chart_of_accounts WHERE specialAccountType = 'SCC'",
    ).all<{ code: string; name: string }>(),
    c.var.DB.prepare(
      `SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0${legWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{ accountCode: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; sourceType: string }>(),
    c.var.DB.prepare(
      `SELECT COALESCE(SUM(outstandingSen),0) AS s FROM suppliers${supWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .first<{ s: number }>(),
  ]);
  const { docDate, openingDate: obDateAp } = await loadDocDateResolver(c.var.DB);
  // PI subledger — defensive: prefer net outstanding (amount − paid, incl
  // PARTIAL_PAID); if paid_amount_sen is STILL absent (ALTER couldn't run), fall
  // back to the original (APPROVED only, paid=0) so the panel always renders.
  type PiAgingRow = {
    id: string;
    supplierId: string;
    supplierName: string;
    piNo: string;
    amountSen: number;
    // Both spellings: the SQL asks for paid_amount_sen, the adapter hands back
    // paidAmountSen. Declaring only the snake_case name is what let the
    // undefined read past the typechecker (BUG-2026-08-05-002).
    paidAmountSen?: number | null;
    paid_amount_sen?: number | null;
    status: string;
    dueDate: string | null;
    invoiceDate: string | null;
    isOpening: number | null;
  };
  let piRes: { results?: PiAgingRow[] };
  try {
    piRes = await c.var.DB.prepare(
      `SELECT id, supplierId, supplierName, piNo, amountSen, paid_amount_sen, status, dueDate, invoiceDate, isOpening
         FROM purchase_invoices
        WHERE status IN ('CONFIRMED', 'APPROVED', 'PARTIAL_PAID')${piWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<PiAgingRow>();
  } catch {
    piRes = await c.var.DB.prepare(
      `SELECT id, supplierId, supplierName, piNo, amountSen, status, dueDate, invoiceDate, isOpening
         FROM purchase_invoices
        WHERE status IN ('CONFIRMED', 'APPROVED')${piWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<PiAgingRow>();
  }
  // Posted purchase CNs reduce what we owe (the control account already absorbed
  // their DR 400-0000 legs). The ALLOCATED portion of each CN is already netted
  // off above via the knocked-off PIs' paid_amount_sen; only the UNALLOCATED
  // remainder (a supplier-level credit not tied to any PI) must be subtracted
  // here — otherwise an allocated discount is double-counted (#6).
  const pcnRes = await c.var.DB.prepare(
    "SELECT COALESCE(SUM(totalAmount),0) AS s FROM purchase_credit_notes WHERE status = 'POSTED'",
  ).first<{ s: number }>();
  let cnAllocSen = 0;
  try {
    const cnAllocRes = await c.var.DB.prepare(
      "SELECT COALESCE(SUM(booked_sen),0) AS s FROM supplier_payments WHERE method = 'CREDIT_NOTE'",
    ).first<{ s: number }>();
    cnAllocSen = Number(cnAllocRes?.s) || 0;
  } catch {
    cnAllocSen = 0; // supplier_payments / booked_sen not present yet → no netting
  }
  const pcnPostedSen = Math.max(0, (Number(pcnRes?.s) || 0) - cnAllocSen);
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  const resolveCtl = await loadAccountResolver(c.var.DB);
  for (const l of legRes.results ?? []) {
    if (legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDateAp)) continue; // pre-opening: not extracted
    const code = resolveCtl(l.accountCode);
    dr.set(code, (dr.get(code) ?? 0) + (Number(l.debitSen) || 0));
    cr.set(code, (cr.get(code) ?? 0) + (Number(l.creditSen) || 0));
  }
  const controls = (coaRes.results ?? [])
    .map((a) => ({
      code: a.code,
      name: a.name,
      // Liability: credit-normal.
      balanceSen: (cr.get(a.code) ?? 0) - (dr.get(a.code) ?? 0),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const tradeControlSen = controls
    .filter((a) => a.code !== "405-0000")
    .reduce((s, a) => s + a.balanceSen, 0);

  const today = new Date().toISOString().slice(0, 10);
  type ApAging = {
    supplierId: string;
    supplierName: string;
    notDueSen: number;
    d30Sen: number;
    d60Sen: number;
    d90Sen: number;
    d120Sen: number;
    over120Sen: number;
    totalSen: number;
  };
  const bySupplier = new Map<string, ApAging>();
  const apExclCtl = await loadOpeningApExcludes(c.var.DB);
  let piOutstandingSen = 0;
  for (const pi of piRes.results ?? []) {
    // Pre-opening PIs count as opening by default; only excluded ones drop.
    if (apRowBeforeOpening({ id: pi.id, date: pi.invoiceDate, isOpening: pi.isOpening }, obDateAp, apExclCtl)) continue;
    // Net outstanding = face − paid (paid includes cash payments AND allocated
    // CN credits), so a knocked-off discount drops the subledger exactly once.
    // Dual-key: the SQL asks for paid_amount_sen but the adapter camelCases
    // every result column, so the snake_case read alone lands on undefined and
    // silently counts every bill at FULL FACE (BUG-2026-08-05-002).
    const amt =
      (Number(pi.amountSen) || 0) - (Number(pi.paidAmountSen ?? pi.paid_amount_sen) || 0);
    if (amt <= 0) continue;
    piOutstandingSen += amt;
    let row = bySupplier.get(pi.supplierId);
    if (!row) {
      row = {
        supplierId: pi.supplierId,
        supplierName: pi.supplierName || "Unknown",
        notDueSen: 0,
        d30Sen: 0,
        d60Sen: 0,
        d90Sen: 0,
        d120Sen: 0,
        over120Sen: 0,
        totalSen: 0,
      };
      bySupplier.set(pi.supplierId, row);
    }
    const due = pi.dueDate || today;
    const overdueDays =
      due >= today
        ? 0
        : Math.floor(
            (new Date(`${today}T00:00:00Z`).getTime() -
              new Date(`${due}T00:00:00Z`).getTime()) /
              86400000,
          );
    if (overdueDays <= 0) row.notDueSen += amt;
    else if (overdueDays <= 30) row.d30Sen += amt;
    else if (overdueDays <= 60) row.d60Sen += amt;
    else if (overdueDays <= 90) row.d90Sen += amt;
    else if (overdueDays <= 120) row.d120Sen += amt;
    else row.over120Sen += amt;
    row.totalSen += amt;
  }
  // Unapplied supplier advances → NEGATIVE not-due rows (owner rule 2026-07-05),
  // so the aging table's total ties the 400-0000 control exactly; knock-off
  // clears both sides at once.
  const advMapCtl = await loadUnappliedSupplierAdvances(c.var.DB, getOrgId(c));
  for (const [supplierId, adv] of advMapCtl) {
    let row = bySupplier.get(supplierId);
    if (!row) {
      row = {
        supplierId,
        supplierName: adv.supplierName || "Unknown",
        notDueSen: 0,
        d30Sen: 0,
        d60Sen: 0,
        d90Sen: 0,
        d120Sen: 0,
        over120Sen: 0,
        totalSen: 0,
      };
      bySupplier.set(supplierId, row);
    }
    // Bucket each advance by ITS payment date (owner 2026-07-08) — same
    // day-based buckets as the bills above use for their due dates.
    for (const it of adv.items) {
      const d = it.date || today;
      const days = d >= today ? 0 : Math.floor((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${d}T00:00:00Z`).getTime()) / 86400000);
      const amt = -it.sen;
      if (days <= 0) row.notDueSen += amt;
      else if (days <= 30) row.d30Sen += amt;
      else if (days <= 60) row.d60Sen += amt;
      else if (days <= 90) row.d90Sen += amt;
      else if (days <= 120) row.d120Sen += amt;
      else row.over120Sen += amt;
      row.totalSen += amt;
    }
  }
  const aging = [...bySupplier.values()].sort((a, b) => b.totalSen - a.totalSen);
  const supplierCounterSen = Number(supRes?.s) || 0;
  const netSubledgerSen = piOutstandingSen - pcnPostedSen;
  // Owner rule 2026-07-08 (「卡改成净额」): the card figure is the NET owed —
  // bills minus un-knocked advances — so it ties the control; the advance sum
  // rides along as a reminder line instead of masquerading as drift.
  const unappliedAdvanceSen = [...advMapCtl.values()].reduce((s, a) => s + a.sen, 0);
  const netOutstandingSen = netSubledgerSen - unappliedAdvanceSen;
  return c.json({
    success: true,
    data: {
      asOf: today,
      controls,
      tradeControlSen,
      piOutstandingSen: netSubledgerSen,
      pcnPostedSen,
      unappliedAdvanceSen,
      netOutstandingSen,
      supplierCounterSen,
      driftControlVsPiSen: tradeControlSen - netOutstandingSen,
      driftCounterVsPiSen: supplierCounterSen - netSubledgerSen,
      aging,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /ap-reconciliation — itemized 400-0000 drift breakdown (owner rule
// 2026-07-08 「做账就是要准」— the drift card must break down to the sen).
// One request gathers the control legs, EVERY purchase invoice, EVERY
// supplier-payment row (lifecycle-aware) and the purchase-CN totals under the
// exact same floor/alias/company rules /ap-control uses, then the pure
// buildApReconciliation (tests/ap-recon.test.mjs) decomposes control − net
// into items whose contributions sum EXACTLY to the drift. Read-only.
// ---------------------------------------------------------------------------
app.get("/ap-reconciliation", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  await ensurePartialPaymentColumns(c.var.DB);
  await ensureFinanceOrgColumns(c.var.DB);
  const coFilter = companyFilter(c, "orgId");
  const legWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const piWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const orgId = getOrgId(c);

  const [legRes, piRes, pcnRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT accountCode, sourceType, sourceId, debitSen, creditSen, postedAt FROM ledger_journal_entries WHERE hidden = 0${legWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{ accountCode: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string }>(),
    c.var.DB.prepare(
      `SELECT id, piNo, supplierName, status, amountSen, paid_amount_sen, invoiceDate, isOpening FROM purchase_invoices WHERE 1=1${piWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{
        id: string; piNo?: string; pi_no?: string; supplierName?: string; supplier_name?: string;
        status: string; amountSen?: number; amount_sen?: number;
        paidAmountSen?: number | null; paid_amount_sen?: number | null;
        invoiceDate?: string | null; invoice_date?: string | null;
        isOpening?: number | null; is_opening?: number | null;
      }>(),
    c.var.DB.prepare(
      "SELECT COALESCE(SUM(totalAmount),0) AS s FROM purchase_credit_notes WHERE status = 'POSTED'",
    ).first<{ s: number }>(),
  ]);
  // Payment rows: EVERY row (cash + CN markers + voided/deleted) with its
  // lifecycle state — the recon itemizes what the aging loaders would count
  // vs what the GL shows, so nothing may be pre-filtered here.
  let payRows: {
    paymentNo?: string; payment_no?: string; supplierName?: string; supplier_name?: string;
    purchaseInvoiceId?: string | null; purchase_invoice_id?: string | null;
    date?: string; amountSen?: number; amount_sen?: number;
    bookedSen?: number | null; booked_sen?: number | null;
    method?: string; lifecycleState?: string | null; lifecyclestate?: string | null;
  }[] = [];
  try {
    const payRes = await c.var.DB.prepare(
      `SELECT sp.payment_no   AS payment_no,
              sp.supplier_name AS supplier_name,
              sp.purchase_invoice_id AS purchase_invoice_id,
              sp.date         AS date,
              sp.amount_sen   AS amount_sen,
              sp.booked_sen   AS booked_sen,
              COALESCE(sp.method, '') AS method,
              dl.state        AS lifecycleState
         FROM supplier_payments sp
         LEFT JOIN document_lifecycle dl
                ON dl.sourceType = 'supplier_payment'
               AND dl.sourceId = sp.payment_no
               AND dl.orgId = sp.org_id
        WHERE sp.org_id = ?`,
    )
      .bind(orgId)
      .all<(typeof payRows)[number]>();
    payRows = payRes.results ?? [];
  } catch {
    payRows = []; // supplier_payments absent (pre-migration DB) → payment side reads empty
  }
  let cnAllocCtlSen = 0;
  try {
    const cnAllocRes = await c.var.DB.prepare(
      "SELECT COALESCE(SUM(booked_sen),0) AS s FROM supplier_payments WHERE method = 'CREDIT_NOTE'",
    ).first<{ s: number }>();
    cnAllocCtlSen = Number(cnAllocRes?.s) || 0;
  } catch {
    cnAllocCtlSen = 0;
  }

  const { docDate, openingDate: obDateRc } = await loadDocDateResolver(c.var.DB);
  const resolveRc = await loadAccountResolver(c.var.DB);
  const apExclRc = await loadOpeningApExcludes(c.var.DB);

  // 400-0000 legs, post-floor + alias-resolved — the same filter chain the
  // /ap-control balance walks, so controlSen ties the card.
  const legs400: ApReconLeg[] = [];
  const drAll = new Map<string, number>();
  const crAll = new Map<string, number>();
  for (const l of legRes.results ?? []) {
    if (legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDateRc)) continue;
    const code = resolveRc(l.accountCode);
    drAll.set(code, (drAll.get(code) ?? 0) + (Number(l.debitSen) || 0));
    crAll.set(code, (crAll.get(code) ?? 0) + (Number(l.creditSen) || 0));
    if (code !== "400-0000") continue;
    legs400.push({
      sourceType: String(l.sourceType ?? ""),
      sourceId: String(l.sourceId ?? ""),
      debitSen: Number(l.debitSen) || 0,
      creditSen: Number(l.creditSen) || 0,
    });
  }

  const pis: ApReconPi[] = (piRes.results ?? []).map((r) => {
    const id = String(r.id);
    const invoiceDate = (r.invoiceDate ?? r.invoice_date ?? null) as string | null;
    const isOpening = !!(r.isOpening ?? r.is_opening);
    const floored = apRowBeforeOpening({ id, date: invoiceDate, isOpening }, obDateRc, apExclRc);
    const preOpeningIncluded =
      !floored && !isOpening && !!obDateRc && String(invoiceDate ?? "").slice(0, 10) < obDateRc;
    return {
      id,
      piNo: String(r.piNo ?? r.pi_no ?? ""),
      supplierName: String(r.supplierName ?? r.supplier_name ?? ""),
      status: String(r.status ?? ""),
      amountSen: Math.round(Number(r.amountSen ?? r.amount_sen) || 0),
      paidSen: Math.round(Number(r.paidAmountSen ?? r.paid_amount_sen) || 0),
      isOpening,
      preOpeningIncluded,
      floored,
    };
  });

  const paymentRows: ApReconPaymentRow[] = payRows.map((r) => {
    const state = String(r.lifecycleState ?? r.lifecyclestate ?? "") || "ACTIVE";
    return {
      paymentNo: String(r.paymentNo ?? r.payment_no ?? ""),
      purchaseInvoiceId: (r.purchaseInvoiceId ?? r.purchase_invoice_id ?? null) as string | null,
      bookedSen: Math.round(Number(r.bookedSen ?? r.booked_sen) || 0),
      amountSen: Math.round(Number(r.amountSen ?? r.amount_sen) || 0),
      method: String(r.method ?? ""),
      active: state === "ACTIVE",
      supplierName: String(r.supplierName ?? r.supplier_name ?? ""),
      date: String(r.date ?? "").slice(0, 10),
    };
  });

  const report = buildApReconciliation({
    legs400,
    pis,
    paymentRows,
    pcnPostedSen: Number(pcnRes?.s) || 0,
    cnAllocCtlSen,
  });

  // SCC control balances (405 excluded from trade, mirroring /ap-control) so
  // any gap between the card's tradeControlSen and pure 400-0000 is visible.
  const coaRes = await c.var.DB.prepare(
    "SELECT code, name FROM chart_of_accounts WHERE specialAccountType = 'SCC'",
  ).all<{ code: string; name: string }>();
  const controls = (coaRes.results ?? [])
    .map((a) => ({
      code: a.code,
      name: a.name,
      balanceSen: (crAll.get(a.code) ?? 0) - (drAll.get(a.code) ?? 0),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const tradeControlSen = controls
    .filter((a) => a.code !== "405-0000")
    .reduce((s, a) => s + a.balanceSen, 0);

  return c.json({
    success: true,
    data: {
      asOf: new Date().toISOString().slice(0, 10),
      openingDate: obDateRc ?? null,
      controls,
      tradeControlSen,
      nonTrade400GapSen: tradeControlSen - report.controlSen,
      ...report,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /ar-reconciliation — the AR twin of /ap-reconciliation. Same pure
// decomposition (ap-recon.ts) with AR_RECON_CFG: the 300-0000 control is
// DR-normal, so its legs are fed with debit/credit SWAPPED and the algebra
// holds unchanged (invoice faces ↔ doc family, customer receipts ↔ pay
// family, opening AR seeds ↔ opening). Read-only.
// ---------------------------------------------------------------------------
app.get("/ar-reconciliation", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  await ensureFinanceOrgColumns(c.var.DB);
  const coFilter = companyFilter(c, "orgId");
  const legWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const invWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";

  const [legRes, invRes, recRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT accountCode, sourceType, sourceId, debitSen, creditSen, postedAt FROM ledger_journal_entries WHERE hidden = 0${legWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{ accountCode: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string }>(),
    c.var.DB.prepare(
      `SELECT id, invoiceNo, customerName, status, totalSen, paidAmount, invoiceDate, isOpening FROM invoices WHERE 1=1${invWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{
        id: string; invoiceNo?: string; invoice_no?: string; customerName?: string; customer_name?: string;
        status: string; totalSen?: number; total_sen?: number;
        paidAmount?: number | null; paid_amount?: number | null;
        invoiceDate?: string | null; invoice_date?: string | null;
        isOpening?: number | null; is_opening?: number | null;
      }>(),
    c.var.DB.prepare(
      `SELECT pr.id AS id, pr.receiptNumber AS receiptNumber, pr.customerName AS customerName,
              pr.date AS date, pr.amount AS amount, pr.method AS method, pr.allocations AS allocations,
              dl.state AS lifecycleState
         FROM payment_records pr
         LEFT JOIN document_lifecycle dl
                ON dl.sourceType = 'payment' AND dl.sourceId = pr.id
        WHERE 1=1`,
    ).all<{
      id: string; receiptNumber?: string; receipt_number?: string; customerName?: string; customer_name?: string;
      date?: string; amount?: number; method?: string; allocations?: string | unknown[];
      lifecycleState?: string | null; lifecyclestate?: string | null;
    }>().catch(() => ({ results: [] as never[] })),
  ]);

  const { docDate, openingDate: obDateArc } = await loadDocDateResolver(c.var.DB);
  const resolveArc = await loadAccountResolver(c.var.DB);

  // 300-0000 legs, post-floor, DR/CR SWAPPED so the CR-normal algebra applies.
  const legs300: ApReconLeg[] = [];
  const drAllAr = new Map<string, number>();
  const crAllAr = new Map<string, number>();
  for (const l of legRes.results ?? []) {
    if (legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDateArc)) continue;
    const code = resolveArc(l.accountCode);
    drAllAr.set(code, (drAllAr.get(code) ?? 0) + (Number(l.debitSen) || 0));
    crAllAr.set(code, (crAllAr.get(code) ?? 0) + (Number(l.creditSen) || 0));
    if (code !== "300-0000") continue;
    legs300.push({
      sourceType: String(l.sourceType ?? ""),
      sourceId: String(l.sourceId ?? ""),
      debitSen: Number(l.creditSen) || 0, // swapped
      creditSen: Number(l.debitSen) || 0, // swapped
    });
  }

  const invoices: ApReconPi[] = (invRes.results ?? []).map((r) => {
    const id = String(r.id);
    const invoiceDate = (r.invoiceDate ?? r.invoice_date ?? null) as string | null;
    const isOpening = !!(r.isOpening ?? r.is_opening);
    return {
      id,
      piNo: String(r.invoiceNo ?? r.invoice_no ?? ""),
      supplierName: String(r.customerName ?? r.customer_name ?? ""),
      status: String(r.status ?? ""),
      amountSen: Math.round(Number(r.totalSen ?? r.total_sen) || 0),
      paidSen: Math.round(Number(r.paidAmount ?? r.paid_amount) || 0),
      isOpening,
      preOpeningIncluded: false, // AR has no include-pre-existing mechanism
      floored: rowBeforeOpening(invoiceDate, obDateArc, isOpening),
    };
  });

  const receiptRows: ApReconPaymentRow[] = [];
  for (const r of recRes.results ?? []) {
    const state = String(r.lifecycleState ?? r.lifecyclestate ?? "") || "ACTIVE";
    const active = state === "ACTIVE";
    const recId = String(r.id);
    const name = String(r.customerName ?? r.customer_name ?? "");
    const date = String(r.date ?? "").slice(0, 10);
    let allocs: { invoiceId?: string; amount?: number }[] = [];
    try {
      const raw = r.allocations;
      allocs = Array.isArray(raw) ? raw as never[] : JSON.parse(String(raw ?? "[]"));
    } catch { allocs = []; }
    for (const a of allocs) {
      receiptRows.push({
        paymentNo: recId,
        purchaseInvoiceId: String(a.invoiceId ?? "") || null,
        bookedSen: Math.round(Number(a.amount) || 0),
        amountSen: Math.round(Number(a.amount) || 0),
        method: String(r.method ?? ""),
        active,
        supplierName: name,
        date,
      });
    }
    // NOTE: deliberately NO synthetic "unapplied remainder" row — /ar-control
    // subtracts no advances, so the mirror must not either; a receipt whose GL
    // exceeds its allocations surfaces as a payment_gl_mismatch item instead.
  }

  const report = buildApReconciliation(
    { legs400: legs300, pis: invoices, paymentRows: receiptRows, pcnPostedSen: 0, cnAllocCtlSen: 0 },
    AR_RECON_CFG,
  );

  const coaRes = await c.var.DB.prepare(
    "SELECT code, name FROM chart_of_accounts WHERE specialAccountType = 'SDC'",
  ).all<{ code: string; name: string }>();
  const controls = (coaRes.results ?? [])
    .map((a) => ({
      code: a.code,
      name: a.name,
      balanceSen: (drAllAr.get(a.code) ?? 0) - (crAllAr.get(a.code) ?? 0), // asset: DR-normal
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const tradeControlSen = controls
    .filter((a) => a.code !== "305-0000")
    .reduce((s, a) => s + a.balanceSen, 0);

  return c.json({
    success: true,
    data: {
      asOf: new Date().toISOString().slice(0, 10),
      openingDate: obDateArc ?? null,
      controls,
      tradeControlSen,
      nonTrade300GapSen: tradeControlSen - report.controlSen,
      ...report,
    },
  });
});

// Counter rebuilds (owner rule 2026-07-06 「让他不会漂」) — reset the
// cascade-maintained running counters to their document-derived truth. The
// counters accumulated years of drift (pre-opening docs never un-counted,
// legacy void paths that skipped the decrement). Shared by the Debtor tab's
// Recalculate button AND the nightly cron (worker.ts
// /api/internal/nightly-counter-rebuild) so the counters self-heal daily.
// Idempotent: only rows whose value differs are written.
export async function rebuildArCounterSen(db: Env["Variables"]["DB"]): Promise<{
  updated: number; beforeSen: number; afterSen: number;
}> {
  const [invRes, custRes] = await Promise.all([
    db
      .prepare(
        `SELECT customerId, totalSen, paidAmount, invoiceDate, isOpening
           FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED')`,
      )
      .all<{ customerId: string; totalSen: number; paidAmount: number; invoiceDate: string | null; isOpening: number | null }>(),
    db
      .prepare("SELECT id, outstandingSen FROM customers")
      .all<{ id: string; outstandingSen?: number | null; outstanding_sen?: number | null }>(),
  ]);
  const obDate = await getOpeningDate(db);
  const truth = new Map<string, number>();
  for (const inv of invRes.results ?? []) {
    if (rowBeforeOpening(inv.invoiceDate, obDate, inv.isOpening)) continue;
    const unpaid = Math.max(0, (Number(inv.totalSen) || 0) - (Number(inv.paidAmount) || 0));
    if (unpaid === 0) continue;
    truth.set(inv.customerId, (truth.get(inv.customerId) ?? 0) + unpaid);
  }
  let beforeSen = 0;
  let afterSen = 0;
  const statements: D1PreparedStatement[] = [];
  for (const cu of custRes.results ?? []) {
    const cur = Math.round(Number(cu.outstandingSen ?? cu.outstanding_sen) || 0);
    const want = truth.get(cu.id) ?? 0;
    beforeSen += cur;
    afterSen += want;
    if (cur !== want) {
      statements.push(
        db.prepare("UPDATE customers SET outstandingSen = ? WHERE id = ?").bind(want, cu.id),
      );
    }
  }
  if (statements.length) await db.batch(statements);
  return { updated: statements.length, beforeSen, afterSen };
}

// Supplier side: suppliers.outstandingSen := Σ (PI amount − paid) over
// non-DRAFT/CANCELLED PIs past the opening floor (excluded pre-opening PIs
// drop) — the same bills-only set /ap-control's piOutstandingSen sums, so
// driftCounterVsPiSen reads 0 after a rebuild.
export async function rebuildApCounterSen(db: Env["Variables"]["DB"]): Promise<{
  updated: number; beforeSen: number; afterSen: number;
}> {
  const [piRes, supRes] = await Promise.all([
    db
      .prepare(
        `SELECT id, supplierId, amountSen, paidAmountSen, invoiceDate, isOpening
           FROM purchase_invoices WHERE status NOT IN ('DRAFT','CANCELLED')`,
      )
      .all<{ id: string; supplierId: string; amountSen: number; paidAmountSen?: number | null; paid_amount_sen?: number | null; invoiceDate: string | null; isOpening: number | null }>(),
    db
      .prepare("SELECT id, outstandingSen FROM suppliers")
      .all<{ id: string; outstandingSen?: number | null; outstanding_sen?: number | null }>(),
  ]);
  const obDate = await getOpeningDate(db);
  const excl = await loadOpeningApExcludes(db);
  const truth = new Map<string, number>();
  for (const pi of piRes.results ?? []) {
    if (apRowBeforeOpening({ id: pi.id, date: pi.invoiceDate, isOpening: pi.isOpening }, obDate, excl)) continue;
    const unpaid = (Number(pi.amountSen) || 0) - (Number(pi.paidAmountSen ?? pi.paid_amount_sen) || 0);
    if (unpaid <= 0) continue;
    truth.set(pi.supplierId, (truth.get(pi.supplierId) ?? 0) + unpaid);
  }
  let beforeSen = 0;
  let afterSen = 0;
  const statements: D1PreparedStatement[] = [];
  for (const su of supRes.results ?? []) {
    const cur = Math.round(Number(su.outstandingSen ?? su.outstanding_sen) || 0);
    const want = truth.get(su.id) ?? 0;
    beforeSen += cur;
    afterSen += want;
    if (cur !== want) {
      statements.push(
        db.prepare("UPDATE suppliers SET outstandingSen = ? WHERE id = ?").bind(want, su.id),
      );
    }
  }
  if (statements.length) await db.batch(statements);
  return { updated: statements.length, beforeSen, afterSen };
}

// POST /ar-control/rebuild-counter — the Debtor tab's Recalculate button.
// Audited; the nightly cron does the same thing automatically at 02:30 SGT.
app.post("/ar-control/rebuild-counter", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const r = await rebuildArCounterSen(c.var.DB);
  await emitAudit(c, {
    resource: "accounting",
    resourceId: "ar_counter_rebuild",
    action: "update",
    after: {
      customersUpdated: r.updated,
      beforeSen: r.beforeSen,
      afterSen: r.afterSen,
      driftClearedSen: r.beforeSen - r.afterSen,
    },
  });
  return c.json({
    success: true,
    data: { customersUpdated: r.updated, beforeSen: r.beforeSen, afterSen: r.afterSen },
  });
});

// POST /ap-control/rebuild-counter — supplier twin of the AR rebuild (owner
// request 2026-07-06). Audited; the nightly cron does both sides at 02:30 SGT.
app.post("/ap-control/rebuild-counter", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const r = await rebuildApCounterSen(c.var.DB);
  await emitAudit(c, {
    resource: "accounting",
    resourceId: "ap_counter_rebuild",
    action: "update",
    after: {
      suppliersUpdated: r.updated,
      beforeSen: r.beforeSen,
      afterSen: r.afterSen,
      driftClearedSen: r.beforeSen - r.afterSen,
    },
  });
  return c.json({
    success: true,
    data: { suppliersUpdated: r.updated, beforeSen: r.beforeSen, afterSen: r.afterSen },
  });
});

app.get("/supplier-statement", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const supplierId = c.req.query("supplierId");
  if (!supplierId) {
    return c.json({ success: false, error: "supplierId is required" }, 400);
  }
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const [sup, piRes, payRes, pcnStmtRes] = await Promise.all([
    c.var.DB.prepare("SELECT id, name FROM suppliers WHERE id = ?")
      .bind(supplierId)
      .first<{ id: string; name: string }>(),
    c.var.DB.prepare(
      // Include PARTIAL_PAID (a partly-paid PI still owes money — its full
      // amount is a credit here, the payment a debit; omitting it would drop
      // the credit leg and unbalance the statement). Matches /creditor-ledger.
      `SELECT id, piNo, invoiceDate, amountSen, status, isOpening FROM purchase_invoices
        WHERE supplierId = ? AND status IN ('CONFIRMED','APPROVED','PARTIAL_PAID','PAID')`,
    )
      .bind(supplierId)
      .all<{ id: string; piNo: string; invoiceDate: string; amountSen: number; status: string; isOpening: number | null }>(),
    c.var.DB.prepare(
      // Exclude #6 supplier-discount markers (method='CREDIT_NOTE', amountSen=0,
      // no GL leg) — they'd render as 0.00 PAYMENT noise rows; the CN itself
      // already appears via the purchase_credit_notes query below.
      //
      // VOID/DELETED payments are excluded too, exactly as /creditor-ledger does
      // it (BUG-2026-08-13-080) — the two build the SAME line model and this was
      // the only difference.
      //
      // The AP relief is bookedSen, NOT amountSen (BUG-2026-08-13-082):
      // amountSen is the CASH that left the bank, bookedSen is what came off
      // 400-0000. They differ on a foreign-currency payment settled at a rate
      // other than the PI's — the difference is FX gain/loss (530-0000) and is
      // not an AP movement. COALESCE keeps pre-fix rows that never stored one.
      `SELECT paymentNo, date, COALESCE(bookedSen, amountSen) AS amountSen FROM supplier_payments
        WHERE supplierId = ? AND COALESCE(method,'') <> 'CREDIT_NOTE'
          AND paymentNo NOT IN (SELECT sourceId FROM document_lifecycle WHERE sourceType = 'supplier_payment' AND state IN ('VOID','DELETED'))`,
    )
      .bind(supplierId)
      .all<{ paymentNo: string; date: string; amountSen: number }>(),
    c.var.DB.prepare(
      `SELECT noteNumber, date, totalAmount FROM purchase_credit_notes
        WHERE supplierId = ? AND status = 'POSTED'`,
    )
      .bind(supplierId)
      .all<{ noteNumber: string; date: string; totalAmount: number }>(),
  ]);
  if (!sup) {
    return c.json({ success: false, error: "Supplier not found" }, 404);
  }
  type Line = {
    date: string;
    ref: string;
    type: string;
    debitSen: number;
    creditSen: number;
    isOpening?: number | null;
  };
  const lines: Line[] = [];
  // Pre-opening PIs count as opening by default (owner rule 2026-07-02) — mark
  // every non-excluded PI floor-exempt here. Harmless for post-opening rows
  // (the floor only consults the flag for pre-opening dates).
  const apExclSs = await loadOpeningApExcludes(c.var.DB);
  for (const pi of piRes.results ?? [])
    lines.push({
      date: pi.invoiceDate ?? "",
      ref: pi.piNo,
      type: "PURCHASE_INVOICE",
      debitSen: 0,
      creditSen: Number(pi.amountSen) || 0,
      isOpening: pi.isOpening || (apExclSs.has(pi.id) ? 0 : 1),
    });
  for (const p of payRes.results ?? [])
    lines.push({
      date: p.date ?? "",
      ref: p.paymentNo,
      type: "PAYMENT",
      debitSen: Number(p.amountSen) || 0,
      creditSen: 0,
    });
  for (const n of pcnStmtRes.results ?? [])
    lines.push({
      date: n.date ?? "",
      ref: n.noteNumber,
      type: "PURCHASE_CN",
      debitSen: Number(n.totalAmount) || 0,
      creditSen: 0,
    });
  lines.sort((a, b) =>
    a.date === b.date ? a.ref.localeCompare(b.ref) : a.date.localeCompare(b.date),
  );
  // AP balance is credit-normal: what we still owe = credits − debits.
  const obDateSs = await getOpeningDate(c.var.DB);
  let openingSen = 0;
  const rows: (Line & { runningSen: number })[] = [];
  let running = 0;
  for (const l of lines) {
    if (rowBeforeOpening(l.date, obDateSs, l.isOpening)) continue; // pre-opening: not extracted (not even into B/F)
    const delta = l.creditSen - l.debitSen;
    if (l.date < from) {
      openingSen += delta;
      continue;
    }
    if (l.date > to) continue;
    running = (rows.length === 0 ? openingSen : running) + delta;
    rows.push({ ...l, runningSen: running });
  }
  return c.json({
    success: true,
    data: {
      supplier: { id: sup.id, name: sup.name },
      from: from || null,
      to: to === "9999-12-31" ? null : to,
      openingSen,
      closingSen: rows.length ? rows[rows.length - 1].runningSen : openingSen,
      rows,
    },
  });
});

// ---------------------------------------------------------------------------
// DEBTOR / CREDITOR LEDGER (owner 2026-06-23) — the subsidiary ledger as ONE
// report: every debtor (or creditor) as its own ledger section (opening →
// dated transactions → running balance → closing). Same line model as the
// per-party statement, looped over all parties in a single pass.
// ---------------------------------------------------------------------------
type LedgerLine = { date: string; ref: string; type: string; debitSen: number; creditSen: number; isOpening?: number | null };

app.get("/debtor-ledger", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const [custRes, invRes, payRes, cnRes, dnRes] = await Promise.all([
    c.var.DB.prepare("SELECT id, name, code FROM customers").all<{ id: string; name: string; code: string }>(),
    c.var.DB.prepare(`SELECT customerId, invoiceNo, invoiceDate, totalSen, isOpening FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED')`).all<{ customerId: string; invoiceNo: string; invoiceDate: string; totalSen: number; isOpening: number | null }>(),
    c.var.DB.prepare(`SELECT customerId, receiptNumber, date, amount, status FROM payment_records WHERE id NOT IN (SELECT sourceId FROM document_lifecycle WHERE sourceType = 'payment' AND state IN ('VOID','DELETED'))`).all<{ customerId: string; receiptNumber: string; date: string; amount: number; status: string }>(),
    c.var.DB.prepare(`SELECT customerId, noteNumber, date, totalAmount FROM credit_notes WHERE status IN ('APPROVED','POSTED')`).all<{ customerId: string; noteNumber: string; date: string; totalAmount: number }>(),
    c.var.DB.prepare(`SELECT customerId, noteNumber, date, totalAmount FROM debit_notes WHERE status = 'POSTED'`).all<{ customerId: string; noteNumber: string; date: string; totalAmount: number }>(),
  ]);
  const byParty = new Map<string, LedgerLine[]>();
  const push = (id: string, l: LedgerLine) => { if (!id) return; const arr = byParty.get(id) ?? []; arr.push(l); byParty.set(id, arr); };
  for (const i of invRes.results ?? []) push(i.customerId, { date: i.invoiceDate ?? "", ref: i.invoiceNo, type: "INVOICE", debitSen: Number(i.totalSen) || 0, creditSen: 0, isOpening: i.isOpening });
  for (const p of payRes.results ?? []) {
    push(p.customerId, { date: p.date ?? "", ref: p.receiptNumber, type: "RECEIPT", debitSen: 0, creditSen: Number(p.amount) || 0 });
    if (p.status === "BOUNCED") push(p.customerId, { date: p.date ?? "", ref: p.receiptNumber, type: "BOUNCED", debitSen: Number(p.amount) || 0, creditSen: 0 });
  }
  for (const n of cnRes.results ?? []) push(n.customerId, { date: n.date ?? "", ref: n.noteNumber, type: "CREDIT_NOTE", debitSen: 0, creditSen: Number(n.totalAmount) || 0 });
  for (const n of dnRes.results ?? []) push(n.customerId, { date: n.date ?? "", ref: n.noteNumber, type: "DEBIT_NOTE", debitSen: Number(n.totalAmount) || 0, creditSen: 0 });

  const obDateDl = await getOpeningDate(c.var.DB);
  const parties: unknown[] = [];
  for (const cust of custRes.results ?? []) {
    const lines = byParty.get(cust.id) ?? [];
    if (lines.length === 0) continue;
    lines.sort((a, b) => (a.date === b.date ? a.ref.localeCompare(b.ref) : a.date.localeCompare(b.date)));
    let openingSen = 0;
    const rows: (LedgerLine & { runningSen: number })[] = [];
    let running = 0;
    for (const l of lines) {
      if (rowBeforeOpening(l.date, obDateDl, l.isOpening)) continue; // pre-opening: not extracted (not even into B/F)
      const delta = l.debitSen - l.creditSen; // debit-normal (AR)
      if (l.date < from) { openingSen += delta; continue; }
      if (l.date > to) continue;
      running = (rows.length === 0 ? openingSen : running) + delta;
      rows.push({ ...l, runningSen: running });
    }
    if (openingSen === 0 && rows.length === 0) continue;
    parties.push({ party: { id: cust.id, name: cust.name, code: cust.code }, openingSen, closingSen: rows.length ? rows[rows.length - 1].runningSen : openingSen, rows });
  }
  return c.json({ success: true, data: { from: from || null, to: to === "9999-12-31" ? null : to, parties } });
});

app.get("/creditor-ledger", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const [supRes, piRes, payRes, pcnRes] = await Promise.all([
    c.var.DB.prepare("SELECT id, name, code FROM suppliers").all<{ id: string; name: string; code: string | null }>(),
    c.var.DB.prepare(`SELECT id, supplierId, piNo, invoiceDate, amountSen, isOpening FROM purchase_invoices WHERE status IN ('CONFIRMED','APPROVED','PARTIAL_PAID','PAID')`).all<{ id: string; supplierId: string; piNo: string; invoiceDate: string; amountSen: number; isOpening: number | null }>(),
    // AP relief is bookedSen, not amountSen (BUG-2026-08-13-082) — see the note
    // on /supplier-statement's twin query. COALESCE covers rows written before
    // the column was populated on every path.
    c.var.DB.prepare(`SELECT supplierId, paymentNo, date, COALESCE(bookedSen, amountSen) AS amountSen FROM supplier_payments WHERE COALESCE(method,'') <> 'CREDIT_NOTE' AND paymentNo NOT IN (SELECT sourceId FROM document_lifecycle WHERE sourceType = 'supplier_payment' AND state IN ('VOID','DELETED'))`).all<{ supplierId: string; paymentNo: string; date: string; amountSen: number }>(),
    c.var.DB.prepare(`SELECT supplierId, noteNumber, date, totalAmount FROM purchase_credit_notes WHERE status = 'POSTED'`).all<{ supplierId: string; noteNumber: string; date: string; totalAmount: number }>(),
  ]);
  const byParty = new Map<string, LedgerLine[]>();
  const push = (id: string, l: LedgerLine) => { if (!id) return; const arr = byParty.get(id) ?? []; arr.push(l); byParty.set(id, arr); };
  // Pre-opening PIs count as opening by default — non-excluded rows are marked
  // floor-exempt at load (no effect on post-opening rows).
  const apExclCl = await loadOpeningApExcludes(c.var.DB);
  for (const pi of piRes.results ?? []) push(pi.supplierId, { date: pi.invoiceDate ?? "", ref: pi.piNo, type: "PURCHASE_INVOICE", debitSen: 0, creditSen: Number(pi.amountSen) || 0, isOpening: pi.isOpening || (apExclCl.has(pi.id) ? 0 : 1) });
  for (const p of payRes.results ?? []) push(p.supplierId, { date: p.date ?? "", ref: p.paymentNo, type: "PAYMENT", debitSen: Number(p.amountSen) || 0, creditSen: 0 });
  for (const n of pcnRes.results ?? []) push(n.supplierId, { date: n.date ?? "", ref: n.noteNumber, type: "PURCHASE_CN", debitSen: Number(n.totalAmount) || 0, creditSen: 0 });

  const obDateCl = await getOpeningDate(c.var.DB);
  const parties: unknown[] = [];
  for (const sup of supRes.results ?? []) {
    const lines = byParty.get(sup.id) ?? [];
    if (lines.length === 0) continue;
    lines.sort((a, b) => (a.date === b.date ? a.ref.localeCompare(b.ref) : a.date.localeCompare(b.date)));
    let openingSen = 0;
    const rows: (LedgerLine & { runningSen: number })[] = [];
    let running = 0;
    for (const l of lines) {
      if (rowBeforeOpening(l.date, obDateCl, l.isOpening)) continue; // pre-opening: not extracted (not even into B/F)
      const delta = l.creditSen - l.debitSen; // credit-normal (AP)
      if (l.date < from) { openingSen += delta; continue; }
      if (l.date > to) continue;
      running = (rows.length === 0 ? openingSen : running) + delta;
      rows.push({ ...l, runningSen: running });
    }
    if (openingSen === 0 && rows.length === 0) continue;
    parties.push({ party: { id: sup.id, name: sup.name, code: sup.code ?? "" }, openingSen, closingSen: rows.length ? rows[rows.length - 1].runningSen : openingSen, rows });
  }
  return c.json({ success: true, data: { from: from || null, to: to === "9999-12-31" ? null : to, parties } });
});

// ---------------------------------------------------------------------------
// OTHER DEBTOR / OTHER CREDITOR REGISTRY (Phase 1, 2026-06)
//
// Non-trade counterparties (transporters, deposit holders, staff advances,
// misc payables) — a registry SEPARATE from the operational customers/
// suppliers tables per owner decision, so they never appear in SO/PO
// pickers. Control accounts 305-0000 / 405-0000. Phase 3's Payment &
// Official Receipt vouchers reference these parties.
// ---------------------------------------------------------------------------
type OtherPartyRow = {
  id: string;
  type: "DEBTOR" | "CREDITOR";
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  tin: string | null;
  registrationNo: string | null;
  address: string | null;
  notes: string | null;
  isActive: number;
};

function rowToOtherParty(r: OtherPartyRow) {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    contactPerson: r.contactPerson ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    tin: r.tin ?? "",
    registrationNo: r.registrationNo ?? "",
    address: r.address ?? "",
    notes: r.notes ?? "",
    isActive: r.isActive === 1,
  };
}

type OtherPartyBillRow = {
  id: string;
  billNo: string;
  partyId: string;
  partyType: "DEBTOR" | "CREDITOR";
  partyName: string;
  billDate: string;
  referenceNo: string | null;
  description: string | null;
  subtotalSen: number;
  taxSen: number;
  totalSen: number;
  paidAmountSen: number;
  status: string;
};
type OtherPartyBillItemRow = {
  id: string;
  billId: string;
  counterAccount: string;
  amountSen: number;
  description: string | null;
  lineNo: number;
};
type OtherPartyPaymentRow = {
  id: string;
  paymentNo: string;
  partyId: string;
  partyType: "DEBTOR" | "CREDITOR";
  partyName: string;
  billId: string;
  date: string;
  amountSen: number;
  bankAccount: string;
  reference: string | null;
};

app.get("/other-parties", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const type = c.req.query("type");
  const rows =
    type === "DEBTOR" || type === "CREDITOR"
      ? await c.var.DB.prepare(
          "SELECT * FROM other_parties WHERE orgId = ? AND type = ? ORDER BY name",
        )
          .bind(orgId, type)
          .all<OtherPartyRow>()
      : await c.var.DB.prepare(
          "SELECT * FROM other_parties WHERE orgId = ? ORDER BY type, name",
        )
          .bind(orgId)
          .all<OtherPartyRow>();
  const data = (rows.results ?? []).map(rowToOtherParty);
  return c.json({ success: true, data, total: data.length });
});

app.post("/other-parties", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as {
      type?: string;
      name?: string;
      contactPerson?: string;
      phone?: string;
      email?: string;
      tin?: string;
      registrationNo?: string;
      address?: string;
      notes?: string;
    };
    if (body.type !== "DEBTOR" && body.type !== "CREDITOR") {
      return c.json(
        { success: false, error: "type must be DEBTOR or CREDITOR" },
        400,
      );
    }
    const name = String(body.name ?? "").trim();
    if (!name) {
      return c.json({ success: false, error: "name is required" }, 400);
    }
    const orgId = getOrgId(c);
    const id = `op-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO other_parties
         (id, type, name, contactPerson, phone, email, tin, registrationNo, address, notes, isActive, orgId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        body.type,
        name,
        body.contactPerson ?? null,
        body.phone ?? null,
        body.email ?? null,
        body.tin ?? null,
        body.registrationNo ?? null,
        body.address ?? null,
        body.notes ?? null,
        orgId,
        now,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM other_parties WHERE id = ?",
    )
      .bind(id)
      .first<OtherPartyRow>();
    return c.json({ success: true, data: rowToOtherParty(created!) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.put("/other-parties/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const existing = await c.var.DB.prepare(
      "SELECT * FROM other_parties WHERE id = ?",
    )
      .bind(id)
      .first<OtherPartyRow>();
    if (!existing) {
      return c.json({ success: false, error: "Party not found" }, 404);
    }
    const body = (await c.req.json()) as Partial<{
      name: string;
      contactPerson: string;
      phone: string;
      email: string;
      tin: string;
      registrationNo: string;
      address: string;
      notes: string;
      isActive: boolean;
      type: string;
    }>;
    if (body.type !== undefined && body.type !== existing.type) {
      // Switching DEBTOR↔CREDITOR retroactively moves the party between
      // control accounts — disallowed; create a new party instead.
      return c.json(
        { success: false, error: "type cannot be changed — create a new party instead" },
        400,
      );
    }
    const merged = {
      name: body.name !== undefined ? String(body.name).trim() : existing.name,
      contactPerson:
        body.contactPerson !== undefined ? body.contactPerson : existing.contactPerson,
      phone: body.phone !== undefined ? body.phone : existing.phone,
      email: body.email !== undefined ? body.email : existing.email,
      tin: body.tin !== undefined ? body.tin : existing.tin,
      registrationNo:
        body.registrationNo !== undefined ? body.registrationNo : existing.registrationNo,
      address: body.address !== undefined ? body.address : existing.address,
      notes: body.notes !== undefined ? body.notes : existing.notes,
      isActive:
        body.isActive === undefined ? existing.isActive : body.isActive ? 1 : 0,
    };
    if (!merged.name) {
      return c.json({ success: false, error: "name cannot be empty" }, 400);
    }
    await c.var.DB.prepare(
      `UPDATE other_parties
          SET name = ?, contactPerson = ?, phone = ?, email = ?, tin = ?, registrationNo = ?, address = ?, notes = ?, isActive = ?, updatedAt = ?
        WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.contactPerson,
        merged.phone,
        merged.email,
        merged.tin,
        merged.registrationNo,
        merged.address,
        merged.notes,
        merged.isActive,
        new Date().toISOString(),
        id,
      )
      .run();
    const updated = await c.var.DB.prepare(
      "SELECT * FROM other_parties WHERE id = ?",
    )
      .bind(id)
      .first<OtherPartyRow>();
    return c.json({ success: true, data: rowToOtherParty(updated!) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.delete("/other-parties/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id FROM other_parties WHERE id = ? AND orgId = ?",
  ).bind(id, orgId).first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Party not found" }, 404);

  const bill = await c.var.DB.prepare(
    "SELECT id FROM other_party_bills WHERE partyId = ? AND orgId = ? LIMIT 1",
  ).bind(id, orgId).first<{ id: string }>();
  const pay = await c.var.DB.prepare(
    "SELECT id FROM other_party_payments WHERE partyId = ? AND orgId = ? LIMIT 1",
  ).bind(id, orgId).first<{ id: string }>();
  if (bill || pay) {
    return c.json({ success: false, error: "This party has bills or payments — deactivate it instead of deleting." }, 400);
  }

  await c.var.DB.prepare("DELETE FROM other_parties WHERE id = ? AND orgId = ?").bind(id, orgId).run();
  return c.json({ success: true });
});

app.post("/other-party-bills", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  await ensureOtherPartyBillOpening(c.var.DB);
  try {
    const body = (await c.req.json()) as {
      partyId?: string;
      billDate?: string;
      referenceNo?: string;
      description?: string;
      taxSen?: number;
      items?: { counterAccount?: string; amountSen?: number; description?: string }[];
      isOpening?: boolean;
    };
    const orgId = getOrgId(c);
    const isOpening = body.isOpening ? 1 : 0;

    const party = await c.var.DB.prepare(
      "SELECT * FROM other_parties WHERE id = ? AND orgId = ?",
    )
      .bind(String(body.partyId ?? ""), orgId)
      .first<OtherPartyRow>();
    if (!party) return c.json({ success: false, error: "Party not found" }, 400);

    const billDate = String(body.billDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate))
      return c.json({ success: false, error: "billDate must be YYYY-MM-DD" }, 400);

    const items: BillItemInput[] = (body.items ?? []).map((it) => ({
      counterAccount: String(it.counterAccount ?? "").trim(),
      amountSen: Math.round(Number(it.amountSen ?? 0)),
      description: it.description ? String(it.description) : "",
    }));
    const taxSen = Math.round(Number(body.taxSen ?? 0));

    const shapeErr = validateBillShape(items, taxSen);
    if (shapeErr) return c.json({ success: false, error: shapeErr }, 400);

    for (const code of [...new Set(items.map((i) => i.counterAccount))]) {
      const acct = await c.var.DB.prepare(
        "SELECT code, isPostable FROM chart_of_accounts WHERE code = ?",
      )
        .bind(code)
        .first<{ code: string; isPostable: number }>();
      if (!acct) return c.json({ success: false, error: `Account ${code} not found` }, 400);
      if (acct.isPostable !== 1)
        return c.json({ success: false, error: `Account ${code} is not postable` }, 400);
    }

    const partyType = party.type as PartyType;
    const { subtotalSen, totalSen } = computeBillTotals(items, taxSen);
    const billNo = await issueDocNumberWithPrefix(
      c.var.DB,
      prefixForPartyType(partyType),
      billDate,
    );
    const billId = `opb-${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO other_party_bills
           (id, billNo, partyId, partyType, partyName, billDate, referenceNo, description,
            subtotalSen, taxSen, totalSen, paidAmountSen, status, orgId, createdAt, is_opening)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
      ).bind(
        billId,
        billNo,
        party.id,
        partyType,
        party.name,
        billDate,
        body.referenceNo ?? null,
        body.description ?? null,
        subtotalSen,
        taxSen,
        totalSen,
        orgId,
        now,
        isOpening,
      ),
    ];
    items.forEach((it, idx) => {
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO other_party_bill_items
             (id, billId, counterAccount, amountSen, description, lineNo, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `opbi-${crypto.randomUUID().slice(0, 10)}`,
          billId,
          it.counterAccount,
          it.amountSen,
          it.description ?? null,
          idx + 1,
          now,
        ),
      );
    });

    try {
      const accountingLegs = buildBillLegs({ partyType, billNo, partyName: party.name, items, taxSen });
      const legs: LedgerEntryInput[] = accountingLegs.map((l) => ({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "other_party_bill",
        sourceId: billNo,
        legNo: l.legNo,
        accountCode: l.accountCode,
        debitSen: l.debitSen,
        creditSen: l.creditSen,
        description: l.description,
        actorUserId,
        orgId,
      }));
      const { statements: ledgerStmts } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
      statements.push(...ledgerStmts);
    } catch (e) {
      console.error(`[ledger] other_party_bill ${billNo} GL build failed — aborting:`, e);
      return c.json({ success: false, error: "Failed to build the ledger posting — nothing was saved. Retry, and report if it persists." }, 500);
    }

    await c.var.DB.batch(statements);
    return c.json({ success: true, data: { id: billId, billNo, partyType, totalSen, status: "OPEN" } }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /other-party-bills/:billNo — edit IN PLACE, same bill number (owner
// request 2026-07-09 「开了无法edit,我要能edit」; until now "edit" was Copy-to-
// new-bill). Restate pattern, mirroring the supplier-payment edit: reverse
// whatever GL is currently visible (other_party_bill_restate_rev:<stamp>),
// post fresh legs from the edited fields (…_restate_post:<stamp>), hide all
// but the new post. Party is FIXED (it drives the number prefix + control
// account — Copy for a different party). Payments survive: the new total may
// not drop below paidAmountSen (editedBillStatus), status re-derived.
app.put("/other-party-bills/:billNo", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  await ensureOtherPartyBillOpening(c.var.DB);
  try {
    const orgId = getOrgId(c);
    const billNo = c.req.param("billNo");
    const bill = await c.var.DB.prepare(
      "SELECT * FROM other_party_bills WHERE billNo = ? AND orgId = ?",
    ).bind(billNo, orgId).first<OtherPartyBillRow & { is_opening?: number | null; isOpening?: number | null }>();
    if (!bill) return c.json({ success: false, error: "Bill not found" }, 404);

    const state = await getDocState(c.var.DB, orgId, "other_party_bill", billNo);
    if (state !== "ACTIVE") {
      return c.json({ success: false, error: `Bill is ${state} — restore (unvoid) it before editing` }, 400);
    }
    // A bill that was voided AND restored carries reversal legs pinned to its
    // OLD amounts; a later re-void would reuse them and leak the difference.
    // Rare corner — refuse the edit, Copy covers it.
    if (await ledgerHasSource(c.var.DB, orgId, "other_party_bill_void", billNo)) {
      return c.json({ success: false, error: "This bill was voided and restored before — its void trail is pinned to the old figures. Copy it to a new bill instead of editing." }, 400);
    }

    const body = (await c.req.json()) as {
      billDate?: string;
      referenceNo?: string;
      description?: string;
      taxSen?: number;
      items?: { counterAccount?: string; amountSen?: number; description?: string }[];
      isOpening?: boolean;
    };
    const billDate = String(body.billDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate))
      return c.json({ success: false, error: "billDate must be YYYY-MM-DD" }, 400);

    const items: BillItemInput[] = (body.items ?? []).map((it) => ({
      counterAccount: String(it.counterAccount ?? "").trim(),
      amountSen: Math.round(Number(it.amountSen ?? 0)),
      description: it.description ? String(it.description) : "",
    }));
    const taxSen = Math.round(Number(body.taxSen ?? 0));
    const shapeErr = validateBillShape(items, taxSen);
    if (shapeErr) return c.json({ success: false, error: shapeErr }, 400);
    for (const code of [...new Set(items.map((i) => i.counterAccount))]) {
      const acct = await c.var.DB.prepare(
        "SELECT code, isPostable FROM chart_of_accounts WHERE code = ?",
      ).bind(code).first<{ code: string; isPostable: number }>();
      if (!acct) return c.json({ success: false, error: `Account ${code} not found` }, 400);
      if (acct.isPostable !== 1)
        return c.json({ success: false, error: `Account ${code} is not postable` }, 400);
    }

    const partyType = bill.partyType as PartyType;
    const { subtotalSen, totalSen } = computeBillTotals(items, taxSen);
    const paidAmountSen = Math.round(Number(bill.paidAmountSen) || 0);
    const st = editedBillStatus(totalSen, paidAmountSen);
    if (!st.ok) return c.json({ success: false, error: st.error }, 400);
    const isOpening = body.isOpening === undefined
      ? Math.round(Number(bill.isOpening ?? bill.is_opening) || 0)
      : (body.isOpening ? 1 : 0);

    const now = new Date().toISOString();
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `UPDATE other_party_bills
            SET billDate = ?, referenceNo = ?, description = ?,
                subtotalSen = ?, taxSen = ?, totalSen = ?, status = ?,
                is_opening = ?, updatedAt = ?
          WHERE id = ?`,
      ).bind(
        billDate, body.referenceNo ?? null, body.description ?? null,
        subtotalSen, taxSen, totalSen, st.status, isOpening, now, bill.id,
      ),
      c.var.DB.prepare("DELETE FROM other_party_bill_items WHERE billId = ?").bind(bill.id),
    ];
    items.forEach((it, idx) => {
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO other_party_bill_items
             (id, billId, counterAccount, amountSen, description, lineNo, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `opbi-${crypto.randomUUID().slice(0, 10)}`,
          bill.id, it.counterAccount, it.amountSen, it.description ?? null, idx + 1, now,
        ),
      );
    });

    // GL: reverse the visible legs + post the corrected ones, collapse to the
    // newest post (same shape as the supplier-payment restate).
    const stamp = Date.now();
    const postSource = `other_party_bill_restate_post:${stamp}`;
    const cur =
      (
        await c.var.DB.prepare(
          `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
            WHERE sourceId = ? AND orgId = ? AND hidden = 0 AND sourceType LIKE 'other_party_bill%'`,
        ).bind(billNo, orgId).all<{ accountCode: string; debitSen: number; creditSen: number }>()
      ).results ?? [];
    const legs: LedgerEntryInput[] = cur.map((l, i) => ({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: `other_party_bill_restate_rev:${stamp}`,
      sourceId: billNo,
      legNo: i + 1,
      accountCode: l.accountCode,
      debitSen: Number(l.creditSen) || 0,
      creditSen: Number(l.debitSen) || 0,
      description: `Restate rev · ${billNo}`,
      actorUserId,
      orgId,
    }));
    buildBillLegs({ partyType, billNo, partyName: bill.partyName, items, taxSen }).forEach((l) => {
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: postSource,
        sourceId: billNo,
        legNo: l.legNo,
        accountCode: l.accountCode,
        debitSen: l.debitSen,
        creditSen: l.creditSen,
        description: `${l.description} (edited)`,
        actorUserId,
        orgId,
      });
    });
    const { statements: ledgerStmts } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
    statements.push(...ledgerStmts);
    statements.push(
      c.var.DB.prepare(
        `UPDATE ledger_journal_entries SET hidden = 1
          WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'other_party_bill%' AND sourceType <> ?`,
      ).bind(billNo, orgId, postSource),
    );

    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: billNo,
      action: "update",
      before: { totalSen: bill.totalSen, billDate: bill.billDate },
      after: { totalSen, billDate, status: st.status, lines: items.length },
    });
    return c.json({ success: true, data: { billNo, totalSen, status: st.status } });
  } catch (e) {
    console.error("[PUT /other-party-bills/:billNo] failed:", e);
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// POST /other-party-bills/backfill-gl
//
// One-shot + nightly-callable repair for BUG-2026-07-23-003: ACTIVE
// other-party bills whose creation-time GL never landed (405-0000 went to a
// DEBIT balance because every payment posted but ~14k of bill CRs were
// missing). For each ACTIVE bill with NO visible other_party_bill-family GL,
// re-posts buildBillLegs exactly as creation would have (idempotent via the
// visible-net check). DEFAULTS TO DRY-RUN; ?execute=1 writes.
// Nightly-callable sweep — shared by the manual endpoint below and
// /api/internal/nightly-gl-selfheal (BUG-2026-07-23-003).
export async function sweepOtherPartyBillGl(
  db: Env["Variables"]["DB"],
  defaultOrgId: string,
  execute: boolean,
): Promise<{ scanned: number; missingGl: number; fixed: { billNo: string; totalSen: number }[]; skipped: { billNo: string; reason: string }[] }> {
  const orgIdOb = defaultOrgId;
  const actorUserId: string | null = null;
  const billsRes = await db.prepare(
    `SELECT b.id, b.billNo, b.partyType, b.partyName, b.taxSen, b.orgId
       FROM other_party_bills b
       LEFT JOIN document_lifecycle dl
         ON dl.sourceType = 'other_party_bill' AND dl.sourceId = b.billNo AND dl.orgId = b.orgId
      WHERE (dl.state IS NULL OR dl.state = 'ACTIVE')`,
  ).all<{ id: string; billNo: string; partyType: string; partyName: string; taxSen: number; orgId?: string | null }>();
  const fixed: { billNo: string; totalSen: number }[] = [];
  const skippedOb: { billNo: string; reason: string }[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const b of billsRes.results ?? []) {
    const legRes = await db.prepare(
      `SELECT COALESCE(SUM(debitSen),0) AS d, COALESCE(SUM(creditSen),0) AS cr FROM ledger_journal_entries
        WHERE sourceId = ? AND hidden = 0 AND sourceType LIKE 'other_party_bill%'`,
    ).bind(b.billNo).first<{ d: number; cr: number }>();
    if ((Number(legRes?.d) || 0) !== 0 || (Number(legRes?.cr) || 0) !== 0) continue; // has GL — untouched
    const itemsRes = await db.prepare(
      "SELECT counterAccount, amountSen, description FROM other_party_bill_items WHERE billId = ? ORDER BY lineNo",
    ).bind(b.id).all<{ counterAccount: string; amountSen: number; description?: string | null }>();
    const items = (itemsRes.results ?? []).map((it) => ({
      counterAccount: String(it.counterAccount),
      amountSen: Math.round(Number(it.amountSen) || 0),
      description: it.description ?? "",
    }));
    if (items.length === 0) { skippedOb.push({ billNo: b.billNo, reason: "no line items" }); continue; }
    try {
      const legs = buildBillLegs({
        partyType: b.partyType as PartyType,
        billNo: b.billNo,
        partyName: b.partyName,
        items,
        taxSen: Math.round(Number(b.taxSen) || 0),
      }).map((l) => ({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "other_party_bill",
        sourceId: b.billNo,
        legNo: l.legNo,
        accountCode: l.accountCode,
        debitSen: l.debitSen,
        creditSen: l.creditSen,
        description: l.description,
        actorUserId,
        orgId: String(b.orgId ?? orgIdOb),
      }));
      const totalSen = legs.reduce((s, l) => s + l.debitSen, 0);
      const { statements: ls } = await buildJournalEntryStatements(db, String(b.orgId ?? orgIdOb), legs);
      statements.push(...ls);
      fixed.push({ billNo: b.billNo, totalSen });
    } catch (e) {
      skippedOb.push({ billNo: b.billNo, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  if (execute && statements.length) {
    for (let i = 0; i < statements.length; i += 100) {
      await db.batch(statements.slice(i, i + 100));
    }
  }
  return { scanned: (billsRes.results ?? []).length, missingGl: fixed.length, fixed, skipped: skippedOb };
}

app.post("/other-party-bills/backfill-gl", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const execute = c.req.query("execute") === "1";
  const r = await sweepOtherPartyBillGl(c.var.DB, getOrgId(c), execute);
  return c.json({ success: true, data: { dry: !execute, ...r } });
});

app.get("/other-party-bills", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const partyId = c.req.query("partyId");
  const type = c.req.query("type");

  let q =
    `SELECT other_party_bills.*, dl.state AS lifecycleState
       FROM other_party_bills
       LEFT JOIN document_lifecycle dl
         ON dl.orgId = other_party_bills.orgId
        AND dl.sourceType = 'other_party_bill'
        AND dl.sourceId = other_party_bills.billNo
      WHERE other_party_bills.orgId = ?`;
  const binds: (string)[] = [orgId];
  if (partyId) { q += " AND other_party_bills.partyId = ?"; binds.push(partyId); }
  if (type === "DEBTOR" || type === "CREDITOR") { q += " AND other_party_bills.partyType = ?"; binds.push(type); }
  q += " AND (dl.state IS NULL OR dl.state <> 'DELETED')";
  q += " ORDER BY billDate DESC, billNo DESC";

  const billsRes = await c.var.DB.prepare(q).bind(...binds).all<OtherPartyBillRow & { lifecycleState: string | null }>();
  const bills = billsRes.results ?? [];

  const itemsByBill = new Map<string, OtherPartyBillItemRow[]>();
  if (bills.length > 0) {
    const itemsRes = await c.var.DB.prepare(
      "SELECT i.* FROM other_party_bill_items i JOIN other_party_bills b ON b.id = i.billId WHERE b.orgId = ? ORDER BY i.lineNo",
    ).bind(orgId).all<OtherPartyBillItemRow>();
    for (const it of itemsRes.results ?? []) {
      if (!itemsByBill.has(it.billId)) itemsByBill.set(it.billId, []);
      itemsByBill.get(it.billId)!.push(it);
    }
  }

  const data = bills.map((b) => ({
    id: b.id,
    billNo: b.billNo,
    partyId: b.partyId,
    partyType: b.partyType,
    partyName: b.partyName,
    billDate: b.billDate,
    referenceNo: b.referenceNo ?? "",
    description: b.description ?? "",
    subtotalSen: b.subtotalSen,
    taxSen: b.taxSen,
    totalSen: b.totalSen,
    paidAmountSen: b.paidAmountSen,
    outstandingSen: b.totalSen - b.paidAmountSen,
    status: b.status,
    isOpening: !!Number((b as { isOpening?: number | null; is_opening?: number | null }).isOpening ?? (b as { is_opening?: number | null }).is_opening ?? 0),
    lifecycleState: b.lifecycleState ?? "ACTIVE",
    items: (itemsByBill.get(b.id) ?? []).map((i) => ({
      counterAccount: i.counterAccount,
      amountSen: i.amountSen,
      description: i.description ?? "",
      lineNo: i.lineNo,
    })),
  }));
  return c.json({ success: true, data, total: data.length });
});

app.delete("/other-party-bills/:billNo", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const billNo = c.req.param("billNo");

  const bill = await c.var.DB.prepare(
    "SELECT * FROM other_party_bills WHERE billNo = ? AND orgId = ?",
  ).bind(billNo, orgId).first<OtherPartyBillRow>();
  if (!bill) return c.json({ success: false, error: "Bill not found" }, 404);
  if (bill.paidAmountSen > 0)
    return c.json({ success: false, error: "Bill has payments — void via settlement (D2), cannot delete" }, 400);

  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;

  // Soft delete: keep the row, build the reversal + state=DELETED via the lifecycle helper.
  let lc: { statements: D1PreparedStatement[]; newState: string };
  try {
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: await otherPartyBillLegFamily(c.var.DB, orgId, billNo), voidSourceType: "other_party_bill_void", sourceId: billNo, action: "delete", actorUserId, descriptionTag: `DELETE · ${billNo}` });
  } catch (e) {
    console.error(`[ledger] other_party_bill ${billNo} delete lifecycle build failed — aborting:`, e);
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
  await c.var.DB.batch(lc.statements);
  return c.json({ success: true });
});

// An EDITED bill's live GL sits on other_party_bill_restate_rev/post:<stamp>
// legs — applyLifecycle exact-matches sourceTypes, so void/delete/unvoid must
// receive the whole family or the restate legs would survive a void (the
// exact GL-leak class BUG-2026-07-08-002 was). Original type stays FIRST — it
// is the document_lifecycle key.
async function otherPartyBillLegFamily(
  db: Env["Variables"]["DB"],
  orgId: string,
  billNo: string,
): Promise<string[]> {
  const fam = ["other_party_bill"];
  try {
    const res = await db
      .prepare(
        `SELECT DISTINCT sourceType FROM ledger_journal_entries
          WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'other_party_bill_restate_%'`,
      )
      .bind(billNo, orgId)
      .all<{ sourceType: string }>();
    for (const r of res.results ?? []) fam.push(r.sourceType);
  } catch {
    /* ledger unavailable — plain family */
  }
  return fam;
}

app.post("/other-party-bills/:billNo/lifecycle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const billNo = c.req.param("billNo");
  let action: "void" | "delete" | "unvoid";
  try { action = ((await c.req.json()) as { action: string }).action as typeof action; } catch { return c.json({ success: false, error: "Invalid body" }, 400); }
  if (!["void", "delete", "unvoid"].includes(action)) return c.json({ success: false, error: "action must be void|delete|unvoid" }, 400);

  const bill = await c.var.DB.prepare(
    "SELECT * FROM other_party_bills WHERE billNo = ? AND orgId = ?",
  ).bind(billNo, orgId).first<OtherPartyBillRow>();
  if (!bill) return c.json({ success: false, error: "Bill not found" }, 404);

  // Payment guard: blocks void/delete while there are active payments; unvoid is exempt.
  if (action !== "unvoid" && bill.paidAmountSen > 0)
    return c.json({ success: false, error: "Bill has active payments — void the settlement (D2) first." }, 400);

  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  let lc: { statements: D1PreparedStatement[]; newState: string };
  try {
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: await otherPartyBillLegFamily(c.var.DB, orgId, billNo), voidSourceType: "other_party_bill_void", sourceId: billNo, action, actorUserId, descriptionTag: `${action.toUpperCase()} · ${billNo}` });
  } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }

  // No status-column change: other_party_bills.status carries payment progress
  // (OPEN/PARTIAL_PAID/PAID); lifecycle state lives in document_lifecycle.
  await c.var.DB.batch(lc.statements);
  return c.json({ success: true, data: { state: lc.newState } });
});

// ---------------------------------------------------------------------------
// D2 — OTHER-PARTY PAYMENTS  POST / GET / void
// ---------------------------------------------------------------------------
app.post("/other-party-payments", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;

  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "other-party-payments", idemKey, async () => {
    try {
      const body = (await c.req.json()) as {
        partyId?: string; bankAccount?: string; date?: string; reference?: string;
        allocations?: { billId?: string; amountSen?: number }[];
      };
      const orgId = getOrgId(c);

      const party = await c.var.DB.prepare("SELECT * FROM other_parties WHERE id = ? AND orgId = ?")
        .bind(String(body.partyId ?? ""), orgId).first<OtherPartyRow>();
      if (!party) return c.json({ success: false, error: "Party not found" }, 400);

      const date = String(body.date ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);

      const bankAccount = String(body.bankAccount ?? "");
      const bank = await c.var.DB.prepare("SELECT code, specialAccountType FROM chart_of_accounts WHERE code = ?")
        .bind(bankAccount).first<{ code: string; specialAccountType: string | null }>();
      if (!bank || (bank.specialAccountType !== "SBK" && bank.specialAccountType !== "SCH"))
        return c.json({ success: false, error: "bankAccount must be a bank (SBK) or cash (SCH) account" }, 400);

      const allocs: PaymentAllocInput[] = (body.allocations ?? []).map((a) => ({
        billId: String(a.billId ?? ""), amountSen: Math.round(Number(a.amountSen ?? 0)),
      }));
      if (allocs.length === 0) return c.json({ success: false, error: "Select at least one bill" }, 400);

      const partyType = party.type as PartyType;
      const outstandingByBill: Record<string, number> = {};
      for (const a of allocs) {
        const bill = await c.var.DB.prepare("SELECT * FROM other_party_bills WHERE id = ? AND orgId = ?")
          .bind(a.billId, orgId).first<OtherPartyBillRow>();
        if (!bill) return c.json({ success: false, error: `Bill ${a.billId} not found` }, 400);
        if (bill.partyId !== party.id) return c.json({ success: false, error: "Bill does not belong to this party" }, 400);
        if (bill.partyType !== partyType) return c.json({ success: false, error: "Bill side mismatch" }, 400);
        if (bill.status !== "OPEN" && bill.status !== "PARTIAL_PAID")
          return c.json({ success: false, error: `Bill ${bill.billNo} is not open` }, 400);
        outstandingByBill[a.billId] = bill.totalSen - bill.paidAmountSen;
      }
      const allocErr = validateAllocations(allocs, outstandingByBill);
      if (allocErr) return c.json({ success: false, error: allocErr }, 400);

      const totalSen = computePaymentTotal(allocs);
      const payNo = await issueDocNumber(c.var.DB, {
        bankAccountCode: bankAccount,
        direction: partyType === "CREDITOR" ? "out" : "in",
        dateIso: date,
      });
      const now = new Date().toISOString();
      const actorUserId = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;

      const statements: D1PreparedStatement[] = [];
      for (const a of allocs) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO other_party_payments
               (id, paymentNo, partyId, partyType, partyName, billId, date, amountSen, bankAccount, reference, orgId, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `opp-${crypto.randomUUID().slice(0, 10)}`, payNo, party.id, partyType, party.name,
            a.billId, date, a.amountSen, bankAccount, body.reference ?? null, orgId, now,
          ),
        );
        statements.push(
          c.var.DB.prepare(
            `UPDATE other_party_bills
               SET paidAmountSen = paidAmountSen + ?,
                   status = CASE WHEN paidAmountSen + ? >= totalSen THEN 'PAID'
                                 WHEN paidAmountSen + ? > 0 THEN 'PARTIAL_PAID' ELSE status END,
                   updatedAt = ?
             WHERE id = ?`,
          ).bind(a.amountSen, a.amountSen, a.amountSen, now, a.billId),
        );
      }

      try {
        const legs: LedgerEntryInput[] = buildPaymentLegs({ partyType, paymentNo: payNo, partyName: party.name, bankAccount, totalSen }).map((l) => ({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "other_party_payment", sourceId: payNo,
          legNo: l.legNo, accountCode: l.accountCode, debitSen: l.debitSen, creditSen: l.creditSen, description: l.description, actorUserId, orgId,
        }));
        const { statements: ledgerStmts } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
        statements.push(...ledgerStmts);
      } catch (e) {
        console.error(`[ledger] other_party_payment ${payNo} GL build failed — aborting:`, e);
        return c.json({ success: false, error: "Failed to build the ledger posting — nothing was saved." }, 500);
      }

      await c.var.DB.batch(statements);
      return c.json({ success: true, data: { paymentNo: payNo, totalSen } }, 201);
    } catch {
      return c.json({ success: false, error: "Invalid request body" }, 400);
    }
  });
});

app.get("/other-party-payments", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const partyId = c.req.query("partyId");
  const type = c.req.query("type");

  let q = `SELECT p.*, b.billNo AS billNo, dl.state AS lifecycleState FROM other_party_payments p
           LEFT JOIN other_party_bills b ON b.id = p.billId
           LEFT JOIN document_lifecycle dl ON dl.orgId = p.orgId AND dl.sourceType = 'other_party_payment' AND dl.sourceId = p.paymentNo
           WHERE p.orgId = ?`;
  const binds: string[] = [orgId];
  if (partyId) { q += " AND p.partyId = ?"; binds.push(partyId); }
  if (type === "DEBTOR" || type === "CREDITOR") { q += " AND p.partyType = ?"; binds.push(type); }
  q += " AND (dl.state IS NULL OR dl.state <> 'DELETED')";
  q += " ORDER BY p.date DESC, p.paymentNo DESC";

  const rows = (await c.var.DB.prepare(q).bind(...binds).all<OtherPartyPaymentRow & { billNo: string | null; lifecycleState: string | null }>()).results ?? [];
  const byNo = new Map<string, { paymentNo: string; partyId: string; partyType: string; partyName: string; date: string; bankAccount: string; reference: string; totalSen: number; lifecycleState: string; lines: { billId: string; billNo: string; amountSen: number }[] }>();
  for (const r of rows) {
    let g = byNo.get(r.paymentNo);
    if (!g) { g = { paymentNo: r.paymentNo, partyId: r.partyId, partyType: r.partyType, partyName: r.partyName, date: r.date, bankAccount: r.bankAccount, reference: r.reference ?? "", totalSen: 0, lifecycleState: r.lifecycleState ?? "ACTIVE", lines: [] }; byNo.set(r.paymentNo, g); }
    g.totalSen += r.amountSen;
    g.lines.push({ billId: r.billId, billNo: r.billNo ?? "", amountSen: r.amountSen });
  }
  const data = [...byNo.values()];
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /audit-log — document lifecycle trail (F3). Lists every document
// currently in a non-ACTIVE state (VOID or DELETED), newest action first, for
// the Audit Log page. The immutable ledger keeps the full reversal detail;
// this table is the index of voided/deleted documents + who/when, and the page
// can unvoid from here (the only way back for DELETED docs, which are hidden
// from the normal lists).
// ---------------------------------------------------------------------------
app.get("/audit-log", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const rows =
    (
      await c.var.DB.prepare(
        `SELECT id, sourceType, sourceId, state, actionAt, actorUserId
           FROM document_lifecycle
          WHERE orgId = ? AND state <> 'ACTIVE'
          ORDER BY actionAt DESC
          LIMIT 1000`,
      )
        .bind(orgId)
        .all<{
          id: string;
          sourceType: string;
          sourceId: string;
          state: string;
          actionAt: string | null;
          actorUserId: string | null;
        }>()
    ).results ?? [];

  // Enrich each entry with the human-readable reference + party/amount/date by
  // looking up the source document per type. sourceId is the doc id for
  // PV/OR/JV (so we fetch the number) and already the doc number for the
  // others. Lookups key on the unique id/number — NOT orgId (payment_vouchers/
  // official_receipts/journal_entries have no org_id column).
  type Info = { reference: string; party: string; amountSen: number; docDate: string };
  const info = new Map<string, Info>();
  const idsOf = (t: string) => [...new Set(rows.filter((r) => r.sourceType === t).map((r) => r.sourceId))];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

  const pvIds = idsOf("payment_voucher");
  if (pvIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT id, pvNo, date, payee, totalSen FROM payment_vouchers WHERE id IN (${marks(pvIds.length)})`).bind(...pvIds).all<{ id: string; pvNo: string; date: string; payee: string | null; totalSen: number }>()).results ?? [])
      info.set(`payment_voucher|${d.id}`, { reference: d.pvNo, party: d.payee ?? "", amountSen: d.totalSen, docDate: d.date });
  }
  const orIds = idsOf("official_receipt");
  if (orIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT id, orNo, date, receivedFrom, totalSen FROM official_receipts WHERE id IN (${marks(orIds.length)})`).bind(...orIds).all<{ id: string; orNo: string; date: string; receivedFrom: string | null; totalSen: number }>()).results ?? [])
      info.set(`official_receipt|${d.id}`, { reference: d.orNo, party: d.receivedFrom ?? "", amountSen: d.totalSen, docDate: d.date });
  }
  const jvIds = idsOf("manual");
  if (jvIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT id, entryNo, date, description FROM journal_entries WHERE id IN (${marks(jvIds.length)})`).bind(...jvIds).all<{ id: string; entryNo: string; date: string; description: string | null }>()).results ?? [])
      info.set(`manual|${d.id}`, { reference: d.entryNo, party: d.description ?? "", amountSen: 0, docDate: d.date });
  }
  const billIds = idsOf("other_party_bill");
  if (billIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT billNo, partyName, billDate, totalSen FROM other_party_bills WHERE billNo IN (${marks(billIds.length)})`).bind(...billIds).all<{ billNo: string; partyName: string; billDate: string; totalSen: number }>()).results ?? [])
      info.set(`other_party_bill|${d.billNo}`, { reference: d.billNo, party: d.partyName, amountSen: d.totalSen, docDate: d.billDate });
  }
  const oppIds = idsOf("other_party_payment");
  if (oppIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT paymentNo, MAX(partyName) AS partyName, MAX(date) AS date, SUM(amountSen) AS amt FROM other_party_payments WHERE paymentNo IN (${marks(oppIds.length)}) GROUP BY paymentNo`).bind(...oppIds).all<{ paymentNo: string; partyName: string | null; date: string; amt: number }>()).results ?? [])
      info.set(`other_party_payment|${d.paymentNo}`, { reference: d.paymentNo, party: d.partyName ?? "", amountSen: d.amt ?? 0, docDate: d.date });
  }
  const spIds = idsOf("supplier_payment");
  if (spIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT paymentNo, MAX(supplierName) AS supplierName, MAX(date) AS date, SUM(bookedSen) AS amt FROM supplier_payments WHERE paymentNo IN (${marks(spIds.length)}) GROUP BY paymentNo`).bind(...spIds).all<{ paymentNo: string; supplierName: string | null; date: string; amt: number }>()).results ?? [])
      info.set(`supplier_payment|${d.paymentNo}`, { reference: d.paymentNo, party: d.supplierName ?? "", amountSen: d.amt ?? 0, docDate: d.date });
  }
  const ftIds = idsOf("fund_transfer");
  if (ftIds.length) {
    for (const d of (await c.var.DB.prepare(`SELECT sourceId, MAX(debitSen) AS amt, MIN(postedAt) AS dt FROM ledger_journal_entries WHERE sourceType = 'fund_transfer' AND sourceId IN (${marks(ftIds.length)}) GROUP BY sourceId`).bind(...ftIds).all<{ sourceId: string; amt: number; dt: string | null }>()).results ?? [])
      info.set(`fund_transfer|${d.sourceId}`, { reference: d.sourceId, party: "", amountSen: d.amt ?? 0, docDate: (d.dt ?? "").slice(0, 10) });
  }

  // Resolve actorUserId → displayName so the Audit Log shows WHO voided/deleted
  // each document, not a raw user id (#10). One lookup over the distinct actors.
  const actorIds = [
    ...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x)),
  ];
  const actorName = new Map<string, string>();
  if (actorIds.length) {
    for (const u of (
      await c.var.DB.prepare(
        `SELECT id, displayName FROM users WHERE id IN (${marks(actorIds.length)})`,
      )
        .bind(...actorIds)
        .all<{ id: string; displayName: string | null }>()
    ).results ?? [])
      if (u.displayName) actorName.set(u.id, u.displayName);
  }

  const data = rows.map((r) => {
    const i = info.get(`${r.sourceType}|${r.sourceId}`);
    return {
      ...r,
      reference: i?.reference ?? r.sourceId,
      party: i?.party ?? "",
      amountSen: i?.amountSen ?? 0,
      docDate: i?.docDate ?? "",
      actorName: r.actorUserId ? actorName.get(r.actorUserId) ?? null : null,
    };
  });
  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// GET /other-party-aging?type=DEBTOR|CREDITOR — per-party aging for Other
// Debtor/Creditor bills (F4 #3). Live: reads unpaid bills (outstanding > 0,
// excluding voided/deleted) and buckets by age. Returns the aging rows plus
// the raw unpaid bills (for the bills page's per-party drill-down).
// ---------------------------------------------------------------------------
app.get("/other-party-aging", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  await ensureOtherPartyBillOpening(c.var.DB);
  const orgId = getOrgId(c);
  const type = c.req.query("type");
  if (type !== "DEBTOR" && type !== "CREDITOR") {
    return c.json({ success: false, error: "type must be DEBTOR or CREDITOR" }, 400);
  }
  const rows =
    (
      await c.var.DB.prepare(
        `SELECT b.partyId AS partyId, b.partyName AS partyName, b.billNo AS billNo, b.billDate AS billDate,
                (b.totalSen - b.paidAmountSen) AS amt, b.is_opening AS is_opening
           FROM other_party_bills b
           LEFT JOIN document_lifecycle dl
             ON dl.orgId = b.orgId AND dl.sourceType = 'other_party_bill' AND dl.sourceId = b.billNo
          WHERE b.orgId = ? AND b.partyType = ? AND (b.totalSen - b.paidAmountSen) > 0
            AND (dl.state IS NULL OR dl.state NOT IN ('DELETED','VOID'))
          ORDER BY b.billDate ASC`,
      )
        .bind(orgId, type)
        .all<{ partyId: string; partyName: string; billNo: string; billDate: string; amt: number; is_opening?: number | null; isOpening?: number | null }>()
    ).results ?? [];
  const obDateOpa = await getOpeningDate(c.var.DB);
  const bills = rows
    .filter((r) => !rowBeforeOpening(r.billDate, obDateOpa, r.isOpening ?? r.is_opening)) // opening bills (is_opening=1) bypass the floor — owner rule 2026-07-01
    .map((r) => ({ partyId: r.partyId, partyName: r.partyName, billNo: r.billNo, billDate: r.billDate, outstandingSen: r.amt }));
  const today = new Date().toISOString().slice(0, 10);
  return c.json({ success: true, data: { aging: bucketAging(bills, today), bills } });
});

// Shared internal builder (NOT a route): used by both the rewired /void
// endpoint and the new /lifecycle endpoint. Builds the lifecycle statements
// (GL reversal / hidden flags / document_lifecycle state via applyLifecycle)
// and — only when crossing the ACTIVE boundary — boundary-aware paidAmountSen
// re-apply on each settled bill. It does NOT hard-delete the payment rows.
//   - deactivate (ACTIVE → VOID/DELETED): roll back paidAmountSen (floor 0).
//   - reactivate (VOID → ACTIVE via unvoid): re-add paidAmountSen.
//   - non-active → non-active (e.g. VOID → DELETED): neither flag set, so
//     paidAmountSen is left untouched (correct — money already rolled back).
async function buildOtherPartyPaymentLifecycle(
  db: Env["Variables"]["DB"],
  orgId: string,
  paymentNo: string,
  action: LifecycleAction,
  actorUserId: string | null,
): Promise<{ statements: D1PreparedStatement[]; newState: DocState }> {
  const rows = (await db.prepare("SELECT * FROM other_party_payments WHERE paymentNo = ? AND orgId = ?")
    .bind(paymentNo, orgId).all<OtherPartyPaymentRow>()).results ?? [];
  if (rows.length === 0) throw new Error("PAYMENT_NOT_FOUND");

  const lc = await applyLifecycle(db, {
    orgId, baseSourceTypes: ["other_party_payment"], voidSourceType: "other_party_payment_void",
    sourceId: paymentNo, action, actorUserId, descriptionTag: `${action.toUpperCase()} · ${paymentNo}`,
  });
  const statements = [...lc.statements];

  const deactivated = lc.prevState === "ACTIVE" && lc.newState !== "ACTIVE";
  const reactivated = lc.prevState !== "ACTIVE" && lc.newState === "ACTIVE";
  // An edited (restated) payment's live legs are other_party_payment_restate_post:* —
  // the applyLifecycle exact-match on "other_party_payment" misses them, so hide
  // the whole family on void/delete to keep the GL net at zero.
  if (deactivated) {
    statements.push(
      db
        .prepare(
          `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'other_party_payment%'`,
        )
        .bind(paymentNo, orgId),
    );
  }
  if (deactivated || reactivated) {
    const now = new Date().toISOString();
    for (const r of rows) {
      // deactivate: paid -= amount (floor 0); reactivate: paid += amount. status recalculated uniformly.
      const paidExpr = deactivated
        ? "CASE WHEN paidAmountSen - ? < 0 THEN 0 ELSE paidAmountSen - ? END"
        : "paidAmountSen + ?";
      const binds = deactivated ? [r.amountSen, r.amountSen] : [r.amountSen];
      statements.push(db.prepare(
        `UPDATE other_party_bills
           SET paidAmountSen = ${paidExpr},
               status = CASE WHEN (${paidExpr}) >= totalSen THEN 'PAID'
                            WHEN (${paidExpr}) > 0 THEN 'PARTIAL_PAID' ELSE 'OPEN' END,
               updatedAt = ?
         WHERE id = ? AND orgId = ?`,
      ).bind(...binds, ...binds, ...binds, now, r.billId, orgId));
    }
  }
  return { statements, newState: lc.newState };
}

// buildOtherPartyPaymentRestate — in-place EDIT (same payment number). Rolls the
// old bill allocations back, drops the old rows, writes the new rows + bill
// paid, and on the GL reverses the live legs + posts the corrected ones
// (restate_rev/post:<stamp>), then collapses so only the newest post is visible.
// Mirrors the customer-receipt restate. Throws "PAYMENT_NOT_FOUND".
async function buildOtherPartyPaymentRestate(
  db: Env["Variables"]["DB"],
  orgId: string,
  paymentNo: string,
  body: {
    bankAccount?: string;
    date?: string;
    reference?: string;
    allocations?: { billId?: string; amountSen?: number }[];
  },
  actorUserId: string | null,
  stamp: number,
): Promise<D1PreparedStatement[]> {
  const rows =
    (
      await db
        .prepare("SELECT * FROM other_party_payments WHERE paymentNo = ? AND orgId = ?")
        .bind(paymentNo, orgId)
        .all<OtherPartyPaymentRow>()
    ).results ?? [];
  const first = rows[0];
  if (!first) throw new Error("PAYMENT_NOT_FOUND");
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // 1. Reverse the OLD bill paid amounts.
  const revExpr =
    "CASE WHEN paidAmountSen - ? < 0 THEN 0 ELSE paidAmountSen - ? END";
  for (const r of rows) {
    statements.push(
      db
        .prepare(
          `UPDATE other_party_bills SET paidAmountSen = ${revExpr},
             status = CASE WHEN (${revExpr}) >= totalSen THEN 'PAID' WHEN (${revExpr}) > 0 THEN 'PARTIAL_PAID' ELSE 'OPEN' END,
             updatedAt = ? WHERE id = ? AND orgId = ?`,
        )
        .bind(r.amountSen, r.amountSen, r.amountSen, r.amountSen, r.amountSen, r.amountSen, now, r.billId, orgId),
    );
  }
  // 2. Drop the old payment rows.
  statements.push(
    db
      .prepare("DELETE FROM other_party_payments WHERE paymentNo = ? AND orgId = ?")
      .bind(paymentNo, orgId),
  );
  // 3. Insert the NEW rows + apply bill paid.
  const bankAccount = String(body.bankAccount ?? first.bankAccount);
  const date = String(body.date ?? first.date).slice(0, 10);
  const newAllocs = (body.allocations ?? [])
    .map((a) => ({ billId: String(a.billId ?? ""), amountSen: Math.round(Number(a.amountSen ?? 0)) }))
    .filter((a) => a.billId && a.amountSen > 0);
  let newTotal = 0;
  for (const a of newAllocs) {
    newTotal += a.amountSen;
    statements.push(
      db
        .prepare(
          `INSERT INTO other_party_payments
             (id, paymentNo, partyId, partyType, partyName, billId, date, amountSen, bankAccount, reference, orgId, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `opp-${crypto.randomUUID().slice(0, 10)}`, paymentNo, first.partyId, first.partyType, first.partyName,
          a.billId, date, a.amountSen, bankAccount, body.reference ?? null, orgId, now,
        ),
    );
    statements.push(
      db
        .prepare(
          `UPDATE other_party_bills SET paidAmountSen = paidAmountSen + ?,
             status = CASE WHEN paidAmountSen + ? >= totalSen THEN 'PAID' WHEN paidAmountSen + ? > 0 THEN 'PARTIAL_PAID' ELSE status END,
             updatedAt = ? WHERE id = ? AND orgId = ?`,
        )
        .bind(a.amountSen, a.amountSen, a.amountSen, now, a.billId, orgId),
    );
  }

  // 4. GL: reverse the live legs + post the corrected legs in ONE call, collapse.
  const cur =
    (
      await db
        .prepare(
          `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
            WHERE sourceId = ? AND orgId = ? AND hidden = 0 AND sourceType LIKE 'other_party_payment%'`,
        )
        .bind(paymentNo, orgId)
        .all<{ accountCode: string; debitSen: number; creditSen: number }>()
    ).results ?? [];
  const revLegs = cur.map((l, i) => ({
    id: `lje-${crypto.randomUUID().slice(0, 12)}`,
    sourceType: `other_party_payment_restate_rev:${stamp}`,
    sourceId: paymentNo,
    legNo: i + 1,
    accountCode: l.accountCode,
    debitSen: l.creditSen,
    creditSen: l.debitSen,
    description: `Restate rev · ${paymentNo}`,
    actorUserId,
    orgId,
  }));
  const postLegs =
    newTotal > 0
      ? buildPaymentLegs({
          partyType: first.partyType as PartyType,
          paymentNo,
          partyName: first.partyName,
          bankAccount,
          totalSen: newTotal,
        }).map((l) => ({
          id: `lje-${crypto.randomUUID().slice(0, 12)}`,
          sourceType: `other_party_payment_restate_post:${stamp}`,
          sourceId: paymentNo,
          legNo: l.legNo,
          accountCode: l.accountCode,
          debitSen: l.debitSen,
          creditSen: l.creditSen,
          description: l.description,
          actorUserId,
          orgId,
        }))
      : [];
  const { statements: jeStmts } = await buildJournalEntryStatements(db, orgId, [
    ...revLegs,
    ...postLegs,
  ]);
  statements.push(...jeStmts);
  statements.push(
    db
      .prepare(
        `UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'other_party_payment%' AND sourceType <> ?`,
      )
      .bind(paymentNo, orgId, `other_party_payment_restate_post:${stamp}`),
  );

  return statements;
}

app.post("/other-party-payments/:paymentNo/void", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const paymentNo = c.req.param("paymentNo");

  // Idempotency: keep the legacy early-return so a re-void is a no-op success.
  if (await ledgerHasSource(c.var.DB, orgId, "other_party_payment_void", paymentNo))
    return c.json({ success: true, data: { alreadyVoided: true } });

  const actorUserId = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  try {
    const { statements } = await buildOtherPartyPaymentLifecycle(c.var.DB, orgId, paymentNo, "void", actorUserId);
    await c.var.DB.batch(statements);
    return c.json({ success: true });
  } catch (e) {
    if ((e as Error).message === "PAYMENT_NOT_FOUND") return c.json({ success: false, error: "Payment not found" }, 404);
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

app.post("/other-party-payments/:paymentNo/lifecycle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const paymentNo = c.req.param("paymentNo");
  let action: LifecycleAction;
  try { action = ((await c.req.json()) as { action: string }).action as LifecycleAction; } catch { return c.json({ success: false, error: "Invalid body" }, 400); }
  if (!["void", "delete", "unvoid"].includes(action)) return c.json({ success: false, error: "action must be void|delete|unvoid" }, 400);

  const actorUserId = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  try {
    const { statements, newState } = await buildOtherPartyPaymentLifecycle(c.var.DB, orgId, paymentNo, action, actorUserId);
    await c.var.DB.batch(statements);
    return c.json({ success: true, data: { state: newState } });
  } catch (e) {
    if ((e as Error).message === "PAYMENT_NOT_FOUND") return c.json({ success: false, error: "Payment not found" }, 404);
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

// Edit a payment/receipt IN PLACE — same number; GL reversed + re-posted (see
// buildOtherPartyPaymentRestate). Body: { bankAccount, date, reference, allocations }.
app.post("/other-party-payments/:paymentNo/restate", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const paymentNo = c.req.param("paymentNo");
  let body: {
    bankAccount?: string;
    date?: string;
    reference?: string;
    allocations?: { billId?: string; amountSen?: number }[];
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid body" }, 400);
  }
  const allocs = (body.allocations ?? []).filter(
    (a) => a.billId && Number(a.amountSen) > 0,
  );
  if (allocs.length === 0)
    return c.json({ success: false, error: "Select at least one bill" }, 400);
  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get(
      "userId",
    ) ?? null;
  try {
    const stamp = Date.now();
    const statements = await buildOtherPartyPaymentRestate(
      c.var.DB,
      orgId,
      paymentNo,
      body,
      actorUserId,
      stamp,
    );
    await c.var.DB.batch(statements);
    return c.json({ success: true });
  } catch (e) {
    if ((e as Error).message === "PAYMENT_NOT_FOUND")
      return c.json({ success: false, error: "Payment not found" }, 404);
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
});

// ---------------------------------------------------------------------------
// STOCK-GROUP ACCOUNT GRID (Maintenance tab, owner request 2026-06-12)
//
// AutoCount-style maintenance: one row per raw-material stock group with
// its purchase / balance-stock / opening / closing accounts. Returns the
// EFFECTIVE mapping (owner's kv coa_stock_map overlaid on the built-in
// defaults) plus the live group list from raw_materials, so the UI can
// render an editable grid instead of raw JSON. Saving still writes the
// same kv key the posting/reports already read.
// ---------------------------------------------------------------------------
app.get("/stock-map/effective", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const { DEFAULT_PURCHASE_MAP, DEFAULT_PURCHASE_ACCT } = await import(
    "./purchase-invoices"
  );
  const [grpRes, kvRow] = await Promise.all([
    c.var.DB.prepare(
      "SELECT DISTINCT itemGroup FROM raw_materials WHERE itemGroup IS NOT NULL AND itemGroup <> '' ORDER BY itemGroup",
    ).all<{ itemGroup: string }>(),
    c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("coa_stock_map")
      .first<{ value: string }>(),
  ]);
  type Entry = { stock?: string; opening?: string; closing?: string; purchase?: string };
  let kv: { rmDefault?: Entry; rm?: Record<string, Entry>; wip?: Entry; fg?: Entry } = {};
  try {
    kv = JSON.parse(kvRow?.value ?? "null") ?? {};
  } catch {
    kv = {};
  }
  const def = DEFAULT_STOCK_MAP;
  const eff = (g: string): Entry & { group: string; description: string } => {
    const dStock = def.rm[g] ?? def.rmDefault;
    const o = kv.rm?.[g] ?? {};
    return {
      group: g,
      description: GROUP_DESCRIPTIONS[g] ?? g,
      stock: o.stock ?? dStock.stock,
      opening: o.opening ?? dStock.opening,
      closing: o.closing ?? dStock.closing,
      purchase: o.purchase ?? DEFAULT_PURCHASE_MAP[g] ?? DEFAULT_PURCHASE_ACCT,
    };
  };
  const groups = (grpRes.results ?? []).map((r) => eff(r.itemGroup));
  return c.json({
    success: true,
    data: {
      groups,
      rmDefault: {
        stock: kv.rmDefault?.stock ?? def.rmDefault.stock,
        opening: kv.rmDefault?.opening ?? def.rmDefault.opening,
        closing: kv.rmDefault?.closing ?? def.rmDefault.closing,
        purchase: kv.rmDefault?.purchase ?? DEFAULT_PURCHASE_ACCT,
      },
      wip: {
        stock: kv.wip?.stock ?? def.wip.stock,
        opening: kv.wip?.opening ?? def.wip.opening,
        closing: kv.wip?.closing ?? def.wip.closing,
      },
      fg: {
        stock: kv.fg?.stock ?? def.fg.stock,
        opening: kv.fg?.opening ?? def.fg.opening,
        closing: kv.fg?.closing ?? def.fg.closing,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// TRIAL BALANCE + GL INQUIRY (Phase 1, 2026-06)
//
// The immutable ledger previously had NO read surface beyond the P&L/BS
// aggregate — auto-posted legs were unbrowsable and there was no way to
// eyeball "do all accounts balance". Two read-only endpoints:
//   GET /trial-balance?asOf=YYYY-MM-DD  — per-account net balances in
//     natural debit/credit columns, with a balanced flag.
//   GET /gl?account=&from=&to=          — one account's leg-by-leg flow
//     with opening balance and running balance, each leg carrying its
//     source document reference for drill-down.
// ---------------------------------------------------------------------------
app.get("/trial-balance", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const asOf = c.req.query("asOf") || new Date().toISOString().slice(0, 10);
  // Multi-company (Phase 1): OPTIONAL ?orgId= / ?company= scopes the TB to one
  // company. Absent → today's consolidated trial balance, byte-identical.
  const coFilter = companyFilter(c, "orgId");
  const legWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const [legRes, coaRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0${legWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{
      accountCode: string;
      sourceId: string;
      debitSen: number;
      creditSen: number;
      postedAt: string;
      sourceType: string;
    }>(),
    c.var.DB.prepare(
      "SELECT code, name, type FROM chart_of_accounts",
    ).all<{ code: string; name: string; type: CoaRow["type"] }>(),
  ]);
  const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  const resolveTb = await loadAccountResolver(c.var.DB);
  const { docDate, openingDate: obDateTb } = await loadDocDateResolver(c.var.DB);
  for (const l of legRes.results ?? []) {
    const d10 = docDate(l.sourceType, l.sourceId, l.postedAt); // by document date
    if (legBeforeOpening(l.sourceType, d10, obDateTb)) continue; // pre-opening: not extracted
    if (d10 > asOf) continue;
    const code = resolveTb(l.accountCode);
    dr.set(code, (dr.get(code) ?? 0) + (Number(l.debitSen) || 0));
    cr.set(code, (cr.get(code) ?? 0) + (Number(l.creditSen) || 0));
  }
  const rows: {
    accountCode: string;
    accountName: string;
    type: string;
    debitSen: number;
    creditSen: number;
  }[] = [];
  let totalDr = 0;
  let totalCr = 0;
  for (const code of [...new Set([...dr.keys(), ...cr.keys()])].sort()) {
    const net = (dr.get(code) ?? 0) - (cr.get(code) ?? 0);
    if (net === 0) continue;
    const acct = coa.get(code);
    const row = {
      accountCode: code,
      accountName: acct?.name ?? "(unknown account)",
      type: acct?.type ?? "?",
      debitSen: net > 0 ? net : 0,
      creditSen: net < 0 ? -net : 0,
    };
    totalDr += row.debitSen;
    totalCr += row.creditSen;
    rows.push(row);
  }
  return c.json({
    success: true,
    data: { asOf, rows, totalDr, totalCr, balanced: totalDr === totalCr },
  });
});

app.get("/gl", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const account = c.req.query("account");
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  // No account → journal-listing mode (Phase 2 follow-up, owner request):
  // EVERY ledger leg in the date window, newest first, capped at 1000
  // rows so an all-time listing can't flatten the browser. Per-account
  // running balances only make sense in single-account mode. `accounts`
  // (comma-separated) narrows the listing to a reviewed SET of accounts
  // (owner: "可能会选多个 review").
  const accountsCsv = c.req.query("accounts") || "";
  const accountSet = accountsCsv
    ? new Set(
        accountsCsv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  // AutoCount-style ledger scope (owner): sales = every SDC debtor control
  // (300-x trade + 305-0000 other debtor), purchase = every SCC creditor
  // control (400-0000 + 405-0000 other creditors), general = everything
  // that is neither, all = no scope.
  const ledgerScope = (c.req.query("ledger") || "all").toLowerCase();
  if (!account) {
    const legRes = await c.var.DB.prepare(
      `SELECT id, accountCode, sourceType, sourceId, debitSen, creditSen,
              description, postedAt
         FROM ledger_journal_entries
        WHERE hidden = 0
        ORDER BY postedAt DESC, id DESC`,
    ).all<{
      id: string;
      accountCode: string;
      sourceType: string;
      sourceId: string;
      debitSen: number;
      creditSen: number;
      description: string;
      postedAt: string;
    }>();
    const coaRes = await c.var.DB.prepare(
      "SELECT code, name, specialAccountType FROM chart_of_accounts",
    ).all<{ code: string; name: string; specialAccountType: string | null }>();
    const names = new Map(
      (coaRes.results ?? []).map((a) => [a.code, a.name] as const),
    );
    const sdcSet = new Set<string>();
    const sccSet = new Set<string>();
    for (const a of coaRes.results ?? []) {
      if (a.specialAccountType === "SDC") sdcSet.add(a.code);
      else if (a.specialAccountType === "SCC") sccSet.add(a.code);
    }
    const inScope = (code: string): boolean => {
      switch (ledgerScope) {
        case "sales":
          return sdcSet.has(code);
        case "purchase":
          return sccSet.has(code);
        case "general":
          return !sdcSet.has(code) && !sccSet.has(code);
        default:
          return true;
      }
    };
    const resolveGl = await loadAccountResolver(c.var.DB);
    // Every read surface dates a leg by its SOURCE DOCUMENT date (opening legs
    // → kv opening date; bookkeeping/ledger-only → postedAt fallback). Their
    // postedAt is the entry timestamp — backdating it would break the hash walk.
    const { docDate, openingDate: obDateAll } = await loadDocDateResolver(c.var.DB);
    const legDay = (l: { postedAt: string; sourceType: string; sourceId: string }) =>
      docDate(l.sourceType, l.sourceId, l.postedAt);
    const all = (legRes.results ?? []).filter((l) => {
      const d10 = legDay(l);
      if (legBeforeOpening(l.sourceType, d10, obDateAll)) return false; // pre-opening: not extracted
      if (d10 < from || d10 > to) return false;
      const code = resolveGl(l.accountCode);
      if (accountSet && !accountSet.has(code)) return false;
      if (!inScope(code)) return false;
      return true;
    });
    // Newest-first by EFFECTIVE day (opening legs sort at the opening date,
    // not at their insert timestamp).
    all.sort(
      (a, b) =>
        legDay(b).localeCompare(legDay(a)) ||
        String(b.postedAt).localeCompare(String(a.postedAt)) ||
        b.id.localeCompare(a.id),
    );
    const CAP = 1000;
    const rows = all.slice(0, CAP).map((l) => {
      const code = resolveGl(l.accountCode);
      return {
        id: l.id,
        postedAt: legDay(l),
        accountCode: code,
        accountName: names.get(code) ?? "",
        description: l.description ?? "",
        sourceType: l.sourceType,
        sourceId: l.sourceId,
        debitSen: Number(l.debitSen) || 0,
        creditSen: Number(l.creditSen) || 0,
      };
    });
    // Owner: per-account total debit / total credit for the filtered date
    // window. Summed over EVERY matching leg (not the 1000-row display
    // cap), so the totals stay right even when the listing is capped.
    const totalsByAccount = new Map<string, { debitSen: number; creditSen: number }>();
    for (const l of all) {
      const code = resolveGl(l.accountCode);
      const t = totalsByAccount.get(code) ?? { debitSen: 0, creditSen: 0 };
      t.debitSen += Number(l.debitSen) || 0;
      t.creditSen += Number(l.creditSen) || 0;
      totalsByAccount.set(code, t);
    }
    const accountTotals = [...totalsByAccount.entries()]
      .map(([code, t]) => ({
        accountCode: code,
        accountName: names.get(code) ?? "",
        debitSen: t.debitSen,
        creditSen: t.creditSen,
      }))
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return c.json({
      success: true,
      data: {
        mode: "all",
        from: from || null,
        to: to === "9999-12-31" ? null : to,
        totalRows: all.length,
        capped: all.length > CAP,
        accountTotals,
        rows,
      },
    });
  }
  const acct = await c.var.DB.prepare(
    "SELECT code, name, type FROM chart_of_accounts WHERE code = ?",
  )
    .bind(account)
    .first<{ code: string; name: string; type: CoaRow["type"] }>();
  if (!acct) {
    return c.json({ success: false, error: "Account not found" }, 404);
  }
  // Old codes renamed INTO this account must show in its flow: query the
  // account plus every alias that resolves to it.
  const resolveOne = await loadAccountResolver(c.var.DB);
  let equivalents = [account];
  try {
    const aliasRows = await c.var.DB.prepare(
      "SELECT oldCode FROM account_aliases",
    ).all<{ oldCode: string }>();
    for (const a of aliasRows.results ?? []) {
      if (resolveOne(a.oldCode) === account) equivalents.push(a.oldCode);
    }
  } catch {
    equivalents = [account];
  }
  const placeholders = equivalents.map(() => "?").join(",");
  const legRes = await c.var.DB.prepare(
    `SELECT id, sourceType, sourceId, debitSen, creditSen, description,
            postedAt
       FROM ledger_journal_entries
      WHERE accountCode IN (${placeholders}) AND hidden = 0
      ORDER BY postedAt ASC, id ASC`,
  )
    .bind(...equivalents)
    .all<{
      id: string;
      sourceType: string;
      sourceId: string;
      debitSen: number;
      creditSen: number;
      description: string;
      postedAt: string;
    }>();
  // Natural direction: debit-normal for ASSET/EXPENSE/COST, credit-normal
  // for LIABILITY/EQUITY/REVENUE — running balance grows in the account's
  // normal direction.
  const debitNormal =
    acct.type === "ASSET" || acct.type === "EXPENSE" || acct.type === "COST";
  let openingSen = 0;
  let running = 0;
  // Owner: the account's total debit / total credit within the date window.
  let totalDebitSen = 0;
  let totalCreditSen = 0;
  const rows: {
    id: string;
    postedAt: string;
    description: string;
    sourceType: string;
    sourceId: string;
    debitSen: number;
    creditSen: number;
    runningSen: number;
  }[] = [];
  const { docDate, openingDate: obDateOne } = await loadDocDateResolver(c.var.DB);
  const effDay = (l: { postedAt: string; sourceType: string; sourceId: string }) =>
    docDate(l.sourceType, l.sourceId, l.postedAt);
  // Re-sort by EFFECTIVE (document) day — a leg carries the entry timestamp but
  // belongs at its source document's date.
  const ordered = [...(legRes.results ?? [])].sort(
    (a, b) =>
      effDay(a).localeCompare(effDay(b)) ||
      String(a.postedAt).localeCompare(String(b.postedAt)) ||
      a.id.localeCompare(b.id),
  );
  for (const l of ordered) {
    const d10 = effDay(l);
    if (legBeforeOpening(l.sourceType, d10, obDateOne)) continue; // pre-opening: not extracted (not even into B/F)
    const delta = debitNormal
      ? (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0)
      : (Number(l.creditSen) || 0) - (Number(l.debitSen) || 0);
    if (d10 < from) {
      openingSen += delta;
      continue;
    }
    if (d10 > to) continue;
    running = (rows.length === 0 ? openingSen : running) + delta;
    totalDebitSen += Number(l.debitSen) || 0;
    totalCreditSen += Number(l.creditSen) || 0;
    rows.push({
      id: l.id,
      postedAt: d10,
      description: l.description ?? "",
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      debitSen: Number(l.debitSen) || 0,
      creditSen: Number(l.creditSen) || 0,
      runningSen: running,
    });
  }
  return c.json({
    success: true,
    data: {
      account: { code: acct.code, name: acct.name, type: acct.type },
      debitNormal,
      from: from || null,
      to: to === "9999-12-31" ? null : to,
      openingSen,
      closingSen: rows.length ? rows[rows.length - 1].runningSen : openingSen,
      totalDebitSen,
      totalCreditSen,
      rows,
    },
  });
});

// ---------------------------------------------------------------------------
// YEAR-END PROFIT CLOSE (Phase 1, 2026-06)
//
// Closes the un-closed P&L result of an ENDED financial year into
// 150-0000 RETAINED EARNING with sourceType='year_close' ledger legs:
// every revenue/cost/expense account's residual balance (cumulative to
// the FYE date, INCLUDING prior year_close legs, so re-closing is a
// no-op) is flipped, balanced by one retained-earnings leg. P&L reports
// exclude year_close legs; the BS includes them — that is how retained
// earnings accumulates and the "Current Year Earnings (unclosed)" line
// shrinks to just the open year.
// ---------------------------------------------------------------------------
const RETAINED_EARNINGS_ACCT = "150-0000";

// Most recent FYE date strictly before `today`.
function lastEndedFyeIso(today: Date, fyeMonth: number): string {
  const win = fyWindowFor(today, fyeMonth);
  const start = new Date(`${win.startIso}T00:00:00Z`);
  return new Date(start.getTime() - 86400000).toISOString().slice(0, 10);
}

// Residual (un-closed) balance per P&L account, cumulative to endIso.
async function computeUnclosedAsOf(
  db: Env["Variables"]["DB"],
  endIso: string,
): Promise<{
  accounts: {
    code: string;
    name: string;
    type: "REVENUE" | "COST" | "EXPENSE";
    residualSen: number;
  }[];
  netSen: number;
}> {
  const [legRes, coaRes] = await Promise.all([
    db
      .prepare(
        "SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0",
      )
      .all<{
        accountCode: string;
        sourceId: string;
        debitSen: number;
        creditSen: number;
        postedAt: string;
        sourceType: string;
      }>(),
    db
      .prepare("SELECT code, name, type FROM chart_of_accounts")
      .all<{ code: string; name: string; type: CoaRow["type"] }>(),
  ]);
  const coa = new Map(
    (coaRes.results ?? []).map((a) => [a.code, a] as const),
  );
  const { docDate, openingDate: obDateUnc } = await loadDocDateResolver(db);
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  const resolveYc = await loadAccountResolver(db);
  for (const l of legRes.results ?? []) {
    const d10 = docDate(l.sourceType, l.sourceId, l.postedAt); // by document date
    if (legBeforeOpening(l.sourceType, d10, obDateUnc)) continue; // pre-opening: not extracted
    if (d10 > endIso) continue;
    const code = resolveYc(l.accountCode);
    dr.set(code, (dr.get(code) ?? 0) + (Number(l.debitSen) || 0));
    cr.set(code, (cr.get(code) ?? 0) + (Number(l.creditSen) || 0));
  }
  const accounts: {
    code: string;
    name: string;
    type: "REVENUE" | "COST" | "EXPENSE";
    residualSen: number;
  }[] = [];
  let netSen = 0;
  for (const code of new Set([...dr.keys(), ...cr.keys()])) {
    const acct = coa.get(code);
    if (!acct) continue;
    if (
      acct.type !== "REVENUE" &&
      acct.type !== "COST" &&
      acct.type !== "EXPENSE"
    )
      continue;
    const d = dr.get(code) ?? 0;
    const c2 = cr.get(code) ?? 0;
    // Residual in the account's NORMAL direction: revenue credit-normal,
    // cost/expense debit-normal. Sign-carrying (a debit-heavy revenue
    // account yields a negative residual and reverses correctly).
    const residualSen = acct.type === "REVENUE" ? c2 - d : d - c2;
    if (residualSen === 0) continue;
    accounts.push({ code, name: acct.name, type: acct.type, residualSen });
    netSen += acct.type === "REVENUE" ? residualSen : -residualSen;
  }
  return { accounts, netSen };
}

// GET /api/accounting/year-close/preview?fyEnd=YYYY-MM-DD
app.get("/year-close/preview", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const fyeMonth = await getFyeMonth(c.var.DB);
  const fyEndIso =
    c.req.query("fyEnd") || lastEndedFyeIso(new Date(), fyeMonth);
  const orgId = getOrgId(c);
  const alreadyClosed = await ledgerHasSource(
    c.var.DB,
    orgId,
    "year_close",
    `fyclose-${fyEndIso}`,
  );
  const { accounts, netSen } = await computeUnclosedAsOf(c.var.DB, fyEndIso);
  return c.json({
    success: true,
    data: {
      fyEnd: fyEndIso,
      fyeMonth,
      alreadyClosed,
      netSen,
      accountCount: accounts.length,
      accounts,
      retainedAccount: RETAINED_EARNINGS_ACCT,
    },
  });
});

// POST /api/accounting/year-close  { fyEnd?: "YYYY-MM-DD" }
app.post("/year-close", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      fyEnd?: string;
    };
    const fyeMonth = await getFyeMonth(c.var.DB);
    const fyEndIso = body.fyEnd || lastEndedFyeIso(new Date(), fyeMonth);
    const today = new Date().toISOString().slice(0, 10);
    if (fyEndIso >= today) {
      return c.json(
        {
          success: false,
          error: `Cannot close FY ending ${fyEndIso} — the year has not ended yet.`,
        },
        400,
      );
    }
    const orgId = getOrgId(c);
    const sourceId = `fyclose-${fyEndIso}`;
    if (await ledgerHasSource(c.var.DB, orgId, "year_close", sourceId)) {
      return c.json(
        {
          success: false,
          error: `FY ended ${fyEndIso} is already closed (idempotent — nothing re-posted).`,
        },
        400,
      );
    }
    const re = await c.var.DB.prepare(
      "SELECT code FROM chart_of_accounts WHERE code = ?",
    )
      .bind(RETAINED_EARNINGS_ACCT)
      .first<{ code: string }>();
    if (!re) {
      return c.json(
        {
          success: false,
          error: `Retained-earnings account ${RETAINED_EARNINGS_ACCT} not found in the chart of accounts.`,
        },
        500,
      );
    }
    const { accounts, netSen } = await computeUnclosedAsOf(
      c.var.DB,
      fyEndIso,
    );
    if (accounts.length === 0) {
      return c.json(
        { success: false, error: "Nothing to close — all P&L accounts are at zero as of that date." },
        400,
      );
    }
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get(
        "userId",
      ) ?? null;
    const legs: LedgerEntryInput[] = [];
    let legNo = 1;
    let totalDr = 0;
    let totalCr = 0;
    for (const a of accounts) {
      // Flip the residual: a credit-normal residual is DEBITED away and
      // vice versa. Negative residuals flip the flip.
      const closesAsDebit =
        a.type === "REVENUE" ? a.residualSen > 0 : a.residualSen < 0;
      const amt = Math.abs(a.residualSen);
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "year_close",
        sourceId,
        legNo: legNo++,
        accountCode: a.code,
        debitSen: closesAsDebit ? amt : 0,
        creditSen: closesAsDebit ? 0 : amt,
        description: `Year-end close · FY ended ${fyEndIso}`,
        actorUserId,
        orgId,
      });
      totalDr += closesAsDebit ? amt : 0;
      totalCr += closesAsDebit ? 0 : amt;
    }
    if (netSen !== 0) {
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "year_close",
        sourceId,
        legNo: legNo++,
        accountCode: RETAINED_EARNINGS_ACCT,
        debitSen: netSen < 0 ? Math.abs(netSen) : 0,
        creditSen: netSen > 0 ? netSen : 0,
        description: `Year-end close · FY ended ${fyEndIso} · net ${netSen > 0 ? "profit" : "loss"}`,
        actorUserId,
        orgId,
      });
      totalDr += netSen < 0 ? Math.abs(netSen) : 0;
      totalCr += netSen > 0 ? netSen : 0;
    }
    if (totalDr !== totalCr) {
      return c.json(
        {
          success: false,
          error: `Close legs do not balance (DR ${totalDr} vs CR ${totalCr}) — aborted, nothing posted.`,
        },
        500,
      );
    }
    const { statements } = await buildJournalEntryStatements(
      c.var.DB,
      orgId,
      legs,
    );
    await c.var.DB.batch(statements);
    return c.json({
      success: true,
      data: {
        fyEnd: fyEndIso,
        netSen,
        legCount: legs.length,
        retainedAccount: RETAINED_EARNINGS_ACCT,
      },
    });
  } catch (e) {
    console.error("[year-close] failed:", e);
    return c.json(
      { success: false, error: "Year-end close failed — nothing was posted." },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// P&L
// ---------------------------------------------------------------------------
// Is a YYYY-MM string inside the requested period? period forms:
//   "2026-Q1" (quarter) · "2026" (year) · "2026-05" (month) · "" / "all".
function ymInPeriod(ym: string, period?: string): boolean {
  if (!period || period === "all") return true;
  if (period.includes("Q")) {
    const [year, q] = period.split("-Q");
    const start = (parseInt(q, 10) - 1) * 3 + 1;
    const months = [start, start + 1, start + 2].map(
      (m) => `${year}-${m.toString().padStart(2, "0")}`,
    );
    return months.includes(ym);
  }
  if (period.length === 4) return ym.startsWith(period);
  return ym === period;
}
// Last YYYY-MM covered by the period (for as-of balance-sheet cutoff).
function periodEndYm(period?: string): string | null {
  if (!period || period === "all") return null;
  if (period.includes("Q")) {
    const [year, q] = period.split("-Q");
    const end = (parseInt(q, 10) - 1) * 3 + 3;
    return `${year}-${end.toString().padStart(2, "0")}`;
  }
  if (period.length === 4) return `${period}-12`;
  return period;
}
// First YYYY-MM of the period (null = since the beginning of time).
function periodStartYm(period?: string): string | null {
  if (!period || period === "all") return null;
  if (period.includes("Q")) {
    const [year, q] = period.split("-Q");
    const start = (parseInt(q, 10) - 1) * 3 + 1;
    return `${year}-${start.toString().padStart(2, "0")}`;
  }
  if (period.length === 4) return `${period}-01`;
  return period;
}
// The YYYY-MM immediately before the given one (for opening-stock cutoff).
function prevYm(ym: string | null): string | null {
  if (!ym) return null;
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  if (m <= 1) return `${y - 1}-12`;
  return `${y}-${(m - 1).toString().padStart(2, "0")}`;
}

// Default item_group → {stock, opening, closing} mapping. Operator-editable
// via kv_config `coa_stock_map`. Unmapped groups fall to the generic
// raw-material stock account; WIP & FG have fixed homes.
type StockMapEntry = { stock: string; opening: string; closing: string };
export const DEFAULT_STOCK_MAP: {
  rmDefault: StockMapEntry;
  rm: Record<string, StockMapEntry>;
  wip: StockMapEntry;
  fg: StockMapEntry;
} = {
  rmDefault: { stock: "330-3001", opening: "704-0001", closing: "704-9991" },
  rm: {
    // ---- REAL AutoCount stock-group codes (owner's workbook + grid
    // screenshot, 2026-06-12). raw_materials.itemGroup carries THESE
    // values — the previous aspirational keys (FABRIC / FOAM / MECHANISM)
    // never matched, so every group silently fell to rmDefault. ----
    "B.M-FABR": { stock: "330-0001", opening: "701-0001", closing: "701-9991" },
    "S-FABRIC": { stock: "330-0002", opening: "701-0002", closing: "701-9992" },
    "S.M-FABR": { stock: "330-0003", opening: "701-0003", closing: "701-9993" },
    PLYWOOD: { stock: "330-1001", opening: "702-0001", closing: "702-9991" },
    "WD STRIP": { stock: "330-1002", opening: "702-0002", closing: "702-9992" },
    "B.FILLER": { stock: "330-2001", opening: "703-0001", closing: "703-9999" },
    "S.FILLER": { stock: "330-2002", opening: "703-0002", closing: "703-9998" },
    "B.OTHERS": { stock: "330-3001", opening: "704-0001", closing: "704-9991" },
    "B.ACCE": { stock: "330-3002", opening: "704-0002", closing: "704-9992" },
    MAINTENA: { stock: "330-3003", opening: "704-0003", closing: "704-9993" },
    "B.MECHAN": { stock: "330-3004", opening: "704-0004", closing: "704-9994" },
    "B.WEBB": { stock: "330-3005", opening: "704-0005", closing: "704-9995" },
    "S.OTHERS": { stock: "330-3006", opening: "704-0006", closing: "704-9996" },
    "S.ACC": { stock: "330-3007", opening: "704-0007", closing: "704-9997" },
    "S.MECH": { stock: "330-3008", opening: "704-0008", closing: "704-9998" },
    "S.WEBB": { stock: "330-3009", opening: "704-0009", closing: "704-9999" },
    PACKING: { stock: "330-4000", opening: "705-0001", closing: "705-9999" },
    EQUIPMEN: { stock: "330-3001", opening: "704-0001", closing: "704-9991" },
    "R&D": { stock: "330-3001", opening: "704-0001", closing: "704-9991" },
    // Legacy aspirational keys kept harmless for any stragglers.
    FABRIC: { stock: "330-0001", opening: "701-0001", closing: "701-9991" },
    WOOD: { stock: "330-1001", opening: "702-0001", closing: "702-9991" },
    FOAM: { stock: "330-2001", opening: "703-0001", closing: "703-9999" },
    WEBBING: { stock: "330-3005", opening: "704-0005", closing: "704-9995" },
  },
  wip: { stock: "330-8000", opening: "700-9005", closing: "700-9010" },
  fg: { stock: "330-9000", opening: "600-0000", closing: "620-0000" },
};

// Stock-group full names for the Maintenance grid (owner's AutoCount
// "Description" column). Fallback = the code itself.
const GROUP_DESCRIPTIONS: Record<string, string> = {
  "B.ACCE": "B.ACCESSORIES",
  "B.FILLER": "B.FILLER",
  "B.MECHAN": "B.MECHANISM",
  "B.M-FABR": "B.M-FABRIC",
  "B.OTHERS": "B.OTHERS",
  "B.WEBB": "B.WEBBING",
  EQUIPMEN: "EQUIPMENT",
  MAINTENA: "MAINTENANCE",
  PACKING: "PACKING",
  PLYWOOD: "PLYWOOD",
  "R&D": "RESEARCH & DEVELOPMENT",
  "S.ACC": "SOFA ACCESSORIES",
  "S.FILLER": "SOFA FILLER",
  "S.MECH": "SOFA MECHANISM",
  "S.M-FABR": "SOFA M-FABRIC",
  "S.OTHERS": "SOFA OTHERS",
  "S.WEBB": "SOFA WEBBING",
  "S-FABRIC": "S-FABRIC",
  "WD STRIP": "WOODEN STRIP",
};

// Live inventory value from the real-time cost ledger, as of `cutoffYm`
// (null = now / all time). RM is netted on-hand (receipts − issues) per
// item_group; WIP = issued + labour − completed; FG = completed −
// delivered. No double-count — RM=on-hand, WIP=in-production, FG=unshipped.
// The effective stock map = built-in defaults overlaid with the owner's
// kv_config `coa_stock_map` override (same shape). Single reader so the
// P&L, stock summary and closing-stock posting all see one truth.
async function getStockMap(
  db: Env["Variables"]["DB"],
): Promise<typeof DEFAULT_STOCK_MAP> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'coa_stock_map'")
      .first<{ value: string | null }>();
    const parsed = JSON.parse(row?.value ?? "null");
    if (parsed && typeof parsed === "object") {
      return {
        ...DEFAULT_STOCK_MAP,
        ...parsed,
        rm: { ...DEFAULT_STOCK_MAP.rm, ...(parsed.rm ?? {}) },
      };
    }
  } catch {
    /* absent / malformed — defaults */
  }
  return DEFAULT_STOCK_MAP;
}

async function liveInventory(
  db: Env["Variables"]["DB"],
  cutoffYm: string | null,
): Promise<{
  rmByGroup: Record<string, number>;
  wip: number;
  fg: number;
  total: number;
}> {
  const [clRes, rmRes] = await Promise.all([
    db
      .prepare(
        "SELECT type, itemType, itemId, direction, totalCostSen, date FROM cost_ledger",
      )
      .all<{
        type: string;
        itemType: string;
        itemId: string;
        direction: string;
        totalCostSen: number;
        date: string;
      }>(),
    db
      .prepare("SELECT id, itemGroup FROM raw_materials")
      .all<{ id: string; itemGroup: string }>(),
  ]);
  const grp = new Map<string, string>();
  for (const r of rmRes.results ?? []) grp.set(r.id, r.itemGroup || "OTHER");
  const rmByGroup: Record<string, number> = {};
  let wip = 0;
  let fg = 0;
  for (const l of clRes.results ?? []) {
    const ym = String(l.date ?? "").slice(0, 7);
    if (cutoffYm && ym > cutoffYm) continue;
    const v = Number(l.totalCostSen) || 0;
    if (l.itemType === "RM") {
      const g = grp.get(l.itemId) || "OTHER";
      rmByGroup[g] =
        (rmByGroup[g] ?? 0) + (l.direction === "IN" ? v : -v);
    }
    if (l.type === "RM_ISSUE" || l.type === "LABOR_POSTED") wip += v;
    else if (l.type === "FG_COMPLETED") {
      wip -= v;
      fg += v;
    } else if (l.type === "FG_DELIVERED") fg -= v;
  }
  const total =
    Object.values(rmByGroup).reduce((s, n) => s + n, 0) + wip + fg;
  return { rmByGroup, wip, fg, total };
}

// ---------------------------------------------------------------------------
// STOCK SUMMARY (Phase 4.2, 2026-06) — per material-group, for any period:
// opening (as-of prior month-end), purchases (RM_RECEIPT IN in period),
// consumption (RM_ISSUE OUT in period), closing (as-of period end). The
// identity opening + purchases − consumption = closing holds per group by
// construction (closing is recomputed from the same cost-ledger movements,
// not opening±deltas, so it's a real cross-check). WIP and FG roll up the
// same way. This is the read layer the Closing-Stock posting (4.4) and the
// Phase-5 Cost Structure report consume.
// ---------------------------------------------------------------------------
type StockGroupRow = {
  group: string;
  openingSen: number;
  purchasesSen: number;
  consumptionSen: number;
  closingSen: number;
};

async function stockSummary(
  db: Env["Variables"]["DB"],
  orgId: string,
  period?: string,
): Promise<{
  rows: StockGroupRow[];
  wip: { openingSen: number; closingSen: number };
  fg: { openingSen: number; closingSen: number };
  totals: { openingSen: number; purchasesSen: number; consumptionSen: number; closingSen: number };
}> {
  return stockSummaryRange(db, orgId, periodStartYm(period), periodEndYm(period));
}

// Window form (FY-YTD and arbitrary spans for the Phase-5 statement).
//
// Stage 2 (owner rule 2026-07-01; design doc
// docs/superpowers/specs/2026-06-30-pi-driven-stock-in-closing-design.md): this
// used to independently re-derive opening/purchases/consumption/closing from
// cost_ledger RM_RECEIPT/RM_ISSUE (GRN-only, no PI, no month-end stock-take
// override) — a SEPARATE pipeline from the P&L's material engine
// (loadMaterialCostData/materialWindow), which is why the GL/Balance-Sheet
// stock could disagree with the P&L closing the moment PI-only receipts or a
// stock-take override entered the picture. Now delegates to that SAME engine
// so the two can never diverge again — this drives BOTH the GL closing-stock
// posting (buildClosingStockLegs) AND the Stock Summary display, from one
// source of truth.
async function stockSummaryRange(
  db: Env["Variables"]["DB"],
  orgId: string,
  startYm: string | null,
  endYm: string | null,
): Promise<{
  rows: StockGroupRow[];
  wip: { openingSen: number; closingSen: number };
  fg: { openingSen: number; closingSen: number };
  totals: { openingSen: number; purchasesSen: number; consumptionSen: number; closingSen: number };
}> {
  const lastYm = endYm ?? new Date().toISOString().slice(0, 7);
  const data = await loadMaterialCostData(db, orgId, lastYm);
  const w = materialWindow(data, startYm, endYm);
  const rows: StockGroupRow[] = w.rmGroups
    .filter((g) => g.openingSen !== 0 || g.purchaseSen !== 0 || g.consumedSen !== 0 || g.closingSen !== 0)
    .map((g) => ({
      group: g.itemGroup,
      openingSen: g.openingSen,
      purchasesSen: g.purchaseSen,
      consumptionSen: g.consumedSen,
      closingSen: g.closingSen,
    }))
    .sort((a, b) => a.group.localeCompare(b.group));
  const totals = {
    openingSen: rows.reduce((s, r) => s + r.openingSen, 0),
    purchasesSen: rows.reduce((s, r) => s + r.purchasesSen, 0),
    consumptionSen: rows.reduce((s, r) => s + r.consumptionSen, 0),
    closingSen: rows.reduce((s, r) => s + r.closingSen, 0),
  };
  return {
    rows,
    wip: { openingSen: w.wipOpenSen, closingSen: w.wipCloseSen },
    fg: { openingSen: w.fgOpenSen, closingSen: w.fgCloseSen },
    totals,
  };
}

// Build the closing-stock journal legs for a month (shared by preview +
// post). Periodic-inventory pair per group/WIP/FG: take up closing
// (DR 330 stock · CR SCS) + bring down opening (DR SOS · CR 330 stock).
// Net 330 = closing − opening (the asset), net P&L = opening − closing
// (the stock movement into COGS). The /pl manufacturing section reads
// opening/closing LIVE and overrides these SOS/SCS legs, so there is no
// double count — the legs exist to put inventory on the Balance Sheet
// and keep the trial balance whole.
// Hex SHA-256 of a string — used to derive a content-deterministic ledger
// source_id for the closing-stock post so a retried/double-fired re-post
// collides on the immutable unique index (exactly-once) while a genuine
// restate (changed stock snapshot → different hash) still posts.
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildClosingStockLegs(
  db: Env["Variables"]["DB"],
  month: string,
  orgId: string,
  actorUserId: string | null,
  sourceId: string,
): Promise<{ legs: LedgerEntryInput[]; closingTotalSen: number }> {
  const { rows, wip, fg } = await stockSummary(db, orgId, month);
  const map = await getStockMap(db);
  const legs: LedgerEntryInput[] = [];
  let legNo = 1;
  let closingTotalSen = 0;
  const pair = (stock: string, sos: string, scs: string, openingSen: number, closingSen: number, label: string) => {
    if (closingSen !== 0) {
      legs.push({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "closing_stock", sourceId, legNo: legNo++, accountCode: stock, debitSen: closingSen, creditSen: 0, description: `Closing stock ${month} · ${label}`, actorUserId, orgId });
      legs.push({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "closing_stock", sourceId, legNo: legNo++, accountCode: scs, debitSen: 0, creditSen: closingSen, description: `Closing stock ${month} · ${label}`, actorUserId, orgId });
      closingTotalSen += closingSen;
    }
    if (openingSen !== 0) {
      legs.push({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "closing_stock", sourceId, legNo: legNo++, accountCode: sos, debitSen: openingSen, creditSen: 0, description: `Opening stock ${month} · ${label}`, actorUserId, orgId });
      legs.push({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "closing_stock", sourceId, legNo: legNo++, accountCode: stock, debitSen: 0, creditSen: openingSen, description: `Opening stock ${month} · ${label}`, actorUserId, orgId });
    }
  };
  for (const r of rows) {
    const m = map.rm[r.group] ?? map.rmDefault;
    pair(m.stock, m.opening, m.closing, Math.round(r.openingSen), Math.round(r.closingSen), r.group);
  }
  pair(map.wip.stock, map.wip.opening, map.wip.closing, Math.round(wip.openingSen), Math.round(wip.closingSen), "WIP");
  pair(map.fg.stock, map.fg.opening, map.fg.closing, Math.round(fg.openingSen), Math.round(fg.closingSen), "FG");
  return { legs, closingTotalSen };
}

app.post("/stock/close-post", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const month = String(body.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
    }
    const today = new Date().toISOString().slice(0, 7);
    if (month > today) {
      return c.json({ success: false, error: `Cannot close stock for a future month (${month})` }, 400);
    }
    const db = c.var.DB;
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;

    // --- Idempotency (2026-07-04) -----------------------------------------
    // Re-posting closing stock is an INTENTIONAL feature (re-base after a
    // stock-take / RM-valuation-mode flip / next-month roll). But the old
    // code keyed the ledger source_id on `Date.now()`, so the immutable
    // UNIQUE(org,source_type,source_id,leg_no) index NEVER fired on a
    // re-post — an accidental double-fire (network retry, double-click past
    // the FE `posting` guard) appended a SECOND reversal+repost pair. The
    // trial balance self-heals (each post first reverses ALL prior net), but
    // the append-only ledger accumulated unbounded duplicate legs.
    //
    // Fix: derive the source_id from the CONTENT of the fresh legs (a hash
    // of month + every (account,debit,credit) tuple) instead of the clock.
    //   * An IDENTICAL re-post (same month, same computed closing snapshot)
    //     → same source_id → collides on the unique index → we detect it via
    //     ledgerHasSource and cleanly NO-OP. A double-fire posts exactly once.
    //   * A GENUINE restate (stock/valuation actually changed → a different
    //     closing snapshot) → different content hash → different source_id →
    //     posts as a fresh reversal+repost, exactly as before.
    // This preserves the re-post feature while making a retried double-fire
    // exactly-once at the ledger level.
    const { legs: freshLegs, closingTotalSen } = await buildClosingStockLegs(
      db,
      month,
      orgId,
      actorUserId,
      "PENDING", // placeholder sourceId — rewritten below once we know the hash
    );

    // Reverse the prior closing-stock net (any month) so a re-post or the
    // next month always lands the 330 stock accounts at THIS month's
    // closing — history-independent, like the opening-balance re-post.
    const prior = await db
      .prepare(
        `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
          WHERE sourceType IN ('closing_stock','closing_stock_reversal') AND orgId = ? AND hidden = 0`,
      )
      .bind(orgId)
      .all<{ accountCode: string; debitSen: number; creditSen: number }>();
    const priorNet = new Map<string, number>();
    for (const l of prior.results ?? []) {
      priorNet.set(l.accountCode, (priorNet.get(l.accountCode) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
    }

    // Content hash over the fresh closing snapshot + the prior net being
    // reversed. Two identical re-posts against the same ledger state hash the
    // same; anything that moved the stock value changes the hash.
    const hashInput = [
      month,
      ...freshLegs.map((l) => `${l.accountCode}:${l.debitSen}:${l.creditSen}`),
      "REV",
      ...[...priorNet.entries()].map(([code, net]) => `${code}:${net}`),
    ].join("|");
    const contentHash = await sha256Hex(hashInput);
    const postSourceId = `cs-${month}-${contentHash.slice(0, 16)}`;
    const revSourceId = `cs-rev-${contentHash.slice(0, 16)}`;

    // Already posted this exact snapshot? Clean no-op — a retry / double-fire
    // returns success without appending a second identical pair.
    if (await ledgerHasSource(db, orgId, "closing_stock", postSourceId)) {
      return c.json({
        success: true,
        data: { month, closingTotalSen, alreadyPosted: true },
      });
    }

    const legs: LedgerEntryInput[] = [];
    let legNo = 1;
    for (const [code, net] of priorNet) {
      if (net === 0) continue;
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "closing_stock_reversal",
        sourceId: revSourceId,
        legNo: legNo++,
        accountCode: code,
        debitSen: net < 0 ? -net : 0,
        creditSen: net > 0 ? net : 0,
        description: `Prior closing-stock reversed`,
        actorUserId,
        orgId,
      });
    }
    // Re-stamp the fresh legs with the content-derived source_id.
    for (const l of freshLegs) l.sourceId = postSourceId;
    if (freshLegs.length === 0 && legs.length === 0) {
      return c.json({ success: false, error: `No stock movements for ${month} — nothing to post.` }, 400);
    }
    legs.push(...freshLegs);
    const { statements } = await buildJournalEntryStatements(db, orgId, legs);
    await db.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: `cs-${month}`,
      action: "create",
      after: { month, closingTotalSen },
    });
    return c.json({ success: true, data: { month, closingTotalSen } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/stock-summary", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const period = c.req.query("period") || undefined;
  const { rows, wip, fg, totals } = await stockSummary(c.var.DB, orgId, period);
  // Has this month's closing stock been posted? (informational for the UI)
  let posted = false;
  if (period && /^\d{4}-\d{2}$/.test(period)) {
    try {
      const row = await c.var.DB.prepare(
        `SELECT 1 AS x FROM ledger_journal_entries
          WHERE sourceType = 'closing_stock' AND sourceId LIKE ? AND orgId = ? LIMIT 1`,
      )
        .bind(`cs-${period}-%`, orgId)
        .first<{ x: number }>();
      posted = !!row;
    } catch {
      /* ignore */
    }
  }
  // Attach the group description + mapped COA accounts for display.
  const stockMap = await getStockMap(c.var.DB);
  return c.json({
    success: true,
    data: {
      period: period ?? "all",
      rows: rows.map((r) => ({
        ...r,
        description: GROUP_DESCRIPTIONS[r.group] ?? r.group,
        accounts: stockMap.rm[r.group] ?? stockMap.rmDefault,
        balanced: r.openingSen + r.purchasesSen - r.consumptionSen === r.closingSen,
      })),
      wip,
      fg,
      totals,
      posted,
    },
  });
});

// ---------------------------------------------------------------------------
// PRODUCT-LINE COST AGGREGATION (Phase 4.5, 2026-06) — split the
// manufacturing cost into Sofa vs Bedframe by FOLLOWING ACTUAL ACTIVITY
// (owner rule, 2026-06-10): material consumption follows the RM_ISSUE →
// production-order category; labour follows LABOR_POSTED → production-order
// category. SOFA + ACCESSORY → Sofa, BEDFRAME → Bedframe; issues with no
// category / no PO land in "unallocated" (surfaced so they can be fixed —
// the Phase-4.7 cleanup report). Shared/indirect costs (no-issue factory
// materials, SST, admin) are apportioned by net-sales ratio in the report
// layer (Phase 4.6) — this engine returns the DIRECT split + the sales
// ratio so the report can do the apportionment.
// ---------------------------------------------------------------------------
type LineBucket = { materialSen: number; labourSen: number };

async function costByLine(
  db: Env["Variables"]["DB"],
  period?: string,
): Promise<{
  sofa: LineBucket;
  bedframe: LineBucket;
  unallocated: LineBucket;
  totalMaterialSen: number;
  totalLabourSen: number;
  salesRatio: { sofa: number; bedframe: number };
  salesByLine: { sofa: number; bedframe: number };
}> {
  const [clRes, poRes] = await Promise.all([
    db
      .prepare(
        `SELECT type, itemId, refType, refId, totalCostSen, date
           FROM cost_ledger WHERE type IN ('RM_ISSUE','LABOR_POSTED')`,
      )
      .all<{ type: string; itemId: string; refType: string | null; refId: string | null; totalCostSen: number; date: string }>(),
    db.prepare("SELECT id, itemCategory FROM production_orders").all<{ id: string; itemCategory: string | null }>(),
  ]);
  const poCat = new Map<string, string>();
  for (const p of poRes.results ?? []) poCat.set(p.id, String(p.itemCategory ?? "").toUpperCase());
  const sofa: LineBucket = { materialSen: 0, labourSen: 0 };
  const bedframe: LineBucket = { materialSen: 0, labourSen: 0 };
  const unallocated: LineBucket = { materialSen: 0, labourSen: 0 };
  const lineOf = (poId: string | null): LineBucket => {
    const cat = poId ? poCat.get(poId) : undefined;
    if (cat === "SOFA" || cat === "ACCESSORY") return sofa;
    if (cat === "BEDFRAME") return bedframe;
    return unallocated;
  };
  for (const l of clRes.results ?? []) {
    if (!ymInPeriod(String(l.date ?? "").slice(0, 7), period)) continue;
    const v = Number(l.totalCostSen) || 0;
    // RM_ISSUE → refId is the PO; LABOR_POSTED → itemId is the PO.
    const poId = l.type === "RM_ISSUE" ? l.refId : l.itemId;
    const bucket = lineOf(poId);
    if (l.type === "RM_ISSUE") bucket.materialSen += v;
    else bucket.labourSen += v;
  }
  // Sales by line (invoice items → product category), for the ratio.
  let sofaSales = 0;
  let bedSales = 0;
  try {
    const [invRes, itemRes, prodRes] = await Promise.all([
      db.prepare(`SELECT id, invoiceDate, status FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED')`).all<{ id: string; invoiceDate: string | null; status: string }>(),
      db.prepare(`SELECT invoiceId, productCode, totalSen FROM invoice_items`).all<{ invoiceId: string; productCode: string | null; totalSen: number }>(),
      db.prepare(`SELECT code, category FROM products`).all<{ code: string; category: string | null }>(),
    ]);
    const invYm = new Map<string, string>();
    for (const i of invRes.results ?? []) invYm.set(i.id, String(i.invoiceDate ?? "").slice(0, 7));
    const cat = new Map<string, string>();
    for (const p of prodRes.results ?? []) cat.set(p.code, String(p.category ?? "").toUpperCase());
    for (const it of itemRes.results ?? []) {
      const ym = invYm.get(it.invoiceId);
      if (ym === undefined || !ymInPeriod(ym, period)) continue;
      const c2 = cat.get(it.productCode ?? "") ?? "";
      const v = Number(it.totalSen) || 0;
      if (c2 === "BEDFRAME") bedSales += v;
      else sofaSales += v; // SOFA + ACCESSORY + anything else → Sofa
    }
  } catch {
    /* invoices/products absent — ratio stays 0 */
  }
  const salesTotal = sofaSales + bedSales;
  const salesRatio = salesTotal > 0
    ? { sofa: sofaSales / salesTotal, bedframe: bedSales / salesTotal }
    : { sofa: 0.5, bedframe: 0.5 };
  return {
    sofa,
    bedframe,
    unallocated,
    totalMaterialSen: sofa.materialSen + bedframe.materialSen + unallocated.materialSen,
    totalLabourSen: sofa.labourSen + bedframe.labourSen + unallocated.labourSen,
    salesRatio,
    salesByLine: { sofa: sofaSales, bedframe: bedSales },
  };
}

app.get("/cost-by-line", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const period = c.req.query("period") || undefined;
  const data = await costByLine(c.var.DB, period);
  return c.json({ success: true, data: { period: period ?? "all", ...data } });
});

// ---------------------------------------------------------------------------
// WIP DETAIL (Phase 4.3, 2026-06) — WIP is already valued as issued
// materials + posted labour − completed (RM_ISSUE fires at FAB_CUT, not
// at PO completion, so an in-progress order already carries its material
// part). This surfaces that valuation per open production order so it's
// auditable: materialSen + labourSen − completedSen = wipSen, listed for
// every order still carrying WIP.
// ---------------------------------------------------------------------------
app.get("/wip-detail", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const asOf = c.req.query("asOf") || ""; // YYYY-MM cutoff, optional
  const [clRes, poRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT type, itemId, refType, refId, totalCostSen, date
           FROM cost_ledger WHERE type IN ('RM_ISSUE','LABOR_POSTED','FG_COMPLETED')`,
      )
      .all<{ type: string; itemId: string; refType: string | null; refId: string | null; totalCostSen: number; date: string }>(),
    // `poNo`, not `poNumber`: production_orders stores it as po_no. The
    // rename map DOES carry poNumber → po_number, but that column lives on
    // grns / goods_in_transit / three_way_matches — so this SELECT rewrote
    // cleanly and then 500'd on a column production_orders never had.
    c.var.DB.prepare("SELECT id, poNo, itemCategory, status FROM production_orders").all<{ id: string; poNo: string | null; itemCategory: string | null; status: string | null }>(),
  ]);
  const po = new Map<string, { poNumber: string; category: string; status: string }>();
  for (const p of poRes.results ?? []) po.set(p.id, { poNumber: p.poNo ?? p.id, category: String(p.itemCategory ?? "").toUpperCase(), status: p.status ?? "" });
  type Wip = { poId: string; poNumber: string; category: string; status: string; materialSen: number; labourSen: number; completedSen: number };
  const byPo = new Map<string, Wip>();
  const ensure = (poId: string): Wip => {
    let w = byPo.get(poId);
    if (!w) {
      const meta = po.get(poId);
      w = { poId, poNumber: meta?.poNumber ?? poId, category: meta?.category ?? "", status: meta?.status ?? "", materialSen: 0, labourSen: 0, completedSen: 0 };
      byPo.set(poId, w);
    }
    return w;
  };
  for (const l of clRes.results ?? []) {
    if (asOf && String(l.date ?? "").slice(0, 7) > asOf) continue;
    const v = Number(l.totalCostSen) || 0;
    // RM_ISSUE → refId is the PO; LABOR_POSTED → itemId is PO; FG_COMPLETED → refId is PO.
    const poId = l.type === "LABOR_POSTED" ? l.itemId : l.refId;
    if (!poId) continue;
    const w = ensure(poId);
    if (l.type === "RM_ISSUE") w.materialSen += v;
    else if (l.type === "LABOR_POSTED") w.labourSen += v;
    else w.completedSen += v;
  }
  const rows = [...byPo.values()]
    .map((w) => ({ ...w, wipSen: w.materialSen + w.labourSen - w.completedSen }))
    .filter((w) => Math.round(w.wipSen) !== 0)
    .sort((a, b) => b.wipSen - a.wipSen);
  const totalSen = rows.reduce((s, w) => s + w.wipSen, 0);
  return c.json({ success: true, data: { asOf: asOf || null, rows, totalSen } });
});

// ---------------------------------------------------------------------------
// CLEANUP REPORT (Phase 4.7, 2026-06) — surface data that can't be
// allocated to a material group or product line, so the owner can fix it
// before trusting the split reports:
//   · production orders with cost activity but no/unknown itemCategory
//     (their material + labour land in "unallocated")
//   · raw materials with a blank itemGroup (fall to the generic RM stock
//     account)
//   · itemGroups in use that have no stock-map entry (fall to rmDefault)
// ---------------------------------------------------------------------------
app.get("/cleanup-report", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const [clRes, poRes, rmRes] = await Promise.all([
    db.prepare(
      `SELECT type, itemId, refType, refId, totalCostSen FROM cost_ledger WHERE type IN ('RM_ISSUE','LABOR_POSTED')`,
    ).all<{ type: string; itemId: string; refType: string | null; refId: string | null; totalCostSen: number }>(),
    // `poNo` — see the note on /wip-detail above.
    db.prepare("SELECT id, poNo, itemCategory FROM production_orders").all<{ id: string; poNo: string | null; itemCategory: string | null }>(),
    // `description` — raw_materials has no `name` column; the item's readable
    // label is its description. This is what was 500ing the report.
    db.prepare("SELECT id, itemCode, description, itemGroup FROM raw_materials").all<{ id: string; itemCode: string | null; description: string | null; itemGroup: string | null }>(),
  ]);
  const poCat = new Map<string, { poNumber: string; category: string }>();
  for (const p of poRes.results ?? []) poCat.set(p.id, { poNumber: p.poNo ?? p.id, category: String(p.itemCategory ?? "").toUpperCase() });
  // POs with cost activity but no usable category.
  const badPo = new Map<string, { poNumber: string; costSen: number }>();
  for (const l of clRes.results ?? []) {
    const poId = l.type === "LABOR_POSTED" ? l.itemId : l.refId;
    if (!poId) continue;
    const meta = poCat.get(poId);
    const cat = meta?.category ?? "";
    if (cat === "SOFA" || cat === "BEDFRAME" || cat === "ACCESSORY") continue;
    const cur = badPo.get(poId) ?? { poNumber: meta?.poNumber ?? poId, costSen: 0 };
    cur.costSen += Number(l.totalCostSen) || 0;
    badPo.set(poId, cur);
  }
  // Raw materials with no group + the set of groups actually in use.
  const map = await getStockMap(db);
  const mappedGroups = new Set(Object.keys(map.rm));
  const rmNoGroup: { itemCode: string; name: string }[] = [];
  const usedGroups = new Set<string>();
  for (const r of rmRes.results ?? []) {
    const g = String(r.itemGroup ?? "").trim();
    if (!g) rmNoGroup.push({ itemCode: r.itemCode ?? r.id, name: r.description ?? "" });
    else usedGroups.add(g);
  }
  const unmappedGroups = [...usedGroups].filter((g) => !mappedGroups.has(g)).sort();
  return c.json({
    success: true,
    data: {
      posWithoutCategory: [...badPo.values()].sort((a, b) => b.costSen - a.costSen),
      rmWithoutGroup: rmNoGroup.sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
      unmappedGroups,
      defaultRmAccount: map.rmDefault,
    },
  });
});

// ---------------------------------------------------------------------------
// MANUFACTURING-ACCOUNT P&L STATEMENT (Phase 5.1/5.2, 2026-06) — the
// owner's workbook format, computed for a date window. Raw-material,
// WIP and FG come from the cost-ledger stock summary (the validated
// opening+purchase−closing identity); labour / overhead / carriage / SST
// / revenue / other-income / expenses come from the GL window. For a
// product line (sofa/bedframe) the directly-attributable material &
// labour follow the production-order category (costByLine) and the
// shared/indirect costs are apportioned by the net-sales ratio (4.6).
// ---------------------------------------------------------------------------
type GlWindow = Map<string, number>; // accountCode → signed (DR−CR) sen

// The per-request document-date resolver context (built once, threaded into
// the per-window P&L helpers so they don't re-load all source tables N times).
interface DocDateCtx {
  docDate: (
    sourceType: string,
    sourceId: string,
    postedAt: string | null | undefined,
  ) => string;
  openingDate: string | null;
  // Per-request memo for glWindowSigned (key `${startYm}|${endYm}`). The
  // periodic-inventory stock chain re-reads overlapping windows; cached
  // results are shared and must be treated as READ-ONLY by callers.
  glMemo?: Map<string, { net: GlWindow; coa: Map<string, { name: string; type: CoaRow["type"] }> }>;
  // Per-request memo for the report-layer labour injection (key = ym →
  // debit lines). The dashboard walks many one-month windows on one ctx; a
  // dry payroll projection must run at most once per month per request.
  labourMemo?: Map<string, { account: string; sen: number }[]>;
}

// Report-layer labour for one month (owner 2026-08-31 「任何时候我看P&L 时你都
// 自动提取」): the payslips' department costs if any were generated, else a
// dry run of the same payroll engine; mapped to accounts exactly like the
// Labour tab's Post would. Returns [] when the month has neither payslips nor
// clock data. Callers must ALREADY have established the month is unrecorded
// (no salary-accrual credit in the GL) via labourInjectMonths.
async function labourInjectionLines(
  db: Env["Variables"]["DB"],
  orgId: string,
  ym: string,
  memo?: Map<string, { account: string; sen: number }[]>,
): Promise<{ account: string; sen: number }[]> {
  const hit = memo?.get(ym);
  if (hit) return hit;
  let byDept: LabourDeptAgg[] = [];
  let map: LabourMap | null = null;
  try {
    const agg = await aggregateLabour(db, ym, orgId);
    byDept = agg.byDept;
    map = agg.map;
  } catch { /* payslips table absent → dry-run below */ }
  if (!byDept.length) {
    try {
      if (!map) map = await getLabourMap(db);
      const proj = await projectedLabourByDept(db, ym);
      byDept = proj.map((d) => ({
        departmentCode: d.departmentCode,
        account: (map as LabourMap).byDept[d.departmentCode] ?? (map as LabourMap).fallback,
        workers: d.workers,
        grossSen: d.grossSen,
        employerSen: d.epfSen + d.socsoSen + d.eisSen,
        costSen: d.grossSen + d.epfSen + d.socsoSen + d.eisSen,
        epfSen: d.epfSen,
        socsoSen: d.socsoSen,
        eisSen: d.eisSen,
      }));
    } catch { byDept = []; }
  }
  const lines = byDept.length && map ? labourDebitLines(byDept, map) : [];
  memo?.set(ym, lines);
  return lines;
}

// Prior-cumulative P&L balances (the old accountant's TB as at the month-end
// BEFORE the opening month) — kv-config JSON {accountCode: signedSen}. Used to
// carve the opening-balance P&L lump into "≤ prior month" (shown via the
// historical P&L) and "opening-month 1st → opening date" (shown in the opening
// month by applyOpeningSlice). Report-layer only; the ledger keeps one clean
// opening entry (owner rule 2026-07-03: no bridge JVs, no trace).
async function getPnlOpeningPriorCum(
  db: Env["Variables"]["DB"],
): Promise<Record<string, number>> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'pnl_opening_prior_cum'")
      .first<{ value: string | null }>();
    const parsed = JSON.parse(row?.value ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const n = Math.round(Number(v));
        if (Number.isFinite(n) && n !== 0) out[k] = n;
      }
      return out;
    }
  } catch {
    // absent key / bad JSON → no prior-cum: the whole opening lump stays in
    // the opening month (still correct when the books simply began then)
  }
  return {};
}

const PNL_TYPES: ReadonlySet<CoaRow["type"]> = new Set(["REVENUE", "COST", "EXPENSE"]);

async function glWindowSigned(
  db: Env["Variables"]["DB"],
  orgId: string,
  startYm: string | null,
  endYm: string | null,
  dc: DocDateCtx,
): Promise<{ net: GlWindow; coa: Map<string, { name: string; type: CoaRow["type"] }> }> {
  const memoKey = `${startYm ?? ""}|${endYm ?? ""}`;
  const cached = dc.glMemo?.get(memoKey);
  if (cached) return cached;
  const [legRes, coaRes] = await Promise.all([
    db.prepare("SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0")
      .all<{ accountCode: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; sourceType: string }>(),
    db.prepare("SELECT code, name, type FROM chart_of_accounts").all<{ code: string; name: string; type: CoaRow["type"] }>(),
  ]);
  const resolve = await loadAccountResolver(db);
  const { docDate, openingDate: obDate } = dc;
  const net: GlWindow = new Map();
  const openingNet: GlWindow = new Map(); // opening_balance(+reversal) legs, netted
  // Salary accruals ALREADY in the GL, per month and ACCOUNT: any entry that
  // credits 410-0010 (a Labour-tab post OR a manual JV) marks the accounts its
  // debit legs touched. Those (month, account) pairs keep the owner's figures;
  // everything else still gets the report-layer labour injection below.
  // Account-level, not month-level (BUG-2026-08-31-172): the owner's Aug'26
  // office-salary JV (CR 410-0010 55,000 → DR 900-S00x) used to silence the
  // WHOLE month, wiping the production 750-x auto-extract with it.
  const salaryEntryYm = new Map<string, string>(); // sourceType::sourceId → ym of its 410-0010 credit
  for (const l of legRes.results ?? []) {
    if ((Number(l.creditSen) || 0) <= 0) continue;
    if (resolve(l.accountCode) !== LABOUR_ACCRUAL_ACCT) continue;
    const dd = docDate(l.sourceType, l.sourceId, l.postedAt);
    if (legBeforeOpening(l.sourceType, dd, obDate) || isOpeningSource(l.sourceType)) continue;
    salaryEntryYm.set(`${l.sourceType}::${l.sourceId}`, dd.slice(0, 7));
  }
  const recordedSalaryAccts = new Map<string, Set<string>>(); // ym → debited accounts
  for (const l of legRes.results ?? []) {
    if ((Number(l.debitSen) || 0) <= 0) continue;
    const ym = salaryEntryYm.get(`${l.sourceType}::${l.sourceId}`);
    if (!ym) continue;
    let set = recordedSalaryAccts.get(ym);
    if (!set) { set = new Set(); recordedSalaryAccts.set(ym, set); }
    set.add(resolve(l.accountCode));
  }
  for (const l of legRes.results ?? []) {
    const dd = docDate(l.sourceType, l.sourceId, l.postedAt); // by document date
    if (legBeforeOpening(l.sourceType, dd, obDate)) continue; // pre-opening: not extracted
    // Opening-balance legs carry the CUMULATIVE-to-opening P&L balances — they
    // don't belong to any single month directly. Collect them (reversals net
    // out) and inject only the opening-month slice below.
    if (isOpeningSource(l.sourceType)) {
      const code = resolve(l.accountCode);
      openingNet.set(code, (openingNet.get(code) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
      continue;
    }
    // Closing-stock legs are bookkeeping, not trading — the stock summary
    // already supplies stock.
    if (l.sourceType === "closing_stock" || l.sourceType === "closing_stock_reversal") continue;
    const ym = dd.slice(0, 7);
    if (startYm && ym < startYm) continue;
    if (endYm && ym > endYm) continue;
    const code = resolve(l.accountCode);
    net.set(code, (net.get(code) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
  }
  // Report-layer labour (owner 2026-08-31 「任何时候我看P&L 时你都自动提取」):
  // the payroll figures show up without waiting for a post — stored payslips
  // if generated, else a dry run of the same engine. Per line: an account the
  // owner already recorded that month keeps HIS figure (以我记录的为准), the
  // rest inject. Display-only: TB/BS carry nothing until an actual post (same
  // trade-off as the opening slice).
  for (const ym of labourInjectMonths({
    startYm,
    endYm,
    openingYm: obDate ? obDate.slice(0, 7) : null,
    nowYm: new Date().toISOString().slice(0, 7),
    recordedYms: new Set(), // recording is handled per account below
  })) {
    dc.labourMemo ??= new Map();
    const recorded = recordedSalaryAccts.get(ym);
    for (const { account, sen } of await labourInjectionLines(db, orgId, ym, dc.labourMemo)) {
      if (recorded?.has(account)) continue;
      net.set(account, (net.get(account) ?? 0) + sen);
    }
  }
  const coa = new Map((coaRes.results ?? []).map((a) => [a.code, { name: a.name, type: a.type }] as const));
  // Mid-year opening: the opening month's P&L = opening cumulative − prior
  // month-end TB (kv `pnl_opening_prior_cum`). Months before the opening month
  // come from the owner-keyed historical P&L, so nothing double-counts.
  if (openingNet.size && windowCoversMonth(startYm, endYm, obDate ? obDate.slice(0, 7) : null)) {
    const priorCum = await getPnlOpeningPriorCum(db);
    applyOpeningSlice(net, openingNet, priorCum, (code) => {
      const t = coa.get(code)?.type;
      return t !== undefined && PNL_TYPES.has(t);
    });
  }
  const out = { net, coa };
  dc.glMemo?.set(memoKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// loadMaterialCost (F6 T4b) — read-only FIFO material cost for a P&L window.
//
// MONEY-CRITICAL. Replaces the cost_ledger perpetual figures (which stopped
// being fed after 2026-03) with a from-source FIFO replay, for the three
// inventory layers the manufacturing P&L needs:
//   · RM  — opening + GRN purchases − closing, per item_group (FIFO consumption)
//   · WIP — per in-progress production_order: Σ RM_ISSUE.total_cost_sen (material
//           actually booked) + Σ LABOR_POSTED.total_cost_sen, both as-of-date
//   · FG  — per completed-not-delivered fg_batch: undelivered qty × the
//           cascade-maintained fg_batches.unit_cost_sen
//
// The pure FIFO maths live in src/lib/material-cost-fifo.ts; here we only
// assemble the events from the operational tables and feed the engine for the RM
// layer (opening/purchase/closing/consumed via monthly checkpoints). WIP material
// and FG are NOT taken from the replay's per-issue costs: that re-valuation was
// ~15× too high on live prod because the replay's per-layer issue costs for a PO
// did not reconcile to Σ RM_ISSUE.total_cost_sen booked to it. WIP/FG now read the
// actual booked cost_ledger totals (and FG's cascade unit cost) instead — see
// BUG-2026-06-29-001. The RM checkpoint path (computeMaterialCheckpoints) is
// unaffected and stays coherent to the sen.
//
// As-of-date reconstruction (the hard part — owner accepts pre-cutover /
// transitional imperfection, but the CURRENT period, whose closing date is
// "now", must be exact):
//   · closing (wipClose/fgClose) is as of endIso (period end).
//   · opening (wipOpen/fgOpen)  is as of the instant BEFORE startIso, i.e. the
//     day before the period start (= end of the prior month) — last close of it.
//   · "in progress as of D"     = start_date <= D AND (completed_date IS NULL OR
//                                 completed_date > D)   — rebuilt from dates, not
//                                 the current `status`, so any historical window
//                                 is answerable.
//   · "undelivered as of D"     = original_qty − COUNT(fg_units delivered_at<=D).
// ---------------------------------------------------------------------------
type LoadMaterialCostResult = {
  rmGroups: { itemGroup: string; openingSen: number; purchaseSen: number; closingSen: number; consumedSen: number }[];
  wipOpenSen: number;
  wipCloseSen: number;
  fgOpenSen: number;
  fgCloseSen: number;
  warnings: {
    negatives: { rmId: string; itemCode: string; units: number }[];
    unresolved: { source: string; code: string }[];
  };
};

// Last calendar day of a YYYY-MM month, as YYYY-MM-DD (UTC-safe via day 0 of
// next month). Used to turn the inclusive period-end month into an ISO date.
function monthEndIso(ym: string): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of month m+1 = last day of month m
  return d.toISOString().slice(0, 10);
}

// The YYYY-MM month immediately before `ym`.
function prevMonthYm(ym: string): string {
  let [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  m -= 1; if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Inclusive list of YYYY-MM from startYm to endYm. Empty when startYm > endYm.
// Guarded at 1200 months (100y) so a bad cutover can never spin forever.
function monthsBetweenYm(startYm: string, endYm: string): string[] {
  const out: string[] = [];
  let [y, m] = startYm.split("-").map((n) => parseInt(n, 10));
  const [ey, em] = endYm.split("-").map((n) => parseInt(n, 10));
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 1200) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1; if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

// Precomputed material-cost data for a whole request: built ONCE by
// loadMaterialCostData (one replay per item), then any P&L window is derived
// synchronously by materialWindow via checkpoint subtraction. groupCum holds,
// per item-group, a cumulative checkpoint at every month-end in
// [globalFirstYm..lastYm]; wipByYm/fgByYm hold the WIP/FG stock value as of each
// month-end. Lookups for a ym outside the range fall back to zero.
type MaterialCostData = {
  globalFirstYm: string;
  lastYm: string;
  groups: string[];
  groupCum: Map<string, Map<string, CheckpointCum>>;
  // PI-driven purchase (owner rule 2026-06-30): cumulative supplier-invoice
  // purchase per group per ym (by PI invoice date, post-cutover). materialWindow
  // uses this for the trading-account PURCHASE line INSTEAD of GRN receipts;
  // OPENING/CLOSING stay GRN/FIFO and CONSUMED re-balances. See materialWindow.
  piPurchaseCum: Map<string, Map<string, number>>;
  // Month-end stock-take (owner periodic option): group → ym → closing value sen.
  // materialWindow uses it as the period closing (override FIFO) where present.
  stockTakeByGroupYm: Map<string, Map<string, number>>;
  // Periodic-inventory mode (owner rule 2026-07-03 v3, kv `rm_valuation_mode`):
  // 'stock_take_only' → a month-end RM value is EXACTLY what the owner imported
  // for that month, 0 when nothing imported (the opening seed counts as the
  // cutover month's import). No system-computed carry or consumption — every
  // nonzero stock figure is verifiably the owner's own number. 'auto' →
  // FIFO/BOM behaviour unchanged.
  rmValuationMode: "auto" | "stock_take_only";
  // Same rule for FINISHED GOODS (owner 2026-08-31 「让他别自动capture」, kv
  // `fg_valuation_mode`): 'stock_take_only' → the FG month-end value is only
  // what the owner keyed (stock_take pseudo-group "FG"; the 30/04 opening seed
  // counts as its month's number), 0 otherwise — the ~1,600-batch automatic
  // valuation stops feeding the statements. 'auto' → batch computation as
  // before. WIP is untouched either way.
  fgValuationMode: "auto" | "stock_take_only";
  fgSeedSen: number;
  fgSeedYm: string | null;
  // Opening seed value per group (material_opening_stock, qty × unitCost) and
  // the month it belongs to (the cutover month) — the one "import" that exists
  // before any stock_take rows.
  seedByGroup: Map<string, number>;
  seedYm: string | null;
  wipByYm: Map<string, number>;
  fgByYm: Map<string, number>;
  warnings: {
    negatives: { rmId: string; itemCode: string; units: number }[];
    unresolved: { source: string; code: string }[];
  };
};

async function loadMaterialCostData(
  db: Env["Variables"]["DB"],
  orgId: string,
  lastYm: string,
): Promise<MaterialCostData> {
  // Replay every movement ONCE up to the last month any window needs, sampling
  // monthly checkpoints. matEndIso = end of lastYm; events after it can't affect
  // any window ending <= lastYm, so they're dropped while assembling.
  const matEndIso = monthEndIso(lastYm);
  // 0. Ensure the opening-stock tables exist (deploys don't run migrations).
  await ensureMaterialOpeningStock(db);
  await ensureInventoryOpening(db);
  await ensureStockTake(db);

  // 0a. Cutover day: global kv `material_opening_date`, else the earliest
  //     as_of_date on file. Only GRN/issue movements strictly AFTER the cutover
  //     are replayed — everything up to cutover is captured by the opening seed
  //     layer (so we never double-count the day the books were switched).
  const [openRes, kvRes] = await Promise.all([
    db
      .prepare(
        `SELECT rmId AS rmId, qty AS qty, unitCostSen AS unitCostSen, asOfDate AS asOfDate
           FROM material_opening_stock WHERE orgId = ?`,
      )
      .bind(orgId)
      .all<{ rmId: string; qty: number | null; unitCostSen: number | null; asOfDate: string | null }>(),
    db
      .prepare("SELECT value FROM kv_config WHERE key = 'material_opening_date'")
      .first<{ value: string | null }>()
      .catch(() => null),
  ]);
  const openingRows = openRes.results ?? [];
  let cutoverIso = (kvRes?.value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverIso)) {
    // Fall back to the earliest opening as_of_date; if there are none either,
    // use a sentinel far in the past so every movement is replayed.
    cutoverIso = "";
    for (const r of openingRows) {
      const d = (r.asOfDate ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (cutoverIso === "" || d < cutoverIso)) cutoverIso = d;
    }
    if (cutoverIso === "") cutoverIso = "0000-01-01";
  }

  // 1. Reference maps: rmId → itemGroup, material_code → rmId, rmId → itemCode.
  const rmRes = await db
    .prepare("SELECT id, itemCode, itemGroup FROM raw_materials WHERE orgId = ?")
    .bind(orgId)
    .all<{ id: string; itemCode: string | null; itemGroup: string | null }>();
  const groupOf = new Map<string, string>();
  const codeOf = new Map<string, string>();
  const rmIdByCode = new Map<string, string>();
  for (const r of rmRes.results ?? []) {
    groupOf.set(r.id, (r.itemGroup || "OTHER").trim() || "OTHER");
    codeOf.set(r.id, r.itemCode ?? r.id);
    if (r.itemCode) rmIdByCode.set(r.itemCode, r.id);
  }
  const unresolved: { source: string; code: string }[] = [];
  const seenUnresolved = new Set<string>();
  const flagUnresolved = (source: string, code: string) => {
    const key = `${source}\u0000${code}`;
    if (seenUnresolved.has(key)) return;
    seenUnresolved.add(key);
    unresolved.push({ source, code });
  };

  // 2-4. Source movements: GRN receipts, approved PI lines (for layer cost),
  //      and the cost_ledger RM_ISSUE / ADJUSTMENT rows. Loaded in parallel.
  //      (cost_ledger is read whole — same pattern as stockSummaryRange — and
  //      filtered in JS; LABOR / FG rows are reused for WIP / FG below.)
  const [grnRes, piRes, clRes, poRes, fgbRes, fguRes] = await Promise.all([
    db
      .prepare(
        `SELECT g.poId AS poId, g.receiveDate AS receiveDate, g.status AS status,
                gi.materialCode AS materialCode, gi.acceptedQty AS acceptedQty, gi.unitPrice AS unitPrice,
                po.status AS poStatus
           FROM grn_items gi
           JOIN grns g ON g.id = gi.grnId
           LEFT JOIN purchase_orders po ON po.id = g.poId
          WHERE g.orgId = ? AND g.status IN ('CONFIRMED','POSTED')`,
      )
      .bind(orgId)
      .all<{ poId: string | null; receiveDate: string | null; status: string; materialCode: string | null; acceptedQty: number | null; unitPrice: number | null; poStatus: string | null }>(),
    db
      .prepare(
        `SELECT pi.purchaseOrderId AS poId, pii.materialCode AS materialCode,
                pii.qty AS qty, pii.lineTotalSen AS lineTotalSen
           FROM purchase_invoice_items pii
           JOIN purchase_invoices pi ON pi.id = pii.piId
          WHERE pi.orgId = ? AND pi.status IN ('CONFIRMED','APPROVED') AND pii.lineType = 'STOCKED'
            AND pii.materialCode IS NOT NULL AND pi.purchaseOrderId IS NOT NULL`,
      )
      .bind(orgId)
      .all<{ poId: string | null; materialCode: string | null; qty: number | null; lineTotalSen: number | null }>(),
    db
      .prepare(
        // Only the movement types the engine reads (RM in/out + labour for WIP).
        // Cuts the scan from the whole ledger to the few thousand rows we use.
        `SELECT type, itemId, direction, qty, unitCostSen, totalCostSen, refId, date
           FROM cost_ledger
          WHERE orgId = ? AND type IN ('RM_ISSUE','ADJUSTMENT','LABOR_POSTED')`,
      )
      .bind(orgId)
      .all<{ type: string; itemId: string; direction: string; qty: number | null; unitCostSen: number | null; totalCostSen: number | null; refId: string | null; date: string | null }>(),
    db
      .prepare("SELECT id, startDate, completedDate, status FROM production_orders WHERE orgId = ?")
      .bind(orgId)
      .all<{ id: string; startDate: string | null; completedDate: string | null; status: string | null }>(),
    db
      .prepare("SELECT id, productionOrderId, completedDate, originalQty, unitCostSen FROM fg_batches WHERE orgId = ?")
      .bind(orgId)
      .all<{ id: string; productionOrderId: string | null; completedDate: string | null; originalQty: number | null; unitCostSen: number | null }>(),
    // FG relief signal: cost_ledger FG_DELIVERED rows. consumeFGBatchesForDO
    // (do-cost-cascade.ts) emits one row per layer-slice on every DO→DELIVERED
    // with (date, qty, batchId), where qty is the SAME quantity decremented
    // from fg_batches.remainingQty — i.e. the SAME unit as fg_batches.originalQty
    // (which is piece-level when a product has >1 piece). This replaces the old
    // `fg_units.batchId` count, which was always 0 because fg_units.batchId is
    // never written (fg-units.ts INSERT omits it) → FG closing accumulated
    // without bound. Keyed by batchId = fg_batches.id (real, non-null here).
    db
      .prepare(
        "SELECT batchId, date, qty FROM cost_ledger WHERE orgId = ? AND type = 'FG_DELIVERED' AND batchId IS NOT NULL",
      )
      .bind(orgId)
      .all<{ batchId: string | null; date: string | null; qty: number | null }>(),
  ]);

  // 3. PI-weighted-average layer cost, batched into one map keyed PO+material.
  //    round(Σ line_total_sen / Σ qty) over all APPROVED-PI STOCKED lines for
  //    that (purchase_order_id, material_code). Used as the GRN receipt's unit
  //    cost when present; otherwise the GRN line's own unit_price (already sen).
  const piAgg = new Map<string, { totalSen: number; qty: number }>();
  for (const r of piRes.results ?? []) {
    if (!r.poId || !r.materialCode) continue;
    const key = `${r.poId}\u0000${r.materialCode}`;
    const a = piAgg.get(key) ?? { totalSen: 0, qty: 0 };
    a.totalSen += Number(r.lineTotalSen) || 0;
    a.qty += Number(r.qty) || 0;
    piAgg.set(key, a);
  }
  const piUnitCostSen = new Map<string, number>();
  for (const [key, a] of piAgg) {
    if (a.qty > 0) piUnitCostSen.set(key, Math.round(a.totalSen / a.qty));
  }

  // 5. Assemble one MaterialInput per raw material: opening seed + receipt
  //    events (GRN, post-cutover) + issue/adjustment events (cost_ledger,
  //    post-cutover, up to endIso). Same-day ordering: receipts BEFORE issues
  //    (T4 contract) so an issue can draw from goods received the same day.
  const eventsByRm = new Map<string, FifoEvent[]>();
  const pushEvent = (rmId: string, ev: FifoEvent) => {
    let arr = eventsByRm.get(rmId);
    if (!arr) { arr = []; eventsByRm.set(rmId, arr); }
    arr.push(ev);
  };

  // 5a. GRN receipts (exclude lines whose PO is CANCELLED).
  for (const r of grnRes.results ?? []) {
    const date = (r.receiveDate ?? "").slice(0, 10);
    if (!date || date <= cutoverIso || date > matEndIso) continue;
    if (r.poStatus === "CANCELLED") continue;
    const code = r.materialCode ?? "";
    const rmId = code ? rmIdByCode.get(code) : undefined;
    if (!rmId) { if (code) flagUnresolved("grn_items", code); continue; }
    const qty = Number(r.acceptedQty) || 0;
    if (qty <= 0) continue;
    const key = r.poId ? `${r.poId}\u0000${code}` : "";
    const unitCostSen = (key && piUnitCostSen.has(key)) ? (piUnitCostSen.get(key) as number) : (Number(r.unitPrice) || 0);
    pushEvent(rmId, { kind: "receipt", date, qty, unitCostSen });
  }

  // 5b. cost_ledger RM movements (RM_ISSUE / ADJUSTMENT), post-cutover.
  for (const l of clRes.results ?? []) {
    if (l.type !== "RM_ISSUE" && l.type !== "ADJUSTMENT") continue;
    const date = (l.date ?? "").slice(0, 10);
    if (!date || date <= cutoverIso || date > matEndIso) continue;
    const rmId = l.itemId;
    if (!groupOf.has(rmId)) { flagUnresolved("cost_ledger", rmId); continue; }
    const qty = Number(l.qty) || 0;
    if (l.type === "RM_ISSUE") {
      pushEvent(rmId, { kind: "issue", date, qty, ref: l.refId ?? undefined });
    } else {
      // ADJUSTMENT: IN → receipt (valued at its unit_cost_sen), OUT → issue.
      if (l.direction === "IN") pushEvent(rmId, { kind: "receipt", date, qty, unitCostSen: Number(l.unitCostSen) || 0 });
      else pushEvent(rmId, { kind: "issue", date, qty, ref: l.refId ?? undefined });
    }
  }

  // 5c. PI-only receipts (owner rule 2026-06-30; see docs/superpowers/specs/
  //     2026-06-30-pi-driven-stock-in-closing-design.md). A PI STOCKED line NOT
  //     linked to a GRN (grn_item_id IS NULL) brought goods into stock directly →
  //     it IS a receipt. A converted PI carries grn_item_id → its GRN receipt (5a)
  //     already counts → skip it here (read-only dedup: no qty math, no writes).
  //     Separately, EVERY PI STOCKED line feeds the purchase total (= whole purchase
  //     ledger), cumulated after the replay into piPurchaseCum.
  const piPurchaseByGroupYm = new Map<string, Map<string, number>>();
  const piRowsRes = await db
    .prepare(
      `SELECT pi.invoiceDate AS invoiceDate, pii.materialCode AS materialCode,
              pii.qty AS qty, pii.lineTotalSen AS lineTotalSen, pii.grn_item_id
         FROM purchase_invoice_items pii
         JOIN purchase_invoices pi ON pi.id = pii.piId
        WHERE pi.orgId = ? AND pi.status NOT IN ('DRAFT','CANCELLED') AND pii.lineType = 'STOCKED'
          AND pii.materialCode IS NOT NULL`,
    )
    .bind(orgId)
    .all<{ invoiceDate: string | null; materialCode: string | null; qty: number | null; lineTotalSen: number | null; grnItemId?: string | null; grn_item_id?: string | null }>();
  for (const r of piRowsRes.results ?? []) {
    const date = (r.invoiceDate ?? "").slice(0, 10);
    if (!date || date <= cutoverIso || date > matEndIso) continue;
    const code = r.materialCode ?? "";
    const rmId = code ? rmIdByCode.get(code) : undefined;
    const g = rmId ? groupOf.get(rmId) : undefined;
    if (!rmId || !g) { if (code) flagUnresolved("pi_items", code); continue; }
    const ym = date.slice(0, 7);
    const lineSen = Math.round(Number(r.lineTotalSen) || 0);
    // purchase = ALL PI STOCKED lines.
    let m = piPurchaseByGroupYm.get(g);
    if (!m) { m = new Map(); piPurchaseByGroupYm.set(g, m); }
    m.set(ym, (m.get(ym) ?? 0) + lineSen);
    // stock-in receipt ONLY for PI-only lines (grn_item_id NULL → no GRN to dedup).
    const grnRaw = r.grnItemId ?? r.grn_item_id ?? null;
    const grnLink = grnRaw == null || String(grnRaw).trim() === "" ? null : String(grnRaw).trim();
    const qty = Number(r.qty) || 0;
    if (!grnLink && qty > 0) {
      // A rate, derived by division: 3300 sen / 600 pcs is 5.5 sen, and
      // Math.round made it 6 — valuing the receipt at RM 36 against a
      // supplier invoice of RM 33.
      pushEvent(rmId, {
        kind: "receipt",
        date,
        qty,
        unitCostSen: roundUnitPriceSen(lineSen / qty),
      });
    }
  }

  // 6. Earliest month to checkpoint from: the first real movement (or the
  //    cutover seed if it has a real date). Bounded below at year 2000 so a
  //    "0000-01-01" sentinel (opening with no as-of date) can't explode the range.
  let minIso = matEndIso;
  for (const arr of eventsByRm.values()) for (const e of arr) if (e.date && e.date < minIso) minIso = e.date;
  if (cutoverIso >= "2000-01-01" && cutoverIso < minIso) minIso = cutoverIso;
  const globalFirstYm = minIso.slice(0, 7);
  const monthsYm = monthsBetweenYm(globalFirstYm, lastYm); // [] when first > last
  const monthEnds = monthsYm.map(monthEndIso);

  // Replay each item ONCE and sum its monthly checkpoints into its item-group.
  // No per-window re-replay — that repetition was the prod P&L hang. (Per-PO
  // material cost for WIP comes from cost_ledger RM_ISSUE totals below, NOT this
  // replay — see materialAsOf / BUG-2026-06-29-001.)
  const rank = (e: FifoEvent) => (e.kind === "receipt" ? 0 : 1);
  const groupCum = new Map<string, Map<string, CheckpointCum>>(); // group → ym → cumulative
  const allGroups = new Set<string>();
  const negatives: { rmId: string; itemCode: string; units: number }[] = [];
  const openByRm = new Map<string, { rmId: string; qty: number | null; unitCostSen: number | null; asOfDate: string | null }>();
  for (const r of openingRows) openByRm.set(r.rmId, r);
  const allRmIds = new Set<string>([...eventsByRm.keys()]);
  for (const r of openingRows) if (groupOf.has(r.rmId)) allRmIds.add(r.rmId);

  for (const rmId of allRmIds) {
    const itemGroup = groupOf.get(rmId) ?? "OTHER";
    allGroups.add(itemGroup);
    const open = openByRm.get(rmId);
    const events = (eventsByRm.get(rmId) ?? [])
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : rank(a) - rank(b)));
    const m: MaterialInput = {
      rmId,
      itemGroup,
      opening: open && (Number(open.qty) || 0) !== 0
        ? { qty: Number(open.qty) || 0, unitCostSen: Number(open.unitCostSen) || 0 }
        : null,
      // One GLOBAL cutover day for every material: the seed layer is dated at
      // cutoverIso and every replayed event is filtered date > cutoverIso, so
      // the seed and the events never overlap regardless of a row's own
      // as_of_date (which only feeds the global-cutover derivation above).
      openingDate: cutoverIso,
      events,
    };
    // Monthly cumulative checkpoints, summed into this item's group (additive).
    const cps = computeMaterialCheckpoints(m, monthEnds);
    let gm = groupCum.get(itemGroup);
    if (!gm) { gm = new Map(); groupCum.set(itemGroup, gm); }
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      const ym = monthsYm[i];
      let acc = gm.get(ym);
      if (!acc) { acc = { closingSen: 0, cumPurchaseSen: 0, cumConsumedSen: 0, cumNegativeUnits: 0 }; gm.set(ym, acc); }
      acc.closingSen += cp.closingSen;
      acc.cumPurchaseSen += cp.cumPurchaseSen;
      acc.cumConsumedSen += cp.cumConsumedSen;
      acc.cumNegativeUnits += cp.cumNegativeUnits;
    }
    // Whole-range negative-stock flag (fractional qty → rounded; diagnostic only).
    const lastCp = cps.length ? cps[cps.length - 1] : null;
    const negUnits = lastCp ? lastCp.cumNegativeUnits : 0;
    if (negUnits > 1e-9) negatives.push({ rmId, itemCode: codeOf.get(rmId) ?? rmId, units: Math.round(negUnits * 1000) / 1000 });
  }

  // 6a. Per-PO material cost as of a date D = Σ RM_ISSUE.total_cost_sen for that
  //     PO with date <= D — the material ACTUALLY booked to the PO. ATTRIBUTION
  //     (locked by cost-attribution.test): for RM_ISSUE the PO is in `refId`
  //     (itemId is the raw-material id). Built the SAME way as the labour
  //     accessor below, via costAsOfByPo.
  //
  //     NOT re-valued from the FIFO replay (the old `fifoMaterialAsOf` = Σ of the
  //     replay's per-issue costs for the PO): that re-valuation came out ~15× too
  //     high on live prod (WIP-CLOSING RM 267,721 vs the owner's real ~RM 10k)
  //     because the replay's per-layer issue costs for a PO did NOT reconcile to
  //     Σ RM_ISSUE.total_cost_sen booked to that PO. The same defect inflated FG
  //     (worked around there by valuing FG at fg_batches.unit_cost_sen, which is
  //     floor((ΣRM_ISSUE+ΣLABOR)/originalQty) — i.e. this same RM_ISSUE total).
  //     WIP has no per-batch unit cost to fall back to, so the material basis is
  //     fixed at source here. See BUG-2026-06-29-001.
  const materialAsOf = costAsOfByPo(clRes.results ?? [], "RM_ISSUE");

  // 6b. Per-PO labour cost as of a date D = Σ LABOR_POSTED.total_cost_sen for
  //     that PO with date <= D. ATTRIBUTION (locked by cost-attribution.test):
  //     for LABOR_POSTED the PO is in `itemId` — postJobCardLabor
  //     (po-cost-cascade.ts) writes itemId=productionOrderId, refType='JOB_CARD',
  //     refId=jobCardId. (RM_ISSUE is the opposite: refId=PO.) The previous code
  //     bucketed by refId (the JOB CARD id) but looked up by poId, so every
  //     lookup missed and labour was silently 0 in WIP & FG.
  const laborAsOf = costAsOfByPo(clRes.results ?? [], "LABOR_POSTED");

  // 7. WIP as of D = Σ over production_orders in progress at D of
  //    (material issued so far + labour posted so far) — both the ACTUAL booked
  //    cost_ledger totals (Σ RM_ISSUE.total_cost_sen + Σ LABOR_POSTED.total_cost_sen
  //    ≤ D for that PO), matching what the cascade rolls into fg_batches.unit_cost_sen.
  const pos = poRes.results ?? [];
  const wipAsOf = (dIso: string): number => {
    let s = 0;
    for (const p of pos) {
      const start = (p.startDate ?? "").slice(0, 10);
      const completed = (p.completedDate ?? "").slice(0, 10);
      if (!start || start > dIso) continue;            // not started yet
      if (completed && completed <= dIso) continue;    // already completed by D
      s += materialAsOf(p.id, dIso) + laborAsOf(p.id, dIso);
    }
    return s;
  };

  // 8. FG as of D = Σ over batches completed by D, of undelivered qty ×
  //    fg_batches.unit_cost_sen (the cascade-maintained per-unit cost).
  //    Undelivered qty = original_qty − Σ FG_DELIVERED.qty for this batch (date<=D).
  //
  //    NOT re-valued from the FIFO engine: a (PO FIFO material + labour)/qty
  //    re-valuation came out ~15× too high on live prod (FG closing RM 595k vs
  //    the real RM 39k) because the replay's per-layer issue costs for a PO did
  //    not reconcile to the material booked to that PO. unit_cost_sen is the
  //    figure backfillFGBatchCost rolls up from the same RM_ISSUE+LABOR rows and
  //    is what every other FG surface uses — sane and authoritative.
  //
  //    Relief signal = cost_ledger FG_DELIVERED rows (fguRes), summed per batch
  //    up to D. This is the only as-of-date, qty-correct, real-batchId signal:
  //    its qty is the exact quantity decremented from fg_batches.remainingQty,
  //    so it is in the SAME unit as originalQty by construction. (The old
  //    fg_units.batchId count was always 0 — batchId is never written — so FG
  //    closing accumulated without bound. A raw COUNT(fg_units) would also be
  //    wrong: fg_units is piece-level (units×pieces rows per PO).)
  const deliveredAsOf = buildDeliveredAsOf(fguRes.results ?? []);
  const batches = fgbRes.results ?? [];
  // Opening-date floor: finished-goods batches completed BEFORE the accounting
  // opening date are pre-opening stock (represented by the seeded opening
  // inventory), NOT the system's batch-by-batch computation. Without this floor
  // every historical batch ever completed accumulates into FG closing — the
  // ~RM 1.35M legacy over-statement the owner reported. (Relief by FG_DELIVERED
  // only clears batches that were delivered via a DO; pre-opening / pre-cascade
  // legacy batches have no FG_DELIVERED rows and would otherwise pile up.)
  const fgOpeningIso = await getOpeningDate(db);
  // fgClosingSen values each batch's undelivered qty at its stored
  // fg_batches.unit_cost_sen (cascade-maintained), clamps relief at 0, and floors
  // out pre-opening batches.
  const fgAsOf = (dIso: string): number =>
    fgClosingSen({
      batches,
      asOfIso: dIso,
      deliveredAsOf,
      openingIso: fgOpeningIso,
    });

  // Precompute WIP/FG stock value as of EACH month-end so a window's open/close
  // are O(1) lookups (open of a window = value at the end of the prior month).
  const wipByYm = new Map<string, number>();
  const fgByYm = new Map<string, number>();
  for (let i = 0; i < monthsYm.length; i++) {
    wipByYm.set(monthsYm[i], wipAsOf(monthEnds[i]));
    fgByYm.set(monthsYm[i], fgAsOf(monthEnds[i]));
  }

  // Task 2.2 — inject the owner's pre-opening WIP/FG stock seed (30/04 stock-
  // take) at the cutover month-end so it surfaces as the FIRST system month's
  // OPENING and is absorbed into that month's COGS. value_sen / as_of_date come
  // back camelCased from the PG adapter → buildInventoryOpeningSeed reads them
  // dual-keyed. See src/lib/inventory-opening.ts + design §3b.
  const invSeed = buildInventoryOpeningSeed(
    (
      await db
        .prepare("SELECT layer, value_sen, as_of_date FROM inventory_opening WHERE org_id = ?")
        .bind(orgId)
        .all<InventoryOpeningRow>()
    ).results ?? [],
  );
  applyOpeningSeed(wipByYm, invSeed.wipSen, invSeed.asOfDate);
  applyOpeningSeed(fgByYm, invSeed.fgSen, invSeed.asOfDate);

  // --- PI purchase → cumulative-by-ym (owner rule 2026-06-30) --------------------
  // piPurchaseByGroupYm (per-group per-ym PI purchase) AND the PI-only receipt
  // events were built in step 5c, before the replay. Here: ensure any group seen
  // ONLY via PIs (e.g. all-converted, no GRN/issue/opening) still gets a row, then
  // cumulate by ym so materialWindow can take cum(end)−cum(prev) like the
  // checkpoints. Purchase = whole purchase ledger; OPENING/CLOSING stay GRN/FIFO;
  // CONSUMED re-balances (opening+purchase−closing).
  for (const g of piPurchaseByGroupYm.keys()) allGroups.add(g);
  // Cumulative-by-ym across the same monthsYm axis the checkpoints use, so every
  // ym (even PI-less months) carries the running total → cum(end)−cum(prev) works.
  const piPurchaseCum = new Map<string, Map<string, number>>();
  for (const [g, perYm] of piPurchaseByGroupYm) {
    const cum = new Map<string, number>();
    let run = 0;
    for (const ym of monthsYm) { run += perYm.get(ym) ?? 0; cum.set(ym, run); }
    piPurchaseCum.set(g, cum);
  }

  // Periodic-inventory mode + per-group opening seed (owner rule 2026-07-03).
  const modeRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = 'rm_valuation_mode'")
    .first<{ value: string | null }>()
    .catch(() => null);
  const rmValuationMode: "auto" | "stock_take_only" =
    (modeRow?.value ?? "").trim() === "stock_take_only" ? "stock_take_only" : "auto";
  const fgModeRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = 'fg_valuation_mode'")
    .first<{ value: string | null }>()
    .catch(() => null);
  const fgValuationMode: "auto" | "stock_take_only" =
    (fgModeRow?.value ?? "").trim() === "stock_take_only" ? "stock_take_only" : "auto";
  const seedByGroup = new Map<string, number>();
  for (const r of openingRows) {
    const g = groupOf.get(r.rmId) ?? "OTHER";
    const v = Math.round((Number(r.qty) || 0) * (Number(r.unitCostSen) || 0));
    if (v) seedByGroup.set(g, (seedByGroup.get(g) ?? 0) + v);
  }
  for (const g of seedByGroup.keys()) allGroups.add(g);
  const seedYm = cutoverIso >= "2000-01-01" ? cutoverIso.slice(0, 7) : null;

  // Month-end stock-take (owner periodic-inventory option): group → ym → closing
  // value sen. materialWindow uses it as the period closing (and the prior month
  // as opening) INSTEAD of the FIFO value, where present. Read-only override.
  const stockTakeByGroupYm = new Map<string, Map<string, number>>();
  {
    const stRes = await db
      .prepare("SELECT item_group, ym, value_sen FROM stock_take WHERE org_id = ?")
      .bind(orgId)
      .all<{ item_group?: string | null; itemGroup?: string | null; ym: string | null; value_sen?: number | null; valueSen?: number | null }>();
    for (const r of stRes.results ?? []) {
      const g = String(r.itemGroup ?? r.item_group ?? "").trim();
      const ym = String(r.ym ?? "").slice(0, 7);
      if (!g || !/^\d{4}-\d{2}$/.test(ym)) continue;
      const sen = Math.round(Number(r.valueSen ?? r.value_sen) || 0);
      let m = stockTakeByGroupYm.get(g);
      if (!m) { m = new Map(); stockTakeByGroupYm.set(g, m); }
      m.set(ym, sen);
      // "WIP" / "FG" are pseudo-groups (see materialWindow) — NOT real material
      // groups, so they must never surface as an extra RAW MATERIALS row.
      if (g !== "WIP" && g !== "FG") allGroups.add(g);
    }
  }

  return {
    globalFirstYm,
    lastYm,
    groups: [...allGroups],
    groupCum,
    piPurchaseCum,
    stockTakeByGroupYm,
    rmValuationMode,
    fgValuationMode,
    fgSeedSen: invSeed.fgSen,
    fgSeedYm: invSeed.asOfDate ? invSeed.asOfDate.slice(0, 7) : null,
    seedByGroup,
    seedYm,
    wipByYm,
    fgByYm,
    warnings: { negatives, unresolved },
  };
}

// Derive one P&L window (the old per-window loadMaterialCost shape) from the
// precomputed data — pure arithmetic, no replay. opening = closing at the end of
// the month BEFORE startYm; purchase/consumed = cumulative(end) − cumulative(prev);
// closing = closing at endYm. WIP/FG open/close are month-end snapshots. A null
// startYm means "since the beginning" → opening 0.
function materialWindow(data: MaterialCostData, startYm: string | null, endYm: string | null): LoadMaterialCostResult {
  const ZERO: CheckpointCum = { closingSen: 0, cumPurchaseSen: 0, cumConsumedSen: 0, cumNegativeUnits: 0 };
  const endKey = endYm ?? data.lastYm;
  const prevKey = startYm ? prevMonthYm(startYm) : null;
  // Periodic-inventory mode (owner rule 2026-07-03 v3: 「我没上传就 0 就好」):
  // a month-end RM value is EXACTLY the owner's import for that month — 0 when
  // nothing was imported (the opening seed counts as the cutover month's
  // import). No carry, no computed consumption: every nonzero stock figure on
  // the statement is verifiably the owner's own number.
  const noAuto = data.rmValuationMode === "stock_take_only";
  const importedVal = (g: string, ym: string | null): number => {
    if (!ym) return 0;
    const st = data.stockTakeByGroupYm.get(g);
    if (st?.has(ym)) return st.get(ym) as number;
    if (data.seedYm && ym === data.seedYm) return data.seedByGroup.get(g) ?? 0;
    return 0;
  };
  const rmGroups = data.groups.map((g) => {
    const gm = data.groupCum.get(g);
    const end = gm?.get(endKey) ?? ZERO;
    const prev = prevKey ? (gm?.get(prevKey) ?? ZERO) : null;
    const w = windowFromCheckpoints(end, prev);
    // Owner rule (2026-06-30): the trading-account PURCHASE line comes from the
    // purchase ledger (PI), NOT the GRN receipts (w.purchaseSen). OPENING and
    // CLOSING stay GRN/FIFO (the perpetual stock valuation — unchanged), and
    // CONSUMED re-balances to opening+purchase−closing so the section still ties.
    // When a period's PI ≠ its GRN receipts (e.g. invoiced-not-yet-received), the
    // gap lands in CONSUMED by design (see loadMaterialCostData / BUG-HISTORY).
    const piCum = data.piPurchaseCum.get(g);
    const piEnd = piCum?.get(endKey) ?? 0;
    const piPrev = prevKey ? (piCum?.get(prevKey) ?? 0) : 0;
    const purchaseSen = piEnd - piPrev;
    // Month-end stock-take override (owner periodic option, 2026-06-30): a manually
    // entered count at a month-end becomes the period CLOSING (and the prior month's
    // the OPENING) instead of the FIFO value, for groups that have one. Groups with
    // no stock-take keep the FIFO/BOM closing exactly as before. CONSUMED rebalances.
    const st = data.stockTakeByGroupYm.get(g);
    const openingSen = noAuto
      ? importedVal(g, prevKey)
      : (prevKey && st?.has(prevKey)) ? (st.get(prevKey) as number) : w.openingSen;
    const closingSen = noAuto
      ? importedVal(g, endKey)
      : st?.has(endKey) ? (st.get(endKey) as number) : w.closingSen;
    const consumedSen = openingSen + purchaseSen - closingSen;
    return { itemGroup: g, openingSen, purchaseSen, closingSen, consumedSen };
  });
  const wipCloseSenAuto = data.wipByYm.get(endKey) ?? 0;
  const wipOpenSenAuto = prevKey ? (data.wipByYm.get(prevKey) ?? 0) : 0;
  const fgCloseSenAuto = data.fgByYm.get(endKey) ?? 0;
  const fgOpenSenAuto = prevKey ? (data.fgByYm.get(prevKey) ?? 0) : 0;
  // WIP/FG month-end stock-take override (owner rule 2026-07-01): same mechanism as
  // the material groups above, keyed by the pseudo-group "WIP" / "FG" in the SAME
  // stock_take table. Blank/0 (no row — see PUT /stock-take) keeps the automatic
  // (consumption-based) figure; a positive entry overrides it for that month-end.
  const wipSt = data.stockTakeByGroupYm.get("WIP");
  const wipOpenSen = (prevKey && wipSt?.has(prevKey)) ? (wipSt.get(prevKey) as number) : wipOpenSenAuto;
  const wipCloseSen = wipSt?.has(endKey) ? (wipSt.get(endKey) as number) : wipCloseSenAuto;
  const fgSt = data.stockTakeByGroupYm.get("FG");
  // FG periodic mode (owner 2026-08-31 「让他别自动capture」, same v3 rule as
  // RM): the month-end FG value is exactly the owner's keyed number for that
  // month (stock_take pseudo-group "FG"; the opening seed counts as its own
  // month's number), 0 otherwise. 'auto' keeps the per-batch computation.
  const noAutoFg = data.fgValuationMode === "stock_take_only";
  const fgImported = (ym: string | null): number => {
    if (!ym) return 0;
    if (fgSt?.has(ym)) return fgSt.get(ym) as number;
    if (data.fgSeedYm && ym === data.fgSeedYm) return data.fgSeedSen;
    return 0;
  };
  const fgOpenSen = noAutoFg
    ? fgImported(prevKey)
    : (prevKey && fgSt?.has(prevKey)) ? (fgSt.get(prevKey) as number) : fgOpenSenAuto;
  const fgCloseSen = noAutoFg
    ? fgImported(endKey)
    : fgSt?.has(endKey) ? (fgSt.get(endKey) as number) : fgCloseSenAuto;
  return { rmGroups, wipOpenSen, wipCloseSen, fgOpenSen, fgCloseSen, warnings: data.warnings };
}

type PnlWindow = Awaited<ReturnType<typeof computePnlWindow>>;

// ---------------------------------------------------------------------------
// Task 3.1 — pnl_historical table + reader
// Stores owner-provided PnlWindow JSON for months BEFORE the accounting
// opening date. Runtime self-apply pattern mirrors ensureMaterialOpeningStock.
// Pure helpers (selectHistoricalWindow, sumPnlWindows) live in
// src/lib/pnl-historical.ts so they can be tested without Worker deps.
// ---------------------------------------------------------------------------

let _pendingPnlHistMigrations: Promise<void> | null = null;
function ensurePnlHistorical(db: D1Database): Promise<void> {
  if (_pendingPnlHistMigrations) return _pendingPnlHistMigrations;
  _pendingPnlHistMigrations = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS pnl_historical (
         id          TEXT PRIMARY KEY,
         org_id      TEXT NOT NULL DEFAULT 'hookka',
         ym          TEXT NOT NULL,
         line        TEXT NOT NULL,
         window_json TEXT NOT NULL,
         updated_at  TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pnl_hist_key ON pnl_historical (org_id, ym, line)`,
    ];
    await runSelfApply(db, "accounting", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _pendingPnlHistMigrations = null;
    throw err;
  });
  return _pendingPnlHistMigrations;
}

// Task 2.2 — inventory_opening (WIP/FG opening-stock seed). Runtime self-apply
// mirrors ensurePnlHistorical / ensureMaterialOpeningStock.
let _pendingInventoryOpeningMigrations: Promise<void> | null = null;
function ensureInventoryOpening(db: D1Database): Promise<void> {
  if (_pendingInventoryOpeningMigrations) return _pendingInventoryOpeningMigrations;
  _pendingInventoryOpeningMigrations = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS inventory_opening (
         id         TEXT PRIMARY KEY,
         org_id     TEXT NOT NULL DEFAULT 'hookka',
         layer      TEXT NOT NULL,
         value_sen  INTEGER NOT NULL DEFAULT 0,
         as_of_date TEXT,
         updated_at TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_opening_key ON inventory_opening (org_id, layer)`,
    ];
    await runSelfApply(db, "accounting", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _pendingInventoryOpeningMigrations = null;
    throw err;
  });
  return _pendingInventoryOpeningMigrations;
}

// Month-end stock-take (owner periodic-inventory option, 2026-06-30). Per-group
// closing value the owner enters at each month-end; materialWindow uses it as the
// period CLOSING (and the prior month's as OPENING) INSTEAD of the FIFO value, for
// groups that have one. Coexists with BOM/FIFO — a group with no stock-take keeps
// the FIFO closing exactly as before. Runtime self-apply mirrors ensureInventoryOpening.
let _pendingStockTakeMigrations: Promise<void> | null = null;
function ensureStockTake(db: D1Database): Promise<void> {
  if (_pendingStockTakeMigrations) return _pendingStockTakeMigrations;
  _pendingStockTakeMigrations = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS stock_take (
         id         TEXT PRIMARY KEY,
         org_id     TEXT NOT NULL DEFAULT 'hookka',
         item_group TEXT NOT NULL,
         ym         TEXT NOT NULL,
         value_sen  INTEGER NOT NULL DEFAULT 0,
         updated_at TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_key ON stock_take (org_id, item_group, ym)`,
    ];
    await runSelfApply(db, "accounting", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _pendingStockTakeMigrations = null;
    throw err;
  });
  return _pendingStockTakeMigrations;
}

// Stock-take ITEM alias (owner rule 2026-07-01; design doc
// docs/superpowers/specs/2026-07-01-stock-take-item-alias-import-design.md). The
// owner's monthly raw stock-count file has no category column and its layout
// varies month to month, so grouping comes from each physical line's own
// identity (item_key = normalized identity columns), not a label. item_group is
// nullable: NULL means "deliberately not a stock line" (e.g. a GRAND TOTAL
// trailer row), set via "Ignore this line" so a recurring non-item row is
// skipped silently forever after, instead of re-prompting every month.
let _pendingStockTakeItemAliasMigrations: Promise<void> | null = null;
function ensureStockTakeItemAlias(db: D1Database): Promise<void> {
  if (_pendingStockTakeItemAliasMigrations) return _pendingStockTakeItemAliasMigrations;
  _pendingStockTakeItemAliasMigrations = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS stock_take_item_alias (
         id         TEXT PRIMARY KEY,
         org_id     TEXT NOT NULL DEFAULT 'hookka',
         item_key   TEXT NOT NULL,
         item_group TEXT,
         updated_at TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_take_item_alias_key ON stock_take_item_alias (org_id, item_key)`,
    ];
    await runSelfApply(db, "accounting", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _pendingStockTakeItemAliasMigrations = null;
    throw err;
  });
  return _pendingStockTakeItemAliasMigrations;
}

// Other Party Bill opening support (owner rule 2026-07-01). Mirrors migration
// 0158's is_opening column on invoices/purchase_invoices (same name, same
// floor-bypass semantics via rowBeforeOpening — see opening-floor.ts), but as a
// RUNTIME self-apply (CLAUDE.md: a migration file alone is inert) since
// other_party_bills predates any is_opening support. A bill flagged is_opening
// still posts its OWN balanced GL entry immediately at creation (DR the chosen
// counterAccount, CR 405-0000/305-0000 — see buildBillLegs) exactly like any
// other bill; is_opening ONLY changes whether the aging report floors it out
// for being dated before the opening cutoff. The owner picks a BALANCE-SHEET
// counterAccount (e.g. Retained Earnings) for an opening bill, not a P&L
// expense, so a prior period's expense isn't re-recognised.
let _pendingOtherPartyBillOpeningMigrations: Promise<void> | null = null;
function ensureOtherPartyBillOpening(db: D1Database): Promise<void> {
  if (_pendingOtherPartyBillOpeningMigrations) return _pendingOtherPartyBillOpeningMigrations;
  _pendingOtherPartyBillOpeningMigrations = (async () => {
    const stmts = [
      `ALTER TABLE other_party_bills ADD COLUMN IF NOT EXISTS is_opening INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_other_party_bills_is_opening ON other_party_bills (is_opening) WHERE is_opening = 1`,
    ];
    await runSelfApply(db, "accounting", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _pendingOtherPartyBillOpeningMigrations = null;
    throw err;
  });
  return _pendingOtherPartyBillOpeningMigrations;
}

/** Load all historical P&L rows for an org, grouped by ym. */
async function loadHistoricalPnl(
  db: D1Database,
  orgId: string,
): Promise<Map<string, Partial<Record<"all" | "sofa" | "bedframe", PnlWindow>>>> {
  const [res, coaRes] = await Promise.all([
    db
      .prepare("SELECT ym, line, window_json FROM pnl_historical WHERE org_id = ?")
      .bind(orgId)
      .all<{ ym: string; line: string; windowJson?: string; window_json?: string }>(),
    db
      .prepare("SELECT code, name, type FROM chart_of_accounts")
      .all<{ code: string; name: string; type: string }>(),
  ]);
  // window_json arrives camelCased as `windowJson` via the db-pg adapter's
  // transform.column.from; buildHistoricalMap reads it dual-keyed. Reading
  // row.window_json directly gave undefined → JSON.parse threw → every row
  // skipped → empty map → no injection (prod bug 2026-06-30).
  const map = buildHistoricalMap(res.results ?? []) as Map<
    string,
    Partial<Record<"all" | "sofa" | "bedframe", PnlWindow>>
  >;
  // Canonicalize the owner-keyed identities to the COA at LOAD time (display
  // only — stored rows untouched) so historical months and engine months share
  // one row per item in the Monthly P&L instead of duplicating (owner
  // complaint 2026-07-03). Exact normalized-name matches + explicit spelling
  // aliases only; see src/lib/pnl-hist-remap.ts. The historical rmGroups carry
  // AutoCount stock-group CODES ("B.M-FABR", "MAINTENA"…) — resolve those with
  // the same group→purchase-account map the engine posts with.
  const { DEFAULT_PURCHASE_MAP: histPMap } = await import("./purchase-invoices");
  const histStockMap = await getStockMap(db);
  const histGroupAcct: Record<string, string> = { ...histPMap };
  for (const [g, v] of Object.entries(histStockMap.rm as Record<string, { purchase?: string }>)) {
    if (v?.purchase) histGroupAcct[g] = v.purchase;
  }
  const remap = buildHistIdentityRemap(coaRes.results ?? [], histGroupAcct);
  for (const perLine of map.values()) {
    for (const w of Object.values(perLine)) {
      if (w) remap.remapWindow(w as unknown as Parameters<typeof remap.remapWindow>[0]);
    }
  }
  return map;
}

async function computePnlWindow(
  db: Env["Variables"]["DB"],
  orgId: string,
  startYm: string | null,
  endYm: string | null,
  line: "all" | "sofa" | "bedframe",
  matData: MaterialCostData,
  dc: DocDateCtx,
  override: Record<string, string> = {},
) {
  // RM / WIP / FG come from the FIFO engine via the precomputed per-request
  // checkpoints (materialWindow), replacing the cost_ledger perpetual figures
  // that stockSummaryRange returns (that ledger stopped being fed after 2026-03).
  // All OTHER P&L lines (labour / overhead / carriage / SST / revenue / other
  // income / expenses) still come from the GL window untouched.
  const [gl, ratio] = await Promise.all([
    glWindowSigned(db, orgId, startYm, endYm, dc),
    costByLineWindow(db, startYm, endYm),
  ]);
  // Material window derived synchronously from the single-replay checkpoints.
  const mat = materialWindow(matData, startYm, endYm);
  const isAll = line === "all";
  const R = isAll ? 1 : line === "sofa" ? ratio.salesRatio.sofa : ratio.salesRatio.bedframe;
  // Helpers to read GL sums for an account band/predicate.
  const bandSum = (pred: (code: string, type: CoaRow["type"]) => boolean, sign: 1 | -1) => {
    let s = 0;
    for (const [code, v] of gl.net) {
      const meta = gl.coa.get(code);
      if (!meta) continue;
      if (pred(code, meta.type)) s += sign * v;
    }
    return s;
  };

  // --- Sales (revenue < 530), net (credit-normal so sign −1 on DR−CR) ---
  // Revenue is posted to LINE-SPECIFIC GL accounts (BEDFRAME → 500-0000; SOFA +
  // ACCESSORY → 500-0020 / 500-0030, per SALES_ACCT in invoices.ts), so a
  // product-line P&L filters its SALES section by account — it must NOT pro-rate
  // the whole-company total or the other line's revenue leaks in. Mirrors
  // costByLineWindow's split (BEDFRAME vs everything-else → sofa): bedframe view
  // keeps only the bedframe sales account; sofa view keeps every other revenue
  // account. Revenue is therefore EXACT (not R-scaled); only the shared cost
  // lines below stay apportioned by the sales ratio R.
  const BEDFRAME_SALES_CODE = "500-0000";
  const revOnLine = (code: string): boolean =>
    isAll ? true : line === "bedframe" ? code === BEDFRAME_SALES_CODE : code !== BEDFRAME_SALES_CODE;
  const revLines: { code: string; name: string; amountSen: number }[] = [];
  let otherIncomeSen = 0;
  const otherIncomeLines: { code: string; name: string; amountSen: number }[] = [];
  for (const [code, v] of gl.net) {
    const meta = gl.coa.get(code);
    if (!meta) continue;
    const bucket = pnlBucketFor(code, meta.type, override);
    const amt = -v; // credit-normal (income class)
    if (bucket === "REVENUE") { if (revOnLine(code)) revLines.push({ code, name: meta.name, amountSen: amt }); }
    else if (bucket === "OTHER_INCOME") { otherIncomeSen += amt; otherIncomeLines.push({ code, name: meta.name, amountSen: amt }); }
  }
  // revLines is already filtered to the selected line, so net sales is exact.
  const netSalesSen = revLines.reduce((s, r) => s + r.amountSen, 0);

  // --- Raw materials (rows keyed by PURCHASE ACCOUNT; owner rule 2026-07-03:
  // "采购改读 ledger") ---
  // PURCHASES read the LEDGER — the GL purchase accounts that the PI postings
  // and the opening-slice JV debit — so the P&L purchase figures tie to the
  // TB. OPENING/CLOSING stock stays engine-valued (item-level FIFO; the
  // ledger has no items). Each engine group's stock lands on its mapped
  // purchase account (kv coa_stock_map rm[g].purchase → DEFAULT_PURCHASE_MAP
  // → default), mirroring how the PI posting picked the DR account, so
  // opening + purchase − closing stays a same-account identity.
  const { DEFAULT_PURCHASE_MAP: pnlPMap, DEFAULT_PURCHASE_ACCT: pnlPDefault } =
    await import("./purchase-invoices");
  const pnlStockMap = await getStockMap(db);
  const purchaseAcctOf = (g: string): string => {
    const o = (pnlStockMap.rm as Record<string, { purchase?: string }>)[g];
    return (
      o?.purchase ??
      pnlPMap[g] ??
      (pnlStockMap.rmDefault as { purchase?: string })?.purchase ??
      pnlPDefault
    );
  };
  // A "purchase account" = COST-type account that is not one of the dedicated
  // account-driven lines (carriage 700-1015 / SST 706-0000 / labour 750 /
  // overhead 780) — i.e. the 701~705 purchase band.
  const isPurchaseAcct = (code: string, type: CoaRow["type"]): boolean =>
    type === "COST" &&
    defaultPnlBucket(code, type) === null &&
    code !== "700-1015" &&
    code !== "706-0000";
  const acctRows = new Map<
    string,
    { openingSen: number; purchasesSen: number; closingSen: number; grpLines: Set<string> }
  >();
  const ensureAcctRow = (code: string) => {
    let x = acctRows.get(code);
    if (!x) {
      x = { openingSen: 0, purchasesSen: 0, closingSen: 0, grpLines: new Set() };
      acctRows.set(code, x);
    }
    return x;
  };
  // 1) Stock per group → its purchase account (scaled per group). materialWindow
  //    already applies the valuation mode: under stock_take_only (owner rule
  //    2026-07-03 v3 「我没上传就 0 就好」) a month-end value is exactly the
  //    owner's import for that month — 0 when nothing imported (opening seed =
  //    the cutover month's import) — so every nonzero stock figure on the
  //    statement is verifiably the owner's own number and consumption exists
  //    only where he supplied the counts. auto mode: FIFO/BOM window values.
  for (const r of mat.rmGroups) {
    const sc = rmScale(r.itemGroup, line, R);
    const mapped = purchaseAcctOf(r.itemGroup);
    const mappedMeta = gl.coa.get(mapped);
    // Groups mapped to a NON-purchase account (e.g. R&D → 900-R002, an
    // EXPENSE — already counted in the expense section) park their stock on
    // the default purchase account instead of double-showing the account.
    const acct = mappedMeta && isPurchaseAcct(mapped, mappedMeta.type) ? mapped : pnlPDefault;
    const x = ensureAcctRow(acct);
    x.openingSen += Math.round(r.openingSen * sc);
    x.closingSen += Math.round(r.closingSen * sc);
    x.grpLines.add(rmLineOf(r.itemGroup));
  }
  // 2) Ledger purchases per account (scaled by the account's group lines:
  //    single-line accounts stay on their line, mixed/unknown pro-rate by R).
  for (const [code, v] of gl.net) {
    const meta = gl.coa.get(code);
    if (!meta || !isPurchaseAcct(code, meta.type)) continue;
    const x = ensureAcctRow(code);
    const only = x.grpLines.size === 1 ? [...x.grpLines][0] : "shared";
    const sc = line === "all" ? 1 : only === "shared" ? R : only === line ? 1 : 0;
    x.purchasesSen += Math.round(v * sc);
  }
  const rmGroups = [...acctRows.entries()]
    .map(([code, x]) => ({
      group: code,
      description: gl.coa.get(code)?.name ?? GROUP_DESCRIPTIONS[code] ?? code,
      openingSen: x.openingSen,
      purchasesSen: x.purchasesSen,
      closingSen: x.closingSen,
    }))
    .filter((g) => g.openingSen !== 0 || g.purchasesSen !== 0 || g.closingSen !== 0)
    .sort((a, b) => a.group.localeCompare(b.group));
  const rmConsumedSen = rmGroups.reduce((s, g) => s + g.openingSen + g.purchasesSen - g.closingSen, 0);

  // --- Carriage (700-1015), SST (706-0000) ---
  const carriageSen = Math.round(bandSum((code) => code === "700-1015", 1) * (isAll ? 1 : R));
  const sstSen = Math.round(bandSum((code) => code === "706-0000", 1) * (isAll ? 1 : R));

  // --- Direct labour (750-x) ---
  const labourLines: { code: string; name: string; amountSen: number }[] = [];
  for (const [code, v] of gl.net) {
    const meta = gl.coa.get(code);
    if (!meta) continue;
    if (pnlBucketFor(code, meta.type, override) !== "DIRECT_LABOUR") continue;
    labourLines.push({ code, name: meta.name, amountSen: Math.round(v * (isAll ? 1 : R)) });
  }
  const labourSen = labourLines.reduce((s, l) => s + l.amountSen, 0);

  // --- Factory overhead (780-x) ---
  const overheadLines: { code: string; name: string; amountSen: number }[] = [];
  for (const [code, v] of gl.net) {
    const meta = gl.coa.get(code);
    if (!meta) continue;
    if (pnlBucketFor(code, meta.type, override) !== "FACTORY_OVERHEAD") continue;
    overheadLines.push({ code, name: meta.name, amountSen: Math.round(v * (isAll ? 1 : R)) });
  }
  const overheadSen = overheadLines.reduce((s, l) => s + l.amountSen, 0);

  // --- WIP / FG movements (from the FIFO engine, as-of-date reconstructed) ---
  const wipOpen = isAll ? mat.wipOpenSen : Math.round(mat.wipOpenSen * R);
  const wipClose = isAll ? mat.wipCloseSen : Math.round(mat.wipCloseSen * R);
  const fgOpen = isAll ? mat.fgOpenSen : Math.round(mat.fgOpenSen * R);
  const fgClose = isAll ? mat.fgCloseSen : Math.round(mat.fgCloseSen * R);

  const manufacturingSen = rmConsumedSen + carriageSen + sstSen + labourSen + overheadSen + (wipOpen - wipClose);
  const cogsSen = fgOpen + manufacturingSen - fgClose;
  const grossProfitSen = netSalesSen - cogsSen;

  // --- Operating expenses (EXPENSE type, 900-x). Salaries & Contribution
  //     (900-S00x) grouped; product-line-tagged PV lines stay on their line. ---
  const expenseLines: { code: string; name: string; amountSen: number; salary: boolean }[] = [];
  for (const [code, v] of gl.net) {
    const meta = gl.coa.get(code);
    if (!meta) continue;
    const bucket = pnlBucketFor(code, meta.type, override);
    if (bucket !== "OPERATING_EXPENSE" && bucket !== "OPEX_SALARIES") continue;
    expenseLines.push({ code, name: meta.name, amountSen: Math.round(v * (isAll ? 1 : R)), salary: bucket === "OPEX_SALARIES" });
  }
  const expenseSen = expenseLines.reduce((s, l) => s + l.amountSen, 0);
  const netProfitSen = grossProfitSen + otherIncomeSen * (isAll ? 1 : R) - expenseSen;

  return {
    netSalesSen,
    revLines, // already filtered to the selected line; exact (not R-scaled)
    rmGroups,
    rmConsumedSen,
    carriageSen,
    sstSen,
    labourLines,
    labourSen,
    overheadLines,
    overheadSen,
    wipOpen, wipClose, fgOpen, fgClose,
    manufacturingSen,
    cogsSen,
    grossProfitSen,
    otherIncomeSen: Math.round(otherIncomeSen * (isAll ? 1 : R)),
    otherIncomeLines: otherIncomeLines.map((r) => ({ ...r, amountSen: Math.round(r.amountSen * (isAll ? 1 : R)) })),
    expenseLines,
    expenseSen,
    netProfitSen,
    // Material-wide data-quality warnings from the FIFO engine (negative stock
    // / unresolved item codes). These are NOT period-specific — they reflect
    // the whole replayed timeline — so the caller can take them from any one
    // window (the broadest/accumulated call is the natural choice).
    materialWarnings: mat.warnings,
  };
}

// Window form of costByLine for sales ratio (period-string version exists
// for the public endpoint; this one takes an explicit window).
async function costByLineWindow(
  db: Env["Variables"]["DB"],
  startYm: string | null,
  endYm: string | null,
): Promise<{ salesRatio: { sofa: number; bedframe: number } }> {
  let sofaSales = 0;
  let bedSales = 0;
  try {
    const [invRes, itemRes, prodRes] = await Promise.all([
      db.prepare(`SELECT id, invoiceDate, status FROM invoices WHERE status NOT IN ('DRAFT','CANCELLED')`).all<{ id: string; invoiceDate: string | null; status: string }>(),
      db.prepare(`SELECT invoiceId, productCode, totalSen FROM invoice_items`).all<{ invoiceId: string; productCode: string | null; totalSen: number }>(),
      db.prepare(`SELECT code, category FROM products`).all<{ code: string; category: string | null }>(),
    ]);
    const invYm = new Map<string, string>();
    for (const i of invRes.results ?? []) invYm.set(i.id, String(i.invoiceDate ?? "").slice(0, 7));
    const cat = new Map<string, string>();
    for (const p of prodRes.results ?? []) cat.set(p.code, String(p.category ?? "").toUpperCase());
    for (const it of itemRes.results ?? []) {
      const ym = invYm.get(it.invoiceId);
      if (ym === undefined) continue;
      if (startYm && ym < startYm) continue;
      if (endYm && ym > endYm) continue;
      const c2 = cat.get(it.productCode ?? "") ?? "";
      const v = Number(it.totalSen) || 0;
      if (c2 === "BEDFRAME") bedSales += v;
      else sofaSales += v;
    }
  } catch {
    /* absent */
  }
  const tot = sofaSales + bedSales;
  return { salesRatio: tot > 0 ? { sofa: sofaSales / tot, bedframe: bedSales / tot } : { sofa: 0.5, bedframe: 0.5 } };
}

// Assemble the statement row tree from a period window + the FY-YTD window.
function buildPnlRows(p: PnlWindow, y: PnlWindow, editable = false) {
  type Row = { kind: "group" | "line" | "total" | "grandtotal" | "gap"; depth: number; label: string; periodSen?: number; ytdSen?: number; groupId?: string; totalLabel?: string; badge?: string; accountCode?: string; bucket?: string };
  const rows: Row[] = [];
  let gid = 0;
  const g = (label: string, depth: number, periodSen: number, ytdSen: number, totalLabel: string, bucket?: string) => { const id = `g${gid++}`; rows.push({ kind: "group", depth, label, periodSen, ytdSen, groupId: id, totalLabel, bucket }); return id; };
  const line = (label: string, depth: number, ps: number, ys: number, accountCode?: string, bucket?: string) => rows.push({ kind: "line", depth, label, periodSen: ps, ytdSen: ys, accountCode, bucket });
  const tot = (label: string, depth: number, ps: number, ys: number) => rows.push({ kind: "total", depth, label, periodSen: ps, ytdSen: ys });

  // SALES
  g("SALES", 0, p.netSalesSen, y.netSalesSen, "NET SALES", "REVENUE");
  for (let i = 0; i < p.revLines.length; i++) line(p.revLines[i].name, 1, p.revLines[i].amountSen, y.revLines[i]?.amountSen ?? 0, p.revLines[i].code, "REVENUE");
  rows.push({ kind: "gap", depth: 0, label: "" });

  // COST OF GOODS SOLD
  g("COST OF GOODS SOLD", 0, p.cogsSen, y.cogsSen, "TOTAL COST OF GOODS SOLD");
  line("OPENING STOCK - FINISHED GOODS", 1, p.fgOpen, y.fgOpen);
  // Raw materials sub-group
  g("RAW MATERIALS", 1, p.rmConsumedSen, y.rmConsumedSen, "TOTAL RAW MATERIALS");
  for (let i = 0; i < p.rmGroups.length; i++) {
    const pg = p.rmGroups[i];
    const yg = y.rmGroups.find((x) => x.group === pg.group);
    g(pg.description, 2, pg.openingSen + pg.purchasesSen - pg.closingSen, yg ? yg.openingSen + yg.purchasesSen - yg.closingSen : 0, `TOTAL ${pg.description}`);
    line("OPENING STOCK", 3, pg.openingSen, yg?.openingSen ?? 0);
    line("PURCHASE", 3, pg.purchasesSen, yg?.purchasesSen ?? 0);
    line("CLOSING STOCK", 3, -pg.closingSen, yg ? -yg.closingSen : 0);
  }
  line("CARRIAGE INWARDS", 1, p.carriageSen, y.carriageSen);
  line("SST CHARGES", 1, p.sstSen, y.sstSen);
  // Direct labour
  g("DIRECT LABOUR", 1, p.labourSen, y.labourSen, "TOTAL DIRECT LABOUR", "DIRECT_LABOUR");
  for (let i = 0; i < p.labourLines.length; i++) line(p.labourLines[i].name, 2, p.labourLines[i].amountSen, y.labourLines.find((x) => x.code === p.labourLines[i].code)?.amountSen ?? 0, p.labourLines[i].code, "DIRECT_LABOUR");
  // Factory overhead
  g("FACTORY OVERHEAD", 1, p.overheadSen, y.overheadSen, "TOTAL FACTORY OVERHEAD", "FACTORY_OVERHEAD");
  for (let i = 0; i < p.overheadLines.length; i++) line(p.overheadLines[i].name, 2, p.overheadLines[i].amountSen, y.overheadLines.find((x) => x.code === p.overheadLines[i].code)?.amountSen ?? 0, p.overheadLines[i].code, "FACTORY_OVERHEAD");
  // WIP movement
  g("WORK IN PROGRESS", 1, p.wipOpen - p.wipClose, y.wipOpen - y.wipClose, "WIP MOVEMENT (net)");
  line("WIP - OPENING", 2, p.wipOpen, y.wipOpen);
  line("WIP - CLOSING", 2, -p.wipClose, -y.wipClose);
  tot("MANUFACTURING COST", 1, p.manufacturingSen, y.manufacturingSen);
  line("CLOSING STOCK - FINISHED GOODS", 1, -p.fgClose, -y.fgClose);
  rows.push({ kind: "grandtotal", depth: 0, label: "GROSS PROFIT / (LOSS)", periodSen: p.grossProfitSen, ytdSen: y.grossProfitSen });
  rows.push({ kind: "gap", depth: 0, label: "" });

  // OTHER INCOME
  if (editable || p.otherIncomeLines.length > 0 || p.otherIncomeSen !== 0) {
    g("OTHER INCOME", 0, p.otherIncomeSen, y.otherIncomeSen, "TOTAL OTHER INCOME", "OTHER_INCOME");
    for (let i = 0; i < p.otherIncomeLines.length; i++) line(p.otherIncomeLines[i].name, 1, p.otherIncomeLines[i].amountSen, y.otherIncomeLines.find((x) => x.code === p.otherIncomeLines[i].code)?.amountSen ?? 0, p.otherIncomeLines[i].code, "OTHER_INCOME");
  }

  // OPERATING EXPENSES — Salaries & Contribution grouped, rest as lines.
  g("OPERATING EXPENSES", 0, p.expenseSen, y.expenseSen, "TOTAL EXPENSES", "OPERATING_EXPENSE");
  const pSal = p.expenseLines.filter((l) => l.salary);
  const ySalSum = y.expenseLines.filter((l) => l.salary).reduce((s, l) => s + l.amountSen, 0);
  if (editable || pSal.length > 0) {
    g("SALARIES & CONTRIBUTION", 1, pSal.reduce((s, l) => s + l.amountSen, 0), ySalSum, "TOTAL SALARIES & CONTRIBUTION", "OPEX_SALARIES");
    for (const l of pSal) line(l.name, 2, l.amountSen, y.expenseLines.find((x) => x.code === l.code)?.amountSen ?? 0, l.code, "OPEX_SALARIES");
  }
  for (const l of p.expenseLines.filter((x) => !x.salary)) line(l.name, 1, l.amountSen, y.expenseLines.find((x) => x.code === l.code)?.amountSen ?? 0, l.code, "OPERATING_EXPENSE");
  rows.push({ kind: "grandtotal", depth: 0, label: "NET PROFIT / (LOSS)", periodSen: p.netProfitSen, ytdSen: y.netProfitSen });
  return rows;
}

// Phase 5.6 — Cost Structure: a financial year, per material group, each of
// the 12 months showing O/P Stock · Purchase · C/L Stock · Cost Spend
// (consumed = opening + purchase − closing), with the line's monthly sales
// and cost-spend % of sales. Opening carries across months (and from the
// prior FY). One pass over the cost ledger.
app.get("/cost-structure", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const fyParam = c.req.query("fy");
  const fyeMonth = await getFyeMonth(db);
  const anchorDate = fyParam ? new Date(Date.UTC(parseInt(fyParam, 10), fyeMonth % 12, 15)) : new Date();
  const fyWin = fyWindowFor(anchorDate, fyeMonth);
  const startYm = fyWin.startIso.slice(0, 7);
  const cols: string[] = [];
  {
    let [y, m] = startYm.split("-").map((n) => parseInt(n, 10));
    for (let i = 0; i < 12; i++) { cols.push(`${y}-${String(m).padStart(2, "0")}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  // Owner rule 2026-07-28 (「cost structure 其实就和 P&L 一样拿数据」): this
  // report now takes every month's numbers from THE SAME per-month window the
  // P&L uses — GL purchases by purchase account, engine/stock-take inventory,
  // historical swap for pre-opening months — replacing the cost_ledger
  // RM_RECEIPT/RM_ISSUE feed, which stopped being fed after 2026-03 (PUR read
  // blank from April even though the GL had the purchases).
  await ensurePnlHistorical(db);
  const nowYm = new Date().toISOString().slice(0, 7);
  const orgIdCs = getOrgId(c);
  const overrideCs = await getPnlSectionMap(db);
  const lastComputeYm = cols[0] > nowYm ? null : (nowYm < cols[11] ? nowYm : cols[11]);
  const [matDataCs, dcCs] = lastComputeYm
    ? await Promise.all([loadMaterialCostData(db, orgIdCs, lastComputeYm), loadDocDateResolver(db)])
    : [null, null];
  const [historicalCs, openingDateRawCs] = await Promise.all([
    loadHistoricalPnl(db, orgIdCs),
    getOpeningDate(db),
  ]);
  const openingMonthCs = openingDateRawCs ? openingDateRawCs.slice(0, 7) : null;

  type CsMonth = { opening: number; purchase: number; closing: number; spend: number };
  const groups = new Map<string, { description: string; months: CsMonth[] }>();
  const ensureG = (code: string, desc: string) => {
    let g = groups.get(code);
    if (!g) { g = { description: desc, months: cols.map(() => ({ opening: 0, purchase: 0, closing: 0, spend: 0 })) }; groups.set(code, g); }
    return g;
  };
  const salesSofa = new Array(12).fill(0);
  const salesBed = new Array(12).fill(0);
  const CS_BEDFRAME_SALES_CODE = "500-0000";
  for (let i = 0; i < 12; i++) {
    const ym = cols[i];
    if (ym > nowYm) continue; // future months stay blank
    const hist = selectHistoricalWindow(historicalCs, openingMonthCs, ym, "all");
    const w = hist ?? (matDataCs && dcCs
      ? await computePnlWindow(db, orgIdCs, ym, ym, "all", matDataCs, dcCs, overrideCs)
      : null);
    if (!w) continue;
    for (const g of w.rmGroups) {
      const row = ensureG(g.group, g.description);
      const purchase = Number(g.purchasesSen) || 0;
      const opening = Number(g.openingSen) || 0;
      const closing = Number(g.closingSen) || 0;
      row.months[i] = { opening, purchase, closing, spend: opening + purchase - closing };
    }
    for (const r of w.revLines) {
      if (r.code === CS_BEDFRAME_SALES_CODE) salesBed[i] += r.amountSen;
      else salesSofa[i] += r.amountSen;
    }
  }
  const out = [...groups.entries()]
    .map(([code, g]) => ({ group: code, description: g.description, months: g.months }))
    .filter((r) => r.months.some((m) => m.opening || m.purchase || m.closing || m.spend))
    .sort((a, b) => a.group.localeCompare(b.group));
  return c.json({
    success: true,
    data: { fyLabel: fyWin.label, cols, groups: out, salesSofa, salesBed, salesAll: cols.map((_, i) => salesSofa[i] + salesBed[i]) },
  });
});

// Phase 5.9 — Cost & Expense classes: for a financial year, COST (mfg) and
// EXPENSE (operating) accounts laid out months-as-columns, grouped by
// pnl_category (FIXED / VARIABLE / OTHERS). This report is the ONLY thing
// pnl_category drives — it does NOT change the Overall/Sofa/Bedframe P&L
// format (owner decision 2026-06-11). Unclassified accounts fall to OTHERS.
app.get("/cost-expense-classes", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const fyParam = c.req.query("fy"); // YYYY (FY start year) optional
  const fyeMonth = await getFyeMonth(db);
  const anchorDate = fyParam
    ? new Date(Date.UTC(parseInt(fyParam, 10), fyeMonth % 12, 15))
    : new Date();
  const fyWin = fyWindowFor(anchorDate, fyeMonth);
  const startYm = fyWin.startIso.slice(0, 7);
  const endYm = fyWin.endIso.slice(0, 7);
  const cols: string[] = [];
  {
    let [y, m] = startYm.split("-").map((n) => parseInt(n, 10));
    for (let i = 0; i < 12; i++) {
      cols.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  }
  const [legRes, coaRes] = await Promise.all([
    db.prepare("SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0").all<{ accountCode: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; sourceType: string }>(),
    db.prepare("SELECT code, name, type, pnlCategory FROM chart_of_accounts").all<{ code: string; name: string; type: CoaRow["type"]; pnlCategory: string | null }>(),
  ]);
  const resolve = await loadAccountResolver(db);
  const { docDate, openingDate: obDateCec } = await loadDocDateResolver(db);
  const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
  const byAcct = new Map<string, number[]>();
  const openingNetCec = new Map<string, number>(); // opening legs on COST/EXPENSE accounts
  // Same account-level recorded-salary map as glWindowSigned (BUG-2026-08-31-172).
  const salaryEntryYmCec = new Map<string, string>();
  for (const l of legRes.results ?? []) {
    if ((Number(l.creditSen) || 0) <= 0) continue;
    if (resolve(l.accountCode) !== LABOUR_ACCRUAL_ACCT) continue;
    const dd = docDate(l.sourceType, l.sourceId, l.postedAt);
    if (legBeforeOpening(l.sourceType, dd, obDateCec) || isOpeningSource(l.sourceType)) continue;
    salaryEntryYmCec.set(`${l.sourceType}::${l.sourceId}`, dd.slice(0, 7));
  }
  const recordedSalaryAcctsCec = new Map<string, Set<string>>();
  for (const l of legRes.results ?? []) {
    if ((Number(l.debitSen) || 0) <= 0) continue;
    const ym = salaryEntryYmCec.get(`${l.sourceType}::${l.sourceId}`);
    if (!ym) continue;
    let set = recordedSalaryAcctsCec.get(ym);
    if (!set) { set = new Set(); recordedSalaryAcctsCec.set(ym, set); }
    set.add(resolve(l.accountCode));
  }
  for (const l of legRes.results ?? []) {
    const dd = docDate(l.sourceType, l.sourceId, l.postedAt); // by document date
    if (legBeforeOpening(l.sourceType, dd, obDateCec)) continue; // pre-opening: not extracted
    if (isOpeningSource(l.sourceType)) {
      const code = resolve(l.accountCode);
      openingNetCec.set(code, (openingNetCec.get(code) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
      continue;
    }
    if (l.sourceType === "closing_stock" || l.sourceType === "closing_stock_reversal" || l.sourceType === "year_close") continue;
    const ym = dd.slice(0, 7);
    if (ym < startYm || ym > endYm) continue;
    const code = resolve(l.accountCode);
    const meta = coa.get(code);
    if (!meta || (meta.type !== "COST" && meta.type !== "EXPENSE")) continue;
    const idx = cols.indexOf(ym);
    if (idx < 0) continue;
    let arr = byAcct.get(code);
    if (!arr) { arr = new Array(12).fill(0); byAcct.set(code, arr); }
    arr[idx] += (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0);
  }
  // Report-layer labour — same rule as glWindowSigned (owner 2026-08-31):
  // payroll figures inject per line; an account the owner recorded that month
  // keeps his figure.
  {
    const injMemo = new Map<string, { account: string; sen: number }[]>();
    for (const ym of labourInjectMonths({
      startYm,
      endYm,
      openingYm: obDateCec ? obDateCec.slice(0, 7) : null,
      nowYm: new Date().toISOString().slice(0, 7),
      recordedYms: new Set(),
    })) {
      const idx = cols.indexOf(ym);
      if (idx < 0) continue;
      const recorded = recordedSalaryAcctsCec.get(ym);
      for (const { account, sen } of await labourInjectionLines(db, getOrgId(c), ym, injMemo)) {
        if (recorded?.has(account)) continue;
        let arr = byAcct.get(account);
        if (!arr) { arr = new Array(12).fill(0); byAcct.set(account, arr); }
        arr[idx] += sen;
      }
    }
  }
  // Mid-year opening: show the opening-month slice (opening cumulative − prior
  // month-end TB) in the opening month's column — same rule as glWindowSigned.
  const obYmCec = obDateCec ? obDateCec.slice(0, 7) : null;
  const obIdxCec = obYmCec ? cols.indexOf(obYmCec) : -1;
  if (openingNetCec.size && obIdxCec >= 0) {
    const priorCum = await getPnlOpeningPriorCum(db);
    const sliceNet = new Map<string, number>();
    applyOpeningSlice(sliceNet, openingNetCec, priorCum, (code) => {
      const t = coa.get(code)?.type;
      return t === "COST" || t === "EXPENSE";
    });
    for (const [code, v] of sliceNet) {
      let arr = byAcct.get(code);
      if (!arr) { arr = new Array(12).fill(0); byAcct.set(code, arr); }
      arr[obIdxCec] += v;
    }
  }
  const classOf = (cat: string | null) => {
    const v = String(cat ?? "").toUpperCase();
    return v === "FIXED" || v === "VARIABLE" ? v : "OTHERS";
  };
  const buildSection = (type: "COST" | "EXPENSE") => {
    const classes: Record<string, { account: string; name: string; months: number[]; total: number }[]> = { FIXED: [], VARIABLE: [], OTHERS: [] };
    for (const [code, arr] of byAcct) {
      const meta = coa.get(code);
      if (!meta || meta.type !== type) continue;
      const total = arr.reduce((s, n) => s + n, 0);
      if (total === 0 && arr.every((n) => n === 0)) continue;
      classes[classOf(meta.pnlCategory)].push({ account: code, name: meta.name, months: arr, total });
    }
    for (const k of Object.keys(classes)) classes[k].sort((a, b) => a.account.localeCompare(b.account));
    return classes;
  };
  return c.json({
    success: true,
    data: {
      fyLabel: fyWin.label,
      cols,
      cost: buildSection("COST"),
      expense: buildSection("EXPENSE"),
    },
  });
});

// Phase 5.8 — Monthly Trend: per-month P&L summary for the last N months
// (newest first), one product line. Reuses computePnlWindow per month.
app.get("/pl-trend", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const lineParam = (c.req.query("line") || "all").toLowerCase();
  const line: "all" | "sofa" | "bedframe" = lineParam === "sofa" ? "sofa" : lineParam === "bedframe" ? "bedframe" : "all";
  const months = Math.min(24, Math.max(3, parseInt(c.req.query("months") || "6", 10) || 6));
  const anchor = c.req.query("anchor") || new Date().toISOString().slice(0, 7);
  const [ay, am] = anchor.split("-").map((n) => parseInt(n, 10));
  const orgId = getOrgId(c);
  // Build the FIFO checkpoints ONCE (anchor is the latest month in the trend);
  // every month-window below is then a synchronous lookup, not a fresh replay.
  const matData = await loadMaterialCostData(c.var.DB, orgId, anchor);
  const dc = await loadDocDateResolver(c.var.DB); // once per request — threaded into every window below
  const cols: { ym: string; netSalesSen: number; cogsSen: number; grossProfitSen: number; otherIncomeSen: number; expenseSen: number; netProfitSen: number }[] = [];
  for (let i = 0; i < months; i++) {
    // newest first: anchor, anchor-1, …
    let y = ay;
    let m = am - i;
    while (m <= 0) { m += 12; y -= 1; }
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const p = await computePnlWindow(c.var.DB, orgId, ym, ym, line, matData, dc);
    cols.push({
      ym,
      netSalesSen: p.netSalesSen,
      cogsSen: p.cogsSen,
      grossProfitSen: p.grossProfitSen,
      otherIncomeSen: p.otherIncomeSen,
      expenseSen: p.expenseSen,
      netProfitSen: p.netProfitSen,
    });
  }
  return c.json({ success: true, data: { line, months, cols } });
});

app.get("/pl-statement", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  // Task 3.1 — ensure table exists before first read.
  await ensurePnlHistorical(c.var.DB);
  const period = c.req.query("period") || new Date().toISOString().slice(0, 7);
  const lineParam = (c.req.query("line") || "all").toLowerCase();
  const line: "all" | "sofa" | "bedframe" = lineParam === "sofa" ? "sofa" : lineParam === "bedframe" ? "bedframe" : "all";
  const editable = c.req.query("editable") === "1";
  const pnlOverride = await getPnlSectionMap(c.var.DB);
  const startYm = periodStartYm(period);
  const endYm = periodEndYm(period);
  // FY-YTD window = FY start (per fye_month) → period end.
  const fyeMonth = await getFyeMonth(c.var.DB);
  const endForFy = new Date(`${endYm ?? new Date().toISOString().slice(0, 7)}-15T00:00:00Z`);
  const fyWin = fyWindowFor(endForFy, fyeMonth);
  const fyStartYm = fyWin.startIso.slice(0, 7);
  const orgId = getOrgId(c);
  // FIFO checkpoints once — period end is the latest month either window needs.
  const matData = await loadMaterialCostData(c.var.DB, orgId, endYm ?? new Date().toISOString().slice(0, 7));
  const dc = await loadDocDateResolver(c.var.DB); // once per request
  // Task 3.2 — load historical and check if the period window should be swapped.
  const [historical, openingDateRaw] = await Promise.all([
    loadHistoricalPnl(c.var.DB, orgId),
    getOpeningDate(c.var.DB),
  ]);
  const openingMonth = openingDateRaw ? openingDateRaw.slice(0, 7) : null;
  // For the period window: only single-month periods (startYm === endYm) can be
  // swapped from historical; a multi-month range spans both sides so we fall back
  // to computePnlWindow.
  const historicalP = startYm && startYm === endYm
    ? selectHistoricalWindow(historical, openingMonth, startYm, line)
    : null;
  const EMPTY_WARNINGS: PnlWindow["materialWarnings"] = { negatives: [], unresolved: [] };
  const [p, y] = await Promise.all([
    historicalP
      ? Promise.resolve({ ...historicalP, materialWarnings: EMPTY_WARNINGS } as PnlWindow)
      : computePnlWindow(c.var.DB, orgId, startYm, endYm, line, matData, dc, pnlOverride),
    computePnlWindow(c.var.DB, orgId, fyStartYm, endYm, line, matData, dc, pnlOverride),
  ]);
  // Material warnings are material-wide (whole-timeline), not period-specific —
  // merge both windows' lists and de-dupe so the same material can't appear
  // twice (by rmId for negatives, by source+code for unresolved).
  const negMap = new Map<string, { itemCode: string; units: number }>();
  const unresMap = new Map<string, { source: string; code: string }>();
  for (const w of [p.materialWarnings, y.materialWarnings]) {
    for (const n of w.negatives) negMap.set(n.rmId, { itemCode: n.itemCode, units: n.units });
    for (const u of w.unresolved) unresMap.set(`${u.source}\u0000${u.code}`, u);
  }
  const materialWarnings = {
    negatives: [...negMap.entries()].map(([rmId, v]) => ({ rmId, itemCode: v.itemCode, units: v.units })),
    unresolved: [...unresMap.values()],
  };
  return c.json({
    success: true,
    data: {
      period,
      line,
      periodLabel: period,
      fyLabel: fyWin.label,
      netSalesSen: p.netSalesSen,
      rows: buildPnlRows(p, y, editable),
      materialWarnings,
    },
  });
});

app.get("/pl-monthly", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  // Task 3.1 — ensure table exists before first read.
  await ensurePnlHistorical(c.var.DB);
  const lineParam = c.req.query("line");
  const line: "all" | "sofa" | "bedframe" = lineParam === "sofa" || lineParam === "bedframe" ? lineParam : "all";
  const anchor = c.req.query("anchor");

  const fyeMonth = await getFyeMonth(c.var.DB);
  const anchorYm = /^\d{4}-\d{2}$/.test(anchor ?? "") ? (anchor as string) : new Date().toISOString().slice(0, 7);
  const anchorDate = new Date(`${anchorYm}-01T00:00:00Z`);
  const fy = fyWindowFor(anchorDate, fyeMonth);
  const fyStartYm = fy.startIso.slice(0, 7);
  const fyEndYm = fy.endIso.slice(0, 7);
  const lastYm = anchorYm < fyEndYm ? anchorYm : fyEndYm;
  const months: string[] = [];
  {
    let d = new Date(`${fyStartYm}-01T00:00:00Z`);
    const end = new Date(`${lastYm}-01T00:00:00Z`);
    while (d <= end) { months.push(d.toISOString().slice(0, 7)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
  }

  const override = await getPnlSectionMap(c.var.DB);
  const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" });

  const orgId = getOrgId(c);
  // FIFO checkpoints once for the whole FY matrix (lastYm is the latest column).
  const matData = await loadMaterialCostData(c.var.DB, orgId, lastYm);
  const dc = await loadDocDateResolver(c.var.DB); // once per request — threaded into every month window

  // Task 3.2 — load historical P&L rows once per request.
  const [historical, openingDateRaw] = await Promise.all([
    loadHistoricalPnl(c.var.DB, orgId),
    getOpeningDate(c.var.DB),
  ]);
  const openingMonth = openingDateRaw ? openingDateRaw.slice(0, 7) : null;

  // Build each month's window, swapping in historical data for pre-opening months.
  const EMPTY_WARNINGS_M: PnlWindow["materialWarnings"] = { negatives: [], unresolved: [] };
  const cols: PnlMatrixCol[] = [];
  const perMonthWindows: PnlWindow[] = [];
  // Months newest-first (after Accumulated) per owner layout (F4 #7).
  for (const ym of [...months].reverse()) {
    const hist = selectHistoricalWindow(historical, openingMonth, ym, line);
    const window: PnlWindow = hist
      ? { ...hist, materialWarnings: EMPTY_WARNINGS_M }
      : await computePnlWindow(c.var.DB, orgId, ym, ym, line, matData, dc, override);
    perMonthWindows.push(window);
    cols.push({ key: ym, label: monthLabel(ym), accum: false, window });
  }

  // Accumulated column: sum all per-month windows (historical + computed) so
  // pre-opening months contribute their owner-provided figures. Then merge the
  // computed windows' materialWarnings into the accumulated result.
  const computedAccWindow = await computePnlWindow(c.var.DB, orgId, fyStartYm, lastYm, line, matData, dc, override);
  // Determine if any month in range is pre-opening (historical might be absent
  // for that month, but we always use sumPnlWindows when historical rows exist).
  const hasHistoricalMonths = months.some((ym) => selectHistoricalWindow(historical, openingMonth, ym, line) !== null);
  const accWindow: PnlWindow = hasHistoricalMonths
    ? { ...sumPnlWindows(perMonthWindows), materialWarnings: computedAccWindow.materialWarnings }
    : computedAccWindow;

  cols.unshift({ key: "acc", label: "Accumulated", accum: true, window: accWindow });

  const matrix = buildPnlMatrix(cols);
  return c.json({ success: true, data: { fyLabel: fy.label, line, anchor: anchorYm, columns: matrix.columns, rows: matrix.rows } });
});

// The cash-flow statement computation, shared by GET /cashflow-statement and
// the dashboard card — one engine, so the two can never disagree.
async function computeCashflowStatement(
  db: Env["Variables"]["DB"],
  period: string,
  editable: boolean,
  orgId: string,
) {
  // Local alias so the extracted body reads exactly as it did in the route.
  const c: { var: { DB: Env["Variables"]["DB"] } } = { var: { DB: db } };
  const resolveAcct = await loadAccountResolver(c.var.DB);
  const fyeMonth = await getFyeMonth(c.var.DB);
  const { docDate, openingDate: obDate } = await loadDocDateResolver(c.var.DB);

  const coaRes = await c.var.DB.prepare(
    "SELECT code, name, type, specialAccountType, parentCode FROM chart_of_accounts",
  ).all<{ code: string; name: string; type: CoaLite["type"]; specialAccountType: string | null; parentCode: string | null }>();
  const coa = new Map<string, CoaLite>();
  const bankCodes = new Set<string>();
  for (const a of coaRes.results ?? []) {
    const code = resolveAcct(a.code);
    coa.set(code, { code, name: a.name, type: a.type, sat: a.specialAccountType ?? null, parentCode: a.parentCode ? resolveAcct(a.parentCode) : null });
    if (a.specialAccountType === "SBK" || a.specialAccountType === "SCH")
      bankCodes.add(code);
  }

  const legRes = await c.var.DB.prepare(
    "SELECT accountCode, sourceType, sourceId, debitSen, creditSen, postedAt, description FROM ledger_journal_entries WHERE hidden = 0",
  ).all<{ accountCode: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; description: string | null }>();
  const allLegs = (legRes.results ?? [])
    .filter((l) => !legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDate)) // pre-opening: not extracted
    .map((l) => ({
      code: resolveAcct(l.accountCode),
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      debitSen: l.debitSen,
      creditSen: l.creditSen,
      ym: docDate(l.sourceType, l.sourceId, l.postedAt).slice(0, 7), // by document date
      description: l.description ?? "",
    }));

  const byEntry = new Map<string, typeof allLegs>();
  for (const l of allLegs) {
    const k = `${l.sourceType}::${l.sourceId}`;
    const arr = byEntry.get(k) ?? [];
    arr.push(l);
    byEntry.set(k, arr);
  }

  const classified: ClassifiedLeg[] = [];
  const bankLegs: BankLeg[] = [];
  // Payment NUMBERS, not PI ids — a supplier_payment leg's sourceId is the
  // voucher number (HPV-…). The old code fed these straight into
  // `purchase_invoice_items WHERE pi_id = ?`, which matched nothing, so every
  // raw-material payment fell to "Unallocated raw material" (owner
  // 2026-08-27: 「unallocated raw material 要分出来」). Family match so
  // EDITED payments (live legs = supplier_payment_restate_post:…) split too.
  const paymentNos = new Set<string>();
  // Other-creditor payments (Houzs Century repayments, GVP, transporters …)
  // also settle a creditor-control contra and land in the Raw Materials
  // section, but have no PI behind them. Measured 2026-08-27: they were the
  // bulk of "Unallocated raw material" (Aug'26 RM 309,463.37 = supplier
  // payments 62,133.10 + other-party payments 247,330.27, to the sen). Name
  // each by its payee instead (owner: 「必须要知道还什么」).
  // Other-creditor payments are NOT classified by their contra (the 405
  // control) — the owner reads this statement as a receipts-and-payments
  // report (2026-08-27 「根据purpose 放去相对应的account」), so each payment is
  // re-routed to the counterAccounts of the bills it settled: transporter
  // bills land in Transport expense, SMD's in Capex, Houzs Century's (bills
  // that debit 400-0000, i.e. suppliers paid on our behalf) in Raw Materials.
  // The legs are stashed here and re-injected as per-account pseudo-legs
  // below, once the bill mixes are loaded.
  const opLegs: (ClassifiedLeg & { description: string })[] = [];
  // Salary settlements (DR 410-0010 · CR bank): the payment voucher's
  // description names the payroll month it pays ("… Salaries - May'26"), which
  // is the month whose payslip department mix splits the cash (owner
  // 2026-08-27 「salary 那边也是要拆散成department」).
  const salaryLegs: { sourceId: string; description: string; ym: string }[] = [];
  for (const legs of byEntry.values()) {
    const hasBank = legs.some((l) => bankCodes.has(l.code));
    if (!hasBank) continue;
    const opening = legs.some((l) => isOpeningSource(l.sourceType));
    for (const l of legs) {
      if (bankCodes.has(l.code)) {
        bankLegs.push({ accountCode: l.code, debitSen: l.debitSen, creditSen: l.creditSen, ym: l.ym });
      } else if (!opening) {
        if (l.sourceType.startsWith("other_party_payment")) {
          opLegs.push({
            accountCode: l.code, debitSen: l.debitSen, creditSen: l.creditSen,
            ym: l.ym, sourceType: l.sourceType, sourceId: l.sourceId, description: l.description,
          });
          continue;
        }
        classified.push({
          accountCode: l.code, debitSen: l.debitSen, creditSen: l.creditSen,
          ym: l.ym, sourceType: l.sourceType, sourceId: l.sourceId,
        });
        if (l.sourceType.startsWith("supplier_payment")) paymentNos.add(l.sourceId);
        else if (l.code === LABOUR_ACCRUAL_ACCT)
          salaryLegs.push({ sourceId: l.sourceId, description: l.description, ym: l.ym });
      }
    }
  }

  const map = await getCashflowMap(c.var.DB);
  const sgOverride = await getCashflowStockGroupMap(c.var.DB);
  const rmSplit: RmSplit = {};
  if (paymentNos.size || opLegs.length) {
    const rmRes = await c.var.DB.prepare("SELECT * FROM raw_materials").all<Record<string, unknown>>();
    const grpByCode = new Map<string, string>();
    for (const r of rmRes.results ?? []) {
      const code = String((r.item_code ?? r.itemCode) ?? "");
      const grp = String((r.item_group ?? r.itemGroup) ?? "");
      if (code) grpByCode.set(code, grp);
    }
    // Per-PI material-line weights, computed once per PI and reused across
    // every payment that touched it. A PI belongs to exactly one supplier, so
    // the supplier-tagged fallback label is stable under the piId cache key.
    const piWeightCache = new Map<string, Map<string, number>>();
    const piWeightsFor = async (piId: string, supplier: string): Promise<Map<string, number>> => {
      const hit = piWeightCache.get(piId);
      if (hit) return hit;
      const w = new Map<string, number>();
      const itRes = await c.var.DB.prepare("SELECT * FROM purchase_invoice_items WHERE pi_id = ?").bind(piId).all<Record<string, unknown>>();
      for (const it of itRes.results ?? []) {
        const lt = String((it.line_type ?? it.lineType) ?? "STOCKED");
        const amt = Number((it.line_total_sen ?? it.lineTotalSen) ?? 0);
        const mc = String((it.material_code ?? it.materialCode) ?? "");
        const grp = mc ? grpByCode.get(mc) ?? "" : "";
        // Owner 2026-08-27 「拆散」: one row PER STOCK GROUP, not the four
        // rolled-up lines. The stock-group override map still renames a group
        // when set; tax rides its own line; a line with no resolvable group is
        // named by its SUPPLIER (owner 2026-08-31 「这个我也有要分」) so he can
        // see whose invoice needs a material code — or that it is a service.
        const line = lt === "TAX" ? "SST / TAX" : grp ? (sgOverride[grp] ?? grp) : `Unallocated — ${supplier}`;
        w.set(line, (w.get(line) ?? 0) + Math.max(0, amt));
      }
      piWeightCache.set(piId, w);
      return w;
    };
    // What one payment actually settled: its allocation rows, weighted by
    // the BOOKED amount each row paid off. Rows the system can name but not
    // split get their own labelled line (owner 2026-08-27 「必须要知道还
    // 什么」): advances (no PI yet), opening-balance PIs (pi-ob-*, item
    // lines predate the system), trade-finance repayments. Discount
    // markers (CREDIT_NOTE) are not cash and stay out.
    const weightsForPayment = async (payNo: string): Promise<Map<string, number>> => {
      const rowsRes = await c.var.DB.prepare(
        `SELECT sp.purchase_invoice_id AS purchase_invoice_id, sp.booked_sen AS booked_sen, sp.amount_sen AS amount_sen,
                sp.supplier_name AS supplier_name, COALESCE(sp.method,'') AS method
           FROM supplier_payments sp
          WHERE sp.payment_no = ? AND COALESCE(sp.method,'') <> 'CREDIT_NOTE'`,
      ).bind(payNo).all<Record<string, unknown>>();
      const weights = new Map<string, number>();
      const bump = (line: string, sen: number) => weights.set(line, (weights.get(line) ?? 0) + sen);
      for (const row of rowsRes.results ?? []) {
        const piId = String(row.purchaseInvoiceId ?? row.purchase_invoice_id ?? "");
        const booked = Math.max(0, Number(row.bookedSen ?? row.booked_sen ?? row.amountSen ?? row.amount_sen) || 0);
        if (!booked) continue;
        const supplier = String(row.supplierName ?? row.supplier_name ?? "").trim() || "unknown supplier";
        if (String(row.method ?? "") === "TF_REPAYMENT") { bump("Trade finance repayment", booked); continue; }
        if (!piId) { bump("Supplier advance / deposit", booked); continue; }
        const w = await piWeightsFor(piId, supplier);
        let totalW = 0;
        for (const v of w.values()) totalW += v;
        // Owner 2026-08-31 「我想要分」: pre-system opening invoices carry no
        // item lines, but they DO carry a supplier — one row per supplier
        // answers 还了谁的旧账 without inventing a material mix.
        if (!totalW) { bump(piId.startsWith("pi-ob-") ? `Opening creditors — ${supplier}` : `Unallocated — ${supplier}`, booked); continue; }
        for (const [line, lw] of w) bump(line, (booked * lw) / totalW);
      }
      return weights;
    };
    for (const payNo of paymentNos) {
      const weights = await weightsForPayment(payNo);
      if (weights.size) {
        rmSplit[payNo] = [...weights.entries()].map(([line, weight]) => ({ line, weight: Math.round(weight) }));
      }
    }
    if (opLegs.length) {
    // Purpose mix per other-party payment = its bill allocations × each bill's
    // item counterAccount mix. A payment whose bills carry no usable items
    // (opening bills, missing data) keeps its original contra and shows as a
    // "<payee> (other creditor)" row instead — named, never silently smeared.
    const allocRes = await c.var.DB.prepare(
      "SELECT payment_no AS payment_no, bill_id AS bill_id, amount_sen AS amount_sen, party_name AS party_name FROM other_party_payments",
    ).all<Record<string, unknown>>();
    const itemsRes = await c.var.DB.prepare(
      "SELECT billId AS bill_id, counterAccount AS counter_account, amountSen AS amount_sen FROM other_party_bill_items",
    ).all<Record<string, unknown>>();
    const billMix = new Map<string, Map<string, number>>();
    for (const r of itemsRes.results ?? []) {
      const bid = String(r.billId ?? r.bill_id ?? "");
      const acct = String(r.counterAccount ?? r.counter_account ?? "").trim();
      const sen = Math.max(0, Number(r.amountSen ?? r.amount_sen) || 0);
      if (!bid || !acct || !sen) continue;
      const m = billMix.get(bid) ?? new Map<string, number>();
      m.set(acct, (m.get(acct) ?? 0) + sen);
      billMix.set(bid, m);
    }
    const payMix = new Map<string, Map<string, number>>();
    const partyByNo = new Map<string, string>();
    for (const r of allocRes.results ?? []) {
      const no = String(r.paymentNo ?? r.payment_no ?? "");
      if (!no) continue;
      const nm = String(r.partyName ?? r.party_name ?? "").trim();
      if (nm && !partyByNo.has(no)) partyByNo.set(no, nm);
      const alloc = Math.max(0, Number(r.amountSen ?? r.amount_sen) || 0);
      const mix = billMix.get(String(r.billId ?? r.bill_id ?? ""));
      if (!alloc || !mix) continue;
      let tot = 0;
      for (const v of mix.values()) tot += v;
      if (!tot) continue;
      const pm = payMix.get(no) ?? new Map<string, number>();
      for (const [acct, w] of mix) pm.set(acct, (pm.get(acct) ?? 0) + (alloc * w) / tot);
      payMix.set(no, pm);
    }
    const isCreditorControl = (code: string): boolean => {
      const a2 = coa.get(code);
      const b2 = parseInt(code.split("-")[0] ?? "0", 10) || 0;
      return a2?.sat === "SCC" || b2 === 400 || b2 === 405;
    };
    for (const leg of opLegs) {
      const mix = payMix.get(leg.sourceId);
      const payee = partyByNo.get(leg.sourceId) ?? "Other creditor";
      if (!mix || !mix.size) {
        classified.push({
          accountCode: leg.accountCode, debitSen: leg.debitSen, creditSen: leg.creditSen,
          ym: leg.ym, sourceType: leg.sourceType, sourceId: leg.sourceId,
        });
        rmSplit[`${leg.sourceId}@${leg.accountCode}`] ??= [{ line: `${payee} (other creditor)`, weight: 1 }];
        continue;
      }
      const buckets = [...mix.entries()].map(([acct, w]) => ({ key: acct, weight: Math.round(w) }));
      const dParts = splitByLargestRemainder(leg.debitSen, buckets);
      const cParts = splitByLargestRemainder(leg.creditSen, buckets);
      for (const { key: acct } of buckets) {
        const d = dParts[acct] ?? 0, cr = cParts[acct] ?? 0;
        if (!d && !cr) continue;
        const rc = resolveAcct(acct);
        classified.push({
          accountCode: rc, debitSen: d, creditSen: cr,
          ym: leg.ym, sourceType: leg.sourceType, sourceId: leg.sourceId,
        });
        // Only the money whose purpose account is itself a creditor control
        // (Houzs Century's bill lines on 400-0000: suppliers paid on our
        // behalf — owner 2026-08-29: old pre-system fabric) needs a label;
        // parts on real purchase/expense accounts keep the account's own
        // line via the engine. Keyed per account so they don't mix.
        if (isCreditorControl(rc))
          rmSplit[`${leg.sourceId}@${rc}`] ??= [{ line: `Suppliers settled via ${payee}`, weight: 1 }];
      }
    }
    }
  }

  // Salary → department rows. Weights come from aggregateLabour of the payroll
  // month the voucher description names ("… - May'26"); a leg with no parseable
  // month uses its own document month; a month with no payslips gets no split
  // and the leg stays on the account line.
  const deptSplit: RmSplit = {};
  if (salaryLegs.length) {
    if (!map[LABOUR_ACCRUAL_ACCT]) map[LABOUR_ACCRUAL_ACCT] = { section: "DIRECT_LABOUR", order: 10 };
    const MONTHS3 = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" } as const;
    const payrollYm = (desc: string, fallback: string): string => {
      const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'(\d{2})\b/.exec(desc);
      return m ? `20${m[2]}-${MONTHS3[m[1] as keyof typeof MONTHS3]}` : fallback;
    };
    const mixCache = new Map<string, { line: string; weight: number }[]>();
    for (const leg of salaryLegs) {
      const ym = payrollYm(leg.description, leg.ym);
      let mix = mixCache.get(ym);
      if (!mix) {
        try {
          const { byDept } = await aggregateLabour(c.var.DB, ym, orgId);
          mix = byDept.filter((d) => d.costSen > 0).map((d) => ({ line: d.departmentCode, weight: d.costSen }));
        } catch { mix = []; }
        mixCache.set(ym, mix);
      }
      if (mix.length && !deptSplit[leg.sourceId]) deptSplit[leg.sourceId] = mix;
    }
  }

  const statement = buildStatement({
    classified, bankLegs, coa, map, rmSplit, deptSplit, stockGroupOverride: sgOverride,
    fyeMonth, period, editable,
  });
  // Money IN / OUT straight off the bank legs (DR = in, CR = out). Derived
  // here rather than by summing statement lines: the statement's line values
  // carry a per-SECTION display sign, so a salary payment reads positive under
  // "COST / EXPENSE OUT" — summing those gave an in/out pair that didn't add
  // up to the cash surplus. Bank legs tie to it by construction.
  const bankByMonth = new Map<string, { inflow: number; outflow: number }>();
  for (const l of bankLegs) {
    const cur = bankByMonth.get(l.ym) ?? { inflow: 0, outflow: 0 };
    cur.inflow += Number(l.debitSen) || 0;
    cur.outflow -= Number(l.creditSen) || 0;
    bankByMonth.set(l.ym, cur);
  }
  return { ...statement, bankByMonth };
}

app.get("/cashflow-statement", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const period = c.req.query("period") || new Date().toISOString().slice(0, 7);
  const editable = c.req.query("editable") === "1";
  const { bankByMonth: _bank, ...statement } = await computeCashflowStatement(c.var.DB, period, editable, getOrgId(c));
  return c.json({ success: true, data: { period, ...statement } });
});

// GL-truth P&L + Balance Sheet, computed from the immutable
// ledger_journal_entries ⨝ chart_of_accounts (Phase 3, Option C). The
// product/customer revenue cuts stay operational (sourced from invoices),
// per the owner's choice — the GL has no such dimensions. Response shape
// is unchanged so the PL/BS UI tabs render as-is.
app.get("/pl", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const period = c.req.query("period");
  const productCategory = c.req.query("productCategory");
  const customerId = c.req.query("customerId");
  const state = c.req.query("state");
  // Multi-company (Phase 1): OPTIONAL ?orgId= / ?company= scopes the P&L and
  // Balance Sheet to one company. Absent → today's consolidated statements,
  // byte-identical (the GL legs + operational-revenue cut both stay unfiltered).
  const coFilter = companyFilter(c, "orgId");
  const legWhere = coFilter.active ? ` AND ${coFilter.sql}` : "";
  const invWhere = coFilter.active ? ` WHERE ${coFilter.sql}` : "";

  // --- chart of accounts lookup ---
  const coaRes = await c.var.DB.prepare(
    "SELECT code, name, type, specialAccountType, cashFlowCategory FROM chart_of_accounts",
  ).all<{
    code: string;
    name: string;
    type: CoaRow["type"];
    specialAccountType: string | null;
    cashFlowCategory: string | null;
  }>();
  const coa = new Map<
    string,
    {
      name: string;
      type: CoaRow["type"];
      sat: string | null;
      cf: string | null;
    }
  >();
  for (const a of coaRes.results ?? [])
    coa.set(a.code, {
      name: a.name,
      type: a.type,
      sat: a.specialAccountType ?? null,
      cf: a.cashFlowCategory ?? null,
    });

  // --- ledger legs ---
  const legRes = await c.var.DB.prepare(
    `SELECT accountCode, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries WHERE hidden = 0${legWhere}`,
  )
    .bind(...(coFilter.active ? [coFilter.param] : []))
    .all<{
    accountCode: string;
    sourceId: string;
    debitSen: number;
    creditSen: number;
    postedAt: string;
    sourceType: string;
  }>();
  const endYm = periodEndYm(period);
  // Per-account net for the P&L period and cumulative-as-of for the BS.
  // Phase 1 (2026-06): year-close legs zero the P&L accounts into 150-0000
  // Retained Earning — they are bookkeeping, not trading activity, so the
  // P&L view skips them (a close inside the period would otherwise show
  // as a giant negative revenue). The BS view keeps them: that is exactly
  // how retained earnings accumulates and the unclosed-earnings line
  // shrinks to the open year.
  const plDr = new Map<string, number>();
  const plCr = new Map<string, number>();
  const bsDr = new Map<string, number>();
  const bsCr = new Map<string, number>();
  const resolveAcct = await loadAccountResolver(c.var.DB);
  // Opening-balance legs (BS accounts only) are dated at the kv opening
  // date and are bookkeeping, not trading — the P&L view skips them like
  // year_close; the BS view counts them at the opening month.
  const { docDate, openingDate: obDatePl } = await loadDocDateResolver(c.var.DB);
  for (const l of legRes.results ?? []) {
    const dd = docDate(l.sourceType, l.sourceId, l.postedAt); // by document date
    if (legBeforeOpening(l.sourceType, dd, obDatePl)) continue; // pre-opening: not extracted (P&L + BS)
    const opening = isOpeningSource(l.sourceType);
    const ym = dd.slice(0, 7);
    const d = Number(l.debitSen) || 0;
    const cr = Number(l.creditSen) || 0;
    const code = resolveAcct(l.accountCode);
    if (l.sourceType !== "year_close" && !opening && ymInPeriod(ym, period)) {
      plDr.set(code, (plDr.get(code) ?? 0) + d);
      plCr.set(code, (plCr.get(code) ?? 0) + cr);
    }
    if (!endYm || ym <= endYm) {
      bsDr.set(code, (bsDr.get(code) ?? 0) + d);
      bsCr.set(code, (bsCr.get(code) ?? 0) + cr);
    }
  }

  // --- P&L by account (REVENUE credit-normal; COST/EXPENSE debit-normal) ---
  type PLLine = {
    id: string;
    period: string;
    accountCode: string;
    accountName: string;
    category: "REVENUE" | "COGS" | "OPERATING_EXPENSE";
    amount: number;
  };
  const plEntries: PLLine[] = [];
  const cogsByAccount: Record<string, number> = {};
  const opexByAccount: Record<string, number> = {};
  let totalRevenue = 0;
  let totalCOGS = 0;
  let totalOpex = 0;
  // Manufacturing-account breakdown (Malaysian format): cost of production
  // = opening stock + purchases + direct labour + factory overhead + other
  // − closing stock. Classified from COST accounts by special-account type
  // (SOS=opening, SCS=closing) then account-number band.
  const mfg = {
    openingStock: 0,
    purchases: 0,
    directLabour: 0,
    factoryOverhead: 0,
    otherMfg: 0,
    closingStock: 0,
  };
  // Cash-flow buckets by the account's cash_flow_category (O/I/F). This is
  // a categorised P&L-result view (income +, cost/expense −), NOT a full
  // IAS7 statement with working-capital movements — see cashFlowNote.
  const cashFlow = { operating: 0, investing: 0, financing: 0 };
  const bumpCf = (cf: string | null, impact: number) => {
    if (cf === "O") cashFlow.operating += impact;
    else if (cf === "I") cashFlow.investing += impact;
    else if (cf === "F") cashFlow.financing += impact;
  };
  const codes = new Set([...plDr.keys(), ...plCr.keys()]);
  for (const code of codes) {
    const acct = coa.get(code);
    if (!acct) continue;
    const dr = plDr.get(code) ?? 0;
    const cr = plCr.get(code) ?? 0;
    if (acct.type === "REVENUE") {
      const amt = cr - dr;
      if (amt === 0) continue;
      totalRevenue += amt;
      bumpCf(acct.cf, amt);
      plEntries.push({ id: code, period: period ?? "all", accountCode: code, accountName: acct.name, category: "REVENUE", amount: amt });
    } else if (acct.type === "COST") {
      const amt = dr - cr;
      if (amt === 0) continue;
      totalCOGS += amt;
      cogsByAccount[acct.name] = (cogsByAccount[acct.name] ?? 0) + amt;
      bumpCf(acct.cf, -amt);
      if (acct.sat === "SOS") mfg.openingStock += amt;
      else if (acct.sat === "SCS") mfg.closingStock += amt;
      else {
        const p = parseInt(code.split("-")[0], 10) || 0;
        if (p >= 701 && p <= 705) mfg.purchases += amt;
        else if (p === 750) mfg.directLabour += amt;
        else if (p === 780) mfg.factoryOverhead += amt;
        else mfg.otherMfg += amt;
      }
      plEntries.push({ id: code, period: period ?? "all", accountCode: code, accountName: acct.name, category: "COGS", amount: amt });
    } else if (acct.type === "EXPENSE") {
      const amt = dr - cr;
      if (amt === 0) continue;
      totalOpex += amt;
      bumpCf(acct.cf, -amt);
      opexByAccount[acct.name] = (opexByAccount[acct.name] ?? 0) + amt;
      plEntries.push({ id: code, period: period ?? "all", accountCode: code, accountName: acct.name, category: "OPERATING_EXPENSE", amount: amt });
    }
  }
  const grossProfit = totalRevenue - totalCOGS;
  const grossProfitPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const netProfit = grossProfit - totalOpex;
  const netProfitPct = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  // --- real-time stock into the Manufacturing Account (read, not post) ---
  // Opening = inventory value as of the month BEFORE the period start;
  // closing = inventory value as of the period end (or now). Sourced live
  // from the cost ledger so opening the report always reflects current
  // stock — no period-close JE, no double-count.
  const [openInv, closeInv, stockMapRow] = await Promise.all([
    liveInventory(c.var.DB, prevYm(periodStartYm(period))),
    liveInventory(c.var.DB, periodEndYm(period)),
    c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("coa_stock_map")
      .first<{ value: string }>(),
  ]);
  let stockMap = DEFAULT_STOCK_MAP;
  try {
    const parsed = JSON.parse(stockMapRow?.value ?? "null");
    if (parsed && typeof parsed === "object")
      stockMap = { ...DEFAULT_STOCK_MAP, ...parsed };
  } catch {
    stockMap = DEFAULT_STOCK_MAP;
  }
  // Override the GL SOS/SCS lines (which are 0 until a period-close JE
  // exists) with the live valuation, and recompute cost of production.
  mfg.openingStock = openInv.total;
  mfg.closingStock = -closeInv.total;
  const costOfProduction =
    mfg.openingStock +
    mfg.purchases +
    mfg.directLabour +
    mfg.factoryOverhead +
    mfg.otherMfg +
    mfg.closingStock;
  // Per-bucket closing-stock breakdown for the detailed mapping display.
  const inventoryBreakdown = [
    ...Object.entries(closeInv.rmByGroup).map(([g, val]) => {
      const m = stockMap.rm[g] ?? stockMap.rmDefault;
      return {
        bucket: `RM · ${g}`,
        value: val,
        stockAcct: m.stock,
        openingAcct: m.opening,
        closingAcct: m.closing,
      };
    }),
    {
      bucket: "Work in Progress",
      value: closeInv.wip,
      stockAcct: stockMap.wip.stock,
      openingAcct: stockMap.wip.opening,
      closingAcct: stockMap.wip.closing,
    },
    {
      bucket: "Finished Goods",
      value: closeInv.fg,
      stockAcct: stockMap.fg.stock,
      openingAcct: stockMap.fg.opening,
      closingAcct: stockMap.fg.closing,
    },
  ];

  // --- operational revenue cuts from invoices (NOT the GL) ---
  const [invRes, itemRes, prodRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT id, customerName, totalSen, invoiceDate, customerId, customerState, status FROM invoices${invWhere}`,
    )
      .bind(...(coFilter.active ? [coFilter.param] : []))
      .all<{
      id: string;
      customerName: string;
      totalSen: number;
      invoiceDate: string;
      customerId: string;
      customerState: string | null;
      status: string;
    }>(),
    c.var.DB.prepare(
      "SELECT invoiceId, productCode, totalSen FROM invoice_items",
    ).all<{ invoiceId: string; productCode: string; totalSen: number }>(),
    c.var.DB.prepare("SELECT code, category FROM products").all<{
      code: string;
      category: string;
    }>(),
  ]);
  const prodCat = new Map<string, string>();
  for (const p of prodRes.results ?? []) prodCat.set(p.code, p.category);
  const invById = new Map<
    string,
    { cust: string; cid: string; st: string | null; ym: string; status: string }
  >();
  for (const i of invRes.results ?? [])
    invById.set(i.id, {
      cust: i.customerName || "Unknown",
      cid: i.customerId,
      st: i.customerState,
      ym: String(i.invoiceDate ?? "").slice(0, 7),
      status: i.status,
    });
  const revenueByCustomer: Record<string, number> = {};
  for (const i of invRes.results ?? []) {
    if (i.status === "CANCELLED" || i.status === "DRAFT") continue;
    const ym = String(i.invoiceDate ?? "").slice(0, 7);
    if (!ymInPeriod(ym, period)) continue;
    if (customerId && i.customerId !== customerId) continue;
    if (state && i.customerState !== state) continue;
    revenueByCustomer[i.customerName || "Unknown"] =
      (revenueByCustomer[i.customerName || "Unknown"] ?? 0) + (Number(i.totalSen) || 0);
  }
  const revenueByProduct: Record<string, number> = {};
  for (const it of itemRes.results ?? []) {
    const inv = invById.get(it.invoiceId);
    if (!inv) continue;
    if (inv.status === "CANCELLED" || inv.status === "DRAFT") continue;
    if (!ymInPeriod(inv.ym, period)) continue;
    if (customerId && inv.cid !== customerId) continue;
    if (state && inv.st !== state) continue;
    const cat = prodCat.get(it.productCode) || "OTHER";
    if (productCategory && cat !== productCategory) continue;
    revenueByProduct[cat] = (revenueByProduct[cat] ?? 0) + (Number(it.totalSen) || 0);
  }

  // --- Balance sheet from the ledger (ASSET/LIABILITY/EQUITY) ---
  const balanceSheet: {
    id: string;
    accountCode: string;
    accountName: string;
    category: BsSection;
    balance: number;
    asOfDate: string;
  }[] = [];
  const asOf = endYm ? `${endYm}-28` : new Date().toISOString().slice(0, 10);
  const bsOverride = await getBsSectionMap(c.var.DB);
  const bsCodes = new Set([...bsDr.keys(), ...bsCr.keys()]);
  for (const code of bsCodes) {
    const acct = coa.get(code);
    if (!acct) continue;
    const section = bsSectionFor(code, acct.type, bsOverride);
    if (!section) continue; // not a balance-sheet account
    const dr = bsDr.get(code) ?? 0;
    const cr = bsCr.get(code) ?? 0;
    const bal = bsSectionClass(section) === "asset" ? dr - cr : cr - dr;
    if (bal === 0) continue;
    balanceSheet.push({
      id: code,
      accountCode: code,
      accountName: acct.name,
      category: section,
      balance: bal,
      asOfDate: asOf,
    });
  }
  // Un-closed P&L result as of the BS cutoff — CUMULATIVE revenue/cost/
  // expense nets including year_close legs (a closed FY nets to zero
  // here, leaving only the open year). Phase 1 fix: the old code injected
  // the PERIOD-scoped netProfit, so viewing a single month understated
  // equity by every other month's earnings and the sheet didn't balance.
  let unclosedEarnings = 0;
  for (const code of bsCodes) {
    const acct = coa.get(code);
    if (!acct) continue;
    const dr = bsDr.get(code) ?? 0;
    const cr = bsCr.get(code) ?? 0;
    if (acct.type === "REVENUE") unclosedEarnings += cr - dr;
    else if (acct.type === "COST" || acct.type === "EXPENSE")
      unclosedEarnings -= dr - cr;
  }
  if (unclosedEarnings !== 0)
    balanceSheet.push({
      id: "NP-CURRENT",
      accountCode: "NP-CURRENT",
      accountName: "Current Year Earnings (unclosed)",
      category: "EQUITY",
      balance: unclosedEarnings,
      asOfDate: asOf,
    });

  return c.json({
    success: true,
    data: {
      entries: plEntries,
      totals: {
        revenue: totalRevenue,
        cogs: totalCOGS,
        grossProfit,
        grossProfitPct: Math.round(grossProfitPct * 100) / 100,
        operatingExpenses: totalOpex,
        netProfit,
        netProfitPct: Math.round(netProfitPct * 100) / 100,
      },
      revenueByProduct,
      revenueByCustomer,
      cogsByAccount,
      opexByAccount,
      balanceSheet,
      manufacturing: {
        ...mfg,
        // Opening/closing stock are LIVE from the cost ledger (read at
        // report time, not posted). Cost of production = opening +
        // purchases + labour + overhead + other − closing.
        costOfProduction,
        inventoryBreakdown,
        stockNote:
          "Opening/closing stock are real-time from the cost ledger when this report is opened (no period-close entry, no double-count). Purchases/labour/overhead come from the GL and grow as the purchase-invoice & payroll posting nodes are wired.",
      },
      cashFlow: {
        ...cashFlow,
        netChange:
          cashFlow.operating + cashFlow.investing + cashFlow.financing,
        note: "Categorised by each account's cash-flow tag (O/I/F) on a P&L-result basis (income +, cost/expense −). Not a full IAS7 statement — working-capital movements are not included.",
      },
    },
  });
});

// ---------------------------------------------------------------------------
// PAYMENT / EXPENSE VOUCHERS + OFFICIAL RECEIPTS (Phase 3.2/3.3, 2026-06)
//
// PV pays an expense: DR each line account, CR the SBK/SCH bank/cash
// account. The 「先挂账」 switch instead credits an accrual account
// (410-x / 405-0000) now and clears it against the bank on settle.
// OR is money in that is NOT a trade-invoice payment: DR bank/cash,
// CR each line (sundry income / other-debtor recovery). Both post to
// the immutable ledger immediately; void posts a reversal.
// ---------------------------------------------------------------------------


type VoucherLineIn = { accountCode: string; description?: string; amountSen: number };

// Shared line validation for PV/OR: postable, real, no debtor controls,
// no bank/cash (a bank-to-bank move is a Cash Book transfer, not this).
function validateDocLines(
  coa: Map<string, { type: CoaRow["type"]; specialAccountType: string | null; isPostable: number | null }>,
  linesIn: unknown,
): { ok: true; lines: { accountCode: string; description: string; amountSen: number }[]; totalSen: number } | { ok: false; error: string } {
  if (!Array.isArray(linesIn) || linesIn.length === 0) {
    return { ok: false, error: "At least one line is required" };
  }
  const lines: { accountCode: string; description: string; amountSen: number }[] = [];
  let totalSen = 0;
  for (const raw of linesIn as VoucherLineIn[]) {
    const amountSen = Math.round(Number(raw.amountSen) || 0);
    if (amountSen <= 0) return { ok: false, error: "Every line needs a positive amount" };
    const acct = coa.get(raw.accountCode);
    if (!acct) return { ok: false, error: `Account ${raw.accountCode} not found` };
    if ((acct.isPostable ?? 1) !== 1) {
      return { ok: false, error: `${raw.accountCode} is a non-postable header account` };
    }
    if (acct.specialAccountType === "SDC") {
      return { ok: false, error: `${raw.accountCode} is a debtor control — trade receipts go through invoice payments, other-debtor recovery uses 305-0000 via Other D/C` };
    }
    if (acct.specialAccountType === "SBK" || acct.specialAccountType === "SCH") {
      return { ok: false, error: `${raw.accountCode} is a bank/cash account — pick it as the paying/receiving account, not a line` };
    }
    lines.push({ accountCode: raw.accountCode, description: String(raw.description ?? ""), amountSen });
    totalSen += amountSen;
  }
  return { ok: true, lines, totalSen };
}

app.get("/payment-vouchers", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  try {
    const [pvRes, lineRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT payment_vouchers.*, dl.state AS lifecycleState
           FROM payment_vouchers
           LEFT JOIN document_lifecycle dl
             ON dl.sourceType = 'payment_voucher'
            AND dl.sourceId = payment_vouchers.id
          WHERE (dl.state IS NULL OR dl.state <> 'DELETED')
          ORDER BY date DESC, pvNo DESC LIMIT 500`,
      ).all(),
      c.var.DB.prepare(
        `SELECT * FROM payment_voucher_lines ORDER BY lineOrder`,
      ).all(),
    ]);
    const lines = (lineRes.results ?? []) as { voucherId: string }[];
    const data = (pvRes.results ?? []).map((v) => ({
      ...(v as object),
      lines: lines.filter((l) => l.voucherId === (v as { id: string }).id),
    }));
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: true, data: [], migrationMissing: true });
  }
});

app.post("/payment-vouchers", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const date = String(body.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);
    }
    const accrued = body.accrued === true || body.accrued === 1;
    const productLine =
      body.productLine === "SOFA" || body.productLine === "BEDFRAME"
        ? body.productLine
        : null;
    const coaRes = await c.var.DB.prepare(
      "SELECT code, type, specialAccountType, isPostable FROM chart_of_accounts",
    ).all<{ code: string; type: CoaRow["type"]; specialAccountType: string | null; isPostable: number | null }>();
    const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
    const v = validateDocLines(coa, body.lines);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);

    let payFrom: string | null = null;
    let accrualAccount: string | null = null;
    if (accrued) {
      accrualAccount = String(body.accrualAccount || "");
      // 405-x (Other Creditors) is not a valid expense-accrual target — record
      // creditor liabilities via an Other Creditor bill instead (F4 #5).
      if (accrualAccount.startsWith("405")) {
        return c.json(
          { success: false, error: "Expense accrual must use a 410-x accrued-expense account, not 405 Other Creditors. To owe a creditor, raise an Other Creditor bill." },
          400,
        );
      }
      const acct = coa.get(accrualAccount);
      if (!acct || acct.type !== "LIABILITY" || (acct.isPostable ?? 1) !== 1) {
        return c.json(
          { success: false, error: "Pick a postable LIABILITY accrual account (410-x)" },
          400,
        );
      }
    } else {
      payFrom = String(body.payFrom || "");
      const acct = coa.get(payFrom);
      if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")) {
        return c.json(
          { success: false, error: "Pay From must be a bank (SBK) or cash (SCH) account" },
          400,
        );
      }
    }
    const id = `pv-${crypto.randomUUID().slice(0, 8)}`;
    const pvNo = await issueDocNumber(c.var.DB, {
      bankAccountCode: payFrom ?? "",
      direction: "out",
      dateIso: date,
    });
    const now = new Date().toISOString();
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const creditAccount = accrued ? accrualAccount! : payFrom!;
    const legs: LedgerEntryInput[] = v.lines.map((l, idx) => ({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "payment_voucher",
      sourceId: id,
      legNo: idx + 1,
      accountCode: l.accountCode,
      debitSen: l.amountSen,
      creditSen: 0,
      description: `${pvNo} · ${l.description || body.description || "Payment"}${accrued ? " (accrued)" : ""}`,
      actorUserId,
      orgId,
    }));
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "payment_voucher",
      sourceId: id,
      legNo: legs.length + 1,
      accountCode: creditAccount,
      debitSen: 0,
      creditSen: v.totalSen,
      description: `${pvNo} · ${body.payee ? `to ${body.payee}` : "Payment"}${accrued ? " (accrued)" : ""}`,
      actorUserId,
      orgId,
    });
    const { statements: ledgerStmts } = await buildJournalEntryStatements(
      c.var.DB,
      orgId,
      legs,
    );
    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO payment_vouchers (
           id, pvNo, date, payee, description, payFrom, accrued,
           accrualAccount, settledAt, productLine, totalSen, status,
           createdBy, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'POSTED', ?, ?, ?)`,
      ).bind(
        id, pvNo, date,
        String(body.payee ?? ""), String(body.description ?? ""),
        payFrom, accrued ? 1 : 0, accrualAccount, productLine,
        v.totalSen, actorUserId, now, now,
      ),
      ...v.lines.map((l, idx) =>
        c.var.DB.prepare(
          `INSERT INTO payment_voucher_lines (id, voucherId, accountCode, description, amountSen, lineOrder)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(`pvl-${crypto.randomUUID().slice(0, 8)}`, id, l.accountCode, l.description, l.amountSen, idx),
      ),
      ...ledgerStmts,
    ];
    await c.var.DB.batch(statements);
    return c.json({ success: true, data: { id, pvNo } }, 201);
  } catch (e) {
    console.error("[pv] create failed:", e);
    return c.json(
      { success: false, error: "Failed to save the payment — is migration 0159 applied?" },
      400,
    );
  }
});

// Clear an accrued voucher against the bank: DR accrual, CR bank/cash.
app.post("/payment-vouchers/:id/settle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const pv = await c.var.DB.prepare(
      "SELECT * FROM payment_vouchers WHERE id = ?",
    )
      .bind(id)
      .first<{ id: string; pvNo: string; accrued: number; accrualAccount: string | null; settledAt: string | null; status: string; totalSen: number; payee: string | null }>();
    if (!pv) return c.json({ success: false, error: "Voucher not found" }, 404);
    if (pv.status !== "POSTED" || pv.accrued !== 1 || pv.settledAt) {
      return c.json(
        { success: false, error: "Only an unsettled accrued voucher can be settled" },
        400,
      );
    }
    const payFrom = String(body.payFrom || "");
    const acct = await c.var.DB.prepare(
      "SELECT specialAccountType FROM chart_of_accounts WHERE code = ?",
    )
      .bind(payFrom)
      .first<{ specialAccountType: string | null }>();
    if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")) {
      return c.json(
        { success: false, error: "Pay From must be a bank (SBK) or cash (SCH) account" },
        400,
      );
    }
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const legs: LedgerEntryInput[] = [
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "payment_voucher_settle",
        sourceId: id,
        legNo: 1,
        accountCode: pv.accrualAccount!,
        debitSen: pv.totalSen,
        creditSen: 0,
        description: `${pv.pvNo} · accrual cleared`,
        actorUserId,
        orgId,
      },
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "payment_voucher_settle",
        sourceId: id,
        legNo: 2,
        accountCode: payFrom,
        debitSen: 0,
        creditSen: pv.totalSen,
        description: `${pv.pvNo} · paid${pv.payee ? ` to ${pv.payee}` : ""}`,
        actorUserId,
        orgId,
      },
    ];
    const { statements: ledgerStmts } = await buildJournalEntryStatements(
      c.var.DB,
      orgId,
      legs,
    );
    await c.var.DB.batch([
      c.var.DB.prepare(
        "UPDATE payment_vouchers SET payFrom = ?, settledAt = ?, updated_at = ? WHERE id = ?",
      ).bind(payFrom, new Date().toISOString(), new Date().toISOString(), id),
      ...ledgerStmts,
    ]);
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.post("/payment-vouchers/:id/lifecycle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  let action: "void" | "delete" | "unvoid";
  try { action = ((await c.req.json()) as { action: string }).action as typeof action; } catch { return c.json({ success: false, error: "Invalid body" }, 400); }
  if (!["void", "delete", "unvoid"].includes(action)) return c.json({ success: false, error: "action must be void|delete|unvoid" }, 400);

  const pv = await c.var.DB.prepare("SELECT id, pvNo, status FROM payment_vouchers WHERE id = ?").bind(id).first<{ id: string; pvNo: string; status: string }>();
  if (!pv) return c.json({ success: false, error: "Voucher not found" }, 404);

  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  let lc: { statements: D1PreparedStatement[]; newState: string };
  try {
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: ["payment_voucher", "payment_voucher_settle"], voidSourceType: "payment_voucher_void", sourceId: id, action, actorUserId, descriptionTag: `${action.toUpperCase()} · ${pv.pvNo}` });
  } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }

  // doc-specific side effect: sync status column (lifecycle state is source of truth; this is for UI)
  const docStatus = lc.newState === "ACTIVE" ? "POSTED" : "VOID";
  const statements: D1PreparedStatement[] = [
    ...lc.statements,
    c.var.DB.prepare("UPDATE payment_vouchers SET status = ? WHERE id = ?").bind(docStatus, id),
  ];
  // Cover restate legs (payment_voucher_restate_post:*) on void/delete so an
  // edited-then-voided voucher still nets to zero in the GL.
  if (lc.newState !== "ACTIVE") {
    statements.push(
      c.var.DB.prepare(`UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'payment_voucher%'`).bind(id, orgId),
    );
  }
  await c.var.DB.batch(statements);
  return c.json({ success: true, data: { state: lc.newState } });
});

// Edit a payment voucher IN PLACE — same PV number; reverses the live legs and
// re-posts the corrected ones (payment_voucher_restate_rev/post:<stamp>), then
// collapses to the newest post. Mirrors the customer-receipt restate. A settled
// accrual is un-settled (its settle legs are reversed), so re-settle if needed.
app.post("/payment-vouchers/:id/restate", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  try {
    const pv = await c.var.DB.prepare("SELECT id, pvNo FROM payment_vouchers WHERE id = ?").bind(id).first<{ id: string; pvNo: string }>();
    if (!pv) return c.json({ success: false, error: "Voucher not found" }, 404);
    const body = await c.req.json();
    const date = String(body.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);
    const accrued = body.accrued === true || body.accrued === 1;
    const productLine = body.productLine === "SOFA" || body.productLine === "BEDFRAME" ? body.productLine : null;
    const coaRes = await c.var.DB.prepare("SELECT code, type, specialAccountType, isPostable FROM chart_of_accounts").all<{ code: string; type: CoaRow["type"]; specialAccountType: string | null; isPostable: number | null }>();
    const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
    const v = validateDocLines(coa, body.lines);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);
    let payFrom: string | null = null;
    let accrualAccount: string | null = null;
    if (accrued) {
      accrualAccount = String(body.accrualAccount || "");
      if (accrualAccount.startsWith("405")) return c.json({ success: false, error: "Expense accrual must use a 410-x accrued-expense account, not 405 Other Creditors." }, 400);
      const acct = coa.get(accrualAccount);
      if (!acct || acct.type !== "LIABILITY" || (acct.isPostable ?? 1) !== 1) return c.json({ success: false, error: "Pick a postable LIABILITY accrual account (410-x)" }, 400);
    } else {
      payFrom = String(body.payFrom || "");
      const acct = coa.get(payFrom);
      if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")) return c.json({ success: false, error: "Pay From must be a bank (SBK) or cash (SCH) account" }, 400);
    }
    const now = new Date().toISOString();
    const actorUserId = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const stamp = Date.now();
    const creditAccount = accrued ? accrualAccount! : payFrom!;

    const statements: D1PreparedStatement[] = [];
    // 1. Reverse the live voucher legs (incl. any settle legs).
    const cur = (await c.var.DB.prepare(`SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries WHERE sourceId = ? AND orgId = ? AND hidden = 0 AND sourceType LIKE 'payment_voucher%'`).bind(id, orgId).all<{ accountCode: string; debitSen: number; creditSen: number }>()).results ?? [];
    const revLegs = cur.map((l, i) => ({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: `payment_voucher_restate_rev:${stamp}`, sourceId: id, legNo: i + 1, accountCode: l.accountCode, debitSen: l.creditSen, creditSen: l.debitSen, description: `Restate rev · ${pv.pvNo}`, actorUserId, orgId }));
    // 2. Corrected legs (DR expense lines, CR pay-from / accrual).
    const postSource = `payment_voucher_restate_post:${stamp}`;
    const newLegs: LedgerEntryInput[] = v.lines.map((l, idx) => ({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: postSource, sourceId: id, legNo: idx + 1, accountCode: l.accountCode, debitSen: l.amountSen, creditSen: 0, description: `${pv.pvNo} · ${l.description || body.description || "Payment"}${accrued ? " (accrued)" : ""}`, actorUserId, orgId }));
    newLegs.push({ id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: postSource, sourceId: id, legNo: newLegs.length + 1, accountCode: creditAccount, debitSen: 0, creditSen: v.totalSen, description: `${pv.pvNo} · ${body.payee ? `to ${body.payee}` : "Payment"}${accrued ? " (accrued)" : ""}`, actorUserId, orgId });
    const { statements: jeStmts } = await buildJournalEntryStatements(c.var.DB, orgId, [...revLegs, ...newLegs]);
    statements.push(...jeStmts);
    statements.push(c.var.DB.prepare(`UPDATE ledger_journal_entries SET hidden = 1 WHERE sourceId = ? AND orgId = ? AND sourceType LIKE 'payment_voucher%' AND sourceType <> ?`).bind(id, orgId, postSource));
    // 3. Update the voucher row + replace its lines (same id + pvNo); un-settle.
    statements.push(c.var.DB.prepare(`UPDATE payment_vouchers SET date = ?, payee = ?, description = ?, payFrom = ?, accrued = ?, accrualAccount = ?, settledAt = NULL, productLine = ?, totalSen = ?, status = 'POSTED', updated_at = ? WHERE id = ?`).bind(date, String(body.payee ?? ""), String(body.description ?? ""), payFrom, accrued ? 1 : 0, accrualAccount, productLine, v.totalSen, now, id));
    statements.push(c.var.DB.prepare("DELETE FROM payment_voucher_lines WHERE voucherId = ?").bind(id));
    v.lines.forEach((l, idx) => {
      statements.push(c.var.DB.prepare(`INSERT INTO payment_voucher_lines (id, voucherId, accountCode, description, amountSen, lineOrder) VALUES (?, ?, ?, ?, ?, ?)`).bind(`pvl-${crypto.randomUUID().slice(0, 8)}`, id, l.accountCode, l.description, l.amountSen, idx));
    });
    await c.var.DB.batch(statements);
    return c.json({ success: true, data: { id, pvNo: pv.pvNo } });
  } catch (e) {
    console.error("[pv] restate failed:", e);
    return c.json({ success: false, error: "Failed to update the payment voucher" }, 400);
  }
});

app.get("/official-receipts", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  try {
    const [orRes, lineRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT official_receipts.*, dl.state AS lifecycleState
         FROM official_receipts
         LEFT JOIN document_lifecycle dl
           ON dl.sourceType = 'official_receipt'
          AND dl.sourceId = official_receipts.id
         WHERE (dl.state IS NULL OR dl.state <> 'DELETED')
         ORDER BY date DESC, orNo DESC LIMIT 500`,
      ).all(),
      c.var.DB.prepare(
        `SELECT * FROM official_receipt_lines ORDER BY lineOrder`,
      ).all(),
    ]);
    const lines = (lineRes.results ?? []) as { receiptId: string }[];
    const data = (orRes.results ?? []).map((r) => ({
      ...(r as object),
      lines: lines.filter((l) => l.receiptId === (r as { id: string }).id),
    }));
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: true, data: [], migrationMissing: true });
  }
});

app.post("/official-receipts", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const date = String(body.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);
    }
    const coaRes = await c.var.DB.prepare(
      "SELECT code, type, specialAccountType, isPostable FROM chart_of_accounts",
    ).all<{ code: string; type: CoaRow["type"]; specialAccountType: string | null; isPostable: number | null }>();
    const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
    const v = validateDocLines(coa, body.lines);
    if (!v.ok) return c.json({ success: false, error: v.error }, 400);
    const payTo = String(body.payTo || "");
    const payToAcct = coa.get(payTo);
    if (!payToAcct || (payToAcct.specialAccountType !== "SBK" && payToAcct.specialAccountType !== "SCH")) {
      return c.json(
        { success: false, error: "Deposit To must be a bank (SBK) or cash (SCH) account" },
        400,
      );
    }
    const id = `or-${crypto.randomUUID().slice(0, 8)}`;
    const orNo = await issueDocNumber(c.var.DB, {
      bankAccountCode: payTo,
      direction: "in",
      dateIso: date,
    });
    const now = new Date().toISOString();
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const legs: LedgerEntryInput[] = [
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "official_receipt",
        sourceId: id,
        legNo: 1,
        accountCode: payTo,
        debitSen: v.totalSen,
        creditSen: 0,
        description: `${orNo} · ${body.receivedFrom ? `from ${body.receivedFrom}` : "Receipt"}`,
        actorUserId,
        orgId,
      },
      ...v.lines.map((l, idx) => ({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "official_receipt",
        sourceId: id,
        legNo: idx + 2,
        accountCode: l.accountCode,
        debitSen: 0,
        creditSen: l.amountSen,
        description: `${orNo} · ${l.description || body.description || "Receipt"}`,
        actorUserId,
        orgId,
      })),
    ];
    const { statements: ledgerStmts } = await buildJournalEntryStatements(
      c.var.DB,
      orgId,
      legs,
    );
    await c.var.DB.batch([
      c.var.DB.prepare(
        `INSERT INTO official_receipts (
           id, orNo, date, receivedFrom, description, payTo, totalSen,
           status, createdBy, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
      ).bind(
        id, orNo, date,
        String(body.receivedFrom ?? ""), String(body.description ?? ""),
        payTo, v.totalSen, actorUserId, now, now,
      ),
      ...v.lines.map((l, idx) =>
        c.var.DB.prepare(
          `INSERT INTO official_receipt_lines (id, receiptId, accountCode, description, amountSen, lineOrder)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(`orl-${crypto.randomUUID().slice(0, 8)}`, id, l.accountCode, l.description, l.amountSen, idx),
      ),
      ...ledgerStmts,
    ]);
    return c.json({ success: true, data: { id, orNo } }, 201);
  } catch (e) {
    console.error("[or] create failed:", e);
    return c.json(
      { success: false, error: "Failed to save the receipt — is migration 0159 applied?" },
      400,
    );
  }
});

app.post("/official-receipts/:id/lifecycle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  let action: "void" | "delete" | "unvoid";
  try { action = ((await c.req.json()) as { action: string }).action as typeof action; } catch { return c.json({ success: false, error: "Invalid body" }, 400); }
  if (!["void", "delete", "unvoid"].includes(action)) return c.json({ success: false, error: "action must be void|delete|unvoid" }, 400);

  const orRow = await c.var.DB.prepare("SELECT id, orNo, status FROM official_receipts WHERE id = ?").bind(id).first<{ id: string; orNo: string; status: string }>();
  if (!orRow) return c.json({ success: false, error: "Receipt not found" }, 404);

  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  let lc: { statements: D1PreparedStatement[]; newState: string };
  try {
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: ["official_receipt"], voidSourceType: "official_receipt_void", sourceId: id, action, actorUserId, descriptionTag: `${action.toUpperCase()} · ${orRow.orNo}` });
  } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }

  // doc-specific side effect: sync status column (lifecycle state is source of truth; this is for UI)
  const docStatus = lc.newState === "ACTIVE" ? "POSTED" : "VOID";
  const statements: D1PreparedStatement[] = [
    ...lc.statements,
    c.var.DB.prepare("UPDATE official_receipts SET status = ?, updated_at = ? WHERE id = ?").bind(docStatus, new Date().toISOString(), id),
  ];
  await c.var.DB.batch(statements);
  return c.json({ success: true, data: { state: lc.newState } });
});

// ---------------------------------------------------------------------------
// FUND TRANSFER — move money between two bank/cash accounts.
// Stored ONLY in the immutable ledger (sourceType fund_transfer / fund_transfer_void).
// No dedicated table.
// ---------------------------------------------------------------------------

app.post("/fund-transfers", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  const body = await c.req.json();
  const fromAccount = String(body.fromAccount || "");
  const toAccount = String(body.toAccount || "");
  const amountSen = Math.round(Number(body.amountSen) || 0);
  const date = String(body.date || "");
  const reference = String(body.reference || "");

  if (!fromAccount || !toAccount) {
    return c.json({ success: false, error: "fromAccount and toAccount are required" }, 400);
  }
  if (fromAccount === toAccount) {
    return c.json({ success: false, error: "fromAccount and toAccount must be different" }, 400);
  }
  if (amountSen <= 0) {
    return c.json({ success: false, error: "amountSen must be a positive integer (sen)" }, 400);
  }
  if (!date) {
    return c.json({ success: false, error: "date is required (YYYY-MM-DD)" }, 400);
  }

  const coaRes = await c.var.DB.prepare(
    "SELECT code, type, specialAccountType, isPostable FROM chart_of_accounts",
  ).all<{ code: string; type: CoaRow["type"]; specialAccountType: string | null; isPostable: number | null }>();
  const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));

  const fromAcct = coa.get(fromAccount);
  if (!fromAcct || (fromAcct.specialAccountType !== "SBK" && fromAcct.specialAccountType !== "SCH")) {
    return c.json(
      { success: false, error: "fromAccount must be a bank (SBK) or cash (SCH) account" },
      400,
    );
  }
  const toAcct = coa.get(toAccount);
  if (!toAcct || (toAcct.specialAccountType !== "SBK" && toAcct.specialAccountType !== "SCH")) {
    return c.json(
      { success: false, error: "toAccount must be a bank (SBK) or cash (SCH) account" },
      400,
    );
  }

  const no = await issueDocNumber(c.var.DB, {
    bankAccountCode: fromAccount,
    direction: "out",
    dateIso: date,
  });

  const legs: LedgerEntryInput[] = [
    {
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "fund_transfer",
      sourceId: no,
      legNo: 1,
      accountCode: toAccount,
      debitSen: amountSen,
      creditSen: 0,
      description: `Transfer ${no}${reference ? ` · ${reference}` : ""}`,
      actorUserId,
      orgId,
    },
    {
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "fund_transfer",
      sourceId: no,
      legNo: 2,
      accountCode: fromAccount,
      debitSen: 0,
      creditSen: amountSen,
      description: `Transfer ${no}${reference ? ` · ${reference}` : ""}`,
      actorUserId,
      orgId,
    },
  ];

  try {
    const { statements } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
    await c.var.DB.batch(statements);
  } catch (e) {
    console.error("[fund-transfer] GL post failed:", e);
    return c.json({ success: false, error: "Failed to post fund transfer to ledger" }, 500);
  }

  // Record the transfer's OWN date so reports bucket it by document date, not by
  // the entry timestamp (ledger postedAt). Best-effort — the transfer is already
  // posted; if this fails the resolver just falls back to postedAt (a same-day
  // transfer is unaffected).
  try {
    await ensureFundTransfersTable(c.var.DB);
    await c.var.DB.prepare(
      "INSERT INTO fund_transfers (id, transfer_no, date, org_id) VALUES (?, ?, ?, ?)",
    )
      .bind(`ft-${crypto.randomUUID().slice(0, 8)}`, no, date, orgId)
      .run();
  } catch (e) {
    console.error("[fund-transfer] doc-date row failed (transfer still posted):", e);
  }

  return c.json({ success: true, data: { transferNo: no } });
});

app.get("/fund-transfers", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);

  const resolve = await loadAccountResolver(c.var.DB);

  const [legRes, coaRes, lifeRes] = await Promise.all([
    // Only the original `fund_transfer` legs, and only visible ones: DELETED hides
    // them (hidden=1) so they drop out here; ACTIVE/VOID keep hidden=0 and remain.
    c.var.DB.prepare(
      `SELECT accountCode, sourceType, sourceId, debitSen, creditSen, description, postedAt
         FROM ledger_journal_entries
        WHERE sourceType = 'fund_transfer' AND hidden = 0 AND orgId = ?`,
    ).bind(orgId).all<{
      accountCode: string;
      sourceType: string;
      sourceId: string;
      debitSen: number;
      creditSen: number;
      description: string;
      postedAt: string;
    }>(),
    c.var.DB.prepare(
      "SELECT code, name FROM chart_of_accounts",
    ).all<{ code: string; name: string }>(),
    // Lifecycle state per transfer no (no record → ACTIVE; VOID shown with badge;
    // DELETED never appears because its original legs are hidden above).
    c.var.DB.prepare(
      "SELECT sourceId, state FROM document_lifecycle WHERE sourceType = 'fund_transfer' AND orgId = ?",
    ).bind(orgId).all<{ sourceId: string; state: string }>(),
  ]);

  const nameMap = new Map(
    (coaRes.results ?? []).map((a) => [a.code, a.name] as const),
  );
  const nameOf = (code: string) => nameMap.get(code) ?? nameMap.get(resolve(code)) ?? code;

  const rows = legRes.results ?? [];

  // Each transfer's own (document) date, falling back to postedAt for legacy
  // transfers that predate the fund_transfers table.
  const ftDate = new Map<string, string>();
  try {
    const ftRes = await c.var.DB.prepare(
      "SELECT transfer_no AS tno, date AS dt FROM fund_transfers WHERE org_id = ?",
    )
      .bind(orgId)
      .all<{ tno: string; dt: string }>();
    for (const r of ftRes.results ?? [])
      if (r.tno) ftDate.set(String(r.tno), String(r.dt ?? "").slice(0, 10));
  } catch {
    /* table not created yet → postedAt fallback below */
  }

  // Map each transfer no → lifecycle state (default ACTIVE when no record).
  const stateOf = new Map<string, string>();
  for (const l of lifeRes.results ?? []) stateOf.set(l.sourceId, l.state);

  // Rows are already only original `fund_transfer` legs (void legs are not read);
  // group them by no to rebuild one transfer per leg-group.
  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const grp = grouped.get(r.sourceId) ?? [];
    grp.push(r);
    grouped.set(r.sourceId, grp);
  }

  const out: {
    no: string;
    date: string;
    fromAccount: string;
    toAccount: string;
    fromName: string;
    toName: string;
    amountSen: number;
    description: string;
    lifecycleState: string;
  }[] = [];

  for (const [sourceId, legs] of grouped) {
    const toLeg = legs.find((l) => (Number(l.debitSen) || 0) > 0);
    const fromLeg = legs.find((l) => (Number(l.creditSen) || 0) > 0);
    if (!toLeg || !fromLeg) continue;
    const resolvedFrom = resolve(fromLeg.accountCode);
    const resolvedTo = resolve(toLeg.accountCode);
    out.push({
      no: sourceId,
      date: ftDate.get(sourceId) ?? String(toLeg.postedAt || "").slice(0, 10),
      fromAccount: resolvedFrom,
      toAccount: resolvedTo,
      fromName: nameOf(fromLeg.accountCode),
      toName: nameOf(toLeg.accountCode),
      amountSen: Number(toLeg.debitSen) || 0,
      description: String(toLeg.description || ""),
      lifecycleState: stateOf.get(sourceId) ?? "ACTIVE",
    });
  }

  out.sort((a, b) => (a.no < b.no ? 1 : a.no > b.no ? -1 : 0));

  return c.json({ success: true, data: out });
});

app.post("/fund-transfers/:no/lifecycle", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const no = c.req.param("no");
  let action: "void" | "delete" | "unvoid";
  try { action = ((await c.req.json()) as { action: string }).action as typeof action; } catch { return c.json({ success: false, error: "Invalid body" }, 400); }
  if (!["void", "delete", "unvoid"].includes(action)) return c.json({ success: false, error: "action must be void|delete|unvoid" }, 400);

  // Fund Transfer has no document table; confirm the transfer exists via its original ledger legs.
  const ft = await c.var.DB.prepare("SELECT 1 AS ok FROM ledger_journal_entries WHERE sourceType = 'fund_transfer' AND sourceId = ? AND orgId = ? LIMIT 1").bind(no, orgId).first<{ ok: number }>();
  if (!ft) return c.json({ success: false, error: "Fund transfer not found" }, 404);

  const actorUserId =
    (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
  let lc: { statements: D1PreparedStatement[]; newState: string };
  try {
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: ["fund_transfer"], voidSourceType: "fund_transfer_void", sourceId: no, action, actorUserId, descriptionTag: `${action.toUpperCase()} · FT ${no}` });
  } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }

  // No status column to sync (ledger-only document): just run the lifecycle statements.
  await c.var.DB.batch(lc.statements);
  return c.json({ success: true, data: { state: lc.newState } });
});

// ---------------------------------------------------------------------------
// CONTRA (Phase 3.8, 2026-06) — when a customer IS also a supplier,
// offset what we owe them (whole APPROVED PIs, ticked) against what they
// owe us (FIFO across their oldest unpaid invoices). Legs run through
// the 490-0000 contra suspense (DR AP → CR 490, DR 490 → CR debtor
// control) so both control accounts move and 490 nets to zero, and BOTH
// subledgers settle: PIs flip PAID (supplier_payments method CONTRA, no
// bank), invoices take paidAmount and the customer counter drops — the
// three-card reconciliations stay clean on both sides.
// ---------------------------------------------------------------------------
const CONTRA_ACCT = "490-0000";

app.get("/contra/candidates", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const supplierId = c.req.query("supplierId") || "";
  const customerId = c.req.query("customerId") || "";
  const out: { pis?: unknown[]; arUnpaidSen?: number; customerControl?: string } = {};
  if (supplierId) {
    const pis = await c.var.DB.prepare(
      `SELECT id, piNo, invoiceDate, amountSen FROM purchase_invoices
        WHERE supplierId = ? AND status IN ('CONFIRMED', 'APPROVED')
        ORDER BY invoiceDate, piNo`,
    )
      .bind(supplierId)
      .all();
    out.pis = pis.results ?? [];
  }
  if (customerId) {
    const cust = await c.var.DB.prepare(
      "SELECT id, code FROM customers WHERE id = ?",
    )
      .bind(customerId)
      .first<{ id: string; code: string | null }>();
    const inv = await c.var.DB.prepare(
      `SELECT COALESCE(SUM(totalSen - paidAmount), 0) AS s FROM invoices
        WHERE customerId = ? AND status NOT IN ('DRAFT','CANCELLED')
          AND totalSen > paidAmount`,
    )
      .bind(customerId)
      .first<{ s: number }>();
    out.arUnpaidSen = Number(inv?.s) || 0;
    const parsed = parseDebtorCode(cust?.code);
    out.customerControl = parsed.ok ? parsed.controlCode : "300-0000";
  }
  return c.json({ success: true, data: out });
});

app.post("/contra", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const customerId = String(body.customerId || "");
    const piIds: string[] = Array.isArray(body.piIds) ? body.piIds.map(String) : [];
    if (!customerId || piIds.length === 0) {
      return c.json({ success: false, error: "customerId and at least one piId are required" }, 400);
    }
    const db = c.var.DB;
    const marks = piIds.map(() => "?").join(",");
    const piRes = await db
      .prepare(
        `SELECT id, piNo, supplierId, supplierName, amountSen, status
           FROM purchase_invoices WHERE id IN (${marks})`,
      )
      .bind(...piIds)
      .all<{ id: string; piNo: string; supplierId: string; supplierName: string; amountSen: number; status: string }>();
    const pis = piRes.results ?? [];
    if (pis.length !== piIds.length) {
      return c.json({ success: false, error: "Some PIs were not found" }, 400);
    }
    if (pis.some((p) => p.status !== "CONFIRMED" && p.status !== "APPROVED")) {
      return c.json({ success: false, error: "Only CONFIRMED/APPROVED (unpaid) PIs can be contra'd" }, 400);
    }
    const totalSen = pis.reduce((s, p) => s + (Number(p.amountSen) || 0), 0);
    if (totalSen <= 0) {
      return c.json({ success: false, error: "Selected PIs carry no amount" }, 400);
    }
    const cust = await db
      .prepare("SELECT id, name, code FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ id: string; name: string; code: string | null }>();
    if (!cust) return c.json({ success: false, error: "Customer not found" }, 404);
    const parsed = parseDebtorCode(cust.code);
    const arControl = parsed.ok ? parsed.controlCode : "300-0000";
    const invRes = await db
      .prepare(
        `SELECT id, invoiceNo, totalSen, paidAmount FROM invoices
          WHERE customerId = ? AND status NOT IN ('DRAFT','CANCELLED')
            AND totalSen > paidAmount
          ORDER BY dueDate, invoiceDate, invoiceNo`,
      )
      .bind(customerId)
      .all<{ id: string; invoiceNo: string; totalSen: number; paidAmount: number }>();
    const open = invRes.results ?? [];
    const arUnpaid = open.reduce((s, i) => s + (Number(i.totalSen) || 0) - (Number(i.paidAmount) || 0), 0);
    if (arUnpaid < totalSen) {
      return c.json(
        { success: false, error: `Customer only owes ${arUnpaid} sen — cannot contra ${totalSen} sen of payables against it` },
        400,
      );
    }
    // FIFO allocation across the customer's oldest open invoices.
    const statements: D1PreparedStatement[] = [];
    let remaining = totalSen;
    const now = new Date().toISOString();
    for (const inv of open) {
      if (remaining <= 0) break;
      const due = (Number(inv.totalSen) || 0) - (Number(inv.paidAmount) || 0);
      const take = Math.min(due, remaining);
      remaining -= take;
      const newPaid = (Number(inv.paidAmount) || 0) + take;
      statements.push(
        db
          .prepare(
            `UPDATE invoices SET paidAmount = ?, status = CASE WHEN ? >= totalSen THEN 'PAID' ELSE status END, updated_at = ? WHERE id = ?`,
          )
          .bind(newPaid, newPaid, now, inv.id),
      );
    }
    statements.push(
      db
        .prepare("UPDATE customers SET outstandingSen = outstandingSen - ? WHERE id = ?")
        .bind(totalSen, customerId),
    );
    const today = now.slice(0, 10);
    // Per-supplier relief, so the creditor counter drops by exactly what this
    // contra settled for that supplier (BUG-2026-08-13-081).
    const reliefBySupplier = new Map<string, number>();
    for (const p of pis) {
      const piSen = Number(p.amountSen) || 0;
      reliefBySupplier.set(p.supplierId, (reliefBySupplier.get(p.supplierId) ?? 0) + piSen);
      // paid_amount_sen MUST move with the status flip (BUG-2026-08-13-081).
      // Every other writer of a PAID purchase invoice does both — this one set
      // status alone, so rebuildApCounterSen (which reads amount − paid over
      // every non-DRAFT/CANCELLED PI) kept counting the contra'd bill at FULL
      // FACE, and the AP tab's counter-vs-subledger drift never cleared.
      statements.push(
        db
          .prepare(
            "UPDATE purchase_invoices SET paid_amount_sen = amount_sen, status = 'PAID', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
      statements.push(
        db
          .prepare(
            // bookedSen is the AP relief and EVERY other supplier_payments
            // INSERT in the repo stores it; this one omitted it, so the row
            // claimed zero relief on /ap-reconciliation and in the audit log's
            // SUM(bookedSen) (BUG-2026-08-13-081).
            `INSERT INTO supplier_payments (
               id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
               date, amountSen, bookedSen, method, reference, notes, orgId
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONTRA', ?, ?, ?)`,
          )
          .bind(
            `sp-${crypto.randomUUID().slice(0, 8)}`,
            `SP-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            p.supplierId,
            p.supplierName ?? "",
            p.id,
            today,
            piSen,
            piSen,
            p.piNo,
            `Contra vs ${cust.name}`,
            getOrgId(c),
          ),
      );
    }
    // The AR side already decrements customers.outstandingSen above; the AP side
    // never had its mirror, so the supplier stayed "owed" after the contra.
    for (const [supplierId, sen] of reliefBySupplier) {
      statements.push(
        db
          .prepare("UPDATE suppliers SET outstandingSen = GREATEST(0, outstandingSen - ?) WHERE id = ?")
          .bind(sen, supplierId),
      );
    }
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const sourceId = `contra-${Date.now()}`;
    const legs: LedgerEntryInput[] = [
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "contra",
        sourceId,
        legNo: 1,
        accountCode: "400-0000",
        debitSen: totalSen,
        creditSen: 0,
        description: `Contra · AP ${pis.map((p) => p.piNo).join(", ")}`,
        actorUserId,
        orgId,
      },
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "contra",
        sourceId,
        legNo: 2,
        accountCode: CONTRA_ACCT,
        debitSen: 0,
        creditSen: totalSen,
        description: `Contra suspense · ${cust.name}`,
        actorUserId,
        orgId,
      },
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "contra",
        sourceId,
        legNo: 3,
        accountCode: CONTRA_ACCT,
        debitSen: totalSen,
        creditSen: 0,
        description: `Contra suspense · ${cust.name}`,
        actorUserId,
        orgId,
      },
      {
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "contra",
        sourceId,
        legNo: 4,
        accountCode: arControl,
        debitSen: 0,
        creditSen: totalSen,
        description: `Contra · AR settled vs payables · ${cust.name}`,
        actorUserId,
        orgId,
      },
    ];
    const { statements: ledgerStmts } = await buildJournalEntryStatements(db, orgId, legs);
    statements.push(...ledgerStmts);
    await db.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: sourceId,
      action: "create",
      after: { contraSen: totalSen, customerId, piIds },
    });
    return c.json({ success: true, data: { totalSen, pis: pis.length } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// LABOUR MONTH-END POSTING (Phase 4.1, 2026-06) — accrue the month's
// labour cost to the Manufacturing Account / expenses, by department.
//
// Per the owner's "real-time preview + month-end Post button" model:
// the per-worker EMPLOYER cost (gross pay + employer EPF/SOCSO/EIS) is
// grouped by the payslip's department_code, each department mapped to a
// COST/EXPENSE account (production → 750-0010, maintenance/warehouse →
// 780-x, office → 900-x; Repair / Shortfall show as their own preview
// rows). Post writes DR each account · CR 410-0010 ACCRUAL - SALARY, so
// paying salaries later through Payment/Expense clears the accrual.
// Idempotent per month (sourceId labor-YYYY-MM). The map lives in
// kv_config 'labor_account_map' and is editable in Maintenance.
// ---------------------------------------------------------------------------
const LABOUR_ACCRUAL_ACCT = "410-0010"; // ACCRUAL - SALARY
const DEFAULT_LABOUR_MAP = {
  fallback: "750-0010", // PRODUCTION - SALARIES (any unmapped dept)
  byDept: {
    MAINTENANCE: "780-0030", // UPKEEP OF FACTORY
    WAREHOUSING: "780-0000", // FACTORY OVERHEAD
  } as Record<string, string>,
  // The employer's statutory contributions, posted to their OWN accounts
  // (owner 2026-08-06: 「拆」). They used to be folded into the department's
  // salary account as one all-in cost, which left 750-0020/0030/0040 permanently
  // empty and made the wage bill impossible to reconcile against an EPF or
  // SOCSO statement. The department dimension stays on the salary line, where
  // it is what department costing needs; a statutory contribution is a
  // company-level charge and does not carry one.
  epf: "750-0020", // PRODUCTION - EPF
  socso: "750-0030", // PRODUCTION - SOCSO
  eis: "750-0040", // PRODUCTION - EIS
};

type LabourMap = {
  fallback: string;
  byDept: Record<string, string>;
  epf: string;
  socso: string;
  eis: string;
};

async function getLabourMap(db: Env["Variables"]["DB"]): Promise<LabourMap> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'labor_account_map'")
      .first<{ value: string | null }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Partial<LabourMap>;
      return {
        fallback: parsed.fallback || DEFAULT_LABOUR_MAP.fallback,
        byDept: { ...DEFAULT_LABOUR_MAP.byDept, ...(parsed.byDept ?? {}) },
        epf: parsed.epf || DEFAULT_LABOUR_MAP.epf,
        socso: parsed.socso || DEFAULT_LABOUR_MAP.socso,
        eis: parsed.eis || DEFAULT_LABOUR_MAP.eis,
      };
    }
  } catch {
    /* table/row absent — use defaults */
  }
  return DEFAULT_LABOUR_MAP;
}

async function getCashflowMap(
  db: Env["Variables"]["DB"],
): Promise<CfMap> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'cashflow_account_map'")
      .first<{ value: string | null }>();
    if (row?.value) return JSON.parse(row.value) as CfMap;
  } catch { /* absent → empty: engine falls back to defaults */ }
  return {};
}

async function getCashflowStockGroupMap(
  db: Env["Variables"]["DB"],
): Promise<Record<string, string>> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'cashflow_stockgroup_map'")
      .first<{ value: string | null }>();
    if (row?.value) return JSON.parse(row.value) as Record<string, string>;
  } catch { /* absent → empty */ }
  return {};
}

async function getPnlSectionMap(
  db: Env["Variables"]["DB"],
): Promise<Record<string, string>> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'pnl_section_map'")
      .first<{ value: string | null }>();
    if (row?.value) return JSON.parse(row.value) as Record<string, string>;
  } catch { /* absent → empty */ }
  return {};
}

async function getBsSectionMap(
  db: Env["Variables"]["DB"],
): Promise<Record<string, string>> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'bs_section_map'")
      .first<{ value: string | null }>();
    if (row?.value) return JSON.parse(row.value) as Record<string, string>;
  } catch { /* absent → empty */ }
  return {};
}

type LabourDeptAgg = {
  departmentCode: string;
  account: string;
  workers: number;
  grossSen: number;
  employerSen: number;
  costSen: number;
  // Kept apart so each posts to its own account (owner 2026-08-06: 「拆」).
  epfSen: number;
  socsoSen: number;
  eisSen: number;
};

async function aggregateLabour(
  db: Env["Variables"]["DB"],
  month: string,
  orgId: string,
): Promise<{ byDept: LabourDeptAgg[]; totalSen: number; map: LabourMap }> {
  const map = await getLabourMap(db);
  const res = await db
    .prepare(
      `SELECT departmentCode, grossPaySen, epfEmployerSen, socsoEmployerSen, eisEmployerSen
         FROM payslips WHERE orgId = ? AND period = ? AND status != 'CANCELLED'`,
    )
    .bind(orgId, month)
    .all<{ departmentCode: string | null; grossPaySen: number; epfEmployerSen: number; socsoEmployerSen: number; eisEmployerSen: number }>();
  const agg = new Map<string, LabourDeptAgg>();
  for (const p of res.results ?? []) {
    const dept = String(p.departmentCode ?? "").trim() || "(unassigned)";
    const account = map.byDept[dept] ?? map.fallback;
    const gross = Number(p.grossPaySen) || 0;
    const epf = Number(p.epfEmployerSen) || 0;
    const socso = Number(p.socsoEmployerSen) || 0;
    const eis = Number(p.eisEmployerSen) || 0;
    const employer = epf + socso + eis;
    const cur = agg.get(dept) ?? {
      departmentCode: dept, account, workers: 0,
      grossSen: 0, employerSen: 0, costSen: 0, epfSen: 0, socsoSen: 0, eisSen: 0,
    };
    cur.workers += 1;
    cur.grossSen += gross;
    cur.employerSen += employer;
    cur.epfSen += epf;
    cur.socsoSen += socso;
    cur.eisSen += eis;
    cur.costSen += gross + employer;
    agg.set(dept, cur);
  }
  const byDept = [...agg.values()].sort((a, b) => a.departmentCode.localeCompare(b.departmentCode));
  const totalSen = byDept.reduce((s, d) => s + d.costSen, 0);
  return { byDept, totalSen, map };
}

// Where a month's labour posting currently STANDS in the ledger: the net of
// every visible leg carrying its sourceId, account by account.
//
// "Has it been posted?" has to be answered from this, not from "does a
// labor_post leg exist" — once a month can be unposted, the original legs are
// still there (the journal is hash-chained and append-only, so a reversal is
// appended, never a deletion). The existence test would then refuse to re-post
// a month that had just been reversed. Exactly the flaw the purchase-invoice
// void carried until 2026-08-06.
async function labourLedgerNet(
  db: Env["Variables"]["DB"],
  orgId: string,
  sourceId: string,
): Promise<Map<string, number>> {
  const res = await db
    .prepare(
      `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
        WHERE sourceId = ? AND orgId = ? AND hidden = 0 AND sourceType LIKE 'labor_post%'`,
    )
    .bind(sourceId, orgId)
    .all<{ accountCode: string; debitSen: number; creditSen: number }>();
  const net = new Map<string, number>();
  for (const l of res.results ?? []) {
    const signed = (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0);
    net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + signed);
  }
  return net;
}

const labourIsPosted = (net: Map<string, number>) => [...net.values()].some((v) => v !== 0);

// The next free legNo for a (sourceType, sourceId). The ledger enforces
// UNIQUE(orgId, sourceType, sourceId, legNo) — so a month that is unposted and
// posted again cannot restart at 1, or the insert collides with the legs of the
// first posting, which are still there (append-only journal). Found the hard
// way: the re-post surfaced as "Invalid request body" because the handler's
// catch-all turned a constraint violation into a parse error.
async function nextLegNo(
  db: Env["Variables"]["DB"],
  orgId: string,
  sourceType: string,
  sourceId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(legNo), 0) AS n FROM ledger_journal_entries
        WHERE orgId = ? AND sourceType = ? AND sourceId = ?`,
    )
    .bind(orgId, sourceType, sourceId)
    .first<{ n: number }>();
  return (Number(row?.n) || 0) + 1;
}

// The DEBIT side of a month's labour posting, account by account: each
// department's GROSS pay against its mapped account, then the three statutory
// employer contributions against theirs. One function so the preview the owner
// approves and the batch that posts can never describe different entries.
function labourDebitLines(
  byDept: LabourDeptAgg[],
  map: LabourMap,
): { account: string; sen: number }[] {
  const out = new Map<string, number>();
  const add = (account: string, sen: number) => {
    if (sen === 0) return;
    out.set(account, (out.get(account) ?? 0) + sen);
  };
  for (const d of byDept) add(d.account, d.grossSen);
  add(map.epf, byDept.reduce((s, d) => s + d.epfSen, 0));
  add(map.socso, byDept.reduce((s, d) => s + d.socsoSen, 0));
  add(map.eis, byDept.reduce((s, d) => s + d.eisSen, 0));
  return [...out.entries()]
    .map(([account, sen]) => ({ account, sen }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

app.get("/labor/preview", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const month = c.req.query("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
  }
  try {
    const orgId = getOrgId(c);
    const { byDept, totalSen, map: labourMap } = await aggregateLabour(c.var.DB, month, orgId);
    const posted = labourIsPosted(await labourLedgerNet(c.var.DB, orgId, `labor-${month}`));
    // Roll the per-dept rows up to the account level for the GL preview —
    // gross to the department's account, each statutory contribution to its own.
    const byAccount = new Map<string, number>();
    for (const l of labourDebitLines(byDept, labourMap)) byAccount.set(l.account, l.sen);
    const coaRes = await c.var.DB.prepare(
      "SELECT code, name FROM chart_of_accounts",
    ).all<{ code: string; name: string }>();
    const names = new Map((coaRes.results ?? []).map((a) => [a.code, a.name] as const));
    return c.json({
      success: true,
      data: {
        month,
        posted,
        byDept: byDept.map((d) => ({ ...d, accountName: names.get(d.account) ?? "" })),
        accounts: [...byAccount.entries()]
          .map(([code, sen]) => ({ code, name: names.get(code) ?? "", costSen: sen }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        accrualAccount: LABOUR_ACCRUAL_ACCT,
        totalSen,
      },
    });
  } catch {
    return c.json({ success: false, error: "Preview failed — is the payslips table available?" }, 400);
  }
});

// The Forecast page's per-department salary rows. Seeded from the departments
// MASTER (all 14, production and non-production alike — owner 2026-08-24:
// 「forecast 和 dashboard 并没有 non-production department 可以 key in」) plus
// any department payslips have ever seen. Each entry carries the account the
// labour map would post it to and that account's P&L bucket, so the Forecast
// page files the row in the SAME section the real books would use. Also
// returns the mapped-account list the dept-mode supersede rule skips.
app.get("/labor/departments", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  try {
    const codes = new Set<string>();
    try {
      const master = await c.var.DB.prepare(`SELECT code FROM departments`).all<{ code: string | null }>();
      for (const r of master.results ?? []) {
        const t = String(r.code ?? "").trim();
        if (t) codes.add(t);
      }
    } catch { /* departments master absent — payslips still seed below */ }
    try {
      const ps = await c.var.DB.prepare(
        `SELECT DISTINCT departmentCode FROM payslips WHERE orgId = ? AND status != 'CANCELLED'`,
      )
        .bind(getOrgId(c))
        .all<{ departmentCode: string | null; department_code: string | null }>();
      for (const r of ps.results ?? []) {
        const t = String(r.departmentCode ?? r.department_code ?? "").trim();
        if (t) codes.add(t);
      }
    } catch { /* payslips absent */ }
    const map = await getLabourMap(c.var.DB);
    const override = await getPnlSectionMap(c.var.DB);
    const coaRes = await c.var.DB.prepare("SELECT code, type FROM chart_of_accounts")
      .all<{ code: string; type: string }>();
    const coaTypes = new Map((coaRes.results ?? []).map((a) => [a.code, a.type] as const));
    // Owner 2026-08-29 「不想要改labour tab, 直接forecast 映射在non production」:
    // the department master's is_production flag wins the SECTION a dept files
    // under — a non-production dept sits in NON-PRODUCTION SALARIES even while
    // its labour-map account (which still decides where wages POST) is 750-x.
    const nonProd = new Set<string>();
    try {
      const flags = await c.var.DB.prepare(`SELECT code, is_production FROM departments`)
        .all<{ code: string | null; isProduction: number | null; is_production: number | null }>();
      for (const r of flags.results ?? []) {
        const t = String(r.code ?? "").trim();
        if (t && Number(r.isProduction ?? r.is_production ?? 1) === 0) nonProd.add(t);
      }
    } catch { /* master predates the flag — bucket logic decides alone */ }
    const departments = [...codes].sort().map((code) => {
      const account = map.byDept[code] ?? map.fallback;
      const type = coaTypes.get(account) ?? "COST";
      const bucket = nonProd.has(code)
        ? "OPEX_SALARIES"
        : pnlBucketFor(account, type, override) ?? "DIRECT_LABOUR";
      return { code, account, bucket };
    });
    return c.json({ success: true, data: { departments, mappedAccounts: labourMappedAccounts(map) } });
  } catch {
    return c.json({ success: true, data: { departments: [], mappedAccounts: [] } });
  }
});

app.post("/labor/post", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const month = String(body.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
    }
    const today = new Date().toISOString().slice(0, 7);
    if (month > today) {
      return c.json({ success: false, error: `Cannot post labour for a future month (${month})` }, 400);
    }
    const orgId = getOrgId(c);
    const sourceId = `labor-${month}`;
    if (labourIsPosted(await labourLedgerNet(c.var.DB, orgId, sourceId))) {
      return c.json({ success: false, error: `Labour for ${month} is already posted. Unpost it first if you need to re-post.` }, 400);
    }
    const { byDept, totalSen, map: labourMapPost } = await aggregateLabour(c.var.DB, month, orgId);
    if (totalSen <= 0) {
      return c.json({ success: false, error: `No payslips found for ${month} — generate payslips first.` }, 400);
    }
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const legs: LedgerEntryInput[] = [];
    let legNo = await nextLegNo(c.var.DB, orgId, "labor_post", sourceId);
    // Same helper the preview used, so what was approved is what is posted.
    for (const { account, sen } of labourDebitLines(byDept, labourMapPost)) {
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "labor_post",
        sourceId,
        legNo: legNo++,
        accountCode: account,
        debitSen: sen,
        creditSen: 0,
        description: `Labour ${month}`,
        actorUserId,
        orgId,
      });
    }
    legs.push({
      id: `lje-${crypto.randomUUID().slice(0, 12)}`,
      sourceType: "labor_post",
      sourceId,
      legNo: legNo++,
      accountCode: LABOUR_ACCRUAL_ACCT,
      debitSen: 0,
      creditSen: totalSen,
      description: `Labour ${month} · accrued wages payable`,
      actorUserId,
      orgId,
    });
    const { statements } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: sourceId,
      action: "create",
      after: { month, totalSen, accounts: legs.length - 1},
    });
    return c.json({ success: true, data: { month, totalSen, accounts: legs.length - 1} });
  } catch (err) {
    // NOT "Invalid request body". That blanket message wrapped the whole
    // handler, so a UNIQUE(orgId, sourceType, sourceId, legNo) violation on a
    // re-post read as a malformed request and cost an hour to find. Say what
    // actually failed (owner 2026-08-06).
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /labor/post] failed:", msg);
    return c.json({ success: false, error: `Labour posting failed: ${msg}` }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /labor/unpost — reverse a month's labour posting so it can be redone.
//
// Owner 2026-08-06: July posted before the EPF/SOCSO/EIS split shipped, so it
// sits in the ledger as one all-in line. Posting is idempotent and there was no
// way back — the month was frozen in whatever shape it was first posted, and
// the only alternative was a hand-written journal entry to undo it.
//
// Reverses by APPENDING the negation of the current net, never by deleting: the
// journal is hash-chained. `labor_post_reversal` strips to `labor_post`, so the
// reversal dates to the month it belongs to, like the posting itself. A month
// with nothing outstanding reverses to nothing, so pressing it twice is safe.
// ---------------------------------------------------------------------------
app.post("/labor/unpost", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const month = String(body.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
    }
    const orgId = getOrgId(c);
    const sourceId = `labor-${month}`;
    const net = await labourLedgerNet(c.var.DB, orgId, sourceId);
    if (!labourIsPosted(net)) {
      return c.json({ success: true, data: { month, alreadyUnposted: true, reversedLegs: 0 } });
    }
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const legs: LedgerEntryInput[] = [];
    let legNo = await nextLegNo(c.var.DB, orgId, "labor_post_reversal", sourceId);
    for (const [accountCode, amt] of net) {
      if (amt === 0) continue;
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "labor_post_reversal",
        sourceId,
        legNo: legNo++,
        accountCode,
        debitSen: amt < 0 ? -amt : 0,
        creditSen: amt > 0 ? amt : 0,
        description: `Labour ${month} · unposted`,
        actorUserId,
        orgId,
      });
    }
    const { statements } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: sourceId,
      action: "delete",
      before: { month, accounts: net.size },
      after: { month, reversedLegs: legs.length },
    });
    return c.json({ success: true, data: { month, reversedLegs: legs.length } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /labor/unpost] failed:", msg);
    return c.json({ success: false, error: `Labour unpost failed: ${msg}` }, 400);
  }
});

app.get("/labor/map", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const map = await getLabourMap(c.var.DB);
  return c.json({ success: true, data: map });
});

app.put("/labor/map", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const fallback = String(body.fallback || DEFAULT_LABOUR_MAP.fallback);
    const byDept: Record<string, string> = {};
    if (body.byDept && typeof body.byDept === "object") {
      for (const [k, v] of Object.entries(body.byDept)) {
        if (typeof v === "string" && v.trim()) byDept[k] = v.trim();
      }
    }
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at)
       VALUES ('labor_account_map', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(JSON.stringify({ fallback, byDept }), new Date().toISOString())
      .run();
    return c.json({ success: true, data: { fallback, byDept } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/cashflow/map", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const map = await getCashflowMap(c.var.DB);
  const sgMap = await getCashflowStockGroupMap(c.var.DB);
  return c.json({ success: true, data: { map, stockGroupMap: sgMap } });
});

app.put("/cashflow/map", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as {
      map?: Record<string, { section?: string; order?: number }>;
      stockGroupMap?: Record<string, string>;
    };
    const now = new Date().toISOString();
    // Each map is updated independently — a body that omits one key must NOT
    // wipe the other (the account-map editor only sends `map`, so an
    // unconditional write of stockGroupMap would erase the stock-group
    // override on every save).
    let map: Record<string, { section: string; order: number }> | undefined;
    if (body.map !== undefined) {
      map = {};
      for (const [code, v] of Object.entries(body.map ?? {})) {
        if (v && typeof v.section === "string")
          map[code] = { section: v.section, order: Number(v.order) || 0 };
      }
      await c.var.DB.prepare(
        `INSERT INTO kv_config (key, value, updated_at) VALUES ('cashflow_account_map', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify(map), now).run();
    }
    let sg: Record<string, string> | undefined;
    if (body.stockGroupMap !== undefined) {
      sg = {};
      for (const [g, line] of Object.entries(body.stockGroupMap ?? {}))
        if (typeof line === "string" && line.trim()) sg[g] = line.trim();
      await c.var.DB.prepare(
        `INSERT INTO kv_config (key, value, updated_at) VALUES ('cashflow_stockgroup_map', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify(sg), now).run();
    }
    return c.json({ success: true, data: { map, stockGroupMap: sg } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/doc-number-prefixes", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const map = await getDocNumberPrefixes(c.var.DB);
  return c.json({ success: true, data: { map } });
});

app.put("/doc-number-prefixes", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as { map?: Record<string, { out?: string; in?: string }> };
    if (body.map === undefined) return c.json({ success: false, error: "map required" }, 400);
    const map: Record<string, { out: string; in: string }> = {};
    for (const [code, v] of Object.entries(body.map)) {
      if (!v) continue;
      const out = typeof v.out === "string" ? v.out.trim() : "";
      const inp = typeof v.in === "string" ? v.in.trim() : "";
      if (out || inp) map[code] = { out, in: inp };
    }
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at) VALUES ('doc_number_prefixes', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(map), new Date().toISOString()).run();
    return c.json({ success: true, data: { map } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/pnl/section-map", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const map = await getPnlSectionMap(c.var.DB);
  return c.json({ success: true, data: { map } });
});

app.put("/pnl/section-map", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as { map?: Record<string, string> };
    if (body.map === undefined) return c.json({ success: false, error: "map required" }, 400);
    const valid = new Set(["REVENUE", "OTHER_INCOME", "DIRECT_LABOUR", "FACTORY_OVERHEAD", "OPERATING_EXPENSE", "OPEX_SALARIES"]);
    const map: Record<string, string> = {};
    for (const [code, b] of Object.entries(body.map)) if (typeof b === "string" && valid.has(b)) map[code] = b;
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at) VALUES ('pnl_section_map', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(map), new Date().toISOString()).run();
    return c.json({ success: true, data: { map } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.get("/bs/section-map", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const map = await getBsSectionMap(c.var.DB);
  return c.json({ success: true, data: { map } });
});

app.put("/bs/section-map", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as { map?: Record<string, string> };
    if (body.map === undefined) return c.json({ success: false, error: "map required" }, 400);
    const valid = new Set(["FIXED_ASSET", "CURRENT_ASSET", "CURRENT_LIABILITY", "LONG_TERM_LIABILITY", "EQUITY"]);
    const map: Record<string, string> = {};
    for (const [code, s] of Object.entries(body.map)) if (typeof s === "string" && valid.has(s)) map[code] = s;
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at) VALUES ('bs_section_map', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(map), new Date().toISOString()).run();
    return c.json({ success: true, data: { map } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// FINANCIAL DASHBOARD (owner 2026-07-29) — one call feeds all four cards:
// income statement (with the owner's forecast overlay), cash flow, balance
// sheet and the ratio set. Buckets are MONTHS or CALENDAR QUARTERS (owner's
// pick — his FY ends August, so quarters can straddle the year end; partial
// buckets are flagged so a half-quarter is never read as a trend).
//
// Every figure comes from the SAME engines the reports use, so a card can
// never disagree with its report:
//   • P&L per month  → computePnlWindow + the pre-opening historical swap
//     (identical to Monthly P&L), then summed into the bucket.
//   • Balance sheet  → one ledger walk, snapshotted at each bucket end
//     (post-opening only — pre-opening balances don't exist in the ledger).
//   • Cash flow      → net movement of SBK/SCH accounts per bucket, split
//     operating / investing / financing by the account on the other side.
//   • Forecast       → kv forecast_pnl, evaluated with the same
//     percent-or-amount rule the Forecast page uses.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TRADE FINANCE (owner 2026-08-11) — money a lender (Houzs Century) pays our
// suppliers on our behalf. The TF account is a LIABILITY; each drawing payment
// is a DRAW with an editable due date; repayment happens through the normal
// Supplier Payment screen (see supplier-payments.ts). Derivation is shared:
// api/lib/trade-finance.ts loadTfDraws — amounts always ledger family nets.
// ---------------------------------------------------------------------------

// One-time (idempotent) setup, pressed by the owner: flags the account as a
// TF source AND reclasses it in place — LIABILITY, new name, out of the bank
// (SBK) lists. Zero ledger rows; history reads correctly at every date.
app.post("/trade-finance/setup", async (c) => {
  const denied = requireFinance(c);
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      accountCode?: string; lenderSupplierId?: string; tenorDays?: number; accountName?: string;
    };
    const accountCode = String(body.accountCode ?? "").trim();
    const lenderSupplierId = String(body.lenderSupplierId ?? "").trim();
    const accountName = String(body.accountName ?? "").trim();
    const tenorDays = Math.round(Number(body.tenorDays) || 0);
    if (!accountCode || !lenderSupplierId || !accountName) {
      return c.json({ success: false, error: "accountCode, lenderSupplierId and accountName are required" }, 400);
    }
    if (tenorDays < 1 || tenorDays > 365) {
      return c.json({ success: false, error: "tenorDays must be between 1 and 365" }, 400);
    }
    const acct = await c.var.DB.prepare(
      "SELECT code, name, type, specialAccountType FROM chart_of_accounts WHERE code = ?",
    ).bind(accountCode).first<{ code: string; name: string; type: string; specialAccountType: string | null }>();
    if (!acct) return c.json({ success: false, error: `Account ${accountCode} not found` }, 404);
    const sup = await c.var.DB.prepare("SELECT id, name FROM suppliers WHERE id = ?")
      .bind(lenderSupplierId).first<{ id: string; name: string }>();
    if (!sup) return c.json({ success: false, error: "Lender supplier not found" }, 404);
    await ensureTfTables(c.var.DB);
    await c.var.DB.prepare(
      "UPDATE chart_of_accounts SET type = 'LIABILITY', specialAccountType = NULL, name = ? WHERE code = ?",
    ).bind(accountName, accountCode).run();
    const sources = await getTfSources(c.var.DB);
    const next: TfSource[] = [
      ...sources.filter((s) => s.accountCode !== accountCode),
      { accountCode, lenderSupplierId, lenderName: sup.name, tenorDays },
    ];
    await saveTfSources(c.var.DB, next);
    await emitAudit(c, {
      resource: "trade-finance",
      resourceId: accountCode,
      action: "setup",
      before: { account: acct },
      after: { account: { code: accountCode, name: accountName, type: "LIABILITY", specialAccountType: null }, source: next.find((s) => s.accountCode === accountCode) },
    });
    return c.json({ success: true, data: { sources: next } });
  } catch (err) {
    console.error("[POST /trade-finance/setup] failed:", err instanceof Error ? err.message : err);
    return c.json({ success: false, error: "Setup failed" }, 400);
  }
});

app.get("/trade-finance", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  try {
    const sources = await getTfSources(c.var.DB);
    const todayIso = new Date().toISOString().slice(0, 10);
    const out = [];
    for (const s of sources) {
      const acct = await c.var.DB.prepare("SELECT name FROM chart_of_accounts WHERE code = ?")
        .bind(s.accountCode).first<{ name: string }>();
      const derived = await loadTfDraws(c.var.DB, s);
      const draws = [];
      for (const d of derived.draws) {
        // Which supplier(s) the lender paid for us on this draw — the payment's
        // own rows say so; a repayment or FT stray simply has none.
        let paidSupplier = "";
        try {
          const rs = await c.var.DB.prepare(
            "SELECT DISTINCT supplierName FROM supplier_payments WHERE paymentNo = ?",
          ).bind(d.drawSourceId).all<{ supplierName: string | null; supplier_name: string | null }>();
          paidSupplier = [...new Set((rs.results ?? []).map((r) => String(r.supplierName ?? r.supplier_name ?? "").trim()).filter(Boolean))].join(", ");
        } catch { /* leave blank */ }
        draws.push({ ...d, paidSupplier });
      }
      out.push({
        ...s,
        accountName: acct?.name ?? "",
        accountNetSen: derived.accountNetSen,
        unallocatedSen: derived.unallocatedSen,
        totals: tfTotals(derived.draws, todayIso),
        draws,
      });
    }
    return c.json({ success: true, data: { sources: out } });
  } catch (err) {
    console.error("[GET /trade-finance] failed:", err instanceof Error ? err.message : err);
    return c.json({ success: false, error: "Trade-finance read failed" }, 400);
  }
});

// Interest on a draw (owner 2026-08-11 「要包括 interest」): the owner keys
// the bank's charged interest per draw (manual now; OCR-prefill later). The
// figure is stored NOWHERE — it is posted as `tf_interest` legs under the
// DRAW's sourceId (DR 900-I001 INTEREST ON TRADE FINANCE / CR the TF
// account), so the draw's ledger-derived amount, outstanding, repayment
// clamps and the identity line all include it by construction. The endpoint
// takes the draw's TOTAL interest and delta-posts the difference — send the
// same figure twice and nothing happens; lower it and the excess reverses.
// sourceType `tf_interest` is deliberately NOT in DOC_DATE_FAMILIES: its
// legs date to the day they are keyed (postedAt fallback), which is when the
// charge becomes known.
const TF_INTEREST_ACCT = { code: "900-I001", name: "INTEREST ON TRADE FINANCE" };

app.put("/trade-finance/draw-interest", async (c) => {
  const denied = requireFinance(c);
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => ({}))) as { drawSourceId?: string; interestSen?: number; date?: string };
    const drawSourceId = String(body.drawSourceId ?? "").trim();
    const targetSen = Math.round(Number(body.interestSen) || 0);
    // Charge date (bank statement day) — becomes part of the sourceId so the
    // leg self-dates (doc-date). Defaults to today for hand-keyed figures.
    const chargeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? ""))
      ? String(body.date)
      : new Date().toISOString().slice(0, 10);
    if (!drawSourceId || targetSen < 0) {
      return c.json({ success: false, error: "drawSourceId and a non-negative interestSen are required" }, 400);
    }
    await ensureTfTables(c.var.DB);
    const drawRow = await c.var.DB.prepare(
      "SELECT draw_source_id, account_code FROM trade_finance_draws WHERE draw_source_id = ?",
    ).bind(drawSourceId).first<Record<string, unknown>>();
    if (!drawRow) return c.json({ success: false, error: "Draw not found — open the aging block once to backfill it" }, 404);
    const accountCode = String(drawRow.accountCode ?? drawRow.account_code ?? "");
    const source = (await getTfSources(c.var.DB)).find((s) => s.accountCode === accountCode);
    if (!source) return c.json({ success: false, error: "This draw's account is not a configured trade-finance source" }, 400);
    const { draws } = await loadTfDraws(c.var.DB, source);
    const draw = draws.find((d) => d.drawSourceId === drawSourceId);
    if (!draw) return c.json({ success: false, error: "Draw is not open (voided or fully derived away)" }, 404);
    const deltaSen = targetSen - draw.interestSen;
    if (deltaSen === 0) return c.json({ success: true, data: { drawSourceId, interestSen: targetSen, unchanged: true } });
    if (draw.amountSen + deltaSen < draw.repaidSen) {
      return c.json({ success: false, error: "Lowering interest below what is already repaid would overdraw the draw — void the repayment first" }, 400);
    }
    // Make sure the dedicated expense account exists (created once, quietly).
    await c.var.DB.prepare(
      `INSERT INTO chart_of_accounts (code, name, type, parentCode, balanceSen, isActive, cashFlowCategory, specialAccountType, pnlCategory, isPostable)
       VALUES (?, ?, 'EXPENSE', NULL, 0, 1, NULL, NULL, NULL, 1)
       ON CONFLICT (code) DO NOTHING`,
    ).bind(TF_INTEREST_ACCT.code, TF_INTEREST_ACCT.name).run();
    const orgId = getOrgId(c);
    const actorUserId = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    // sourceId carries the charge date (self-dated leg, see doc-date.ts);
    // deriveDraws strips the `tfint-<date>-` prefix to fold it into the draw.
    const interestSourceId = `tfint-${chargeDate}-${drawSourceId}`;
    const legNoBase = await nextLegNo(c.var.DB, orgId, "tf_interest", interestSourceId);
    const abs = Math.abs(deltaSen);
    const legs: LedgerEntryInput[] = deltaSen > 0
      ? [
          { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "tf_interest", sourceId: interestSourceId, legNo: legNoBase, accountCode: TF_INTEREST_ACCT.code, debitSen: abs, creditSen: 0, description: `TF interest · ${drawSourceId}`, actorUserId, orgId },
          { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "tf_interest", sourceId: interestSourceId, legNo: legNoBase + 1, accountCode: accountCode, debitSen: 0, creditSen: abs, description: `TF interest · ${drawSourceId}`, actorUserId, orgId },
        ]
      : [
          { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "tf_interest", sourceId: interestSourceId, legNo: legNoBase, accountCode: accountCode, debitSen: abs, creditSen: 0, description: `TF interest adjust · ${drawSourceId}`, actorUserId, orgId },
          { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "tf_interest", sourceId: interestSourceId, legNo: legNoBase + 1, accountCode: TF_INTEREST_ACCT.code, debitSen: 0, creditSen: abs, description: `TF interest adjust · ${drawSourceId}`, actorUserId, orgId },
        ];
    const { statements } = await buildJournalEntryStatements(c.var.DB, orgId, legs);
    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "trade-finance",
      resourceId: drawSourceId,
      action: "draw-interest",
      before: { interestSen: draw.interestSen },
      after: { interestSen: targetSen, deltaSen, expenseAccount: TF_INTEREST_ACCT.code },
    });
    return c.json({ success: true, data: { drawSourceId, interestSen: targetSen } });
  } catch (err) {
    console.error("[PUT /trade-finance/draw-interest] failed:", err instanceof Error ? err.message : err);
    return c.json({ success: false, error: "Interest update failed" }, 400);
  }
});

app.put("/trade-finance/draw-due", async (c) => {
  const denied = requireFinance(c);
  if (denied) return denied;
  try {
    const body = (await c.req.json().catch(() => ({}))) as { drawSourceId?: string; dueDate?: string };
    const drawSourceId = String(body.drawSourceId ?? "").trim();
    const dueDate = String(body.dueDate ?? "").trim();
    if (!drawSourceId || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return c.json({ success: false, error: "drawSourceId and dueDate (YYYY-MM-DD) are required" }, 400);
    }
    await ensureTfTables(c.var.DB);
    const before = await c.var.DB.prepare(
      "SELECT draw_source_id, due_date FROM trade_finance_draws WHERE draw_source_id = ?",
    ).bind(drawSourceId).first<Record<string, unknown>>();
    if (!before) return c.json({ success: false, error: "Draw not found — open the aging block once to backfill it" }, 404);
    await c.var.DB.prepare("UPDATE trade_finance_draws SET due_date = ? WHERE draw_source_id = ?")
      .bind(dueDate, drawSourceId).run();
    await emitAudit(c, {
      resource: "trade-finance",
      resourceId: drawSourceId,
      action: "draw-due-edit",
      before: { dueDate: String(before.dueDate ?? before.due_date ?? "") },
      after: { dueDate },
    });
    return c.json({ success: true, data: { drawSourceId, dueDate } });
  } catch (err) {
    console.error("[PUT /trade-finance/draw-due] failed:", err instanceof Error ? err.message : err);
    return c.json({ success: false, error: "Due-date update failed" }, 400);
  }
});

app.get("/dashboard", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const quarterly = (c.req.query("granularity") ?? "month") === "quarter";
  const wanted = Math.min(24, Math.max(2, parseInt(c.req.query("periods") ?? "12", 10) || 12));
  const nowYm = new Date().toISOString().slice(0, 7);

  // Cache-aside + serve-stale-while-revalidate. This endpoint replays
  // computePnlWindow for up to 12 months plus a per-month cost-structure pass,
  // so it measured ~1,950ms on EVERY call (not a cold-snapshot miss — it never
  // cached). withSnapshot serves the last computed copy instantly and refreshes
  // in the background whenever a source table changes; the doc comment names
  // dashboards as an acceptable SWR target because the figures self-heal on the
  // next revalidation. cacheKey partitions by (granularity, periods, month) so
  // switching the range never serves another range's numbers, and the month
  // component forces a natural rebuild when the calendar rolls over.
  const { withSnapshot } = await import("../lib/snapshot");
  // The snapshot table must exist BEFORE withSnapshot reads it — readSnapshot
  // is not guarded, so a missing table 500s (migrations don't auto-apply on
  // this stack; see CLAUDE.md). Runtime-ensure it, matching the exact shape of
  // the other accounting snapshot tables (migration 0082). All-TEXT so it
  // round-trips cleanly through the d1-compat driver, DEFAULT '' because
  // writeSnapshot always sets built_at/built_from explicitly.
  await c.var.DB.prepare(
    `CREATE TABLE IF NOT EXISTS accounting_dashboard_snapshot (
       org_id TEXT NOT NULL,
       cache_key TEXT NOT NULL DEFAULT '',
       data TEXT NOT NULL,
       built_from TEXT NOT NULL,
       built_at TEXT NOT NULL DEFAULT '',
       refresh_count INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (org_id, cache_key)
     )`,
  ).run();
  const dashOrgId = getOrgId(c);
  // PAYLOAD VERSION — bump whenever this endpoint's response SHAPE changes.
  // The snapshot's freshness probe watches the source TABLES, so a pure code
  // change never invalidates it: after the cash in/out + cost-structure
  // forecast fields shipped, the stored 12-month copy kept serving the old
  // shape (its data hadn't changed, so it never revalidated) and the new rows
  // read "-" forever. Versioning the key retires every stale copy at once.
  // Bump for a changed SHAPE *or* a changed default WINDOW: the stored copy is
  // keyed by the range string, and the default range's key is blank either way,
  // so a wider-or-narrower default would keep serving the old month list.
  const DASH_PAYLOAD_V = "v14"; // v14: non-prod actuals = clocked-hours share of payroll; v13: salaryByDept carries nonProd flag; v12: non-prod dept forecasts count in COGS; v11: report-layer labour injection (unrecorded months); v10: master non-prod depts file under staff cost; v9: dept forecasts file by labour-map bucket; v8: + forecastSen; v7: + salaryByDept
  // The explicit window is part of the identity — otherwise two different
  // ranges would share one cached copy.
  const dashRangeKey = `${String(c.req.query("from") ?? "")}~${String(c.req.query("to") ?? "")}`;
  const dashCacheKey = `${DASH_PAYLOAD_V}:${quarterly ? "q" : "m"}:${wanted}:${dashRangeKey}:${nowYm}:${dashOrgId}`;
  const dashPayload = await withSnapshot(
    c.var.DB,
    {
      tableName: "accounting_dashboard_snapshot",
      // Every table the P&L + cost-structure replay reads. kv_config carries
      // the opening date; a change to any of these must rebuild the snapshot.
      sourceTables: [
        "ledger_journal_entries",
        "invoices",
        "purchase_invoices",
        "cost_ledger",
        "grn_items",
        "production_orders",
        "delivery_orders",
        "kv_config",
        // Production Salary per head / per unit reads these two — without them
        // hiring someone or completing a batch would leave the card stale.
        "workers",
        "fg_batches",
        // salaryByDept reads payslips — without it a payroll edit leaves the
        // department stacks stale.
        "payslips",
        // Report-layer labour injection (2026-08-31) dry-runs payroll from
        // these when a month has no payslips yet — new clock entries, docks
        // or a raise must refresh the injected P&L figures.
        "working_hour_entries",
        "payroll_hour_deductions",
        "worker_salary_history",
      ],
    },
    dashOrgId,
    async () => {

  // --- bucket list (oldest → newest), each with its member months ----------
  // The window also reaches FORWARD to the last month the owner has keyed a
  // forecast for — that is the whole point of the dashed target line: the
  // stock-app read where actual bars stop and the plan carries on. Capped at
  // 12 future months so a stray far-future entry can't stretch the axis.
  const fcAheadRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = 'forecast_pnl'")
    .first<{ value: string }>();
  let lastForecastYm = "";
  try {
    const fm = (JSON.parse(fcAheadRow?.value ?? "{}") as { months?: Record<string, unknown> }).months ?? {};
    for (const ym of Object.keys(fm)) if (/^\d{4}-\d{2}$/.test(ym) && ym > lastForecastYm) lastForecastYm = ym;
  } catch {
    /* no forecast yet */
  }
  const aheadMonths: string[] = [];
  if (lastForecastYm > nowYm) {
    let [y, m] = nowYm.split("-").map((n) => parseInt(n, 10));
    for (let i = 0; i < 12; i++) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      aheadMonths.push(ym);
      if (ym >= lastForecastYm) break;
    }
  }

  // Explicit window (owner 2026-08-05: 「dashboard 可以选 period」) — ?from=
  // &to= as YYYY-MM. When given it replaces the rolling look-back entirely
  // (and the forward forecast months, since the range says what to show).
  const rangeRe = /^\d{4}-\d{2}$/;
  const fromQ = String(c.req.query("from") ?? "").trim();
  const toQ = String(c.req.query("to") ?? "").trim();
  const explicit = rangeRe.test(fromQ) && rangeRe.test(toQ) && fromQ <= toQ;

  const monthsBack = quarterly ? wanted * 3 : wanted;
  const allMonths: string[] = [];
  if (explicit) {
    let [y, m] = fromQ.split("-").map((n) => parseInt(n, 10));
    for (let i = 0; i < 60; i++) { // hard cap: 5 years of columns
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      allMonths.push(ym);
      if (ym >= toQ) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  } else {
    let [y, m] = nowYm.split("-").map((n) => parseInt(n, 10));
    for (let i = 0; i < monthsBack; i++) {
      allMonths.unshift(`${y}-${String(m).padStart(2, "0")}`);
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }
    // Never roll back past the month the books begin (owner 2026-08-06: 「这整
    // 个的 period 可以放从 5 月 2026 开始吗」). Months before the opening date
    // have no ledger to read — every figure lands as a zero column that pushes
    // the real ones off the right edge. Keyed off the opening date rather than
    // a literal so it follows if that date is ever restated. An EXPLICIT from/to
    // is still honoured in full: asking for an earlier month is a deliberate act.
    const openingYm = String((await getOpeningDate(db)) ?? "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(openingYm)) {
      const firstKept = allMonths.findIndex((ym) => ym >= openingYm);
      if (firstKept > 0) allMonths.splice(0, firstKept);
    }
    allMonths.push(...aheadMonths);
  }
  type Bucket = { key: string; label: string; months: string[]; partial: boolean };
  const buckets: Bucket[] = [];
  if (quarterly) {
    const byQ = new Map<string, string[]>();
    for (const ym of allMonths) {
      const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
      const q = Math.floor((m - 1) / 3) + 1;
      const k = `${y}-Q${q}`;
      byQ.set(k, [...(byQ.get(k) ?? []), ym]);
    }
    for (const [key, ms] of byQ) {
      buckets.push({ key, label: key.replace("-", "/"), months: ms, partial: ms.length < 3 });
    }
  } else {
    for (const ym of allMonths) buckets.push({ key: ym, label: ym, months: [ym], partial: false });
  }

  // --- P&L per month (Monthly-P&L-identical), then summed per bucket -------
  await ensurePnlHistorical(db);
  const orgIdDash = getOrgId(c);
  const overrideDash = await getPnlSectionMap(db);
  const matDataDash = await loadMaterialCostData(db, orgIdDash, allMonths[allMonths.length - 1]);
  const dcDash = await loadDocDateResolver(db);
  const [historicalDash, openingRawDash] = await Promise.all([
    loadHistoricalPnl(db, orgIdDash),
    getOpeningDate(db),
  ]);
  const openingMonthDash = openingRawDash ? openingRawDash.slice(0, 7) : null;
  // Owner 2026-07-29: the income card breaks the cost side down, so every
  // slice carries the components too. materials + labour + overhead +
  // stockMovement sums to COGS exactly (stockMovement is the WIP/FG swing the
  // manufacturing account contributes), and staffCost + otherOpex sums to
  // operating expenses.
  type PnlSlice = {
    sales: number; cogs: number; gross: number; otherIncome: number; expenses: number; net: number;
    materials: number; labour: number; overhead: number; stockMovement: number;
    staffCost: number; otherOpex: number;
  };
  const zero = (): PnlSlice => ({
    sales: 0, cogs: 0, gross: 0, otherIncome: 0, expenses: 0, net: 0,
    materials: 0, labour: 0, overhead: 0, stockMovement: 0, staffCost: 0, otherOpex: 0,
  });
  const pnlByMonth = new Map<string, PnlSlice>();
  // Cost-structure feed (owner 2026-07-29): per month,每个料别 spend /
  // purchase / closing + that month's bedframe-vs-sofa sales split, so the
  // card can show either line with SHARED materials pro-rated by sales —
  // exactly how the Sofa/Bedframe P&L apportions them.
  type CsCat = { line: "bedframe" | "sofa" | "shared"; spend: number; purchase: number; closing: number };
  const csByMonth = new Map<string, Map<string, CsCat & { name: string }>>();
  const salesSplitByMonth = new Map<string, { bedframe: number; sofa: number }>();

  // ---- Production Salary denominators (owner 2026-08-06) ------------------
  // He wants the wage bill read per HEAD and per UNIT, not just as a total:
  // 91,631 says nothing until you know whether it paid 20 people or 40.
  //
  // Headcount is counted per month from the worker master — everyone who was
  // on the payroll for any part of it (joined on/before the month ends, and
  // had not resigned before it began). A leaver still costs the month they
  // left, so a point-in-time count would divide by too few and overstate the
  // per-head figure. All 42 production workers count, per the owner's ruling.
  const headByMonth = new Map<string, number>();
  const unitsByMonth = new Map<string, number>();
  try {
    const wRes = await db
      .prepare(`SELECT joinDate, resignedAt FROM workers`)
      .all<{ joinDate?: string | null; join_date?: string | null; resignedAt?: string | null; resigned_at?: string | null }>();
    for (const ym of allMonths) {
      const monthEnd = `${ym}-31`; // string compare — a YYYY-MM-DD never exceeds it within the month
      let n = 0;
      for (const w of wRes.results ?? []) {
        const joined = String(w.joinDate ?? w.join_date ?? "").slice(0, 10);
        const left = String(w.resignedAt ?? w.resigned_at ?? "").slice(0, 10);
        if (joined && joined > monthEnd) continue;      // not hired yet
        if (left && left < `${ym}-01`) continue;         // already gone
        n += 1;
      }
      headByMonth.set(ym, n);
    }
  } catch {
    /* workers table absent → no per-head line, the card just omits it */
  }
  // Units completed. NOTE: fg_batches carries the known duplicate-completion
  // defect the owner parked on 2026-07-29 (「会有别人处理」), so this count runs
  // HIGH and the per-unit cost it feeds runs LOW. The card labels it; it is not
  // silently presented as clean.
  try {
    const fgRes = await db
      .prepare(`SELECT completedDate, originalQty FROM fg_batches WHERE orgId = ?`)
      .bind(getOrgId(c))
      .all<{ completedDate?: string | null; completed_date?: string | null; originalQty?: number | null; original_qty?: number | null }>();
    for (const b of fgRes.results ?? []) {
      const ym = String(b.completedDate ?? b.completed_date ?? "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      unitsByMonth.set(ym, (unitsByMonth.get(ym) ?? 0) + (Number(b.originalQty ?? b.original_qty) || 0));
    }
  } catch {
    /* fg_batches absent → no per-unit line */
  }
  // ---- Salary by department (owner 2026-08-11) ----------------------------
  // The dept dimension lives only in payslips; one query for the whole window,
  // grouped by the shared pure rule so Σdepts always equals the Labour tab.
  let salByMonth = new Map<string, { dept: string; costSen: number }[]>();
  try {
    const psRes = await db
      .prepare(
        `SELECT period, departmentCode, grossPaySen, epfEmployerSen, socsoEmployerSen, eisEmployerSen
           FROM payslips WHERE orgId = ? AND status != 'CANCELLED'`,
      )
      .bind(orgIdDash)
      .all<Record<string, unknown>>();
    salByMonth = groupPayslipsByMonthDept((psRes.results ?? []) as never[]);
  } catch {
    /* payslips table absent → card simply shows no dept split */
  }
  // Non-production ACTUALS (owner 2026-08-31 「actual资料不是能从payroll 提取
  // 出来吗」): a payslip files the worker's whole month under his MASTER
  // (production) department, so the non-prod card had no actuals. Instead,
  // each worker's payroll cost (gross + employer statutory — the same ringgit
  // the Labour tab posts) is split across the departments he actually CLOCKED
  // in, and the shares landing on master-flagged non-production departments
  // become that card's actuals. Deliberate overlap with the production card:
  // a borrowed worker's R&D days are inside his production dept's payslip AND
  // shown as R&D activity — two views of one wage bill, disclosed on the card.
  const nonProdDash = new Set<string>();
  try {
    const flags = await db.prepare(`SELECT code, is_production FROM departments`)
      .all<{ code: string | null; isProduction: number | null; is_production: number | null }>();
    for (const r of flags.results ?? []) {
      const t = String(r.code ?? "").trim();
      if (t && Number(r.isProduction ?? r.is_production ?? 1) === 0) nonProdDash.add(t);
    }
  } catch { /* master predates the flag */ }
  const nonProdActualByYm = new Map<string, Map<string, number>>();
  if (nonProdDash.size) {
    try {
      const psW = await db
        .prepare(
          `SELECT period, employeeId, grossPaySen, epfEmployerSen, socsoEmployerSen, eisEmployerSen
             FROM payslips WHERE orgId = ? AND status != 'CANCELLED'`,
        )
        .bind(orgIdDash)
        .all<Record<string, unknown>>();
      const costByYmWorker = new Map<string, number>();
      for (const r of psW.results ?? []) {
        const ym = String(r.period ?? "").slice(0, 7);
        const wid = String(r.employeeId ?? r.employee_id ?? "");
        if (!/^\d{4}-\d{2}$/.test(ym) || !wid) continue;
        const cost =
          (Number(r.grossPaySen ?? r.gross_pay_sen) || 0) +
          (Number(r.epfEmployerSen ?? r.epf_employer_sen) || 0) +
          (Number(r.socsoEmployerSen ?? r.socso_employer_sen) || 0) +
          (Number(r.eisEmployerSen ?? r.eis_employer_sen) || 0);
        const k = `${ym}::${wid}`;
        costByYmWorker.set(k, (costByYmWorker.get(k) ?? 0) + cost);
      }
      const earliestIso = allMonths.length ? `${allMonths[0]}-01` : "2000-01-01";
      const wheRes = await db
        .prepare("SELECT workerId, departmentCode, date, hours FROM working_hour_entries WHERE date >= ?")
        .bind(earliestIso)
        .all<Record<string, unknown>>();
      const hoursByYmWorker = new Map<string, { total: number; byDept: Map<string, number> }>();
      for (const r of wheRes.results ?? []) {
        const ym = String(r.date ?? "").slice(0, 7);
        const wid = String(r.workerId ?? r.worker_id ?? "");
        const dept = String(r.departmentCode ?? r.department_code ?? "").trim();
        const h = Number(r.hours) || 0;
        if (!wid || !dept || h <= 0 || !/^\d{4}-\d{2}$/.test(ym)) continue;
        const k = `${ym}::${wid}`;
        let rec = hoursByYmWorker.get(k);
        if (!rec) { rec = { total: 0, byDept: new Map<string, number>() }; hoursByYmWorker.set(k, rec); }
        rec.total += h;
        rec.byDept.set(dept, (rec.byDept.get(dept) ?? 0) + h);
      }
      for (const [k, rec] of hoursByYmWorker) {
        const cost = costByYmWorker.get(k);
        if (!cost || rec.total <= 0) continue;
        const ym = k.slice(0, 7);
        for (const [dept, h] of rec.byDept) {
          if (!nonProdDash.has(dept)) continue;
          const sen = Math.round((cost * h) / rec.total);
          if (!sen) continue;
          let m = nonProdActualByYm.get(ym);
          if (!m) { m = new Map<string, number>(); nonProdActualByYm.set(ym, m); }
          m.set(dept, (m.get(dept) ?? 0) + sen);
        }
      }
    } catch { /* hours/payslips unavailable → non-prod actuals stay blank */ }
  }
  const BEDFRAME_SALES = "500-0000";
  const csLineOf = (name: string): "bedframe" | "sofa" | "shared" => {
    const t = name.toUpperCase();
    if (/(^|[^A-Z])B\./.test(t)) return "bedframe";
    if (/(^|[^A-Z])S[.\s-]/.test(t)) return "sofa";
    return "shared";
  };
  const csCatOf = (name: string): string => {
    const stripped = name.replace(/^PURCHASE\s*-\s*/i, "").trim();
    return stripped.replace(/^(B\.M|S\.M|B|S)[.\s-]+/i, "").trim() || stripped;
  };
  for (const ym of allMonths) {
    if (ym > nowYm) continue;
    const hist = selectHistoricalWindow(historicalDash, openingMonthDash, ym, "all");
    const w = hist ?? (await computePnlWindow(db, orgIdDash, ym, ym, "all", matDataDash, dcDash, overrideDash));
    {
      // Keyed by category AND line: "PURCHASE - B.M FABRIC" and
      // "PURCHASE - S FABRIC" are both FABRIC but belong to different lines —
      // merging on the name alone would file sofa fabric under bedframe.
      const cats = new Map<string, CsCat & { name: string }>();
      for (const g of w.rmGroups ?? []) {
        const name = g.description || g.group;
        const cat = csCatOf(name);
        const line = csLineOf(name);
        const k = `${cat}||${line}`;
        const cur = cats.get(k) ?? { name: cat, line, spend: 0, purchase: 0, closing: 0 };
        cur.purchase += g.purchasesSen;
        cur.closing += g.closingSen;
        cur.spend += g.openingSen + g.purchasesSen - g.closingSen;
        cats.set(k, cur);
      }
      csByMonth.set(ym, cats);
      let bed = 0, sofa = 0;
      for (const r of w.revLines ?? []) {
        if (r.code === BEDFRAME_SALES) bed += r.amountSen;
        else sofa += r.amountSen;
      }
      salesSplitByMonth.set(ym, { bedframe: bed, sofa });
    }
    const materials = w.rmConsumedSen + w.carriageSen + w.sstSen;
    const staffCost = (w.expenseLines ?? []).filter((l) => l.salary).reduce((s, l) => s + l.amountSen, 0);
    pnlByMonth.set(ym, {
      sales: w.netSalesSen,
      cogs: w.cogsSen,
      gross: w.grossProfitSen,
      otherIncome: w.otherIncomeSen,
      expenses: w.expenseSen,
      net: w.netProfitSen,
      materials,
      labour: w.labourSen,
      overhead: w.overheadSen,
      stockMovement: w.cogsSen - materials - w.labourSen - w.overheadSen,
      staffCost,
      otherOpex: w.expenseSen - staffCost,
    });
  }

  // --- Balance sheet: one ledger walk, snapshot per bucket end -------------
  const bsMap = await getBsSectionMap(db);
  const resolveDash = await loadAccountResolver(db);
  const coaDash = new Map<string, { name: string; type: string; sat: string | null }>();
  {
    const rs = await db
      .prepare("SELECT code, name, type, specialAccountType FROM chart_of_accounts")
      .all<{ code: string; name: string; type: string; specialAccountType: string | null }>();
    for (const a of rs.results ?? []) coaDash.set(resolveDash(a.code), { name: a.name, type: a.type, sat: a.specialAccountType ?? null });
  }
  const legRows = await db
    .prepare("SELECT accountCode, sourceType, sourceId, debitSen, creditSen, postedAt FROM ledger_journal_entries WHERE hidden = 0")
    .all<{ accountCode: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string }>();
  const legsDash = (legRows.results ?? [])
    .map((l) => ({
      code: resolveDash(l.accountCode),
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      dr: Number(l.debitSen) || 0,
      cr: Number(l.creditSen) || 0,
      day: dcDash.docDate(l.sourceType, l.sourceId, l.postedAt),
    }))
    .filter((l) => !legBeforeOpening(l.sourceType, l.day, dcDash.openingDate))
    .sort((a, b) => a.day.localeCompare(b.day));
  const sectionOf = (code: string): BsSection | null => {
    const meta = coaDash.get(code);
    return meta ? bsSectionFor(code, meta.type, bsMap as Record<string, string>) : null;
  };
  const bucketEnd = (b: Bucket) => `${b.months[b.months.length - 1]}-31`;
  const running = new Map<string, number>(); // account → dr−cr
  const bsByBucket = new Map<string, { assets: number; liabilities: number; equity: number; currentAssets: number; currentLiabilities: number; inventory: number } | null>();
  {
    let i = 0;
    for (const b of buckets) {
      const end = bucketEnd(b);
      while (i < legsDash.length && legsDash[i].day <= end) {
        const l = legsDash[i];
        running.set(l.code, (running.get(l.code) ?? 0) + l.dr - l.cr);
        i++;
      }
      // A future bucket has no balances — leave it null so the balance-sheet
      // card doesn't draw phantom zero bars past today.
      if (b.months[0] > nowYm) { bsByBucket.set(b.key, null); continue; }
      let assets = 0, liabilities = 0, equity = 0, curA = 0, curL = 0, inv = 0;
      for (const [code, net] of running) {
        const sec = sectionOf(code);
        if (!sec) continue;
        if (sec === "FIXED_ASSET" || sec === "CURRENT_ASSET") {
          assets += net;
          if (sec === "CURRENT_ASSET") curA += net;
          if (/^33\d/.test(code)) inv += net; // 330-x stock accounts
        } else if (sec === "EQUITY") {
          equity += -net;
        } else {
          liabilities += -net;
          if (sec === "CURRENT_LIABILITY") curL += -net;
        }
      }
      bsByBucket.set(b.key, { assets, liabilities, equity, currentAssets: curA, currentLiabilities: curL, inventory: inv });
    }
  }

  // --- Cash flow: THE Cash Flow report's own engine, read per month --------
  // One call per financial year touched by the window (its columns span the
  // FY), so every figure on the card is the same number the report prints.
  type CfLine = { label: string; section: string; value: number };
  const cfByMonth = new Map<
    string,
    { operating: number; investing: number; financing: number; net: number; inflow: number; outflow: number; lines: CfLine[] }
  >();
  {
    const fyKeys = new Map<string, string>(); // fy label → an anchor month
    const fyeM = await getFyeMonth(db);
    for (const ym of allMonths) {
      if (ym > nowYm) continue;
      const w = fyWindowFor(new Date(`${ym}-15T00:00:00Z`), fyeM);
      fyKeys.set(w.startIso, ym);
    }
    const rowVal = (
      rowsCf: { kind: string; label: string; section?: string; values: (number | null)[] }[],
      idx: number,
      pred: (r: { kind: string; label: string; section?: string }) => boolean,
    ) => rowsCf.filter(pred).reduce((s, r) => s + (Number(r.values[idx]) || 0), 0);
    for (const anchor of fyKeys.values()) {
      const st = await computeCashflowStatement(db, anchor, false, orgIdDash);
      const cols = (st.columns ?? []) as { key: string; accum?: boolean }[];
      const rowsCf = (st.rows ?? []) as { kind: string; label: string; section?: string; values: (number | null)[] }[];
      cols.forEach((col, i) => {
        if (col.accum || !/^\d{4}-\d{2}$/.test(col.key) || cfByMonth.has(col.key)) return;
        const operating = rowVal(rowsCf, i, (r) => r.kind === "result" && /operation surplus/i.test(r.label));
        const investing = rowVal(rowsCf, i, (r) => r.kind === "subtotal" && r.section === "CAPEX");
        const financing = rowVal(rowsCf, i, (r) => r.kind === "subtotal" && (r.section === "LOAN" || r.section === "DEPOSIT" || r.section === "FINANCE_COST"));
        const net = rowVal(rowsCf, i, (r) => r.kind === "total" && /Cash Surplus/i.test(r.label));
        // Owner 2026-07-30: money IN vs money OUT, and the account-level
        // detail behind them. The statement's `line` rows already carry the
        // display sign (inflow +, outflow −), so the split is a sign filter.
        const detail = rowsCf
          .filter((r) => r.kind === "line" && (Number(r.values[i]) || 0) !== 0)
          .map((r) => ({ label: r.label, section: r.section ?? "", value: Number(r.values[i]) || 0 }));
        const bank = st.bankByMonth?.get(col.key) ?? { inflow: 0, outflow: 0 };
        cfByMonth.set(col.key, { operating, investing, financing, net, inflow: bank.inflow, outflow: bank.outflow, lines: detail });
      });
    }
  }

  // --- Forecast overlay (same percent-or-amount rule as the Forecast page) --
  const fcRow = await db.prepare("SELECT value FROM kv_config WHERE key = 'forecast_pnl'").first<{ value: string }>();
  type FcMonth = { salesSen?: number; pct?: Record<string, number | { bp?: number; amtSen?: number }> };
  let fcMonths: Record<string, FcMonth> = {};
  try {
    fcMonths = (JSON.parse(fcRow?.value ?? "{}") as { months?: Record<string, FcMonth> }).months ?? {};
  } catch { /* none yet */ }
  const fcLineAmt = (m: FcMonth, v: number | { bp?: number; amtSen?: number }): number => {
    const salesSen = Math.max(0, Math.round(Number(m.salesSen) || 0));
    if (typeof v === "number") return Math.round((salesSen * v) / 10000);
    if (v?.amtSen) return Math.round(Number(v.amtSen) || 0);
    return Math.round((salesSen * (Number(v?.bp) || 0)) / 10000);
  };
  const fcByMonth = new Map<string, PnlSlice>();
  // Forecast per MATERIAL CATEGORY (the Forecast page keys those rows
  // "cat:FABRIC" after folding the sofa/bedframe variants together — the same
  // category names this dashboard's cost-structure card uses), so each
  // material can show its target beside the actual.
  const fcCatByMonth = new Map<string, Map<string, number>>();
  // Forecast per DEPARTMENT (`dept:` rows) — the Production Salary card's
  // table shows each department's target beside its actual (owner 2026-08-11).
  const fcDeptByMonth = new Map<string, Map<string, number>>();
  // Dept rows file into the SAME P&L section the labour map would post their
  // wages to (owner 2026-08-24): production → DIRECT_LABOUR, warehouse/maint
  // → FACTORY_OVERHEAD, office/R&D → staff cost. A dept-mode month supersedes
  // every account that map can post to (or dept rows + those accounts would
  // double-count). Owner 2026-08-29 refinement: a dept the MASTER flags
  // non-production files under staff cost regardless of the labour map — the
  // map keeps deciding where wages POST, not where the forecast SITS.
  const labourMapDash = await getLabourMap(db);
  const labourMappedDash = new Set(labourMappedAccounts(labourMapDash));
  // nonProdDash is loaded once, earlier, beside the hours-share actuals.
  const deptBucketDash = (dept: string): string => {
    if (nonProdDash.has(dept)) return "OPEX_SALARIES";
    const acct = labourMapDash.byDept[dept] ?? labourMapDash.fallback;
    const meta = coaDash.get(resolveDash(acct)) ?? coaDash.get(acct);
    return (meta ? pnlBucketFor(acct, meta.type, overrideDash) : null) ?? "DIRECT_LABOUR";
  };
  for (const [ym, m] of Object.entries(fcMonths)) {
    const slice = zero();
    slice.sales = Math.max(0, Math.round(Number(m.salesSen) || 0));
    const cats = new Map<string, number>();
    for (const [code, v] of Object.entries(m.pct ?? {})) {
      if (!code.startsWith("cat:")) continue;
      const name = code.slice(4);
      cats.set(name, (cats.get(name) ?? 0) + fcLineAmt(m, v));
    }
    fcCatByMonth.set(ym, cats);
    // Owner 2026-08-11: salaries forecast PER DEPARTMENT (`dept:` pseudo-rows).
    // A month with any dept row owns its labour there — its 750-x account
    // entries are superseded leftovers (shared rule with the Forecast page).
    const deptForecast = monthHasDeptForecast(m.pct);
    for (const [code, v] of Object.entries(m.pct ?? {})) {
      const kind = forecastEntryKind(code);
      if (kind === "dept") {
        const deptAmt = fcLineAmt(m, v);
        const deptName = code.slice(5);
        const bucketD = deptBucketDash(deptName);
        // Owner 2026-08-31 「算法也要改」: non-production salary dept rows
        // count inside COGS (they reduce gross profit) — mirrors the Forecast
        // page's cogsRows, so both screens print the same GP for a month.
        if (bucketD === "OPEX_SALARIES" || bucketD === "OPERATING_EXPENSE") { slice.labour += deptAmt; slice.cogs += deptAmt; }
        else if (bucketD === "FACTORY_OVERHEAD") { slice.overhead += deptAmt; slice.cogs += deptAmt; }
        else { slice.labour += deptAmt; slice.cogs += deptAmt; }
        const dm = fcDeptByMonth.get(ym) ?? new Map<string, number>();
        dm.set(deptName, (dm.get(deptName) ?? 0) + deptAmt);
        fcDeptByMonth.set(ym, dm);
        continue;
      }
      if (deptForecast && (kind === "labourAccount" || labourMappedDash.has(code))) continue;
      const amt = fcLineAmt(m, v);
      const meta = code.startsWith("cat:") ? { type: "COST" } : coaDash.get(code);
      if (!meta) { slice.materials += amt; slice.cogs += amt; continue; }
      const bucket = code.startsWith("cat:") ? null : pnlBucketFor(code, meta.type, overrideDash);
      if (bucket === "OTHER_INCOME") slice.otherIncome += amt;
      else if (bucket === "OPEX_SALARIES") { slice.staffCost += amt; slice.expenses += amt; }
      else if (bucket === "OPERATING_EXPENSE") { slice.otherOpex += amt; slice.expenses += amt; }
      else if (bucket === "DIRECT_LABOUR") { slice.labour += amt; slice.cogs += amt; }
      else if (bucket === "FACTORY_OVERHEAD") { slice.overhead += amt; slice.cogs += amt; }
      else { slice.materials += amt; slice.cogs += amt; } // materials incl. cat: rows
    }
    slice.gross = slice.sales - slice.cogs;
    slice.net = slice.gross + slice.otherIncome - slice.expenses;
    fcByMonth.set(ym, slice);
  }

  // --- assemble per bucket -------------------------------------------------
  const sumSlices = (src: Map<string, PnlSlice>, months: string[]): PnlSlice | null => {
    let any = false;
    const acc = zero();
    for (const ym of months) {
      const s = src.get(ym);
      if (!s) continue;
      any = true;
      acc.sales += s.sales; acc.cogs += s.cogs; acc.gross += s.gross;
      acc.otherIncome += s.otherIncome; acc.expenses += s.expenses; acc.net += s.net;
      acc.materials += s.materials; acc.labour += s.labour; acc.overhead += s.overhead;
      acc.stockMovement += s.stockMovement; acc.staffCost += s.staffCost; acc.otherOpex += s.otherOpex;
    }
    return any ? acc : null;
  };
  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);
  const rows = buckets.map((b) => {
    const actual = sumSlices(pnlByMonth, b.months);
    const forecast = sumSlices(fcByMonth, b.months);
    const bs = bsByBucket.get(b.key) ?? null;
    const cfLines = new Map<string, { label: string; section: string; value: number }>();
    const cf = b.months.reduce(
      (acc, ym) => {
        const m = cfByMonth.get(ym);
        if (m) {
          acc.operating += m.operating; acc.investing += m.investing; acc.financing += m.financing;
          acc.net += m.net; acc.inflow += m.inflow; acc.outflow += m.outflow;
          for (const l of m.lines) {
            const k = `${l.section}||${l.label}`;
            const cur = cfLines.get(k) ?? { label: l.label, section: l.section, value: 0 };
            cur.value += l.value;
            cfLines.set(k, cur);
          }
        }
        return acc;
      },
      { operating: 0, investing: 0, financing: 0, net: 0, inflow: 0, outflow: 0 },
    );
    // Cost structure for the bucket: categories summed over its months, plus
    // the bucket's own sales split (shared materials are apportioned on the
    // client with this ratio, so the same payload serves All/Bedframe/Sofa).
    const csCats = new Map<string, CsCat & { name: string }>();
    const csForecast = new Map<string, number>();
    let bedSales = 0, sofaSales = 0;
    for (const ym of b.months) {
      for (const [k, v] of csByMonth.get(ym) ?? []) {
        const cur = csCats.get(k) ?? { name: v.name, line: v.line, spend: 0, purchase: 0, closing: 0 };
        cur.spend += v.spend; cur.purchase += v.purchase; cur.closing += v.closing;
        csCats.set(k, cur);
      }
      for (const [name, amt] of fcCatByMonth.get(ym) ?? []) {
        csForecast.set(name, (csForecast.get(name) ?? 0) + amt);
      }
      const s = salesSplitByMonth.get(ym);
      if (s) { bedSales += s.bedframe; sofaSales += s.sofa; }
    }
    // Headcount over a QUARTER is the average of its months, not their sum —
    // the same 37 people worked all three. Units are a flow and do sum.
    let headSum = 0;
    let headMonths = 0;
    let units = 0;
    for (const ym of b.months) {
      const h = headByMonth.get(ym);
      if (h !== undefined) { headSum += h; headMonths += 1; }
      units += unitsByMonth.get(ym) ?? 0;
    }
    const headcount = headMonths > 0 ? Math.round(headSum / headMonths) : null;
    // Wage bill per department over the bucket's months (payslips-sourced),
    // with each department's forecast (dept: rows) beside it.
    const salDept = new Map<string, number>();
    const salDeptFc = new Map<string, number>();
    for (const ym of b.months) {
      for (const d of salByMonth.get(ym) ?? []) salDept.set(d.dept, (salDept.get(d.dept) ?? 0) + d.costSen);
      // Non-production actuals: clocked-hours share of payroll (see the
      // hours-share block above) — the master-dept payslip sums carry nothing
      // for these departments.
      for (const [dept, sen] of nonProdActualByYm.get(ym) ?? []) salDept.set(dept, (salDept.get(dept) ?? 0) + sen);
      for (const [dept, sen] of fcDeptByMonth.get(ym) ?? []) salDeptFc.set(dept, (salDeptFc.get(dept) ?? 0) + sen);
    }
    return {
      key: b.key,
      label: b.label,
      partial: b.partial || b.months.some((m) => m === nowYm),
      actual,
      forecast,
      // Production Salary denominators. unitsCompleted is flagged in the UI:
      // fg_batches double-counts some completions (parked defect).
      labourBase: { headcount, unitsCompleted: units > 0 ? units : null },
      salaryByDept: [...new Set([...salDept.keys(), ...salDeptFc.keys()])]
        // nonProd = the departments master's is_production flag (owner
        // 2026-08-31: the dashboard grows a Non-Production Salary twin card;
        // the flag is what splits one dept list into the two cards).
        .map((dept) => ({ dept, costSen: salDept.get(dept) ?? 0, forecastSen: salDeptFc.get(dept) ?? 0, nonProd: nonProdDash.has(dept) || undefined }))
        .filter((d) => d.costSen !== 0 || d.forecastSen !== 0)
        .sort((a, b2) => a.dept.localeCompare(b2.dept)),
      costStructure: {
        salesSplit: { bedframe: bedSales, sofa: sofaSales },
        // Target spend per category from the Forecast P&L (blank when the
        // owner hasn't keyed that month).
        forecast: Object.fromEntries(csForecast),
        categories: [...csCats.values()]
          .filter((v) => v.spend !== 0 || v.purchase !== 0 || v.closing !== 0)
          .sort((x, y) => x.name.localeCompare(y.name) || x.line.localeCompare(y.line)),
      },
      cashFlow: {
        ...cf,
        freeCashFlow: cf.operating, // owner: treat as no fixed assets
        lines: [...cfLines.values()].filter((l) => l.value !== 0).sort((a, b) => a.section.localeCompare(b.section) || b.value - a.value),
      },
      balanceSheet: bs,
      ratios: {
        grossMarginPct: actual ? pct(actual.gross, actual.sales) : null,
        netMarginPct: actual ? pct(actual.net, actual.sales) : null,
        currentRatio: bs && bs.currentLiabilities > 0 ? Math.round((bs.currentAssets / bs.currentLiabilities) * 100) / 100 : null,
        quickRatio: bs && bs.currentLiabilities > 0 ? Math.round(((bs.currentAssets - bs.inventory) / bs.currentLiabilities) * 100) / 100 : null,
        debtToAssetPct: bs && bs.assets > 0 ? pct(bs.liabilities, bs.assets) : null,
        roePct: bs && bs.equity > 0 && actual ? pct(actual.net, bs.equity) : null,
        roaPct: bs && bs.assets > 0 && actual ? pct(actual.net, bs.assets) : null,
      },
    };
  });

  // Trim the empty run at the front — buckets before the business has any
  // figure at all would otherwise draw as blank bars (quarterly reaches two
  // years back to fill its 8 columns).
  const hasAny = (r: (typeof rows)[number]) =>
    (r.actual !== null && (r.actual.sales !== 0 || r.actual.net !== 0)) ||
    r.forecast !== null ||
    // A balance-sheet snapshot exists for every bucket; only a NON-ZERO one
    // counts as data (before the opening date every account reads zero).
    (r.balanceSheet !== null &&
      (r.balanceSheet.assets !== 0 || r.balanceSheet.liabilities !== 0 || r.balanceSheet.equity !== 0)) ||
    r.cashFlow.net !== 0;
  let first = 0;
  while (first < rows.length - 1 && !hasAny(rows[first])) first++;

      return {
        granularity: quarterly ? "quarter" : "month",
        openingDate: openingRawDash,
        rows: rows.slice(first),
      };
    },
    dashCacheKey,
    c,
    { staleWhileRevalidate: true },
  );
  return c.json({ success: true, data: dashPayload });
});

// ---------------------------------------------------------------------------
// FORECAST P&L (owner 2026-07-29) — planning surface, zero contact with the
// books. The owner creates months himself (a month exists only once added),
// keys the month's projected SALES, and maintains every P&L line as a % of
// sales (stored in basis points); a new month inherits the previous month's
// percentages client-side. kv `forecast_pnl` = { months: { "2026-08":
// { salesSen, pct: { [accountCode]: bp } } } }.
// ---------------------------------------------------------------------------
app.get("/forecast", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const row = await c.var.DB
    .prepare("SELECT value FROM kv_config WHERE key = 'forecast_pnl'")
    .first<{ value: string }>();
  let months: Record<string, unknown> = {};
  try {
    months = (JSON.parse(row?.value ?? "{}") as { months?: Record<string, unknown> }).months ?? {};
  } catch {
    /* fresh / corrupt → empty */
  }
  return c.json({ success: true, data: { months } });
});

app.put("/forecast", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as {
      months?: Record<string, { salesSen?: number; pct?: Record<string, number | { bp?: number; amtSen?: number }> }>;
    };
    if (!body.months || typeof body.months !== "object") {
      return c.json({ success: false, error: "months required" }, 400);
    }
    // A line entry is EITHER { bp } (percent of sales, basis points) OR
    // { amtSen } (fixed RM amount — owner 2026-07-29: rent-style lines are
    // keyed as money, not %). Bare numbers = legacy bp payloads.
    const months: Record<string, { salesSen: number; pct: Record<string, { bp?: number; amtSen?: number }> }> = {};
    for (const [ym, m] of Object.entries(body.months)) {
      if (!/^\d{4}-\d{2}$/.test(ym) || !m || typeof m !== "object") continue;
      const pct: Record<string, { bp?: number; amtSen?: number }> = {};
      for (const [code, v] of Object.entries(m.pct ?? {})) {
        if (typeof v === "number") {
          const bp = Math.round(v) || 0;
          if (bp !== 0) pct[code] = { bp };
        } else if (v && typeof v === "object") {
          const amtSen = Math.round(Number(v.amtSen) || 0);
          const bp = Math.round(Number(v.bp) || 0);
          if (amtSen !== 0) pct[code] = { amtSen };
          else if (bp !== 0) pct[code] = { bp };
        }
      }
      months[ym] = { salesSen: Math.max(0, Math.round(Number(m.salesSen) || 0)), pct };
    }
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at) VALUES ('forecast_pnl', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify({ months }), new Date().toISOString()).run();
    await emitAudit(c, {
      resource: "accounting",
      resourceId: "forecast_pnl",
      action: "update",
      after: { months: Object.keys(months) },
    });
    return c.json({ success: true, data: { months } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// LANDED COST (Phase 3.7, 2026-06) — allocate import charges (freight /
// duty / clearance; the owner gets BOTH separate forwarder PIs and FEE
// lines on the goods PI) onto a GRN's rm_batches, proportional to batch
// value. GL needs NO extra legs: the charge PI already debits 700-1015
// CARRIAGE INWARDS into the Manufacturing Account, and closing stock —
// valued off the now-higher batch costs — credits the unused portion
// back out, so the cost "follows the material" exactly as the owner's
// workbook says. Only UNTOUCHED batches (remaining == original) accept
// an allocation; once issues started, the adjustment would silently
// rewrite already-consumed cost history.
// ---------------------------------------------------------------------------

type LandedBatchRow = {
  id: string; rmId: string; originalQty: number; remainingQty: number;
  unitCostSen: number; itemCode: string | null; rmName: string | null;
};

async function landedBatchesForGrn(
  db: Env["Variables"]["DB"],
  grnKey: string,
): Promise<{ grnId: string; grnNumber: string; batches: LandedBatchRow[] } | null> {
  const grn = await db
    .prepare("SELECT id, grnNumber FROM grns WHERE id = ? OR grnNumber = ?")
    .bind(grnKey, grnKey)
    .first<{ id: string; grnNumber: string }>();
  if (!grn) return null;
  const res = await db
    .prepare(
      `SELECT b.id, b.rmId, b.originalQty, b.remainingQty, b.unitCostSen,
              r.itemCode, r.name AS rm_name
         FROM rm_batches b LEFT JOIN raw_materials r ON r.id = b.rmId
        WHERE b.source = 'GRN' AND b.sourceRefId = ?
        ORDER BY b.id`,
    )
    .bind(grn.id)
    .all<LandedBatchRow>();
  return { grnId: grn.id, grnNumber: grn.grnNumber, batches: res.results ?? [] };
}

function allocateLanded(
  batches: LandedBatchRow[],
  amountSen: number,
): { batch: LandedBatchRow; allocSen: number; newUnitCostSen: number }[] {
  const values = batches.map((b) => Math.max(0, Math.round(b.originalQty * b.unitCostSen)));
  const totalValue = values.reduce((s, v) => s + v, 0);
  if (totalValue <= 0) return [];
  // Largest-remainder so the allocations sum EXACTLY to amountSen.
  const raw = values.map((v) => (amountSen * v) / totalValue);
  const base = raw.map((r) => Math.floor(r));
  let left = amountSen - base.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (left <= 0) break;
    base[o.i] += 1;
    left--;
  }
  return batches.map((b, i) => ({
    batch: b,
    allocSen: base[i],
    newUnitCostSen:
      b.originalQty > 0
        ? Math.round((values[i] + base[i]) / b.originalQty)
        : b.unitCostSen,
  }));
}

app.get("/landed-cost/preview", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const grnKey = (c.req.query("grn") || "").trim();
  const amountSen = Math.round(Number(c.req.query("amountSen")) || 0);
  if (!grnKey) return c.json({ success: false, error: "grn is required" }, 400);
  const found = await landedBatchesForGrn(c.var.DB, grnKey);
  if (!found) return c.json({ success: false, error: `GRN ${grnKey} not found` }, 404);
  if (found.batches.length === 0) {
    return c.json({ success: false, error: `GRN ${found.grnNumber} has no stock batches (not posted yet?)` }, 400);
  }
  const untouched = found.batches.every((b) => Number(b.remainingQty) === Number(b.originalQty));
  const allocs = amountSen > 0 ? allocateLanded(found.batches, amountSen) : [];
  return c.json({
    success: true,
    data: {
      grnId: found.grnId,
      grnNumber: found.grnNumber,
      eligible: untouched,
      batches: found.batches.map((b, i) => ({
        id: b.id,
        itemCode: b.itemCode,
        name: b.rmName,
        originalQty: b.originalQty,
        remainingQty: b.remainingQty,
        unitCostSen: b.unitCostSen,
        valueSen: Math.round(b.originalQty * b.unitCostSen),
        allocSen: allocs[i]?.allocSen ?? 0,
        newUnitCostSen: allocs[i]?.newUnitCostSen ?? b.unitCostSen,
      })),
    },
  });
});

app.post("/landed-cost", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const grnKey = String(body.grnId || body.grn || "").trim();
    const amountSen = Math.round(Number(body.amountSen) || 0);
    const ref = String(body.ref ?? "").trim();
    if (!grnKey || amountSen <= 0) {
      return c.json({ success: false, error: "grn and a positive amountSen are required" }, 400);
    }
    const found = await landedBatchesForGrn(c.var.DB, grnKey);
    if (!found) return c.json({ success: false, error: `GRN ${grnKey} not found` }, 404);
    if (found.batches.length === 0) {
      return c.json({ success: false, error: `GRN ${found.grnNumber} has no stock batches` }, 400);
    }
    const touched = found.batches.filter(
      (b) => Number(b.remainingQty) !== Number(b.originalQty),
    );
    if (touched.length > 0) {
      return c.json(
        {
          success: false,
          error: `GRN ${found.grnNumber} already has ${touched.length} batch(es) partly issued — landed cost can only spread onto untouched batches. Book the charge to 700-1015 and leave it (the Manufacturing Account still absorbs it), or adjust by JV.`,
        },
        400,
      );
    }
    const allocs = allocateLanded(found.batches, amountSen);
    if (allocs.length === 0) {
      return c.json({ success: false, error: "Batches carry zero value — nothing to allocate against" }, 400);
    }
    const today = new Date().toISOString().slice(0, 10);
    const statements: D1PreparedStatement[] = [];
    for (const a of allocs) {
      if (a.allocSen === 0) continue;
      statements.push(
        c.var.DB.prepare(
          "UPDATE rm_batches SET unitCostSen = ? WHERE id = ?",
        ).bind(a.newUnitCostSen, a.batch.id),
      );
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO cost_ledger (id, date, type, itemType, itemId, batchId,
             qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
           VALUES (?, ?, 'ADJUSTMENT', 'RM', ?, ?, 0, 'IN', 0, ?, 'LANDED_COST', ?, ?)`,
        ).bind(
          `cl-${crypto.randomUUID().slice(0, 10)}`,
          today,
          a.batch.rmId,
          a.batch.id,
          a.allocSen,
          ref || found.grnNumber,
          `Landed cost ${ref ? `(${ref}) ` : ""}onto GRN ${found.grnNumber}`,
        ),
      );
    }
    await c.var.DB.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: found.grnId,
      action: "update",
      after: { landedCostSen: amountSen, grn: found.grnNumber, ref },
    });
    return c.json({
      success: true,
      data: { grnNumber: found.grnNumber, batches: allocs.filter((a) => a.allocSen > 0).length, amountSen },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// LEDGER REPORT (owner screenshot, AutoCount style) — one section per
// account: B/F opening as at `from`, chronological rows with running
// balance and the DOUBLE-ENTRY counter account, per-account DR/CR totals
// + closing, grand totals across the scope. Balance is SIGNED DR−CR for
// every account (AutoCount "Home Balance" convention: credit-natural
// accounts show negative). Honours the ledger scope (all/general/sales/
// purchase), the picked-accounts set, alias resolution and opening-date
// substitution.
// ---------------------------------------------------------------------------
app.get("/gl-report", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const ledgerScope = (c.req.query("ledger") || "all").toLowerCase();
  const accountsCsv = c.req.query("accounts") || "";
  const accountSet = accountsCsv
    ? new Set(accountsCsv.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const [legRes, coaRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT id, accountCode, sourceType, sourceId, debitSen, creditSen,
              description, postedAt
         FROM ledger_journal_entries
        WHERE hidden = 0
        ORDER BY postedAt ASC, id ASC`,
    ).all<{
      id: string; accountCode: string; sourceType: string; sourceId: string;
      debitSen: number; creditSen: number; description: string; postedAt: string;
    }>(),
    c.var.DB.prepare(
      "SELECT code, name, specialAccountType FROM chart_of_accounts",
    ).all<{ code: string; name: string; specialAccountType: string | null }>(),
  ]);
  const names = new Map((coaRes.results ?? []).map((a) => [a.code, a.name] as const));
  const sdcSet = new Set<string>();
  const sccSet = new Set<string>();
  for (const a of coaRes.results ?? []) {
    if (a.specialAccountType === "SDC") sdcSet.add(a.code);
    else if (a.specialAccountType === "SCC") sccSet.add(a.code);
  }
  const inScope = (code: string): boolean => {
    switch (ledgerScope) {
      case "sales": return sdcSet.has(code);
      case "purchase": return sccSet.has(code);
      case "general": return !sdcSet.has(code) && !sccSet.has(code);
      default: return true;
    }
  };
  const resolveRep = await loadAccountResolver(c.var.DB);
  const { docDate, openingDate: obDateRep } = await loadDocDateResolver(c.var.DB);
  // Double-entry counter accounts: every leg of the same business event.
  const eventAccounts = new Map<string, Set<string>>();
  for (const l of legRes.results ?? []) {
    const key = `${l.sourceType}|${l.sourceId}`;
    let set = eventAccounts.get(key);
    if (!set) { set = new Set(); eventAccounts.set(key, set); }
    set.add(resolveRep(l.accountCode));
  }
  const deDescOf = (code: string, sourceType: string, sourceId: string): string => {
    const others = [...(eventAccounts.get(`${sourceType}|${sourceId}`) ?? [])].filter((x) => x !== code);
    if (others.length === 0) return "";
    const first = names.get(others[0]) ?? others[0];
    return others.length === 1 ? first : `${first} +${others.length - 1}`;
  };
  type RepRow = { id: string; day: string; description: string; sourceType: string; sourceId: string; deDesc: string; debitSen: number; creditSen: number; runningSen: number };
  const buckets = new Map<string, { openingSen: number; rows: Omit<RepRow, "runningSen" | "deDesc">[] }>();
  for (const l of legRes.results ?? []) {
    const day = docDate(l.sourceType, l.sourceId, l.postedAt); // by document date
    if (legBeforeOpening(l.sourceType, day, obDateRep)) continue; // pre-opening: not extracted (not even into B/F)
    const code = resolveRep(l.accountCode);
    if (!inScope(code)) continue;
    if (accountSet && !accountSet.has(code)) continue;
    if (day > to) continue;
    let b = buckets.get(code);
    if (!b) { b = { openingSen: 0, rows: [] }; buckets.set(code, b); }
    const delta = (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0);
    if (from && day < from) {
      b.openingSen += delta;
      continue;
    }
    b.rows.push({
      id: l.id,
      day,
      description: l.description ?? "",
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      debitSen: Number(l.debitSen) || 0,
      creditSen: Number(l.creditSen) || 0,
    });
  }
  // Cap the WHOLE report so an all-time run can't flatten the browser —
  // accounts are emitted in code order until the row budget runs out.
  const ROWS_CAP = 4000;
  let used = 0;
  let capped = false;
  let grandDr = 0;
  let grandCr = 0;
  const accounts: {
    code: string; name: string; openingSen: number;
    totalDr: number; totalCr: number; closingSen: number; rows: RepRow[];
  }[] = [];
  for (const code of [...buckets.keys()].sort()) {
    const b = buckets.get(code)!;
    if (b.rows.length === 0 && b.openingSen === 0) continue;
    b.rows.sort((x, y) => x.day.localeCompare(y.day) || x.id.localeCompare(y.id));
    let running = b.openingSen;
    let totalDr = 0;
    let totalCr = 0;
    const rows: RepRow[] = [];
    for (const r of b.rows) {
      running += r.debitSen - r.creditSen;
      totalDr += r.debitSen;
      totalCr += r.creditSen;
      rows.push({ ...r, deDesc: deDescOf(code, r.sourceType, r.sourceId), runningSen: running });
    }
    grandDr += totalDr;
    grandCr += totalCr;
    if (used + rows.length > ROWS_CAP) { capped = true; break; }
    used += rows.length;
    accounts.push({
      code,
      name: names.get(code) ?? "",
      openingSen: b.openingSen,
      totalDr,
      totalCr,
      closingSen: running,
      rows,
    });
  }
  return c.json({
    success: true,
    data: {
      from: from || null,
      to: to === "9999-12-31" ? null : to,
      capped,
      accounts,
      grandDr,
      grandCr,
    },
  });
});

// ---------------------------------------------------------------------------
// FIXED ASSETS + STRAIGHT-LINE DEPRECIATION (Phase 3.5, 2026-06)
//
// Register maintained by the owner (asset / accum / expense accounts,
// cost, life). Monthly run = preview → check → Post: per active asset
// DR expense_account CR accum_account, amount = (cost − residual) /
// useful_life_months capped at the remaining book value. One posted run
// per month per asset (UNIQUE(asset_id, month)); opening_accum_sen
// carries depreciation taken before the opening date, so the register's
// NBV never needs to read the shared GL account.
// ---------------------------------------------------------------------------

type FixedAssetRow = {
  id: string; name: string; assetAccount: string; accumAccount: string;
  expenseAccount: string; purchaseDate: string; costSen: number;
  residualSen: number; usefulLifeMonths: number; openingAccumSen: number;
  disposedAt: string | null; remarks: string | null;
};

function monthlyDepSen(a: FixedAssetRow, accumToDateSen: number): number {
  const base = Math.max(0, (Number(a.costSen) || 0) - (Number(a.residualSen) || 0));
  if (base === 0 || a.usefulLifeMonths <= 0) return 0;
  const monthly = Math.round(base / a.usefulLifeMonths);
  const remaining = Math.max(0, base - accumToDateSen);
  return Math.min(monthly, remaining);
}

async function loadAssetsWithAccum(db: Env["Variables"]["DB"]): Promise<{
  assets: (FixedAssetRow & { accumSen: number; lastMonth: string | null })[];
}> {
  const [aRes, dRes] = await Promise.all([
    db.prepare("SELECT * FROM fixed_assets ORDER BY purchaseDate, name").all<FixedAssetRow>(),
    db.prepare("SELECT assetId, month, amountSen FROM fixed_asset_depreciation").all<{ assetId: string; month: string; amountSen: number }>(),
  ]);
  const byAsset = new Map<string, { sum: number; last: string | null }>();
  for (const d of dRes.results ?? []) {
    const cur = byAsset.get(d.assetId) ?? { sum: 0, last: null };
    cur.sum += Number(d.amountSen) || 0;
    if (!cur.last || d.month > cur.last) cur.last = d.month;
    byAsset.set(d.assetId, cur);
  }
  return {
    assets: (aRes.results ?? []).map((a) => ({
      ...a,
      accumSen: (Number(a.openingAccumSen) || 0) + (byAsset.get(a.id)?.sum ?? 0),
      lastMonth: byAsset.get(a.id)?.last ?? null,
    })),
  };
}

app.get("/fixed-assets", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  try {
    const { assets } = await loadAssetsWithAccum(c.var.DB);
    return c.json({ success: true, data: assets });
  } catch {
    return c.json({ success: true, data: [], migrationMissing: true });
  }
});

app.post("/fixed-assets", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const b = await c.req.json();
    const name = String(b.name || "").trim();
    const costSen = Math.round(Number(b.costSen) || 0);
    const residualSen = Math.round(Number(b.residualSen) || 0);
    const life = Math.round(Number(b.usefulLifeMonths) || 0);
    const openingAccumSen = Math.round(Number(b.openingAccumSen) || 0);
    if (!name || costSen <= 0 || life <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.purchaseDate || ""))) {
      return c.json({ success: false, error: "name, purchaseDate, positive costSen and usefulLifeMonths are required" }, 400);
    }
    if (residualSen < 0 || residualSen >= costSen || openingAccumSen < 0 || openingAccumSen > costSen - residualSen) {
      return c.json({ success: false, error: "residual must be below cost; opening accumulated must not exceed (cost − residual)" }, 400);
    }
    const coaRes = await c.var.DB.prepare(
      "SELECT code, type, isPostable FROM chart_of_accounts WHERE code IN (?, ?, ?)",
    )
      .bind(String(b.assetAccount || ""), String(b.accumAccount || ""), String(b.expenseAccount || ""))
      .all<{ code: string; type: CoaRow["type"]; isPostable: number | null }>();
    const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
    const asset = coa.get(String(b.assetAccount));
    const accum = coa.get(String(b.accumAccount));
    const exp = coa.get(String(b.expenseAccount));
    if (!asset || asset.type !== "ASSET" || (asset.isPostable ?? 1) !== 1) {
      return c.json({ success: false, error: "Asset (cost) account must be a postable ASSET account" }, 400);
    }
    if (!accum || accum.type !== "ASSET" || (accum.isPostable ?? 1) !== 1) {
      return c.json({ success: false, error: "Accumulated-depreciation account must be a postable ASSET account (credit-balance contra)" }, 400);
    }
    if (!exp || !["EXPENSE", "COST"].includes(exp.type) || (exp.isPostable ?? 1) !== 1) {
      return c.json({ success: false, error: "Depreciation expense account must be a postable EXPENSE/COST account (780-x or 900-D001)" }, 400);
    }
    const id = `fa-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await c.var.DB.prepare(
      `INSERT INTO fixed_assets (
         id, name, assetAccount, accumAccount, expenseAccount, purchaseDate,
         costSen, residualSen, usefulLifeMonths, openingAccumSen, disposedAt,
         remarks, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
      .bind(id, name, b.assetAccount, b.accumAccount, b.expenseAccount, b.purchaseDate, costSen, residualSen, life, openingAccumSen, String(b.remarks ?? ""), now, now)
      .run();
    return c.json({ success: true, data: { id } }, 201);
  } catch {
    return c.json({ success: false, error: "Failed — is migration 0161 applied?" }, 400);
  }
});

app.put("/fixed-assets/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const b = await c.req.json();
    const row = await c.var.DB.prepare("SELECT * FROM fixed_assets WHERE id = ?")
      .bind(id)
      .first<FixedAssetRow>();
    if (!row) return c.json({ success: false, error: "Asset not found" }, 404);
    if (b.dispose === true) {
      await c.var.DB.prepare(
        "UPDATE fixed_assets SET disposedAt = ?, updated_at = ? WHERE id = ?",
      )
        .bind(new Date().toISOString(), new Date().toISOString(), id)
        .run();
      return c.json({ success: true });
    }
    const name = b.name === undefined ? row.name : String(b.name).trim();
    const life = b.usefulLifeMonths === undefined ? row.usefulLifeMonths : Math.round(Number(b.usefulLifeMonths) || 0);
    const residualSen = b.residualSen === undefined ? row.residualSen : Math.round(Number(b.residualSen) || 0);
    if (!name || life <= 0) {
      return c.json({ success: false, error: "name and a positive usefulLifeMonths are required" }, 400);
    }
    await c.var.DB.prepare(
      "UPDATE fixed_assets SET name = ?, usefulLifeMonths = ?, residualSen = ?, remarks = ?, updated_at = ? WHERE id = ?",
    )
      .bind(name, life, residualSen, b.remarks === undefined ? row.remarks : String(b.remarks ?? ""), new Date().toISOString(), id)
      .run();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.delete("/fixed-assets/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const dep = await c.var.DB.prepare(
    "SELECT id FROM fixed_asset_depreciation WHERE assetId = ? LIMIT 1",
  )
    .bind(id)
    .first();
  if (dep) {
    return c.json(
      { success: false, error: "This asset already has posted depreciation — dispose it instead of deleting" },
      400,
    );
  }
  await c.var.DB.prepare("DELETE FROM fixed_assets WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

// Preview the month's run: per active asset, what WOULD post.
app.get("/fixed-assets/depreciation-preview", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const month = c.req.query("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
  }
  try {
    const { assets } = await loadAssetsWithAccum(c.var.DB);
    const doneRes = await c.var.DB.prepare(
      "SELECT assetId FROM fixed_asset_depreciation WHERE month = ?",
    )
      .bind(month)
      .all<{ assetId: string }>();
    const done = new Set((doneRes.results ?? []).map((r) => r.assetId));
    const rows = assets
      .filter(
        (a) =>
          !a.disposedAt &&
          !done.has(a.id) &&
          String(a.purchaseDate).slice(0, 7) <= month,
      )
      .map((a) => ({
        assetId: a.id,
        name: a.name,
        expenseAccount: a.expenseAccount,
        accumAccount: a.accumAccount,
        accumSen: a.accumSen,
        amountSen: monthlyDepSen(a, a.accumSen),
      }))
      .filter((r) => r.amountSen > 0);
    return c.json({
      success: true,
      data: {
        month,
        rows,
        totalSen: rows.reduce((s, r) => s + r.amountSen, 0),
        alreadyRun: done.size > 0,
      },
    });
  } catch {
    return c.json({ success: false, error: "Preview failed — is migration 0161 applied?" }, 400);
  }
});

app.post("/fixed-assets/depreciation-run", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const month = String(body.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
    }
    const today = new Date().toISOString().slice(0, 7);
    if (month > today) {
      return c.json({ success: false, error: `Cannot depreciate a future month (${month})` }, 400);
    }
    const { assets } = await loadAssetsWithAccum(c.var.DB);
    const doneRes = await c.var.DB.prepare(
      "SELECT assetId FROM fixed_asset_depreciation WHERE month = ?",
    )
      .bind(month)
      .all<{ assetId: string }>();
    const done = new Set((doneRes.results ?? []).map((r) => r.assetId));
    const rows = assets
      .filter(
        (a) =>
          !a.disposedAt &&
          !done.has(a.id) &&
          String(a.purchaseDate).slice(0, 7) <= month,
      )
      .map((a) => ({ asset: a, amountSen: monthlyDepSen(a, a.accumSen) }))
      .filter((r) => r.amountSen > 0);
    if (rows.length === 0) {
      return c.json(
        { success: false, error: `Nothing to post for ${month} — already run, all disposed, or fully depreciated.` },
        400,
      );
    }
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const sourceId = `dep-${month}-${Date.now()}`;
    const legs: LedgerEntryInput[] = [];
    let legNo = 1;
    for (const r of rows) {
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "depreciation",
        sourceId,
        legNo: legNo++,
        accountCode: r.asset.expenseAccount,
        debitSen: r.amountSen,
        creditSen: 0,
        description: `Depreciation ${month} · ${r.asset.name}`,
        actorUserId,
        orgId,
      });
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "depreciation",
        sourceId,
        legNo: legNo++,
        accountCode: r.asset.accumAccount,
        debitSen: 0,
        creditSen: r.amountSen,
        description: `Depreciation ${month} · ${r.asset.name}`,
        actorUserId,
        orgId,
      });
    }
    const { statements: ledgerStmts } = await buildJournalEntryStatements(
      c.var.DB,
      orgId,
      legs,
    );
    const now = new Date().toISOString();
    await c.var.DB.batch([
      ...rows.map((r) =>
        c.var.DB.prepare(
          `INSERT INTO fixed_asset_depreciation (id, assetId, month, amountSen, postedAt)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(`fad-${crypto.randomUUID().slice(0, 8)}`, r.asset.id, month, r.amountSen, now),
      ),
      ...ledgerStmts,
    ]);
    return c.json({
      success: true,
      data: {
        month,
        assets: rows.length,
        totalSen: rows.reduce((s, r) => s + r.amountSen, 0),
      },
    });
  } catch {
    return c.json({ success: false, error: "Run failed — is migration 0161 applied?" }, 400);
  }
});

// ---------------------------------------------------------------------------
// CASH BOOK / BANK RECONCILIATION (Phase 3.4, 2026-06)
//
// The owner imports a monthly bank statement (CSV paste, column-mapped
// client-side) into bank_statement_lines, then ticks lines off against
// the ledger legs of that SBK/SCH account. amount_sen is SIGNED:
// + money in (bank credit) / − money out. Matching is 1:1 and amounts
// must agree — what remains unmatched on either side IS the 未达账项
// list (in book not bank / in bank not book).
// ---------------------------------------------------------------------------

// Monthly-session columns (owner 2026-09-01 「每个月我upload文件自动对账」):
// stmt_month ties a line to its statement month (re-upload replaces the
// month's unmatched lines), balance_sen keeps the printed running balance
// for audit, ignored_at marks statement noise the owner dismissed. Runtime
// self-apply — migration files alone are inert on this stack.
let _pendingBankRecoCols: Promise<void> | null = null;
function ensureBankRecoCols(db: Env["Variables"]["DB"]): Promise<void> {
  if (_pendingBankRecoCols) return _pendingBankRecoCols;
  _pendingBankRecoCols = (async () => {
    await runSelfApply(db, "accounting", [
      `ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS stmt_month TEXT`,
      `ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS balance_sen INTEGER`,
      `ALTER TABLE bank_statement_lines ADD COLUMN IF NOT EXISTS ignored_at TEXT`,
    ]);
  })().catch((err) => {
    _pendingBankRecoCols = null;
    throw err;
  });
  return _pendingBankRecoCols;
}

async function bankAccountOrError(
  db: Env["Variables"]["DB"],
  code: string,
): Promise<string | null> {
  const acct = await db
    .prepare("SELECT specialAccountType FROM chart_of_accounts WHERE code = ?")
    .bind(code)
    .first<{ specialAccountType: string | null }>();
  if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH")) {
    return "Account must be a bank (SBK) or cash (SCH) account";
  }
  return null;
}

app.get("/bank-reco", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const account = c.req.query("account") || "";
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const err = await bankAccountOrError(c.var.DB, account);
  if (err) return c.json({ success: false, error: err }, 400);
  // Legs of this account (renamed codes included), dated by effective day.
  const resolveBr = await loadAccountResolver(c.var.DB);
  let equivalents = [account];
  try {
    const aliasRows = await c.var.DB.prepare(
      "SELECT oldCode FROM account_aliases",
    ).all<{ oldCode: string }>();
    for (const a of aliasRows.results ?? []) {
      if (resolveBr(a.oldCode) === account) equivalents.push(a.oldCode);
    }
  } catch {
    equivalents = [account];
  }
  const marks = equivalents.map(() => "?").join(",");
  const legRes = await c.var.DB.prepare(
    `SELECT id, sourceType, sourceId, debitSen, creditSen, description, postedAt
       FROM ledger_journal_entries
      WHERE accountCode IN (${marks}) AND hidden = 0
      ORDER BY postedAt ASC, id ASC`,
  )
    .bind(...equivalents)
    .all<{ id: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; description: string; postedAt: string }>();
  const { docDate, openingDate: obDateBr } = await loadDocDateResolver(c.var.DB);
  const legs = (legRes.results ?? [])
    .map((l) => ({
      id: l.id,
      day: docDate(l.sourceType, l.sourceId, l.postedAt), // by document date
      description: l.description ?? "",
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      amountSen: (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0),
    }))
    .filter((l) => !legBeforeOpening(l.sourceType, l.day, obDateBr) && !isOpeningSource(l.sourceType) && l.day >= from && l.day <= to); // pre-opening + opening legs: not matchable (BUG-2026-09-02-173)
  let stmtLines: unknown[] = [];
  let migrationMissing = false;
  const matchedLegIds = new Set<string>();
  try {
    await ensureBankRecoCols(c.var.DB);
    const res = await c.var.DB.prepare(
      `SELECT id, txnDate, description, amountSen, matchedLegId, matchedAt, stmt_month, balance_sen, ignored_at
         FROM bank_statement_lines
        WHERE accountCode = ? AND txnDate >= ? AND txnDate <= ?
        ORDER BY txnDate ASC, id ASC`,
    )
      .bind(account, from || "0000-01-01", to)
      .all<{ id: string; txnDate: string; description: string | null; amountSen: number; matchedLegId: string | null; matchedAt: string | null }>();
    stmtLines = res.results ?? [];
    // Matches can point at legs outside the window — collect ALL matched
    // leg ids for this account so book legs flag correctly. A match whose
    // statement line is dated BEFORE the opening date does not count: that
    // bank movement is already inside the keyed opening balance, so it can
    // never clear a book leg (BUG-2026-09-02-174).
    const allMatched = await c.var.DB.prepare(
      "SELECT matchedLegId, txnDate FROM bank_statement_lines WHERE accountCode = ? AND matchedLegId IS NOT NULL",
    )
      .bind(account)
      .all<{ matchedLegId: string; txnDate: string }>();
    for (const r of allMatched.results ?? []) {
      if (!obDateBr || r.txnDate >= obDateBr) matchedLegIds.add(r.matchedLegId);
    }
  } catch {
    migrationMissing = true;
  }
  // Which months are already finalised — drives the ✓ chips and the locked UI.
  let finalizedMonths: string[] = [];
  try {
    const fRows = await c.var.DB.prepare(
      "SELECT key FROM kv_config WHERE key LIKE ?",
    ).bind(`bank_reco_final:${account}:%`).all<{ key: string }>();
    finalizedMonths = (fRows.results ?? [])
      .map((r) => String(r.key).slice(`bank_reco_final:${account}:`.length))
      .filter((m) => /^\d{4}-\d{2}$/.test(m))
      .sort();
  } catch { finalizedMonths = []; }
  return c.json({
    success: true,
    data: {
      account,
      from: from || null,
      to: to === "9999-12-31" ? null : to,
      openingDate: obDateBr ?? null,
      migrationMissing,
      finalizedMonths,
      legs: legs.map((l) => ({ ...l, matched: matchedLegIds.has(l.id) })),
      statementLines: stmtLines,
    },
  });
});

app.post("/bank-reco/import", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const account = String(body.accountCode || "");
    const err = await bankAccountOrError(c.var.DB, account);
    if (err) return c.json({ success: false, error: err }, 400);
    const linesIn: { date: string; description?: string; amountSen: number }[] =
      Array.isArray(body.lines) ? body.lines : [];
    if (linesIn.length === 0 || linesIn.length > 2000) {
      return c.json({ success: false, error: "1–2000 statement lines per import" }, 400);
    }
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const l of linesIn) {
      const amountSen = Math.round(Number(l.amountSen) || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.date)) || amountSen === 0) {
        return c.json(
          { success: false, error: `Bad line: date must be YYYY-MM-DD and amount non-zero (got ${l.date} / ${l.amountSen})` },
          400,
        );
      }
      statements.push(
        c.var.DB.prepare(
          `INSERT INTO bank_statement_lines (id, accountCode, txnDate, description, amountSen, importedAt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(`bsl-${crypto.randomUUID().slice(0, 10)}`, account, l.date, String(l.description ?? ""), amountSen, now, now),
      );
    }
    await c.var.DB.batch(statements);
    return c.json({ success: true, data: { imported: statements.length } }, 201);
  } catch {
    return c.json(
      { success: false, error: "Import failed — is migration 0160 applied?" },
      400,
    );
  }
});

app.post("/bank-reco/match", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const lineId = String(body.statementLineId || "");
    const legId = String(body.legId || "");
    const line = await c.var.DB.prepare(
      "SELECT id, accountCode, txnDate, amountSen, matchedLegId FROM bank_statement_lines WHERE id = ?",
    )
      .bind(lineId)
      .first<{ id: string; accountCode: string; txnDate: string; amountSen: number; matchedLegId: string | null }>();
    if (!line) return c.json({ success: false, error: "Statement line not found" }, 404);
    if (line.matchedLegId) return c.json({ success: false, error: "Line already matched" }, 400);
    if (await bankRecoMonthFinalized(c.var.DB, line.accountCode, line.txnDate)) {
      return c.json({ success: false, error: BANK_RECO_FINALIZED_ERR }, 400);
    }
    // Pre-opening bank movements are already inside the keyed opening balance
    // — matching one to a book leg double-counts it (BUG-2026-09-02-174).
    const obDateM = await getOpeningDate(c.var.DB);
    if (obDateM && line.txnDate < obDateM) {
      return c.json({ success: false, error: `This statement line is dated before the opening date (${obDateM}) — its money is already inside the opening balance and cannot clear a book entry.` }, 400);
    }
    const leg = await c.var.DB.prepare(
      "SELECT id, accountCode, debitSen, creditSen FROM ledger_journal_entries WHERE id = ?",
    )
      .bind(legId)
      .first<{ id: string; accountCode: string; debitSen: number; creditSen: number }>();
    if (!leg) return c.json({ success: false, error: "Ledger leg not found" }, 404);
    const resolveM = await loadAccountResolver(c.var.DB);
    if (resolveM(leg.accountCode) !== line.accountCode) {
      return c.json({ success: false, error: "Leg belongs to a different account" }, 400);
    }
    const legAmt = (Number(leg.debitSen) || 0) - (Number(leg.creditSen) || 0);
    if (legAmt !== Number(line.amountSen)) {
      return c.json(
        { success: false, error: `Amounts differ — book ${legAmt} sen vs statement ${line.amountSen} sen. Match must be exact; book the difference (bank charges etc.) first.` },
        400,
      );
    }
    // Self-heal: a match stored on a PRE-OPENING line is void for every read,
    // but it still occupied the leg here and blocked re-matching with
    // "already matched" (BUG-2026-09-02-175). Clear the account's void claims
    // before checking whether the leg is taken.
    if (obDateM) {
      await c.var.DB.prepare(
        "UPDATE bank_statement_lines SET matchedLegId = NULL, matchedAt = NULL WHERE accountCode = ? AND matchedLegId IS NOT NULL AND txnDate < ?",
      ).bind(line.accountCode, obDateM).run();
    }
    const taken = await c.var.DB.prepare(
      "SELECT id FROM bank_statement_lines WHERE matchedLegId = ? LIMIT 1",
    )
      .bind(legId)
      .first();
    if (taken) return c.json({ success: false, error: "This ledger leg is already matched to another statement line" }, 400);
    await c.var.DB.prepare(
      "UPDATE bank_statement_lines SET matchedLegId = ?, matchedAt = ? WHERE id = ?",
    )
      .bind(legId, new Date().toISOString(), lineId)
      .run();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.post("/bank-reco/unmatch", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const lineId = String(body.statementLineId || "");
    const umLine = await c.var.DB.prepare(
      "SELECT id, accountCode, txnDate FROM bank_statement_lines WHERE id = ?",
    ).bind(lineId).first<{ id: string; accountCode: string; txnDate: string }>();
    if (!umLine) return c.json({ success: false, error: "Statement line not found" }, 404);
    if (await bankRecoMonthFinalized(c.var.DB, umLine.accountCode, umLine.txnDate)) {
      return c.json({ success: false, error: BANK_RECO_FINALIZED_ERR }, 400);
    }
    await c.var.DB.prepare(
      "UPDATE bank_statement_lines SET matchedLegId = NULL, matchedAt = NULL WHERE id = ?",
    )
      .bind(lineId)
      .run();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// Auto-match: unique exact-amount candidates within ±7 days.
app.post("/bank-reco/automatch", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const account = String(body.accountCode || "");
    const from = String(body.from || "");
    const to = String(body.to || "9999-12-31");
    const err = await bankAccountOrError(c.var.DB, account);
    if (err) return c.json({ success: false, error: err }, 400);
    const resolveAm = await loadAccountResolver(c.var.DB);
    let equivalents = [account];
    try {
      const aliasRows = await c.var.DB.prepare(
        "SELECT oldCode FROM account_aliases",
      ).all<{ oldCode: string }>();
      for (const a of aliasRows.results ?? []) {
        if (resolveAm(a.oldCode) === account) equivalents.push(a.oldCode);
      }
    } catch {
      equivalents = [account];
    }
    const marks = equivalents.map(() => "?").join(",");
    // Self-heal void claims before reading state: a match stored on a
    // pre-opening line blocks its leg forever (BUG-2026-09-02-175).
    const obDateSweep = await getOpeningDate(c.var.DB);
    if (obDateSweep) {
      await c.var.DB.prepare(
        "UPDATE bank_statement_lines SET matchedLegId = NULL, matchedAt = NULL WHERE accountCode = ? AND matchedLegId IS NOT NULL AND txnDate < ?",
      ).bind(account, obDateSweep).run();
    }
    const [legRes, lineRes, matchedRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT id, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries
          WHERE accountCode IN (${marks}) AND hidden = 0`,
      )
        .bind(...equivalents)
        .all<{ id: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; sourceType: string }>(),
      c.var.DB.prepare(
        `SELECT id, txnDate, amountSen, description FROM bank_statement_lines
          WHERE accountCode = ? AND matchedLegId IS NULL AND ignored_at IS NULL AND txnDate >= ? AND txnDate <= ?`,
      )
        .bind(account, from || "0000-01-01", to)
        .all<{ id: string; txnDate: string; amountSen: number; description: string | null }>(),
      c.var.DB.prepare(
        "SELECT matchedLegId FROM bank_statement_lines WHERE accountCode = ? AND matchedLegId IS NOT NULL",
      )
        .bind(account)
        .all<{ matchedLegId: string }>(),
    ]);
    const takenLegs = new Set((matchedRes.results ?? []).map((r) => r.matchedLegId));
    const { docDate, openingDate: obDateAm } = await loadDocDateResolver(c.var.DB);
    const freeLegs = (legRes.results ?? [])
      .filter((l) => !takenLegs.has(l.id) && !isOpeningSource(l.sourceType) && !legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDateAm)) // pre-opening + opening legs: not match candidates (BUG-2026-09-02-173)
      .map((l) => ({
        id: l.id,
        sourceId: String(l.sourceId ?? ""),
        day: docDate(l.sourceType, l.sourceId, l.postedAt), // by document date
        amountSen: (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0),
      }));
    // Pre-opening statement lines are inside the keyed opening balance —
    // never candidates for matching (BUG-2026-09-02-174).
    const matchableLines = (lineRes.results ?? []).filter((l) => !obDateAm || l.txnDate >= obDateAm);
    const dayMs = 86400000;
    const updates: D1PreparedStatement[] = [];
    const usedLeg = new Set<string>();
    const usedLine = new Set<string>();
    let matched = 0;
    const take = (lineId: string, legId: string) => {
      usedLeg.add(legId);
      usedLine.add(lineId);
      updates.push(
        c.var.DB.prepare(
          "UPDATE bank_statement_lines SET matchedLegId = ?, matchedAt = ? WHERE id = ?",
        ).bind(legId, new Date().toISOString(), lineId),
      );
      matched++;
    };
    // Pass 1 — REFERENCE match (owner 2026-09-01): HLBB prints the transfer
    // reference, which is our own voucher number (HPV-…, PV-…, OR-…). A
    // statement line whose text contains exactly one free leg's voucher
    // number, amount agreeing, is that leg — regardless of date drift.
    const voucherLegs = freeLegs
      .map((l) => ({ ...l, token: /^[A-Z]{2,5}-\d{3,4}-\d+$/i.test(l.sourceId) ? l.sourceId.toUpperCase() : null }))
      .filter((l) => l.token);
    for (const line of matchableLines) {
      const desc = String(line.description ?? "").toUpperCase();
      if (!desc) continue;
      const hits = voucherLegs.filter(
        (l) => !usedLeg.has(l.id) && desc.includes(l.token as string) && l.amountSen === Number(line.amountSen),
      );
      if (hits.length === 1) take(line.id, hits[0].id);
    }
    // Pass 2 — unique exact-amount candidates within ±7 days.
    for (const line of matchableLines) {
      if (usedLine.has(line.id)) continue;
      const lineT = Date.parse(line.txnDate);
      const candidates = freeLegs.filter(
        (l) =>
          !usedLeg.has(l.id) &&
          l.amountSen === Number(line.amountSen) &&
          Math.abs(Date.parse(l.day) - lineT) <= 7 * dayMs,
      );
      // Only match when the candidate is UNAMBIGUOUS.
      if (candidates.length === 1) take(line.id, candidates[0].id);
    }
    if (updates.length > 0) await c.var.DB.batch(updates);
    return c.json({ success: true, data: { matched } });
  } catch {
    return c.json({ success: false, error: "Auto-match failed — is migration 0160 applied?" }, 400);
  }
});

app.delete("/bank-reco/line/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT id, accountCode, txnDate, matchedLegId FROM bank_statement_lines WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; accountCode: string; txnDate: string; matchedLegId: string | null }>();
  if (!row) return c.json({ success: false, error: "Line not found" }, 404);
  if (row.matchedLegId) {
    return c.json({ success: false, error: "Unmatch the line before deleting it" }, 400);
  }
  if (await bankRecoMonthFinalized(c.var.DB, row.accountCode, row.txnDate)) {
    return c.json({ success: false, error: BANK_RECO_FINALIZED_ERR }, 400);
  }
  await c.var.DB.prepare("DELETE FROM bank_statement_lines WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Monthly statement session (owner 2026-09-01 「每个月我upload文件自动对账」).
// The client parses the bank's PDF (src/lib/hlbb-statement.ts — every figure
// triple-locked against the statement's own running balances and totals) and
// posts the rows here WITH the locks, which are re-verified server-side: a
// payload whose sums don't reproduce its own opening→closing arithmetic is
// refused. Importing a month REPLACES that month's unmatched lines (matched
// ones stay; an incoming duplicate of a kept matched line is skipped), so a
// re-upload can never double-import.
// ---------------------------------------------------------------------------
app.post("/bank-reco/import-session", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    await ensureBankRecoCols(c.var.DB);
    const body = await c.req.json() as {
      accountCode?: string;
      month?: string;
      lines?: { date: string; description?: string; amountSen: number; balanceSen?: number | null }[];
      meta?: { openingSen: number; closingSen: number; totalInSen: number; totalOutSen: number; countIn: number; countOut: number };
    };
    const account = String(body.accountCode || "");
    const month = String(body.month || "");
    const err = await bankAccountOrError(c.var.DB, account);
    if (err) return c.json({ success: false, error: err }, 400);
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
    if (await bankRecoMonthFinalized(c.var.DB, account, month)) {
      return c.json({ success: false, error: BANK_RECO_FINALIZED_ERR }, 400);
    }
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const meta = body.meta;
    if (!lines.length || lines.length > 2000 || !meta) {
      return c.json({ success: false, error: "1–2000 lines plus the statement's own totals are required" }, 400);
    }
    let sumIn = 0, sumOut = 0, nIn = 0, nOut = 0;
    for (const l of lines) {
      const amt = Math.round(Number(l.amountSen) || 0);
      if (!String(l.date).startsWith(month) || amt === 0) {
        return c.json({ success: false, error: `Line outside ${month} or zero amount (${l.date} / ${l.amountSen})` }, 400);
      }
      if (amt > 0) { sumIn += amt; nIn++; } else { sumOut += -amt; nOut++; }
    }
    if (sumIn !== Math.round(meta.totalInSen) || sumOut !== Math.round(meta.totalOutSen) ||
        nIn !== meta.countIn || nOut !== meta.countOut ||
        Math.round(meta.openingSen) + sumIn - sumOut !== Math.round(meta.closingSen)) {
      return c.json({ success: false, error: "Statement arithmetic does not reproduce — refusing the import (opening + deposits − withdrawals must equal closing)" }, 400);
    }
    // Keep matched lines of this month; drop the unmatched; skip incoming
    // duplicates of a kept line.
    const kept = await c.var.DB.prepare(
      `SELECT txnDate, description, amountSen FROM bank_statement_lines
        WHERE accountCode = ? AND matchedLegId IS NOT NULL AND txnDate >= ? AND txnDate <= ?`,
    )
      .bind(account, `${month}-01`, `${month}-31`)
      .all<Record<string, unknown>>();
    const keptKeys = new Set(
      (kept.results ?? []).map((r) => `${r.txnDate}|${Math.round(Number(r.amountSen) || 0)}|${String(r.description ?? "")}`),
    );
    await c.var.DB.prepare(
      `DELETE FROM bank_statement_lines
        WHERE accountCode = ? AND matchedLegId IS NULL AND txnDate >= ? AND txnDate <= ?`,
    )
      .bind(account, `${month}-01`, `${month}-31`)
      .run();
    const now = new Date().toISOString();
    const inserts: D1PreparedStatement[] = [];
    let skippedDupes = 0;
    for (const l of lines) {
      const amt = Math.round(Number(l.amountSen) || 0);
      const key = `${l.date}|${amt}|${String(l.description ?? "")}`;
      if (keptKeys.has(key)) { skippedDupes++; continue; }
      inserts.push(
        c.var.DB.prepare(
          `INSERT INTO bank_statement_lines (id, accountCode, txnDate, description, amountSen, importedAt, created_at, stmt_month, balance_sen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(`bsl-${crypto.randomUUID().slice(0, 10)}`, account, l.date, String(l.description ?? ""), amt, now, now, month,
          l.balanceSen === null || l.balanceSen === undefined ? null : Math.round(Number(l.balanceSen))),
      );
    }
    if (inserts.length) await c.var.DB.batch(inserts);
    // Session meta for the reconciliation report.
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(`bank_reco_meta:${account}:${month}`, JSON.stringify({ ...meta, importedAt: now }), now)
      .run();
    return c.json({ success: true, data: { imported: inserts.length, keptMatched: keptKeys.size, skippedDupes } }, 201);
  } catch {
    return c.json({ success: false, error: "Import failed — is migration 0160 applied?" }, 400);
  }
});

// Ignore / un-ignore a statement noise line (bank adverts etc.) — it leaves
// the unmatched list and the reconciliation maths without being deleted.
app.post("/bank-reco/ignore", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    await ensureBankRecoCols(c.var.DB);
    const body = await c.req.json() as { statementLineId?: string; ignored?: boolean };
    const id = String(body.statementLineId || "");
    const row = await c.var.DB.prepare(
      "SELECT id, accountCode, txnDate, matchedLegId FROM bank_statement_lines WHERE id = ?",
    ).bind(id).first<{ id: string; accountCode: string; txnDate: string; matchedLegId: string | null }>();
    if (!row) return c.json({ success: false, error: "Statement line not found" }, 404);
    if (row.matchedLegId) return c.json({ success: false, error: "Unmatch the line before ignoring it" }, 400);
    if (await bankRecoMonthFinalized(c.var.DB, row.accountCode, row.txnDate)) {
      return c.json({ success: false, error: BANK_RECO_FINALIZED_ERR }, 400);
    }
    await c.var.DB.prepare("UPDATE bank_statement_lines SET ignored_at = ? WHERE id = ?")
      .bind(body.ignored === false ? null : new Date().toISOString(), id)
      .run();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// Finalising a month freezes its reconciliation: the figures AND the
// outstanding-item lists are snapshotted to kv, the month's statement lines
// refuse further match/unmatch/ignore/delete/import, and the report shows the
// saved record with a drift warning if the live ledger has since moved
// (owner 2026-09-02:「match 完了就要 save 起来，不会因为往后加新的东西就乱了」).
const BANK_RECO_FINALIZED_ERR =
  "This month's reconciliation is finalised — re-open it on the report card first";

async function bankRecoMonthFinalized(
  db: Env["Variables"]["DB"],
  account: string,
  dateOrMonth: string,
): Promise<boolean> {
  const month = String(dateOrMonth).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  try {
    const row = await db.prepare("SELECT key FROM kv_config WHERE key = ?")
      .bind(`bank_reco_final:${account}:${month}`)
      .first<{ key: string }>();
    return !!row;
  } catch {
    return false;
  }
}

type BankRecoOutstanding = { day: string; description: string; amountSen: number };
type BankRecoComputed = {
  statementOpeningSen: number | null;
  statementClosingSen: number | null;
  importedAt: string | null;
  glSen: number;
  computedGlSen: number | null;
  balanced: boolean;
  unclearedBookSen: number;
  unclearedBookCount: number;
  unbookedStmtSen: number;
  unbookedStmtCount: number;
  unclearedBook: BankRecoOutstanding[];
  unbookedStmt: BankRecoOutstanding[];
  // Book-side daily building blocks for the day-by-day comparison: total of
  // legs before the month, then per-day sums inside it (same floor rules).
  bookPreSen: number;
  bookByDay: Record<string, number>;
};

// Shared loader for every bank-reconciliation walk (report, finalise
// snapshot, daily cash position). Resolves aliases, applies the opening
// floor, and voids matches held by pre-opening lines (BUG-2026-09-02-174).
// A duplicated mirror of these rules is exactly the bug class that keeps
// recurring in this repo, so there is only one copy.
type BankRecoLegState = {
  legs: { id: string; day: string; sourceType: string; sourceId: string; description: string; amountSen: number }[];
  // legId → txnDate of the (post-opening) statement line that cleared it.
  clearedOn: Map<string, string>;
  openingDate: string | null;
};

async function loadBankRecoState(
  db: Env["Variables"]["DB"],
  account: string,
): Promise<BankRecoLegState> {
  const resolveRp = await loadAccountResolver(db);
  let equivalents = [account];
  try {
    const aliasRows = await db.prepare("SELECT oldCode FROM account_aliases").all<{ oldCode: string }>();
    for (const a of aliasRows.results ?? []) if (resolveRp(a.oldCode) === account) equivalents.push(a.oldCode);
  } catch { equivalents = [account]; }
  const marks = equivalents.map(() => "?").join(",");
  const [legRes, matchedRes] = await Promise.all([
    db.prepare(
      `SELECT id, sourceType, sourceId, debitSen, creditSen, description, postedAt FROM ledger_journal_entries
        WHERE accountCode IN (${marks}) AND hidden = 0`,
    ).bind(...equivalents).all<{ id: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; description: string | null; postedAt: string }>(),
    db.prepare(
      "SELECT matchedLegId, txnDate FROM bank_statement_lines WHERE accountCode = ? AND matchedLegId IS NOT NULL",
    ).bind(account).all<{ matchedLegId: string; txnDate: string }>(),
  ]);
  const { docDate, openingDate } = await loadDocDateResolver(db);
  const legs = (legRes.results ?? [])
    .map((l) => ({
      id: l.id,
      day: docDate(l.sourceType, l.sourceId, l.postedAt),
      sourceType: l.sourceType,
      sourceId: String(l.sourceId ?? ""),
      description: l.description ?? "",
      amountSen: (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0),
    }))
    .filter((l) => !legBeforeOpening(l.sourceType, l.day, openingDate));
  // A match on a pre-opening statement line is void for reconciliation — that
  // bank movement is inside the keyed opening balance (BUG-2026-09-02-174).
  const clearedOn = new Map<string, string>();
  for (const r of matchedRes.results ?? []) {
    if (!openingDate || r.txnDate >= openingDate) clearedOn.set(r.matchedLegId, r.txnDate);
  }
  return { legs, clearedOn, openingDate };
}

// One walk, used by BOTH the live report and the finalise snapshot.
async function computeBankRecoReport(
  db: Env["Variables"]["DB"],
  account: string,
  month: string,
): Promise<BankRecoComputed> {
  const monthEnd = `${month}-31`;
  const metaRow = await db.prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind(`bank_reco_meta:${account}:${month}`)
    .first<{ value: string | null }>()
    .catch(() => null);
  let meta: { openingSen?: number; closingSen?: number; importedAt?: string } | null = null;
  try { meta = metaRow?.value ? JSON.parse(metaRow.value) : null; } catch { meta = null; }
  const { legs: stateLegs, clearedOn, openingDate: obDateRp } = await loadBankRecoState(db, account);
  const stmtRes = await db.prepare(
    `SELECT amountSen, txnDate, description, matchedLegId FROM bank_statement_lines
      WHERE accountCode = ? AND ignored_at IS NULL AND txnDate <= ?`,
  ).bind(account, monthEnd).all<{ amountSen: number; txnDate: string; description: string | null; matchedLegId: string | null }>();
  // A match clears an item only WITHIN the report's month. A June voucher the
  // bank processed on 2 July is matched — correctly — yet as of 30 June it is
  // still in transit, so June must list it as uncleared (and, mirrored, a
  // statement line whose book leg is dated after month end is still unbooked
  // for that month). Ignoring the dates made June "Out by" exactly such
  // amounts (BUG-2026-09-04-176: HPV-2606-003 RM 600, leg 29/06, bank 02/07).
  const legDayById = new Map(stateLegs.map((l) => [l.id, l.day]));
  let glSen = 0;
  let unclearedBookSen = 0;
  let unclearedBookCount = 0;
  const unclearedBook: BankRecoOutstanding[] = [];
  const monthStart = `${month}-01`;
  let bookPreSen = 0;
  const bookByDay: Record<string, number> = {};
  for (const l of stateLegs) {
    const day = l.day;
    if (day > monthEnd) continue;
    const amt = l.amountSen;
    glSen += amt;
    if (day < monthStart) bookPreSen += amt;
    else bookByDay[day] = (bookByDay[day] ?? 0) + amt;
    // Opening legs stay in glSen (they ARE the account's floor) but are never
    // 未达账项 — the bank has no "opening balance" transaction to clear them
    // against. Counting them made the report insensitive to the keyed opening
    // figure entirely (BUG-2026-09-02-173).
    const clearedDay = clearedOn.get(l.id);
    if ((clearedDay === undefined || clearedDay > monthEnd) && !isOpeningSource(l.sourceType)) {
      unclearedBookSen += amt;
      unclearedBookCount++;
      if (unclearedBook.length < 200) unclearedBook.push({ day, description: l.description ?? "", amountSen: amt });
    }
  }
  let unbookedStmtSen = 0;
  let unbookedStmtCount = 0;
  const unbookedStmt: BankRecoOutstanding[] = [];
  for (const r of stmtRes.results ?? []) {
    if (obDateRp && r.txnDate < obDateRp) continue; // pre-opening: inside the opening balance
    if (r.matchedLegId) {
      const legDay = legDayById.get(r.matchedLegId);
      // Booked within the month → cleared. A missing leg (match target outside
      // the walk) keeps today's semantics: treated as booked, not resurfaced.
      if (legDay === undefined || legDay <= monthEnd) continue;
    }
    const amt = Math.round(Number(r.amountSen) || 0);
    unbookedStmtSen += amt;
    unbookedStmtCount++;
    if (unbookedStmt.length < 200) unbookedStmt.push({ day: r.txnDate, description: r.description ?? "", amountSen: amt });
  }
  unclearedBook.sort((a, b) => a.day.localeCompare(b.day));
  unbookedStmt.sort((a, b) => a.day.localeCompare(b.day));
  const closingSen = meta?.closingSen ?? null;
  const computedGlSen = closingSen === null ? null : closingSen + unclearedBookSen - unbookedStmtSen;
  return {
    statementOpeningSen: meta?.openingSen ?? null,
    statementClosingSen: closingSen,
    importedAt: meta?.importedAt ?? null,
    glSen,
    computedGlSen,
    balanced: computedGlSen !== null && computedGlSen === glSen,
    unclearedBookSen, unclearedBookCount,
    unbookedStmtSen, unbookedStmtCount,
    unclearedBook, unbookedStmt,
    bookPreSen, bookByDay,
  };
}

// The classic closing statement:
//   statement closing ± items not yet through the bank = GL balance.
app.get("/bank-reco/report", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const account = c.req.query("account") || "";
  const month = c.req.query("month") || "";
  const err = await bankAccountOrError(c.var.DB, account);
  if (err) return c.json({ success: false, error: err }, 400);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
  await ensureBankRecoCols(c.var.DB);
  const live = await computeBankRecoReport(c.var.DB, account, month);
  const finalRow = await c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind(`bank_reco_final:${account}:${month}`)
    .first<{ value: string | null }>()
    .catch(() => null);
  let final: Record<string, unknown> | null = null;
  try { final = finalRow?.value ? JSON.parse(finalRow.value) : null; } catch { final = null; }
  const { unclearedBook, unbookedStmt, bookPreSen, bookByDay, ...figures } = live;
  void unclearedBook; void unbookedStmt; void bookPreSen; void bookByDay; // the live endpoint stays light — lists ship in the snapshot, daily in /bank-reco/daily
  return c.json({ success: true, data: { account, month, ...figures, final } });
});

// Day-by-day book vs bank running balances for one month — the owner's
// 「逐日对照」view: both balances side by side, so the day the difference
// CHANGES is the day a discrepancy was born. Bank side is computed from the
// statement's own opening + every line of the month (any match status — the
// bank's truth doesn't care what we did with the lines).
app.get("/bank-reco/daily", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const account = c.req.query("account") || "";
  const month = c.req.query("month") || "";
  const err = await bankAccountOrError(c.var.DB, account);
  if (err) return c.json({ success: false, error: err }, 400);
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
  await ensureBankRecoCols(c.var.DB);
  const snap = await computeBankRecoReport(c.var.DB, account, month);
  const lineRes = await c.var.DB.prepare(
    `SELECT txnDate, amountSen FROM bank_statement_lines
      WHERE accountCode = ? AND txnDate >= ? AND txnDate <= ?`,
  ).bind(account, `${month}-01`, `${month}-31`).all<{ txnDate: string; amountSen: number }>();
  const bankByDay: Record<string, number> = {};
  for (const r of lineRes.results ?? []) {
    bankByDay[r.txnDate] = (bankByDay[r.txnDate] ?? 0) + Math.round(Number(r.amountSen) || 0);
  }
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  let bookSen = snap.bookPreSen;
  let bankSen: number | null = snap.statementOpeningSen;
  const days: { day: string; bookSen: number; bankSen: number | null; diffSen: number | null }[] = [];
  for (let i = 1; i <= daysInMonth; i++) {
    const day = `${month}-${String(i).padStart(2, "0")}`;
    bookSen += snap.bookByDay[day] ?? 0;
    if (bankSen !== null) bankSen += bankByDay[day] ?? 0;
    days.push({ day, bookSen, bankSen, diffSen: bankSen === null ? null : bookSen - bankSen });
  }
  return c.json({ success: true, data: { account, month, days } });
});

// Cash-board side tables (owner 2026-09-03 完整体):
//   bank_board_cleared — the DAILY TICK. The owner sees a voucher go through
//   in his banking app and ticks it on the board; the leg leaves the pending
//   queue and the bank estimate turns daily-accurate. A tick is board
//   metadata only — the monthly statement import + matching supersedes it,
//   and a ticked leg whose month HAS a statement but no match raises a red
//   warning instead of being silently believed.
//   planned_payments — money he intends to pay that has no voucher yet
//   (default-off section; he may never use it).
// ⚠ Migration files 0232/0213 are the record; THIS self-apply is the
// mechanism.
let _pendingCashBoardTables: Promise<void> | null = null;
function ensureCashBoardTables(db: Env["Variables"]["DB"]): Promise<void> {
  if (!_pendingCashBoardTables) {
    _pendingCashBoardTables = (async () => {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS bank_board_cleared (
           leg_id       TEXT PRIMARY KEY,
           account_code TEXT NOT NULL,
           cleared_on   TEXT NOT NULL,
           created_at   TEXT
         )`,
      ).run();
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS planned_payments (
           id            TEXT PRIMARY KEY,
           party_name    TEXT NOT NULL,
           ref           TEXT,
           expected_date TEXT NOT NULL,
           amount_sen    INTEGER NOT NULL,
           created_at    TEXT,
           done_at       TEXT
         )`,
      ).run();
    })().catch((e) => {
      _pendingCashBoardTables = null;
      throw e;
    });
  }
  return _pendingCashBoardTables;
}

// Tick / untick one pending voucher: 「我在银行 app 看到已经扣了」.
app.post("/cash-position/tick", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    await ensureCashBoardTables(c.var.DB);
    const body = await c.req.json() as { legId?: string; accountCode?: string; cleared?: boolean; date?: string };
    const legId = String(body.legId || "");
    if (!legId) return c.json({ success: false, error: "legId required" }, 400);
    if (body.cleared === false) {
      await c.var.DB.prepare("DELETE FROM bank_board_cleared WHERE leg_id = ?").bind(legId).run();
      return c.json({ success: true });
    }
    const clearedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : new Date().toISOString().slice(0, 10);
    await c.var.DB.prepare(
      `INSERT INTO bank_board_cleared (leg_id, account_code, cleared_on, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(leg_id) DO UPDATE SET cleared_on = excluded.cleared_on`,
    ).bind(legId, String(body.accountCode || ""), clearedOn, new Date().toISOString()).run();
    return c.json({ success: true });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// Planned payments (default-off section): add / mark done / delete.
app.post("/cash-position/planned", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    await ensureCashBoardTables(c.var.DB);
    const body = await c.req.json() as { partyName?: string; ref?: string; expectedDate?: string; amountSen?: number };
    const party = String(body.partyName || "").trim();
    const dateS = String(body.expectedDate || "");
    const amt = Math.round(Number(body.amountSen) || 0);
    if (!party || !/^\d{4}-\d{2}-\d{2}$/.test(dateS) || amt <= 0) {
      return c.json({ success: false, error: "partyName, expectedDate (YYYY-MM-DD) and a positive amountSen are required" }, 400);
    }
    const id = `plan-${crypto.randomUUID().slice(0, 10)}`;
    await c.var.DB.prepare(
      "INSERT INTO planned_payments (id, party_name, ref, expected_date, amount_sen, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, party, String(body.ref || "") || null, dateS, amt, new Date().toISOString()).run();
    return c.json({ success: true, data: { id } }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

app.delete("/cash-position/planned/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  await ensureCashBoardTables(c.var.DB);
  await c.var.DB.prepare("DELETE FROM planned_payments WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ success: true });
});

// Daily cash position (owner 2026-09-03 — his external "BANK BALANCE
// AVAILABLE" board, rebuilt inside the ERP). Per bank/cash account, as at a
// date D: estimated bank balance = book(≤D) − pending + unbooked, where
// pending = recorded legs the bank hasn't processed by D (unmatched, or
// matched to a statement line dated after D — 「我开 PV 了，银行还没付款」),
// and unbooked = bank lines ≤D nobody booked yet. Available (after pending)
// = bank estimate + pending(signed) = what's truly spendable once the queue
// clears. Source is the book ± reconciliation, plus the owner's DAILY TICKS
// (bank_board_cleared) so the estimate stays daily-accurate between monthly
// statements. The pending LIST shows only fresh vouchers (after each
// account's last finalised month); older reconciliation debt is one summary
// line — same maths, less noise.
app.get("/cash-position", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ success: false, error: "date must be YYYY-MM-DD" }, 400);
  await ensureBankRecoCols(c.var.DB);
  await ensureCashBoardTables(c.var.DB);
  // The owner's daily ticks: legId → the day he saw the bank process it.
  const tickRows = await c.var.DB.prepare(
    "SELECT leg_id, cleared_on FROM bank_board_cleared",
  ).all<{ leg_id?: string; legId?: string; cleared_on?: string; clearedOn?: string }>().catch(() => ({ results: [] as { leg_id?: string; legId?: string; cleared_on?: string; clearedOn?: string }[] }));
  const tickMap = new Map<string, string>();
  for (const r of tickRows.results ?? []) {
    const k = r.legId ?? r.leg_id;
    const v = r.clearedOn ?? r.cleared_on;
    if (k && v) tickMap.set(k, v);
  }
  const coaRes = await c.var.DB.prepare(
    "SELECT code, name, specialAccountType FROM chart_of_accounts WHERE isActive = 1 ORDER BY code",
  ).all<{ code: string; name: string; specialAccountType?: string | null; special_account_type?: string | null }>();
  const bankAccounts = (coaRes.results ?? []).filter((a) => {
    const t = a.specialAccountType ?? a.special_account_type ?? "";
    return t === "SBK" || t === "SCH";
  });
  const accounts: {
    code: string; name: string; reconciled: boolean;
    bookSen: number; pendingSen: number; unbookedSen: number; unbookedCount: number;
    bankEstSen: number; availableSen: number;
    oldPendingSen: number; oldPendingCount: number;
    pending: { legId: string; day: string; sourceId: string; description: string; amountSen: number; ticked: boolean }[];
  }[] = [];
  const tickWarnings: { account: string; day: string; sourceId: string; description: string; amountSen: number }[] = [];
  for (const a of bankAccounts) {
    const { legs, clearedOn, openingDate } = await loadBankRecoState(c.var.DB, a.code);
    // The pending LIST only itemises vouchers after this account's last
    // FINALISED month — earlier leftovers are reconciliation debt, collapsed
    // into one summary line (the maths still counts them).
    let freshFloor = "";
    try {
      const fRows = await c.var.DB.prepare("SELECT key FROM kv_config WHERE key LIKE ?")
        .bind(`bank_reco_final:${a.code}:%`).all<{ key: string }>();
      const months = (fRows.results ?? [])
        .map((r) => String(r.key).slice(`bank_reco_final:${a.code}:`.length))
        .filter((m) => /^\d{4}-\d{2}$/.test(m))
        .sort();
      if (months.length) freshFloor = `${months[months.length - 1]}-31`;
    } catch { freshFloor = ""; }
    // Which months have an imported statement — a tick on a leg of such a
    // month that STILL has no match means the bank never showed it: warn.
    const importedMonths = new Set<string>();
    try {
      const mRows = await c.var.DB.prepare("SELECT key FROM kv_config WHERE key LIKE ?")
        .bind(`bank_reco_meta:${a.code}:%`).all<{ key: string }>();
      for (const r of mRows.results ?? []) {
        const m = String(r.key).slice(`bank_reco_meta:${a.code}:`.length);
        if (/^\d{4}-\d{2}$/.test(m)) importedMonths.add(m);
      }
    } catch { /* none */ }
    // An account with no imported statement lines (cash in hand, banks not
    // yet under reconciliation) is BOOK-ONLY: no pending concept, estimate =
    // book balance. Otherwise every leg would read as "pending" forever.
    let reconciled = false;
    try {
      const probe = await c.var.DB.prepare(
        "SELECT id FROM bank_statement_lines WHERE accountCode = ? LIMIT 1",
      ).bind(a.code).first<{ id: string }>();
      reconciled = !!probe;
    } catch { reconciled = false; }
    let bookSen = 0;
    let pendingSen = 0;
    let oldPendingSen = 0;
    let oldPendingCount = 0;
    const pending: { legId: string; day: string; sourceId: string; description: string; amountSen: number; ticked: boolean }[] = [];
    for (const l of legs) {
      if (l.day > date) continue;
      bookSen += l.amountSen;
      if (!reconciled) continue;
      if (isOpeningSource(l.sourceType)) continue; // the floor itself is never pending
      const matchedOn = clearedOn.get(l.id);
      const clearedByMatch = !!matchedOn && matchedOn <= date;
      const tickedOn = tickMap.get(l.id);
      const clearedByTick = !clearedByMatch && !!tickedOn && tickedOn <= date;
      if (!clearedByMatch && !clearedByTick) {
        pendingSen += l.amountSen;
        if (l.day > freshFloor) {
          if (pending.length < 300) pending.push({ legId: l.id, day: l.day, sourceId: l.sourceId, description: l.description, amountSen: l.amountSen, ticked: false });
        } else {
          oldPendingSen += l.amountSen;
          oldPendingCount++;
        }
      } else if (clearedByTick) {
        // Still listed (greyed, tick ON) so the owner can untick a mistake —
        // it just no longer counts as pending.
        if (l.day > freshFloor && pending.length < 300) {
          pending.push({ legId: l.id, day: l.day, sourceId: l.sourceId, description: l.description, amountSen: l.amountSen, ticked: true });
        }
        // The bank's own statement is the referee: month imported + still
        // unmatched means the tick claimed something the paper never showed.
        if (!matchedOn && importedMonths.has(l.day.slice(0, 7))) {
          tickWarnings.push({ account: a.code, day: l.day, sourceId: l.sourceId, description: l.description, amountSen: l.amountSen });
        }
      }
    }
    pending.sort((x, y) => x.day.localeCompare(y.day));
    let unbookedSen = 0;
    let unbookedCount = 0;
    if (reconciled) {
      try {
        const ub = await c.var.DB.prepare(
          `SELECT amountSen, txnDate FROM bank_statement_lines
            WHERE accountCode = ? AND matchedLegId IS NULL AND ignored_at IS NULL AND txnDate <= ?`,
        ).bind(a.code, date).all<{ amountSen: number; txnDate: string }>();
        for (const r of ub.results ?? []) {
          if (openingDate && r.txnDate < openingDate) continue; // inside the opening balance
          unbookedSen += Math.round(Number(r.amountSen) || 0);
          unbookedCount++;
        }
      } catch { /* statement table absent — book-only estimate */ }
    }
    const bankEstSen = bookSen - pendingSen + unbookedSen;
    const availableSen = bankEstSen + pendingSen; // = bookSen + unbookedSen
    accounts.push({ code: a.code, name: a.name, reconciled, bookSen, pendingSen, unbookedSen, unbookedCount, bankEstSen, availableSen, oldPendingSen, oldPendingCount, pending });
  }
  const totalBankEstSen = accounts.reduce((s, x) => s + x.bankEstSen, 0);
  const totalAvailableSen = accounts.reduce((s, x) => s + x.availableSen, 0);

  // TO REPAY / TO RECEIVE — the SAME inclusion rules as the aging tabs
  // (rowBeforeOpening / apRowBeforeOpening / status filters), so the board
  // always ties to Creditor & Debtor Aging. Grouped (month, party); the
  // customer rows also carry the already-due slice (invoice due date = the
  // customer's terms) for the board's default "due now" scope.
  const obDateCp = await getOpeningDate(c.var.DB);
  const apExclCp = await loadOpeningApExcludes(c.var.DB);
  const [piRes2, invRes2, ocbRes2, plannedRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT id, supplierName, amountSen, paidAmountSen, status, invoiceDate, isOpening FROM purchase_invoices",
    ).all<{ id: string; supplierName: string; amountSen: number; paidAmountSen?: number | null; paid_amount_sen?: number | null; status: string; invoiceDate: string | null; isOpening: number | null }>(),
    c.var.DB.prepare(
      "SELECT customerName, totalSen, paidAmount, status, dueDate, invoiceDate, isOpening FROM invoices",
    ).all<{ customerName: string; totalSen: number; paidAmount: number; status: string; dueDate: string | null; invoiceDate: string | null; isOpening: number | null }>(),
    c.var.DB.prepare(
      `SELECT b.partyName, b.billDate, b.totalSen, b.paidAmountSen, b.status, dl.state AS lifecycleState
         FROM other_party_bills b
         LEFT JOIN document_lifecycle dl
           ON dl.sourceType = 'other_party_bill' AND dl.sourceId = b.billNo AND dl.orgId = b.orgId
        WHERE b.partyType = 'CREDITOR'`,
    ).all<{ partyName: string; billDate: string | null; totalSen: number; paidAmountSen?: number | null; paid_amount_sen?: number | null; status: string; lifecycleState: string | null }>(),
    c.var.DB.prepare(
      "SELECT id, party_name, ref, expected_date, amount_sen FROM planned_payments WHERE done_at IS NULL ORDER BY expected_date",
    ).all<{ id: string; party_name?: string; partyName?: string; ref: string | null; expected_date?: string; expectedDate?: string; amount_sen?: number; amountSen?: number }>().catch(() => ({ results: [] as never[] })),
  ]);
  const repayAgg = new Map<string, number>();
  for (const p of piRes2.results ?? []) {
    if (apRowBeforeOpening({ id: p.id, date: p.invoiceDate, isOpening: p.isOpening }, obDateCp, apExclCp)) continue;
    if (["DRAFT", "CANCELLED", "PAID"].includes(p.status)) continue;
    const out = (Number(p.amountSen) || 0) - (Number(p.paidAmountSen ?? p.paid_amount_sen) || 0);
    if (out <= 0) continue;
    const month = String(p.invoiceDate ?? "").slice(0, 7) || "unknown";
    const k = `${month}|${p.supplierName || "Unknown"}`;
    repayAgg.set(k, (repayAgg.get(k) ?? 0) + out);
  }
  for (const b of ocbRes2.results ?? []) {
    if (b.lifecycleState && b.lifecycleState !== "ACTIVE") continue;
    if (["CANCELLED", "PAID"].includes(b.status)) continue;
    const out = (Number(b.totalSen) || 0) - (Number(b.paidAmountSen ?? b.paid_amount_sen) || 0);
    if (out <= 0) continue;
    const month = String(b.billDate ?? "").slice(0, 7) || "unknown";
    const k = `${month}|${b.partyName || "Unknown"}`;
    repayAgg.set(k, (repayAgg.get(k) ?? 0) + out);
  }
  // Unapplied advances net off EXACTLY like the aging tabs (money already
  // paid/received but not yet knocked to a document) — without this the
  // board overstates what is still owed/collectible, and the owner's first
  // cross-check against Creditor/Debtor Aging fails.
  const orgIdCp = getOrgId(c);
  for (const [, adv] of await loadUnappliedSupplierAdvances(c.var.DB, orgIdCp)) {
    for (const it of adv.items) {
      const month = String(it.date ?? "").slice(0, 7) || "unknown";
      const k = `${month}|${adv.supplierName || "Unknown"}`;
      repayAgg.set(k, (repayAgg.get(k) ?? 0) - it.sen);
    }
  }
  const repay = [...repayAgg.entries()]
    .map(([k, sen]) => ({ month: k.split("|")[0], name: k.split("|")[1], outstandingSen: sen }))
    .filter((r) => r.outstandingSen !== 0)
    .sort((x, y) => x.month.localeCompare(y.month) || x.name.localeCompare(y.name));
  const recvAgg = new Map<string, { totalSen: number; dueSen: number }>();
  for (const i of invRes2.results ?? []) {
    if (rowBeforeOpening(i.invoiceDate, obDateCp, i.isOpening)) continue;
    if (["DRAFT", "CANCELLED", "PAID"].includes(i.status)) continue;
    const out = (Number(i.totalSen) || 0) - (Number(i.paidAmount) || 0);
    if (out <= 0) continue;
    const month = String(i.invoiceDate ?? "").slice(0, 7) || "unknown";
    const k = `${month}|${i.customerName || "Unknown"}`;
    const row = recvAgg.get(k) ?? { totalSen: 0, dueSen: 0 };
    row.totalSen += out;
    // No due date recorded = treat as already due (never hide collectible money).
    if (!i.dueDate || i.dueDate <= date) row.dueSen += out;
    recvAgg.set(k, row);
  }
  for (const [, adv] of await loadUnappliedCustomerAdvances(c.var.DB, orgIdCp)) {
    for (const it of adv.items) {
      const month = String(it.date ?? "").slice(0, 7) || "unknown";
      const k = `${month}|${adv.customerName || "Unknown"}`;
      const row = recvAgg.get(k) ?? { totalSen: 0, dueSen: 0 };
      // Cash in hand reduces both scopes — an advance is due-neutral.
      row.totalSen -= it.sen;
      row.dueSen -= it.sen;
      recvAgg.set(k, row);
    }
  }
  const receive = [...recvAgg.entries()]
    .map(([k, v]) => ({ month: k.split("|")[0], name: k.split("|")[1], totalSen: v.totalSen, dueSen: v.dueSen }))
    .filter((r) => r.totalSen !== 0 || r.dueSen !== 0)
    .sort((x, y) => x.month.localeCompare(y.month) || x.name.localeCompare(y.name));
  const planned = (plannedRes.results ?? []).map((p) => ({
    id: p.id,
    partyName: p.partyName ?? p.party_name ?? "",
    ref: p.ref ?? "",
    expectedDate: p.expectedDate ?? p.expected_date ?? "",
    amountSen: Math.round(Number(p.amountSen ?? p.amount_sen) || 0),
  }));
  const openingMonth = (obDateCp ?? "").slice(0, 7) || null;
  return c.json({
    success: true,
    data: { date, accounts, totalBankEstSen, totalAvailableSen, repay, receive, planned, tickWarnings, openingMonth },
  });
});

// Freeze (or re-open) a month's reconciliation. POST {accountCode, month} to
// finalise — the current figures + outstanding lists become the permanent
// record; POST {accountCode, month, reopen: true} to unlock it again.
app.post("/bank-reco/finalize", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  try {
    const body = await c.req.json() as { accountCode?: string; month?: string; reopen?: boolean };
    const account = String(body.accountCode || "");
    const month = String(body.month || "");
    const err = await bankAccountOrError(c.var.DB, account);
    if (err) return c.json({ success: false, error: err }, 400);
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ success: false, error: "month must be YYYY-MM" }, 400);
    await ensureBankRecoCols(c.var.DB);
    const key = `bank_reco_final:${account}:${month}`;
    if (body.reopen) {
      await c.var.DB.prepare("DELETE FROM kv_config WHERE key = ?").bind(key).run();
      return c.json({ success: true, data: { reopened: true } });
    }
    const snap = await computeBankRecoReport(c.var.DB, account, month);
    if (!snap.importedAt) {
      return c.json({ success: false, error: "Import this month's bank statement before finalising" }, 400);
    }
    const actorUserId = (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const now = new Date().toISOString();
    const { bookPreSen: _pre, bookByDay: _byDay, ...snapStored } = snap;
    void _pre; void _byDay; // daily view recomputes live — keep the snapshot lean
    await c.var.DB.prepare(
      `INSERT INTO kv_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(key, JSON.stringify({ v: 1, finalizedAt: now, actorUserId, ...snapStored }), now)
      .run();
    return c.json({ success: true, data: { finalizedAt: now, balanced: snap.balanced } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// OPENING BALANCE (Phase-5 prerequisite, 2026-06 — owner enters it himself)
//
// AutoCount-style split:
//   · AR/AP — one opening invoice per customer/supplier (invoices /
//     purchase_invoices rows flagged isOpening=1). They feed aging,
//     statements, the outstanding counters and the three-card recon, but
//     NEVER post GL legs themselves — no revenue/SST re-recognition.
//   · GL — one balanced batch of 'opening_balance' legs covering BALANCE
//     SHEET accounts only. The debtor/creditor control legs are derived
//     server-side from the opening-invoice sums, so control == subledger
//     by construction. Re-posting reverses the prior batch first
//     ('opening_balance_reversal') — the immutable ledger never updates.
//
// Dating: backdating postedAt would break the hash-chain walk order
// (verifyJournalChain orders by postedAt), so opening legs carry the
// normal insert timestamp and EVERY date-filtered read surface treats
// them as dated at kv 'opening_date' (see openingLegDay below).
// ---------------------------------------------------------------------------
const OPENING_DATE_KV_KEY = "opening_date";

// Exported 2026-08-06 for the invoice list's `preOpening` flag — the payment
// knock-off grid must know which invoices sit outside the books.
export async function getOpeningDate(
  db: Env["Variables"]["DB"],
): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(OPENING_DATE_KV_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return null;
    const v = String(row.value).replace(/^"|"$/g, "");
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function isOpeningSource(sourceType: string | null | undefined): boolean {
  return (
    sourceType === "opening_balance" ||
    sourceType === "opening_balance_reversal"
  );
}

// Self-applies the fund_transfers table (transfer_no → its own date), so a
// back-dated bank transfer reports on its document date instead of postedAt.
// Idempotent; try/catch so a no-DDL-perms env degrades to the postedAt fallback.
async function ensureFundTransfersTable(
  db: Env["Variables"]["DB"],
): Promise<void> {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS fund_transfers (
           id TEXT PRIMARY KEY,
           transfer_no TEXT NOT NULL,
           date TEXT NOT NULL,
           org_id TEXT NOT NULL DEFAULT 'hookka',
           created_at TEXT
         )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_fund_transfers_no ON fund_transfers (org_id, transfer_no)",
      )
      .run();
  } catch {
    /* no DDL perms — Hookka迁移12 paste-SQL covers it; reports fall back to postedAt */
  }
}

// Document-date resolver (owner 2026-06-25): the immutable ledger stores only
// `postedAt` (entry time), but every financial report must bucket/floor by each
// leg's SOURCE DOCUMENT date (a June invoice entered in July belongs to June).
// Loads each document family's (id, human-no → own date) ONCE per request and
// returns docDate(sourceType, sourceId, postedAt):
//   - opening_balance(_reversal)            → kv opening_date
//   - a mapped family (invoice/payment/…)   → that document's date (id or no)
//   - anything else / not found             → postedAt (= legacy behaviour, safe)
// Each family load is try/caught so a missing table/column just degrades that
// family to the postedAt fallback. Keyed by BOTH id and human number because
// posters set sourceId inconsistently (some the UUID, some the doc number).
async function loadDocDateResolver(
  db: Env["Variables"]["DB"],
): Promise<DocDateCtx> {
  const openingDate = await getOpeningDate(db);
  const maps = new Map<string, Map<string, string>>(); // family → (id|no → 'YYYY-MM-DD')
  for (const [fam, cfg] of Object.entries(DOC_DATE_FAMILIES)) {
    const m = new Map<string, string>();
    try {
      const res = await db
        .prepare(
          `SELECT id AS rid, ${cfg.noCol} AS rno, ${cfg.dateCol} AS rdt FROM ${cfg.table}`,
        )
        .all<{ rid: string | null; rno: string | null; rdt: string | null }>();
      for (const r of res.results ?? []) {
        const d = String(r.rdt ?? "").slice(0, 10);
        if (!d) continue;
        if (r.rid) m.set(String(r.rid), d);
        if (r.rno) m.set(String(r.rno), d);
      }
    } catch {
      /* table/column absent → this family falls back to postedAt */
    }
    maps.set(fam, m);
  }
  const docDate = (
    sourceType: string,
    sourceId: string,
    postedAt: string | null | undefined,
  ): string => {
    if (isOpeningSource(sourceType)) {
      return openingDate ?? String(postedAt ?? "").slice(0, 10);
    }
    const fam = maps.get(stripLegSuffix(sourceType));
    // Edit-correction legs carry 'docId:edit-<stamp>' sourceIds — the raw
    // lookup missed, fell back to postedAt, and a post-opening edit to a
    // pre-opening PI escaped the opening floor and double-counted against
    // the opening entry (BUG-2026-07-24-001: +312/+95.04 drift on 400-0000).
    const d = fam?.get(String(sourceId)) ?? fam?.get(stripSourceIdSuffix(sourceId));
    if (d) return d;
    // Period-end bookkeeping (depreciation / closing_stock / year_close) encode
    // their own date in the sourceId; everything else falls back to postedAt.
    const sp = parseSourceIdDate(sourceType, sourceId);
    return sp ?? String(postedAt ?? "").slice(0, 10);
  };
  return { docDate, openingDate, glMemo: new Map() };
}

// Per-control-account sums of the opening invoices: AR per parseDebtorCode
// control (300-x / 305-x), AP all into 400-0000. These become the locked
// control legs of the GL opening batch.
// ---------------------------------------------------------------------------
// Mid-year opening include rule (owner rule 2026-07-02): PIs entered BEFORE the
// opening date count as opening seeds BY DEFAULT — without touching the rows
// (iron rule: never edit existing entries). Exceptions (wrong/phantom entries
// that must stay hidden) live in `opening_ap_excludes`. Runtime self-applied —
// no manual migration required.
// ---------------------------------------------------------------------------
async function ensureOpeningApExcludes(db: Env["Variables"]["DB"]): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS opening_ap_excludes (
         pi_id TEXT PRIMARY KEY,
         org_id TEXT,
         created_at TEXT
       )`,
    )
    .run();
}

async function loadOpeningApExcludes(db: Env["Variables"]["DB"]): Promise<Set<string>> {
  try {
    await ensureOpeningApExcludes(db);
    const res = await db
      .prepare("SELECT pi_id FROM opening_ap_excludes")
      .all<{ piId?: string; pi_id?: string }>();
    return new Set(
      (res.results ?? [])
        .map((r) => String(r.piId ?? r.pi_id ?? ""))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function openingControlSums(db: Env["Variables"]["DB"]): Promise<{
  arByControl: Map<string, number>;
  arTotalSen: number;
  apTotalSen: number;
  opb405Sen: number;
  opb305Sen: number;
}> {
  const arByControl = new Map<string, number>();
  let arTotalSen = 0;
  let apTotalSen = 0;
  let opb405Sen = 0;
  let opb305Sen = 0;
  try {
    const inv = await db
      .prepare(
        `SELECT i.totalSen AS totalSen, c.code AS cust_code
           FROM invoices i LEFT JOIN customers c ON c.id = i.customerId
          WHERE i.isOpening = 1 AND i.status NOT IN ('DRAFT','CANCELLED')`,
      )
      .all<{ totalSen: number; custCode: string | null }>();
    for (const r of inv.results ?? []) {
      const amt = Number(r.totalSen) || 0;
      const parsed = parseDebtorCode(r.custCode);
      const ctl = parsed.ok ? parsed.controlCode : "300-0000";
      arByControl.set(ctl, (arByControl.get(ctl) ?? 0) + amt);
      arTotalSen += amt;
    }
    const pi = await db
      .prepare(
        `SELECT COALESCE(SUM(amountSen),0) AS s FROM purchase_invoices
          WHERE isOpening = 1 AND status != 'DRAFT'`,
      )
      .first<{ s: number }>();
    apTotalSen = Number(pi?.s) || 0;
  } catch {
    /* isOpening column missing — migration 0158 not applied yet */
  }
  // Mid-year opening: pre-opening PIs count as opening by default (see
  // ensureOpeningApExcludes above) — add their face value to the 400-0000
  // control leg alongside the explicitly-keyed opening PIs.
  try {
    const od = await getOpeningDate(db);
    if (od) {
      await ensureOpeningApExcludes(db);
      const inc = await db
        .prepare(
          `SELECT COALESCE(SUM(amountSen),0) AS s FROM purchase_invoices
            WHERE COALESCE(isOpening, 0) = 0
              AND status NOT IN ('DRAFT','CANCELLED')
              AND invoiceDate < ?
              AND id NOT IN (SELECT pi_id FROM opening_ap_excludes)`,
        )
        .bind(od)
        .first<{ s: number }>();
      apTotalSen += Number(inc?.s) || 0;
    }
  } catch {
    /* opening date not set or excludes table unavailable — no auto-include */
  }
  // Other-party (405/305) opening coverage (BUG-2026-07-23-003): pre-opening
  // dated other-party bills self-posted their GL at creation, but those legs
  // sit behind the opening floor — invisible to every report — while their
  // post-opening PAYMENTS show, driving 405-0000 into a debit balance
  // (−12,871.80 vs subledger 1,200 on 2026-07-23). Auto-derive the opening
  // control legs from the pre-opening ACTIVE bills, exactly like 400-0000
  // does for pre-opening PIs.
  try {
    const od = await getOpeningDate(db);
    if (od) {
      // Same proven query shape as sweepOtherPartyBillGl; the date filter and
      // type split run in JS (an SQL aggregate over the adapter's renamed
      // columns read back empty here).
      const opb = await db
        .prepare(
          `SELECT b.billNo, b.partyType, b.totalSen, b.billDate
             FROM other_party_bills b
             LEFT JOIN document_lifecycle dl
               ON dl.sourceType = 'other_party_bill' AND dl.sourceId = b.billNo AND dl.orgId = b.orgId
            WHERE (dl.state IS NULL OR dl.state = 'ACTIVE')`,
        )
        .all<{
          billNo: string; partyType?: string; party_type?: string;
          totalSen?: number; total_sen?: number;
          billDate?: string | null; bill_date?: string | null;
        }>();
      for (const r of opb.results ?? []) {
        const d = String(r.billDate ?? r.bill_date ?? "").slice(0, 10);
        if (!d || d >= od) continue;
        const amt = Math.round(Number(r.totalSen ?? r.total_sen) || 0);
        const t = String(r.partyType ?? r.party_type ?? "");
        if (t === "CREDITOR") opb405Sen += amt;
        else if (t === "DEBTOR") opb305Sen += amt;
      }
    }
  } catch {
    /* other_party tables unavailable — no auto-include */
  }
  return { arByControl, arTotalSen, apTotalSen, opb405Sen, opb305Sen };
}

app.get("/opening-balance", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const openingDate = await getOpeningDate(db);
  // Net existing opening legs per account (posted minus reversed).
  const glNet = new Map<string, number>(); // +ve = DR
  let posted = false;
  const legRes = await db
    .prepare(
      `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
        WHERE sourceType IN ('opening_balance','opening_balance_reversal')`,
    )
    .all<{ accountCode: string; debitSen: number; creditSen: number }>();
  const resolveOb = await loadAccountResolver(db);
  for (const l of legRes.results ?? []) {
    const code = resolveOb(l.accountCode);
    glNet.set(
      code,
      (glNet.get(code) ?? 0) +
        (Number(l.debitSen) || 0) -
        (Number(l.creditSen) || 0),
    );
  }
  const glRows = [...glNet.entries()]
    .filter(([, net]) => net !== 0)
    .map(([code, net]) => ({
      accountCode: code,
      debitSen: net > 0 ? net : 0,
      creditSen: net < 0 ? -net : 0,
    }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  posted = glRows.length > 0;

  let migrationMissing = false;
  let arInvoices: unknown[] = [];
  let apInvoices: unknown[] = [];
  try {
    const ar = await db
      .prepare(
        `SELECT id, invoiceNo, customerId, customerName, invoiceDate, dueDate,
                totalSen, paidAmount, status
           FROM invoices
          WHERE isOpening = 1 AND status NOT IN ('DRAFT','CANCELLED')
          ORDER BY customerName, invoiceDate, invoiceNo`,
      )
      .all();
    arInvoices = ar.results ?? [];
    const ap = await db
      .prepare(
        `SELECT id, piNo, supplierId, supplierName, invoiceDate, dueDate,
                amountSen, status
           FROM purchase_invoices
          WHERE isOpening = 1 AND status != 'DRAFT'
          ORDER BY supplierName, invoiceDate, piNo`,
      )
      .all();
    apInvoices = ap.results ?? [];
  } catch {
    migrationMissing = true;
  }
  // Mid-year opening: PIs entered before the opening date count as opening by
  // default (rows untouched); the owner can exclude wrong/phantom entries.
  let preExistingAp: unknown[] = [];
  try {
    if (openingDate) {
      await ensureOpeningApExcludes(db);
      const pe = await db
        .prepare(
          `SELECT id, piNo, supplierName, invoiceDate, amountSen, status,
                  CASE WHEN id IN (SELECT pi_id FROM opening_ap_excludes) THEN 1 ELSE 0 END AS excluded
             FROM purchase_invoices
            WHERE COALESCE(isOpening, 0) = 0
              AND status NOT IN ('DRAFT','CANCELLED')
              AND invoiceDate < ?
            ORDER BY supplierName, invoiceDate, piNo`,
        )
        .bind(openingDate)
        .all();
      preExistingAp = pe.results ?? [];
    }
  } catch {
    /* excludes table unavailable — list stays empty */
  }
  // The AR mirror, and it runs the OTHER WAY (owner 2026-08-06). A pre-opening
  // PURCHASE invoice counts as opening by default and is excluded by exception;
  // a pre-opening SALES invoice does NOT, and is opted in one at a time.
  //
  // The asymmetry is deliberate: flipping the AR default would sweep every
  // customer's pre-opening invoices into the books at once — Houzs alone has
  // over a hundred — when the owner is reconciling them one customer at a time
  // against that customer's own statement.
  let preExistingAr: unknown[] = [];
  try {
    if (openingDate) {
      const pr = await db
        .prepare(
          `SELECT id, invoiceNo, customerId, customerName, invoiceDate,
                  totalSen, paidAmount, status
             FROM invoices
            WHERE COALESCE(isOpening, 0) = 0
              AND status NOT IN ('DRAFT','CANCELLED')
              AND invoiceDate < ?
            ORDER BY customerName, invoiceDate, invoiceNo`,
        )
        .bind(openingDate)
        .all();
      preExistingAr = pr.results ?? [];
    }
  } catch {
    /* invoices table shape unexpected — list stays empty */
  }
  const sums = await openingControlSums(db);
  const pnlPriorCum = await getPnlOpeningPriorCum(db);
  return c.json({
    success: true,
    data: {
      openingDate,
      posted,
      migrationMissing,
      glRows,
      arInvoices,
      apInvoices,
      preExistingAp,
      preExistingAr,
      pnlPriorCum,
      arByControl: Object.fromEntries(sums.arByControl),
      arTotalSen: sums.arTotalSen,
      apTotalSen: sums.apTotalSen,
      opb405Sen: sums.opb405Sen,
      opb305Sen: sums.opb305Sen,
    },
  });
});

// Toggle a pre-opening PI's opening exclusion. Excluded PIs (wrong/phantom
// entries) stay hidden behind the opening floor; everything else counts as
// opening by default. Writes ONLY the exclude table — the PI row is untouched.
app.post("/opening-balance/ap-exclude", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { piId?: string; excluded?: boolean };
  const piId = String(body.piId ?? "").trim();
  if (!piId) {
    return c.json({ success: false, error: "piId is required" }, 400);
  }
  const db = c.var.DB;
  const pi = await db
    .prepare("SELECT id, piNo FROM purchase_invoices WHERE id = ?")
    .bind(piId)
    .first<{ id: string; piNo: string }>();
  if (!pi) {
    return c.json({ success: false, error: "Purchase invoice not found" }, 404);
  }
  await ensureOpeningApExcludes(db);
  const excluded = body.excluded !== false;
  if (excluded) {
    await db
      .prepare(
        `INSERT INTO opening_ap_excludes (pi_id, org_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(pi_id) DO NOTHING`,
      )
      .bind(piId, getOrgId(c), new Date().toISOString())
      .run();
  } else {
    await db.prepare("DELETE FROM opening_ap_excludes WHERE pi_id = ?").bind(piId).run();
  }
  // Bump kv_config so the aging snapshot (sourced on kv_config) rebuilds with
  // the new include set.
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
         VALUES ('opening_ap_excludes_rev', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(Date.now()), new Date().toISOString())
    .run();
  await emitAudit(c, {
    resource: "accounting",
    resourceId: piId,
    action: "update",
    after: { openingExcluded: excluded, piNo: pi.piNo },
  });
  return c.json({ success: true, data: { piId, excluded } });
});

// ---------------------------------------------------------------------------
// POST /opening-balance/ar-include — count a pre-opening SALES invoice as
// opening, or stop counting it.
//
// Owner 2026-08-06, reconciling Carress against their own creditor aging: six
// ERP invoices dated before 22/05 are exactly the RM 8,828 that customer
// admits owing, so they belong in the opening — but there was no way to say so.
// The AP side has had `ap-exclude` since 2026-07-02; this is the AR twin that
// was noted as missing on 2026-07-09 and never built.
//
// Unlike AP it writes the invoice ROW (isOpening), because that flag is what
// `rowBeforeOpening` reads to let a pre-opening invoice through the floor, and
// what the opening AR total sums. Nothing else on the invoice is touched — not
// the amount, not the status, not its payments.
//
// The opening JV must be RE-POSTED afterwards: openingControlSums derives
// 300-0000 from the flagged set, so until then the posted entry and the covered
// set disagree — the same dance the AP side does.
// ---------------------------------------------------------------------------
app.post("/opening-balance/ar-include", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { invoiceId?: string; isOpening?: boolean };
  const invoiceId = String(body.invoiceId ?? "").trim();
  if (!invoiceId) {
    return c.json({ success: false, error: "invoiceId is required" }, 400);
  }
  const db = c.var.DB;
  const inv = await db
    .prepare("SELECT id, invoiceNo, invoiceDate, status, totalSen FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<{ id: string; invoiceNo: string; invoiceDate: string; status: string; totalSen: number }>();
  if (!inv) return c.json({ success: false, error: "Invoice not found" }, 404);
  if (inv.status === "DRAFT" || inv.status === "CANCELLED") {
    return c.json(
      { success: false, error: `${inv.invoiceNo} is ${inv.status} — only a live invoice can be part of the opening.` },
      409,
    );
  }
  const openingDate = await getOpeningDate(db);
  const isOpening = body.isOpening !== false;
  // An invoice dated ON or AFTER the opening is already in the books on its own
  // date; flagging it would double it against the opening entry.
  if (isOpening && openingDate && String(inv.invoiceDate ?? "").slice(0, 10) >= openingDate) {
    return c.json(
      {
        success: false,
        error: `${inv.invoiceNo} is dated ${inv.invoiceDate}, on or after the opening date ${openingDate} — it is already in the ledger and must not also be opening.`,
      },
      409,
    );
  }
  await db
    .prepare("UPDATE invoices SET isOpening = ?, updated_at = ? WHERE id = ?")
    .bind(isOpening ? 1 : 0, new Date().toISOString(), invoiceId)
    .run();
  // The aging snapshot probes kv_config; bump it so the change shows without
  // waiting for an unrelated write (the lesson of BUG-2026-07-09-002).
  await db
    .prepare(
      `INSERT INTO kv_config (key, value, updated_at)
         VALUES ('opening_ar_include_rev', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(Date.now()), new Date().toISOString())
    .run();
  await emitAudit(c, {
    resource: "accounting",
    resourceId: invoiceId,
    action: "update",
    after: { openingIncluded: isOpening, invoiceNo: inv.invoiceNo, totalSen: inv.totalSen },
  });
  return c.json({ success: true, data: { invoiceId, invoiceNo: inv.invoiceNo, isOpening } });
});

// PUT /opening-balance/pnl-prior-cum — store the prior-month-end TB P&L
// balances (kv 'pnl_opening_prior_cum', {accountCode: signedSen}, DR+/CR−).
// The P&L then shows, in the OPENING month, opening-cumulative − these values
// (the slice belonging to that month); earlier months read the historical P&L.
// Report-layer config only — writes NO ledger rows (owner rule 2026-07-03).
app.put("/opening-balance/pnl-prior-cum", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as {
    rows?: Record<string, number>;
  };
  const rows = body.rows;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) {
    return c.json(
      { success: false, error: "rows must be an object of {accountCode: signedSen}" },
      400,
    );
  }
  const clean: Record<string, number> = {};
  for (const [code, v] of Object.entries(rows)) {
    const n = Math.round(Number(v));
    if (!code.trim() || !Number.isFinite(n)) {
      return c.json(
        { success: false, error: `invalid row: ${code} = ${String(v)}` },
        400,
      );
    }
    if (n !== 0) clean[code.trim()] = n;
  }
  await c.var.DB.prepare(
    `INSERT INTO kv_config (key, value, updated_at)
       VALUES ('pnl_opening_prior_cum', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(clean), new Date().toISOString())
    .run();
  await emitAudit(c, {
    resource: "accounting",
    resourceId: "pnl_opening_prior_cum",
    action: "update",
    after: { accounts: Object.keys(clean).length, totalSen: Object.values(clean).reduce((s, n) => s + n, 0) },
  });
  return c.json({ success: true, data: { accounts: Object.keys(clean).length } });
});

// Add ONE opening invoice (AR). Subledger only — no GL legs, no SST.
// PUT /opening-date — set just the accounting start date (kv 'opening_date'),
// self-service, WITHOUT posting opening balances. Lets the owner set when the
// books start from the Maintenance → Opening Balance tab before they have the
// opening rows. The opening-balance Post also writes this key (same format).
app.put("/opening-date", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { openingDate?: string };
  const d = String(body.openingDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return c.json(
      { success: false, error: "openingDate must be a YYYY-MM-DD date" },
      400,
    );
  }
  await c.var.DB.prepare(
    `INSERT INTO kv_config (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
  )
    .bind(OPENING_DATE_KV_KEY, JSON.stringify(d), new Date().toISOString())
    .run();
  await emitAudit(c, {
    resource: "accounting",
    resourceId: "opening-date",
    action: "update",
    after: { openingDate: d },
  });
  return c.json({ success: true, data: { openingDate: d } });
});

app.post("/opening-balance/ar", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { customerId, invoiceNo, invoiceDate } = body;
    const amountSen = Math.round(Number(body.amountSen) || 0);
    if (!customerId || !invoiceNo || !invoiceDate || amountSen <= 0) {
      return c.json(
        { success: false, error: "customerId, invoiceNo, invoiceDate and a positive amountSen are required" },
        400,
      );
    }
    const cust = await c.var.DB.prepare(
      "SELECT id, name, code FROM customers WHERE id = ?",
    )
      .bind(customerId)
      .first<{ id: string; name: string; code: string | null }>();
    if (!cust) {
      return c.json({ success: false, error: "Customer not found" }, 404);
    }
    const dup = await c.var.DB.prepare(
      "SELECT id FROM invoices WHERE invoiceNo = ?",
    )
      .bind(invoiceNo)
      .first();
    if (dup) {
      return c.json({ success: false, error: `Invoice number ${invoiceNo} already exists` }, 400);
    }
    const now = new Date().toISOString();
    const id = `inv-ob-${crypto.randomUUID().slice(0, 8)}`;
    const dueDate = body.dueDate || nextMonthDueDate(invoiceDate);
    await c.var.DB.batch([
      c.var.DB.prepare(
        `INSERT INTO invoices (
           id, invoiceNo, customerId, customerName, subtotalSen, taxSen,
           totalSen, status, invoiceDate, dueDate, paidAmount, notes,
           isOpening, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, ?, 'SENT', ?, ?, 0, 'Opening balance', 1, ?, ?)`,
      ).bind(id, invoiceNo, cust.id, cust.name, amountSen, amountSen, invoiceDate, dueDate, now, now),
      c.var.DB.prepare(
        "UPDATE customers SET outstandingSen = outstandingSen + ? WHERE id = ?",
      ).bind(amountSen, cust.id),
    ]);
    return c.json({ success: true, data: { id } }, 201);
  } catch {
    return c.json(
      { success: false, error: "Failed — is migration 0158 (isOpening column) applied?" },
      400,
    );
  }
});

app.delete("/opening-balance/ar/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT id, customerId, totalSen, paidAmount, isOpening FROM invoices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; customerId: string; totalSen: number; paidAmount: number; isOpening: number | null }>();
  if (!row || (row.isOpening ?? 0) !== 1) {
    return c.json({ success: false, error: "Opening invoice not found" }, 404);
  }
  // This endpoint DELETES the invoice row. That is right for a seed created by
  // /opening-balance/ar (id `inv-ob-…`) — it exists only to carry an opening
  // balance. It is NOT right for a REAL invoice that was merely FLAGGED as
  // opening via /ar-include (2026-08-06): deleting it would destroy a live
  // document, its line items and its history to undo a bookkeeping flag.
  // Un-flagging is the correct undo, and it is one call away.
  if (!String(row.id).startsWith("inv-ob-")) {
    return c.json(
      {
        success: false,
        error: "This is a real invoice counted as opening, not an opening seed — un-tick it with 'remove from opening' instead of deleting it.",
      },
      409,
    );
  }
  if ((Number(row.paidAmount) || 0) !== 0) {
    return c.json(
      { success: false, error: "This opening invoice already has payments — it can no longer be removed" },
      400,
    );
  }
  await c.var.DB.batch([
    c.var.DB.prepare("DELETE FROM invoices WHERE id = ?").bind(id),
    c.var.DB.prepare(
      "UPDATE customers SET outstandingSen = outstandingSen - ? WHERE id = ?",
    ).bind(Number(row.totalSen) || 0, row.customerId),
  ]);
  return c.json({ success: true });
});

// Add ONE opening purchase invoice (AP). Subledger only — no GL legs.
app.post("/opening-balance/ap", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { supplierId, piNo, invoiceDate } = body;
    const amountSen = Math.round(Number(body.amountSen) || 0);
    if (!supplierId || !piNo || !invoiceDate || amountSen <= 0) {
      return c.json(
        { success: false, error: "supplierId, piNo, invoiceDate and a positive amountSen are required" },
        400,
      );
    }
    const sup = await c.var.DB.prepare(
      "SELECT id, name FROM suppliers WHERE id = ?",
    )
      .bind(supplierId)
      .first<{ id: string; name: string }>();
    if (!sup) {
      return c.json({ success: false, error: "Supplier not found" }, 404);
    }
    const dup = await c.var.DB.prepare(
      "SELECT id FROM purchase_invoices WHERE piNo = ?",
    )
      .bind(piNo)
      .first();
    if (dup) {
      return c.json({ success: false, error: `PI number ${piNo} already exists` }, 400);
    }
    const now = new Date().toISOString();
    const id = `pi-ob-${crypto.randomUUID().slice(0, 8)}`;
    const dueDate = body.dueDate || nextMonthDueDate(invoiceDate);
    await c.var.DB.batch([
      c.var.DB.prepare(
        `INSERT INTO purchase_invoices (
           id, piNo, supplierId, supplierName, invoiceDate, dueDate,
           amountSen, status, remarks, isOpening, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', 'Opening balance', 1, ?, ?)`,
      ).bind(id, piNo, sup.id, sup.name, invoiceDate, dueDate, amountSen, now, now),
      c.var.DB.prepare(
        "UPDATE suppliers SET outstandingSen = outstandingSen + ? WHERE id = ?",
      ).bind(amountSen, sup.id),
    ]);
    return c.json({ success: true, data: { id } }, 201);
  } catch {
    return c.json(
      { success: false, error: "Failed — is migration 0158 (isOpening column) applied?" },
      400,
    );
  }
});

app.delete("/opening-balance/ap/:id", async (c) => {
  const denied = await requirePermission(c, "accounting", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT id, supplierId, amountSen, status, isOpening FROM purchase_invoices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; supplierId: string; amountSen: number; status: string; isOpening: number | null }>();
  if (!row || (row.isOpening ?? 0) !== 1) {
    return c.json({ success: false, error: "Opening PI not found" }, 404);
  }
  if (row.status === "PAID") {
    return c.json(
      { success: false, error: "This opening PI is already paid — it can no longer be removed" },
      400,
    );
  }
  await c.var.DB.batch([
    c.var.DB.prepare("DELETE FROM purchase_invoices WHERE id = ?").bind(id),
    c.var.DB.prepare(
      "UPDATE suppliers SET outstandingSen = outstandingSen - ? WHERE id = ?",
    ).bind(Number(row.amountSen) || 0, row.supplierId),
  ]);
  return c.json({ success: true });
});

// Post (or re-post) the GL opening batch. Balance-sheet accounts only;
// debtor/creditor control legs are derived from the opening invoices so
// control == subledger by construction. Re-posting reverses the previous
// net first — the ledger is append-only.
app.post("/opening-balance/post", async (c) => {
  const denied = await requirePermission(c, "accounting", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const openingDate = String(body.openingDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate)) {
      return c.json({ success: false, error: "openingDate must be YYYY-MM-DD" }, 400);
    }
    const rowsIn: { code: string; debitSen?: number; creditSen?: number }[] =
      Array.isArray(body.rows) ? body.rows : [];
    const db = c.var.DB;
    const coaRes = await db
      .prepare("SELECT code, name, type, specialAccountType FROM chart_of_accounts")
      .all<{ code: string; name: string; type: CoaRow["type"]; specialAccountType: string | null }>();
    const coa = new Map(
      (coaRes.results ?? []).map((a) => [a.code, a] as const),
    );
    const cleaned: { code: string; debitSen: number; creditSen: number }[] = [];
    for (const r of rowsIn) {
      const dr = Math.round(Number(r.debitSen) || 0);
      const cr = Math.round(Number(r.creditSen) || 0);
      if (dr === 0 && cr === 0) continue;
      if (dr < 0 || cr < 0 || (dr > 0 && cr > 0)) {
        return c.json(
          { success: false, error: `${r.code}: enter a positive amount on ONE side only` },
          400,
        );
      }
      const acct = coa.get(r.code);
      if (!acct) {
        return c.json({ success: false, error: `Account ${r.code} not found` }, 400);
      }
      // Mid-year opening (owner rule 2026-07-02): P&L accounts ARE accepted —
      // the opening date sits inside the financial year (FYE 31 Aug), so the
      // old books' YTD sales/purchases/expenses belong in THIS year's P&L,
      // not in prior-year retained earnings.
      if (acct.specialAccountType === "SDC" || acct.specialAccountType === "SCC") {
        return c.json(
          { success: false, error: `${r.code} is a debtor/creditor control account — its opening comes from the per-customer/supplier opening invoices automatically` },
          400,
        );
      }
      cleaned.push({ code: r.code, debitSen: dr, creditSen: cr });
    }
    // Derived control legs from the opening invoices.
    const sums = await openingControlSums(db);
    for (const [ctl, amt] of sums.arByControl) {
      if (amt !== 0) cleaned.push({ code: ctl, debitSen: amt, creditSen: 0 });
    }
    if (sums.apTotalSen !== 0) {
      cleaned.push({ code: "400-0000", debitSen: 0, creditSen: sums.apTotalSen });
    }
    // Other-party controls — auto-derived from pre-opening bills, mirroring
    // 400-0000 (BUG-2026-07-23-003).
    if (sums.opb405Sen !== 0) {
      cleaned.push({ code: "405-0000", debitSen: 0, creditSen: sums.opb405Sen });
    }
    if (sums.opb305Sen !== 0) {
      cleaned.push({ code: "305-0000", debitSen: sums.opb305Sen, creditSen: 0 });
    }
    if (cleaned.length === 0) {
      return c.json({ success: false, error: "Nothing to post — every line is zero" }, 400);
    }
    const totalDr = cleaned.reduce((s, r) => s + r.debitSen, 0);
    const totalCr = cleaned.reduce((s, r) => s + r.creditSen, 0);
    if (totalDr !== totalCr) {
      return c.json(
        {
          success: false,
          error: `Opening balances do not balance: DR ${totalDr} vs CR ${totalCr} (difference ${totalDr - totalCr} sen). Adjust — typically the difference belongs in capital/retained earnings.`,
        },
        400,
      );
    }
    const orgId = getOrgId(c);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const stamp = Date.now();
    const legs: LedgerEntryInput[] = [];
    let legNo = 1;
    // Reverse the prior opening net (if any) in the same batch.
    const prior = await db
      .prepare(
        `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
          WHERE sourceType IN ('opening_balance','opening_balance_reversal') AND orgId = ?`,
      )
      .bind(orgId)
      .all<{ accountCode: string; debitSen: number; creditSen: number }>();
    const priorNet = new Map<string, number>();
    for (const l of prior.results ?? []) {
      priorNet.set(
        l.accountCode,
        (priorNet.get(l.accountCode) ?? 0) +
          (Number(l.debitSen) || 0) -
          (Number(l.creditSen) || 0),
      );
    }
    for (const [code, net] of priorNet) {
      if (net === 0) continue;
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "opening_balance_reversal",
        sourceId: `ob-rev-${stamp}`,
        legNo: legNo++,
        accountCode: code,
        debitSen: net < 0 ? -net : 0,
        creditSen: net > 0 ? net : 0,
        description: `Opening balance re-entry — prior figures reversed`,
        actorUserId,
        orgId,
      });
    }
    for (const r of cleaned) {
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "opening_balance",
        sourceId: `ob-${stamp}`,
        legNo: legNo++,
        accountCode: r.code,
        debitSen: r.debitSen,
        creditSen: r.creditSen,
        description: `Opening balance as at ${openingDate}`,
        actorUserId,
        orgId,
      });
    }
    const { statements } = await buildJournalEntryStatements(db, orgId, legs);
    statements.push(
      db
        .prepare(
          `INSERT INTO kv_config (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .bind(OPENING_DATE_KV_KEY, JSON.stringify(openingDate), new Date().toISOString()) as unknown as D1PreparedStatement,
    );
    await db.batch(statements);
    await emitAudit(c, {
      resource: "accounting",
      resourceId: `ob-${stamp}`,
      action: "create",
      after: { openingDate, lines: cleaned.length, totalSen: totalDr },
    });
    return c.json({
      success: true,
      data: { openingDate, lines: cleaned.length, totalSen: totalDr },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// MONTH-END STOCK-TAKE (owner periodic-inventory option, 2026-06-30)
//
// Per material-group closing value the owner enters at each month-end. The P&L
// material engine (materialWindow) uses it as that period's CLOSING (and the
// prior month's as OPENING) instead of the FIFO/BOM value, for groups that have
// one — so material cost works without a complete BOM. Coexists with FIFO: a
// group with no stock-take keeps the FIFO closing. Table self-applied via
// ensureStockTake. ym = 'YYYY-MM' (the month it closes).
// ---------------------------------------------------------------------------
app.get("/stock-take", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  await ensureStockTake(c.var.DB);
  const res = await c.var.DB
    .prepare("SELECT item_group, ym, value_sen FROM stock_take WHERE org_id = ? ORDER BY ym DESC, item_group ASC")
    .bind(orgId)
    .all<{ item_group?: string | null; itemGroup?: string | null; ym: string | null; value_sen?: number | null; valueSen?: number | null }>();
  const data = (res.results ?? []).map((r) => ({
    itemGroup: String(r.itemGroup ?? r.item_group ?? ""),
    ym: String(r.ym ?? ""),
    valueSen: Math.round(Number(r.valueSen ?? r.value_sen) || 0),
  }));
  const modeRow = await c.var.DB
    .prepare("SELECT value FROM kv_config WHERE key = 'rm_valuation_mode'")
    .first<{ value: string | null }>()
    .catch(() => null);
  const rmValuationMode = (modeRow?.value ?? "").trim() === "stock_take_only" ? "stock_take_only" : "auto";
  const fgModeRow = await c.var.DB
    .prepare("SELECT value FROM kv_config WHERE key = 'fg_valuation_mode'")
    .first<{ value: string | null }>()
    .catch(() => null);
  const fgValuationMode = (fgModeRow?.value ?? "").trim() === "stock_take_only" ? "stock_take_only" : "auto";
  return c.json({ success: true, data, total: data.length, rmValuationMode, fgValuationMode });
});

// PUT /api/accounting/fg-valuation-mode — the FG twin of the RM switch below
// (owner 2026-08-31 「让他别自动capture」): 'stock_take_only' → the FG closing
// on every statement is only what the owner keyed (stock_take pseudo-group
// "FG"; the opening seed stays); no per-batch auto valuation. 'auto' →
// batch computation as before.
app.put("/fg-valuation-mode", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
  const mode = String(body.mode ?? "").trim();
  if (mode !== "auto" && mode !== "stock_take_only") {
    return c.json(
      { success: false, error: "mode must be 'auto' or 'stock_take_only'" },
      400,
    );
  }
  await c.var.DB.prepare(
    `INSERT INTO kv_config (key, value, updated_at)
       VALUES ('fg_valuation_mode', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
  )
    .bind(mode, new Date().toISOString())
    .run();
  await emitAudit(c, {
    resource: "accounting",
    resourceId: "fg_valuation_mode",
    action: "update",
    after: { mode },
  });
  return c.json({ success: true, data: { mode } });
});

// PUT /api/accounting/rm-valuation-mode — periodic-inventory switch (owner rule
// 2026-07-03: "不要用 BOM 算先"). 'stock_take_only' → RM closing at every
// month-end = latest stock-take count + PI purchases since (no BOM/FIFO
// auto-consumption; consumption shows only in counted months). 'auto' →
// FIFO/BOM behaviour (with stock-take override) exactly as before. Report-layer
// valuation only — writes NO ledger rows. Also steers the closing-stock GL
// posting numbers (same engine), so re-Post any already-posted month after
// flipping this.
app.put("/rm-valuation-mode", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
  const mode = String(body.mode ?? "").trim();
  if (mode !== "auto" && mode !== "stock_take_only") {
    return c.json(
      { success: false, error: "mode must be 'auto' or 'stock_take_only'" },
      400,
    );
  }
  await c.var.DB.prepare(
    `INSERT INTO kv_config (key, value, updated_at)
       VALUES ('rm_valuation_mode', ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
  )
    .bind(mode, new Date().toISOString())
    .run();
  await emitAudit(c, {
    resource: "accounting",
    resourceId: "rm_valuation_mode",
    action: "update",
    after: { mode },
  });
  return c.json({ success: true, data: { mode } });
});

// GET /api/accounting/stock-take-item-aliases
// Lists every remembered (item_key -> item_group) mapping for the raw
// stock-take import (item_group null = "ignore this line forever").
app.get("/stock-take-item-aliases", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  await ensureStockTakeItemAlias(c.var.DB);
  const res = await c.var.DB
    .prepare("SELECT item_key, item_group FROM stock_take_item_alias WHERE org_id = ?")
    .bind(orgId)
    .all<{ item_key?: string | null; itemKey?: string | null; item_group?: string | null; itemGroup?: string | null }>();
  const data = (res.results ?? []).map((r) => ({
    itemKey: String(r.itemKey ?? r.item_key ?? ""),
    itemGroup: (r.itemGroup ?? r.item_group) ?? null,
  }));
  return c.json({ success: true, data, total: data.length });
});

// PUT /api/accounting/stock-take
// Body: { ym: 'YYYY-MM', rows: [{ itemGroup, valueSen }], newAliases?: [{ itemKey,
// itemGroup }] } — upserts one month's per-group closing values (ON CONFLICT
// (org_id, item_group, ym)) AND any newly-resolved raw-import item aliases, in
// one atomic write (design doc 2026-07-01-stock-take-item-alias-import-design.md).
//
// valueSen === 0 means "use the system's automatic (FIFO/BOM) figure" — same as
// leaving the group blank — NOT "override closing stock to zero" (owner rule,
// 2026-07-01: "如果我放0就用系统算的，如果我放数额就根据我的"). A 0 row therefore
// DELETES any existing override for that group+month instead of storing a zero,
// so materialWindow's stockTakeByGroupYm.has() check correctly falls back to
// automatic. Positive values upsert as before.
app.put("/stock-take", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  await Promise.all([ensureStockTake(c.var.DB), ensureStockTakeItemAlias(c.var.DB)]);
  try {
    const body = (await c.req.json()) as {
      ym?: unknown;
      rows?: { itemGroup?: unknown; valueSen?: unknown }[];
      newAliases?: { itemKey?: unknown; itemGroup?: unknown }[];
    };
    const ym = String(body.ym ?? "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return c.json({ success: false, error: "ym must be 'YYYY-MM'" }, 400);
    if (!Array.isArray(body.rows)) return c.json({ success: false, error: "rows[] is required" }, 400);
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const stmts: D1PreparedStatement[] = [];
    let cleared = 0;
    for (const raw of body.rows) {
      const g = typeof raw?.itemGroup === "string" ? raw.itemGroup.trim() : "";
      if (!g || seen.has(g)) continue;
      seen.add(g);
      const sen = Math.max(0, Math.round(Number(raw?.valueSen) || 0));
      if (sen === 0) {
        cleared++;
        stmts.push(
          c.var.DB.prepare(`DELETE FROM stock_take WHERE org_id = ? AND item_group = ? AND ym = ?`).bind(orgId, g, ym),
        );
        continue;
      }
      stmts.push(
        c.var.DB
          .prepare(
            `INSERT INTO stock_take (id, org_id, item_group, ym, value_sen, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (org_id, item_group, ym)
             DO UPDATE SET value_sen = excluded.value_sen, updated_at = excluded.updated_at`,
          )
          .bind(`st-${crypto.randomUUID().slice(0, 12)}`, orgId, g, ym, sen, now),
      );
    }
    let aliasesSaved = 0;
    if (Array.isArray(body.newAliases)) {
      const seenKeys = new Set<string>();
      for (const raw of body.newAliases) {
        const key = typeof raw?.itemKey === "string" ? raw.itemKey.trim() : "";
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        const group = typeof raw?.itemGroup === "string" && raw.itemGroup.trim() ? raw.itemGroup.trim() : null;
        stmts.push(
          c.var.DB
            .prepare(
              `INSERT INTO stock_take_item_alias (id, org_id, item_key, item_group, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (org_id, item_key)
               DO UPDATE SET item_group = excluded.item_group, updated_at = excluded.updated_at`,
            )
            .bind(`sta-${crypto.randomUUID().slice(0, 12)}`, orgId, key, group, now),
        );
        aliasesSaved++;
      }
    }
    if (stmts.length) await c.var.DB.batch(stmts);
    return c.json({ success: true, saved: stmts.length - cleared - aliasesSaved, cleared, aliasesSaved, ym });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// POST /api/accounting/stock-take-item-alias-seed — one-time load of the ~230
// (item_key -> item_group) pairs confirmed with the owner this session, derived
// from their 30/05/2026 stock-count file (see
// src/api/lib/stock-take-item-alias-seed-2026-05.ts). Idempotent (ON CONFLICT
// DO UPDATE, safe to re-run) and dry-run-able, mirroring the PI->GL backfill
// pattern in purchase-invoices.ts. Existing aliases with a DIFFERENT group are
// left alone unless overwrite=1 is passed, so a manual correction already made
// via the review panel is never silently clobbered by re-running the seed.
app.post("/stock-take-item-alias-seed", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  await ensureStockTakeItemAlias(db);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";
  const overwrite = c.req.query("overwrite") === "1" || c.req.query("overwrite") === "true";
  const now = new Date().toISOString();

  const existingRes = await db
    .prepare("SELECT item_key, item_group FROM stock_take_item_alias WHERE org_id = ?")
    .bind(orgId)
    .all<{ item_key?: string | null; itemKey?: string | null; item_group?: string | null; itemGroup?: string | null }>();
  const existing = new Map((existingRes.results ?? []).map((r) => [String(r.itemKey ?? r.item_key ?? ""), (r.itemGroup ?? r.item_group) ?? null]));

  let inserted = 0, skippedAlreadyPresent = 0, overwritten = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const [key, group] of STOCK_TAKE_ITEM_ALIAS_SEED_2026_05) {
    if (existing.has(key)) {
      if (!overwrite) { skippedAlreadyPresent++; continue; }
      if (existing.get(key) === group) { skippedAlreadyPresent++; continue; }
      overwritten++;
    } else {
      inserted++;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO stock_take_item_alias (id, org_id, item_key, item_group, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (org_id, item_key)
           DO UPDATE SET item_group = excluded.item_group, updated_at = excluded.updated_at`,
        )
        .bind(`sta-${crypto.randomUUID().slice(0, 12)}`, orgId, key, group, now),
    );
  }
  if (!dry && stmts.length) await db.batch(stmts);
  return c.json({
    success: true,
    dry,
    overwrite,
    totalSeedPairs: STOCK_TAKE_ITEM_ALIAS_SEED_2026_05.length,
    inserted,
    overwritten,
    skippedAlreadyPresent,
  });
});

// ---------------------------------------------------------------------------
// MATERIAL OPENING STOCK (F6 — material-cost FIFO engine)
//
// The FIFO cost engine (src/lib/material-cost-fifo.ts) needs a per-material
// "seed layer" at cutover: the quantity + unit cost on hand the day the old
// perpetual stock ledger stopped (2026-03). The owner fills this once in
// Maintenance → Opening Stock; thereafter each month's opening = last month's
// closing and the engine rolls it forward automatically. Read-only on the
// finance side — does NOT touch the operations rm_batches.
//
// ⚠️ Runtime self-apply (load-bearing): deploys do NOT run migration files, so
// the table reaches prod ONLY via ensureMaterialOpeningStock — an idempotent
// CREATE TABLE IF NOT EXISTS awaited at the top of every handler before the
// first read/write. Mirrors migrations-postgres/0185_material_opening_stock.sql
// (which is an inert double-track record). Pattern copied from
// ensureThreePlStateRatesSchema in src/api/routes/three-pl-state-rates.ts:
// module-level promise = one flight per isolate; per-statement try/catch so a
// benign "already exists" never poisons the cached promise.
// ---------------------------------------------------------------------------
let pendingMosMigrations: Promise<void> | null = null;
function ensureMaterialOpeningStock(db: D1Database): Promise<void> {
  if (pendingMosMigrations) return pendingMosMigrations;
  pendingMosMigrations = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS material_opening_stock (
         id            TEXT PRIMARY KEY,
         rm_id         TEXT NOT NULL,
         qty           DOUBLE PRECISION NOT NULL DEFAULT 0,
         unit_cost_sen INTEGER NOT NULL DEFAULT 0,
         as_of_date    TEXT NOT NULL,
         org_id        TEXT NOT NULL DEFAULT 'hookka',
         created_at    TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
         updated_at    TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_mos_key ON material_opening_stock (org_id, rm_id)`,
    ];
    await runSelfApply(db, "accounting", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    pendingMosMigrations = null;
    throw err;
  });
  return pendingMosMigrations;
}

type MaterialOpeningStockRow = {
  rmId: string;
  qty: number | null;
  unitCostSen: number | null;
  asOfDate: string | null;
};

// GET /api/accounting/material-opening-stock
// Lists every ACTIVE raw material LEFT JOINed to its opening-stock row, so the
// Maintenance grid always shows the full catalogue (qty/unitCostSen/asOfDate
// null for materials not yet filled).
app.get("/material-opening-stock", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  await ensureMaterialOpeningStock(c.var.DB);
  const res = await c.var.DB.prepare(
    `SELECT rm.id            AS id,
            rm.itemCode      AS itemCode,
            rm.description   AS description,
            rm.itemGroup     AS itemGroup,
            rm.baseUOM       AS baseUOM,
            mos.qty          AS qty,
            mos.unitCostSen  AS unitCostSen,
            mos.asOfDate     AS asOfDate
       FROM raw_materials rm
       LEFT JOIN material_opening_stock mos
         ON mos.rmId = rm.id AND mos.orgId = ?
      WHERE rm.orgId = ? AND rm.status = 'ACTIVE'
      ORDER BY rm.itemCode`,
  )
    .bind(orgId, orgId)
    .all<{
      id: string;
      itemCode: string | null;
      description: string | null;
      itemGroup: string | null;
      baseUOM: string | null;
      qty: number | null;
      unitCostSen: number | null;
      asOfDate: string | null;
    }>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    itemCode: r.itemCode ?? "",
    description: r.description ?? "",
    itemGroup: r.itemGroup ?? "",
    baseUOM: r.baseUOM ?? "",
    qty: r.qty ?? null,
    unitCostSen: r.unitCostSen ?? null,
    asOfDate: r.asOfDate ?? null,
  }));
  return c.json({ success: true, data, total: data.length });
});

// PUT /api/accounting/material-opening-stock
// Body: { rows: [{ rmId, qty, unitCostSen, asOfDate }] }
// Upserts the whole batch (ON CONFLICT (org_id, rm_id)). Amounts are integer
// sen; qty is a plain (possibly fractional) quantity. Validates everything up
// front, then writes in one transaction.
app.put("/material-opening-stock", async (c) => {
  const denied = await requirePermission(c, "accounting", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const body = (await c.req.json()) as {
      rows?: {
        rmId?: unknown;
        qty?: unknown;
        unitCostSen?: unknown;
        asOfDate?: unknown;
      }[];
    };
    if (!Array.isArray(body.rows)) {
      return c.json({ success: false, error: "rows[] is required" }, 400);
    }
    await ensureMaterialOpeningStock(c.var.DB);

    type CleanRow = {
      rmId: string;
      qty: number;
      unitCostSen: number;
      asOfDate: string;
    };
    const seen = new Set<string>();
    const cleaned: CleanRow[] = [];
    for (const raw of body.rows) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const rmId = typeof entry.rmId === "string" ? entry.rmId.trim() : "";
      if (!rmId) {
        return c.json({ success: false, error: "Each row needs an rmId" }, 400);
      }
      if (seen.has(rmId)) {
        return c.json(
          { success: false, error: `Duplicate rmId in rows: ${rmId}` },
          400,
        );
      }
      seen.add(rmId);
      const qty = typeof entry.qty === "number" ? entry.qty : Number(entry.qty);
      const unitCostSen =
        typeof entry.unitCostSen === "number"
          ? entry.unitCostSen
          : Number(entry.unitCostSen);
      if (!Number.isFinite(qty) || qty < 0) {
        return c.json(
          { success: false, error: `Invalid qty for ${rmId}: must be a non-negative number` },
          400,
        );
      }
      if (!Number.isInteger(unitCostSen) || unitCostSen < 0) {
        return c.json(
          {
            success: false,
            error: `Invalid unitCostSen for ${rmId}: must be a non-negative integer (sen)`,
          },
          400,
        );
      }
      const asOfDate =
        typeof entry.asOfDate === "string" ? entry.asOfDate.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
        return c.json(
          { success: false, error: `Invalid asOfDate for ${rmId}: expected YYYY-MM-DD` },
          400,
        );
      }
      cleaned.push({ rmId, qty, unitCostSen, asOfDate });
    }

    if (cleaned.length > 0) {
      const now = new Date().toISOString();
      await c.var.DB.batch(
        cleaned.map((r) =>
          c.var.DB.prepare(
            `INSERT INTO material_opening_stock
               (id, rmId, qty, unitCostSen, asOfDate, orgId, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (orgId, rmId) DO UPDATE SET
               qty = EXCLUDED.qty,
               unitCostSen = EXCLUDED.unitCostSen,
               asOfDate = EXCLUDED.asOfDate,
               updated_at = EXCLUDED.updated_at`,
          ).bind(
            `mos-${crypto.randomUUID().slice(0, 12)}`,
            r.rmId,
            r.qty,
            r.unitCostSen,
            r.asOfDate,
            orgId,
            now,
            now,
          ),
        ),
      );
    }

    const res = await c.var.DB.prepare(
      `SELECT rmId AS rmId, qty AS qty, unitCostSen AS unitCostSen, asOfDate AS asOfDate
         FROM material_opening_stock
        WHERE orgId = ?`,
    )
      .bind(orgId)
      .all<MaterialOpeningStockRow>();
    return c.json({
      success: true,
      data: { saved: cleaned.length },
      total: (res.results ?? []).length,
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;

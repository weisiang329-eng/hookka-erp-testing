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
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
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
import { buildStatement, rawMaterialLineFor } from "../../lib/cashflow-engine";
import type { CfMap, ClassifiedLeg, BankLeg, RmSplit, CoaLite } from "../../lib/cashflow-engine";
import { getDocNumberPrefixes, issueDocNumber, issueDocNumberWithPrefix } from "../lib/doc-number-service";
import { computeDiscountAlloc, type PiOpen } from "../../lib/discount-alloc";
import { ensurePartialPaymentColumns } from "../lib/ensure-partial-payment";
import { ensureFinanceOrgColumns } from "../lib/ensure-finance-org";
import { apRowBeforeOpening, legBeforeOpening, rowBeforeOpening } from "../../lib/opening-floor";
import { applyOpeningSlice, windowCoversMonth } from "../../lib/opening-slice";
import { buildDeliveredAsOf, fgClosingSen } from "../../lib/fg-closing";
import { costAsOfByPo } from "../../lib/cost-attribution";
import { STOCK_TAKE_ITEM_ALIAS_SEED_2026_05 } from "../lib/stock-take-item-alias-seed-2026-05";
import { DOC_DATE_FAMILIES, stripLegSuffix, parseSourceIdDate } from "../../lib/doc-date";
import {
  prefixForPartyType,
  computeBillTotals,
  validateBillShape,
  buildBillLegs,
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
import { applyLifecycle } from "../lib/document-lifecycle";
import type { DocState, LifecycleAction } from "../../lib/lifecycle-machine";
import {
  computeMaterialCheckpoints,
  windowFromCheckpoints,
  type MaterialInput,
  type FifoEvent,
  type CheckpointCum,
} from "../../lib/material-cost-fifo";

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
  created_at: string;
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

type ArAgingRow = {
  customerId: string;
  customerName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
};

type ApAgingRow = {
  supplierId: string;
  supplierName: string;
  currentSen: number;
  days30Sen: number;
  days60Sen: number;
  days90Sen: number;
  over90Sen: number;
};

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
    createdAt: e.created_at,
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
      sourceTables: ["invoices", "purchase_invoices", "kv_config"],
    },
    orgId,
    async () => {
      const [invRes, piRes] = await Promise.all([
        c.var.DB.prepare(
          `SELECT customerId, customerName, totalSen, paidAmount, status, dueDate, invoiceDate, isOpening FROM invoices${arWhere}`,
        )
          .bind(...(coFilter.active ? [coFilter.param] : []))
          .all<{
          customerId: string;
          customerName: string;
          totalSen: number;
          paidAmount: number;
          status: string;
          dueDate: string | null;
          invoiceDate: string | null;
          isOpening: number | null;
        }>(),
        c.var.DB.prepare(
          `SELECT id, supplierId, supplierName, amountSen, status, dueDate, invoiceDate, isOpening FROM purchase_invoices${apWhere}`,
        )
          .bind(...(coFilter.active ? [coFilter.param] : []))
          .all<{
          id: string;
          supplierId: string;
          supplierName: string;
          amountSen: number;
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
          };
          arMap.set(i.customerId, row);
        }
        addToBucket(row, monthsOverdue(i.invoiceDate ?? i.dueDate), outstanding);
      }

      const apMap = new Map<string, ApAgingRow>();
      for (const p of piRes.results ?? []) {
        // Pre-opening PIs count as opening by default; only excluded ones drop.
        if (apRowBeforeOpening({ id: p.id, date: p.invoiceDate, isOpening: p.isOpening }, obDateAg, apExclAg)) continue;
        if (["DRAFT", "CANCELLED", "PAID"].includes(p.status)) continue;
        const outstanding = Number(p.amountSen) || 0;
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
          };
          apMap.set(p.supplierId, row);
        }
        addToBucket(row, monthsOverdue(p.invoiceDate ?? p.dueDate), outstanding);
      }

      return {
        data: {
          ar: [...arMap.values()].sort((a, b) =>
            a.customerName.localeCompare(b.customerName),
          ),
          ap: [...apMap.values()].sort((a, b) =>
            a.supplierName.localeCompare(b.supplierName),
          ),
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
  // journal_entries has no orgId column (it predates multi-tenancy), so we
  // bind the active orgId into the JOIN condition rather than referencing a
  // table column — the original query was not orgId-filtered and we keep it
  // that way (consistent with PV/OR). VOID/REVERSED JVs still show (with
  // state); only DELETED is excluded.
  const orgId = getOrgId(c);
  const [entries, lines] = await Promise.all([
    c.var.DB.prepare(
      `SELECT journal_entries.*, dl.state AS lifecycleState
         FROM journal_entries
         LEFT JOIN document_lifecycle dl
           ON dl.orgId = ?
          AND dl.sourceType = 'manual'
          AND dl.sourceId = journal_entries.id
        WHERE (dl.state IS NULL OR dl.state <> 'DELETED')
        ORDER BY date DESC, entryNo DESC`,
    ).bind(orgId).all<JournalEntryRow & { lifecycleState: string | null }>(),
    c.var.DB.prepare("SELECT * FROM journal_lines").all<JournalLineRow>(),
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

    await c.var.DB.prepare(
      `INSERT INTO journal_entries (id, entryNo, date, description, status, createdBy)
       VALUES (?, ?, ?, ?, 'DRAFT', ?)`,
    )
      .bind(id, entryNo, date, description, createdBy)
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
             (journalEntryId, lineOrder, accountCode, accountName, debitSen, creditSen, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          idx,
          l.accountCode,
          l.accountName ?? "",
          l.debitSen ?? 0,
          l.creditSen ?? 0,
          l.description ?? "",
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
  const entry = await c.var.DB.prepare(
    "SELECT * FROM journal_entries WHERE id = ?",
  )
    .bind(id)
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
    const entry = await c.var.DB.prepare(
      "SELECT * FROM journal_entries WHERE id = ?",
    )
      .bind(id)
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
                 (journalEntryId, lineOrder, accountCode, accountName, debitSen, creditSen, description)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              id,
              idx,
              l.accountCode,
              l.accountName ?? "",
              l.debitSen ?? 0,
              l.creditSen ?? 0,
              l.description ?? "",
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

  const entry = await c.var.DB.prepare("SELECT id, entryNo, status FROM journal_entries WHERE id = ?").bind(id).first<{ id: string; entryNo: string; status: string }>();
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
  const entry = await c.var.DB.prepare(
    "SELECT * FROM journal_entries WHERE id = ?",
  )
    .bind(id)
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
  return c.json({
    success: true,
    data: {
      asOf: today,
      controls,
      tradeControlSen,
      invoiceOutstandingSen,
      customerCounterSen,
      driftControlVsInvoicesSen: tradeControlSen - invoiceOutstandingSen,
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
      `SELECT receiptNumber, date, amount, status, method FROM payment_records
        WHERE customerId = ?`,
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
    const amt = (Number(pi.amountSen) || 0) - (Number(pi.paid_amount_sen) || 0);
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
  const aging = [...bySupplier.values()].sort((a, b) => b.totalSen - a.totalSen);
  const supplierCounterSen = Number(supRes?.s) || 0;
  const netSubledgerSen = piOutstandingSen - pcnPostedSen;
  return c.json({
    success: true,
    data: {
      asOf: today,
      controls,
      tradeControlSen,
      piOutstandingSen: netSubledgerSen,
      pcnPostedSen,
      supplierCounterSen,
      driftControlVsPiSen: tradeControlSen - netSubledgerSen,
      driftCounterVsPiSen: supplierCounterSen - netSubledgerSen,
      aging,
    },
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
      `SELECT paymentNo, date, amountSen FROM supplier_payments WHERE supplierId = ? AND COALESCE(method,'') <> 'CREDIT_NOTE'`,
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
    c.var.DB.prepare(`SELECT supplierId, paymentNo, date, amountSen FROM supplier_payments WHERE COALESCE(method,'') <> 'CREDIT_NOTE' AND paymentNo NOT IN (SELECT sourceId FROM document_lifecycle WHERE sourceType = 'supplier_payment' AND state IN ('VOID','DELETED'))`).all<{ supplierId: string; paymentNo: string; date: string; amountSen: number }>(),
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
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: ["other_party_bill"], voidSourceType: "other_party_bill_void", sourceId: billNo, action: "delete", actorUserId, descriptionTag: `DELETE · ${billNo}` });
  } catch (e) {
    console.error(`[ledger] other_party_bill ${billNo} delete lifecycle build failed — aborting:`, e);
    return c.json({ success: false, error: (e as Error).message }, 400);
  }
  await c.var.DB.batch(lc.statements);
  return c.json({ success: true });
});

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
    lc = await applyLifecycle(c.var.DB, { orgId, baseSourceTypes: ["other_party_bill"], voidSourceType: "other_party_bill_void", sourceId: billNo, action, actorUserId, descriptionTag: `${action.toUpperCase()} · ${billNo}` });
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
const DEFAULT_STOCK_MAP: {
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
    const stamp = Date.now();
    // Reverse the prior closing-stock net (any month) so a re-post or the
    // next month always lands the 330 stock accounts at THIS month's
    // closing — history-independent, like the opening-balance re-post.
    const prior = await db
      .prepare(
        `SELECT accountCode, debitSen, creditSen FROM ledger_journal_entries
          WHERE sourceType IN ('closing_stock','closing_stock_reversal') AND orgId = ?`,
      )
      .bind(orgId)
      .all<{ accountCode: string; debitSen: number; creditSen: number }>();
    const priorNet = new Map<string, number>();
    for (const l of prior.results ?? []) {
      priorNet.set(l.accountCode, (priorNet.get(l.accountCode) ?? 0) + (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0));
    }
    const legs: LedgerEntryInput[] = [];
    let legNo = 1;
    for (const [code, net] of priorNet) {
      if (net === 0) continue;
      legs.push({
        id: `lje-${crypto.randomUUID().slice(0, 12)}`,
        sourceType: "closing_stock_reversal",
        sourceId: `cs-rev-${stamp}`,
        legNo: legNo++,
        accountCode: code,
        debitSen: net < 0 ? -net : 0,
        creditSen: net > 0 ? net : 0,
        description: `Prior closing-stock reversed`,
        actorUserId,
        orgId,
      });
    }
    const { legs: freshLegs, closingTotalSen } = await buildClosingStockLegs(
      db,
      month,
      orgId,
      actorUserId,
      `cs-${month}-${stamp}`,
    );
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
    c.var.DB.prepare("SELECT id, poNumber, itemCategory, status FROM production_orders").all<{ id: string; poNumber: string | null; itemCategory: string | null; status: string | null }>(),
  ]);
  const po = new Map<string, { poNumber: string; category: string; status: string }>();
  for (const p of poRes.results ?? []) po.set(p.id, { poNumber: p.poNumber ?? p.id, category: String(p.itemCategory ?? "").toUpperCase(), status: p.status ?? "" });
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
    db.prepare("SELECT id, poNumber, itemCategory FROM production_orders").all<{ id: string; poNumber: string | null; itemCategory: string | null }>(),
    db.prepare("SELECT id, itemCode, name, itemGroup FROM raw_materials").all<{ id: string; itemCode: string | null; name: string | null; itemGroup: string | null }>(),
  ]);
  const poCat = new Map<string, { poNumber: string; category: string }>();
  for (const p of poRes.results ?? []) poCat.set(p.id, { poNumber: p.poNumber ?? p.id, category: String(p.itemCategory ?? "").toUpperCase() });
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
    if (!g) rmNoGroup.push({ itemCode: r.itemCode ?? r.id, name: r.name ?? "" });
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
      pushEvent(rmId, { kind: "receipt", date, qty, unitCostSen: Math.round(lineSen / qty) });
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
  const fgOpenSen = (prevKey && fgSt?.has(prevKey)) ? (fgSt.get(prevKey) as number) : fgOpenSenAuto;
  const fgCloseSen = fgSt?.has(endKey) ? (fgSt.get(endKey) as number) : fgCloseSenAuto;
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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[accounting.pnl-historical] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[accounting.inventory-opening] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[accounting.stock-take] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[accounting.stock-take-item-alias] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[accounting.other-party-bill-opening] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
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
    glWindowSigned(db, startYm, endYm, dc),
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
  const endYm = fyWin.endIso.slice(0, 7);
  const cols: string[] = [];
  {
    let [y, m] = startYm.split("-").map((n) => parseInt(n, 10));
    for (let i = 0; i < 12; i++) { cols.push(`${y}-${String(m).padStart(2, "0")}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  const [clRes, rmRes] = await Promise.all([
    db.prepare("SELECT type, itemType, itemId, direction, totalCostSen, date FROM cost_ledger").all<{ type: string; itemType: string; itemId: string; direction: string; totalCostSen: number; date: string }>(),
    db.prepare("SELECT id, itemGroup FROM raw_materials").all<{ id: string; itemGroup: string }>(),
  ]);
  const grp = new Map<string, string>();
  for (const r of rmRes.results ?? []) grp.set(r.id, r.itemGroup || "OTHER");
  // group → { openingBeforeFy, perMonth: [{purchase,consumed}] }
  type GM = { openingBeforeFy: number; purchase: number[]; consumed: number[] };
  const groups = new Map<string, GM>();
  const ensure = (g: string): GM => {
    let x = groups.get(g);
    if (!x) { x = { openingBeforeFy: 0, purchase: new Array(12).fill(0), consumed: new Array(12).fill(0) }; groups.set(g, x); }
    return x;
  };
  for (const l of clRes.results ?? []) {
    if (l.itemType !== "RM") continue;
    const g = grp.get(l.itemId) || "OTHER";
    const x = ensure(g);
    const ym = String(l.date ?? "").slice(0, 7);
    const v = Number(l.totalCostSen) || 0;
    const signed = l.direction === "IN" ? v : -v;
    if (ym < startYm) { x.openingBeforeFy += signed; continue; }
    if (ym > endYm) continue;
    const idx = cols.indexOf(ym);
    if (idx < 0) continue;
    if (l.type === "RM_RECEIPT") x.purchase[idx] += v;
    else if (l.type === "RM_ISSUE") x.consumed[idx] += v;
    else x.purchase[idx] += signed; // ADJUSTMENT etc.
  }
  // Sales per month by line.
  const salesSofa = new Array(12).fill(0);
  const salesBed = new Array(12).fill(0);
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
      if (!ym) continue;
      const idx = cols.indexOf(ym);
      if (idx < 0) continue;
      const v = Number(it.totalSen) || 0;
      if (cat.get(it.productCode ?? "") === "BEDFRAME") salesBed[idx] += v;
      else salesSofa[idx] += v;
    }
  } catch { /* absent */ }
  // Build per-group rows with running opening/closing.
  const out = [...groups.entries()].map(([g, x]) => {
    let running = x.openingBeforeFy;
    const months = cols.map((_, i) => {
      const opening = running;
      const purchase = x.purchase[i];
      const consumed = x.consumed[i];
      const closing = opening + purchase - consumed;
      running = closing;
      return { opening, purchase, closing, spend: consumed };
    });
    return { group: g, description: GROUP_DESCRIPTIONS[g] ?? g, months };
  }).filter((r) => r.months.some((m) => m.opening || m.purchase || m.closing || m.spend))
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
    for (const u of w.unresolved) unresMap.set(`${u.source} ${u.code}`, u);
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

app.get("/cashflow-statement", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const period = c.req.query("period") || new Date().toISOString().slice(0, 7);
  const editable = c.req.query("editable") === "1";

  const resolveAcct = await loadAccountResolver(c.var.DB);
  const fyeMonth = await getFyeMonth(c.var.DB);
  const { docDate, openingDate: obDate } = await loadDocDateResolver(c.var.DB);

  const coaRes = await c.var.DB.prepare(
    "SELECT code, name, type, specialAccountType FROM chart_of_accounts",
  ).all<{ code: string; name: string; type: CoaLite["type"]; specialAccountType: string | null }>();
  const coa = new Map<string, CoaLite>();
  const bankCodes = new Set<string>();
  for (const a of coaRes.results ?? []) {
    const code = resolveAcct(a.code);
    coa.set(code, { code, name: a.name, type: a.type, sat: a.specialAccountType ?? null });
    if (a.specialAccountType === "SBK" || a.specialAccountType === "SCH")
      bankCodes.add(code);
  }

  const legRes = await c.var.DB.prepare(
    "SELECT accountCode, sourceType, sourceId, debitSen, creditSen, postedAt FROM ledger_journal_entries WHERE hidden = 0",
  ).all<{ accountCode: string; sourceType: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string }>();
  const allLegs = (legRes.results ?? [])
    .filter((l) => !legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDate)) // pre-opening: not extracted
    .map((l) => ({
      code: resolveAcct(l.accountCode),
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      debitSen: l.debitSen,
      creditSen: l.creditSen,
      ym: docDate(l.sourceType, l.sourceId, l.postedAt).slice(0, 7), // by document date
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
  const piIds = new Set<string>();
  for (const legs of byEntry.values()) {
    const hasBank = legs.some((l) => bankCodes.has(l.code));
    if (!hasBank) continue;
    const opening = legs.some((l) => isOpeningSource(l.sourceType));
    for (const l of legs) {
      if (bankCodes.has(l.code)) {
        bankLegs.push({ accountCode: l.code, debitSen: l.debitSen, creditSen: l.creditSen, ym: l.ym });
      } else if (!opening) {
        classified.push({
          accountCode: l.code, debitSen: l.debitSen, creditSen: l.creditSen,
          ym: l.ym, sourceType: l.sourceType, sourceId: l.sourceId,
        });
        if (l.sourceType === "supplier_payment") piIds.add(l.sourceId);
      }
    }
  }

  const map = await getCashflowMap(c.var.DB);
  const sgOverride = await getCashflowStockGroupMap(c.var.DB);
  const rmSplit: RmSplit = {};
  if (piIds.size) {
    const rmRes = await c.var.DB.prepare("SELECT * FROM raw_materials").all<Record<string, unknown>>();
    const grpByCode = new Map<string, string>();
    for (const r of rmRes.results ?? []) {
      const code = String((r.item_code ?? r.itemCode) ?? "");
      const grp = String((r.item_group ?? r.itemGroup) ?? "");
      if (code) grpByCode.set(code, grp);
    }
    for (const pi of piIds) {
      const itRes = await c.var.DB.prepare("SELECT * FROM purchase_invoice_items WHERE pi_id = ?").bind(pi).all<Record<string, unknown>>();
      const weights = new Map<string, number>();
      for (const it of itRes.results ?? []) {
        const lt = String((it.line_type ?? it.lineType) ?? "STOCKED");
        const amt = Number((it.line_total_sen ?? it.lineTotalSen) ?? 0);
        const mc = String((it.material_code ?? it.materialCode) ?? "");
        const grp = mc ? grpByCode.get(mc) ?? "" : "";
        const line = lt === "TAX" ? "Purchase of Other & Packaging" : rawMaterialLineFor(grp, sgOverride);
        weights.set(line, (weights.get(line) ?? 0) + Math.max(0, amt));
      }
      rmSplit[pi] = [...weights.entries()].map(([line, weight]) => ({ line, weight }));
    }
  }

  const statement = buildStatement({
    classified, bankLegs, coa, map, rmSplit, stockGroupOverride: sgOverride,
    fyeMonth, period, editable,
  });
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
    for (const p of pis) {
      statements.push(
        db.prepare("UPDATE purchase_invoices SET status = 'PAID', updated_at = ? WHERE id = ?").bind(now, p.id),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO supplier_payments (
               id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
               date, amountSen, method, reference, notes, orgId
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CONTRA', ?, ?, ?)`,
          )
          .bind(
            `sp-${crypto.randomUUID().slice(0, 8)}`,
            `SP-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
            p.supplierId,
            p.supplierName ?? "",
            p.id,
            today,
            Number(p.amountSen) || 0,
            p.piNo,
            `Contra vs ${cust.name}`,
            getOrgId(c),
          ),
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
};

async function getLabourMap(
  db: Env["Variables"]["DB"],
): Promise<{ fallback: string; byDept: Record<string, string> }> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = 'labor_account_map'")
      .first<{ value: string | null }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { fallback?: string; byDept?: Record<string, string> };
      return {
        fallback: parsed.fallback || DEFAULT_LABOUR_MAP.fallback,
        byDept: { ...DEFAULT_LABOUR_MAP.byDept, ...(parsed.byDept ?? {}) },
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
};

async function aggregateLabour(
  db: Env["Variables"]["DB"],
  month: string,
  orgId: string,
): Promise<{ byDept: LabourDeptAgg[]; totalSen: number; map: { fallback: string; byDept: Record<string, string> } }> {
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
    const employer =
      (Number(p.epfEmployerSen) || 0) +
      (Number(p.socsoEmployerSen) || 0) +
      (Number(p.eisEmployerSen) || 0);
    const cur = agg.get(dept) ?? { departmentCode: dept, account, workers: 0, grossSen: 0, employerSen: 0, costSen: 0 };
    cur.workers += 1;
    cur.grossSen += gross;
    cur.employerSen += employer;
    cur.costSen += gross + employer;
    agg.set(dept, cur);
  }
  const byDept = [...agg.values()].sort((a, b) => a.departmentCode.localeCompare(b.departmentCode));
  const totalSen = byDept.reduce((s, d) => s + d.costSen, 0);
  return { byDept, totalSen, map };
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
    const { byDept, totalSen } = await aggregateLabour(c.var.DB, month, orgId);
    const posted = await ledgerHasSource(c.var.DB, orgId, "labor_post", `labor-${month}`);
    // Roll the per-dept rows up to the account level for the GL preview.
    const byAccount = new Map<string, number>();
    for (const d of byDept) byAccount.set(d.account, (byAccount.get(d.account) ?? 0) + d.costSen);
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
    if (await ledgerHasSource(c.var.DB, orgId, "labor_post", sourceId)) {
      return c.json({ success: false, error: `Labour for ${month} is already posted (idempotent — nothing re-posted).` }, 400);
    }
    const { byDept, totalSen } = await aggregateLabour(c.var.DB, month, orgId);
    if (totalSen <= 0) {
      return c.json({ success: false, error: `No payslips found for ${month} — generate payslips first.` }, 400);
    }
    const byAccount = new Map<string, number>();
    for (const d of byDept) byAccount.set(d.account, (byAccount.get(d.account) ?? 0) + d.costSen);
    const actorUserId =
      (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
    const legs: LedgerEntryInput[] = [];
    let legNo = 1;
    for (const [account, sen] of byAccount) {
      if (sen === 0) continue;
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
      after: { month, totalSen, accounts: byAccount.size },
    });
    return c.json({ success: true, data: { month, totalSen, accounts: byAccount.size } });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
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
              r.itemCode, r.name AS rmName
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
    .filter((l) => !legBeforeOpening(l.sourceType, l.day, obDateBr) && l.day >= from && l.day <= to); // pre-opening: not extracted
  let stmtLines: unknown[] = [];
  let migrationMissing = false;
  const matchedLegIds = new Set<string>();
  try {
    const res = await c.var.DB.prepare(
      `SELECT id, txnDate, description, amountSen, matchedLegId, matchedAt
         FROM bank_statement_lines
        WHERE accountCode = ? AND txnDate >= ? AND txnDate <= ?
        ORDER BY txnDate ASC, id ASC`,
    )
      .bind(account, from || "0000-01-01", to)
      .all<{ id: string; txnDate: string; description: string | null; amountSen: number; matchedLegId: string | null; matchedAt: string | null }>();
    stmtLines = res.results ?? [];
    // Matches can point at legs outside the window — collect ALL matched
    // leg ids for this account so book legs flag correctly.
    const allMatched = await c.var.DB.prepare(
      "SELECT matchedLegId FROM bank_statement_lines WHERE accountCode = ? AND matchedLegId IS NOT NULL",
    )
      .bind(account)
      .all<{ matchedLegId: string }>();
    for (const r of allMatched.results ?? []) matchedLegIds.add(r.matchedLegId);
  } catch {
    migrationMissing = true;
  }
  return c.json({
    success: true,
    data: {
      account,
      from: from || null,
      to: to === "9999-12-31" ? null : to,
      migrationMissing,
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
      "SELECT id, accountCode, amountSen, matchedLegId FROM bank_statement_lines WHERE id = ?",
    )
      .bind(lineId)
      .first<{ id: string; accountCode: string; amountSen: number; matchedLegId: string | null }>();
    if (!line) return c.json({ success: false, error: "Statement line not found" }, 404);
    if (line.matchedLegId) return c.json({ success: false, error: "Line already matched" }, 400);
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
    const [legRes, lineRes, matchedRes] = await Promise.all([
      c.var.DB.prepare(
        `SELECT id, sourceId, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries
          WHERE accountCode IN (${marks}) AND hidden = 0`,
      )
        .bind(...equivalents)
        .all<{ id: string; sourceId: string; debitSen: number; creditSen: number; postedAt: string; sourceType: string }>(),
      c.var.DB.prepare(
        `SELECT id, txnDate, amountSen FROM bank_statement_lines
          WHERE accountCode = ? AND matchedLegId IS NULL AND txnDate >= ? AND txnDate <= ?`,
      )
        .bind(account, from || "0000-01-01", to)
        .all<{ id: string; txnDate: string; amountSen: number }>(),
      c.var.DB.prepare(
        "SELECT matchedLegId FROM bank_statement_lines WHERE accountCode = ? AND matchedLegId IS NOT NULL",
      )
        .bind(account)
        .all<{ matchedLegId: string }>(),
    ]);
    const takenLegs = new Set((matchedRes.results ?? []).map((r) => r.matchedLegId));
    const { docDate, openingDate: obDateAm } = await loadDocDateResolver(c.var.DB);
    const freeLegs = (legRes.results ?? [])
      .filter((l) => !takenLegs.has(l.id) && !legBeforeOpening(l.sourceType, docDate(l.sourceType, l.sourceId, l.postedAt), obDateAm)) // pre-opening: not a match candidate
      .map((l) => ({
        id: l.id,
        day: docDate(l.sourceType, l.sourceId, l.postedAt), // by document date
        amountSen: (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0),
      }));
    const dayMs = 86400000;
    const updates: D1PreparedStatement[] = [];
    const usedLeg = new Set<string>();
    let matched = 0;
    for (const line of lineRes.results ?? []) {
      const lineT = Date.parse(line.txnDate);
      const candidates = freeLegs.filter(
        (l) =>
          !usedLeg.has(l.id) &&
          l.amountSen === Number(line.amountSen) &&
          Math.abs(Date.parse(l.day) - lineT) <= 7 * dayMs,
      );
      // Only match when the candidate is UNAMBIGUOUS.
      if (candidates.length === 1) {
        usedLeg.add(candidates[0].id);
        updates.push(
          c.var.DB.prepare(
            "UPDATE bank_statement_lines SET matchedLegId = ?, matchedAt = ? WHERE id = ?",
          ).bind(candidates[0].id, new Date().toISOString(), line.id),
        );
        matched++;
      }
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
    "SELECT id, matchedLegId FROM bank_statement_lines WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; matchedLegId: string | null }>();
  if (!row) return c.json({ success: false, error: "Line not found" }, 404);
  if (row.matchedLegId) {
    return c.json({ success: false, error: "Unmatch the line before deleting it" }, 400);
  }
  await c.var.DB.prepare("DELETE FROM bank_statement_lines WHERE id = ?").bind(id).run();
  return c.json({ success: true });
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

async function getOpeningDate(
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
    const d = maps.get(stripLegSuffix(sourceType))?.get(String(sourceId));
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
}> {
  const arByControl = new Map<string, number>();
  let arTotalSen = 0;
  let apTotalSen = 0;
  try {
    const inv = await db
      .prepare(
        `SELECT i.totalSen AS totalSen, c.code AS custCode
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
  return { arByControl, arTotalSen, apTotalSen };
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
      pnlPriorCum,
      arByControl: Object.fromEntries(sums.arByControl),
      arTotalSen: sums.arTotalSen,
      apTotalSen: sums.apTotalSen,
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
  return c.json({ success: true, data, total: data.length, rmValuationMode });
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
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        console.warn("[accounting.material-opening-stock] DDL skipped", {
          sql: sql.split("\n")[0],
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
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

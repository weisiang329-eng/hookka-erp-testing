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
import { monthsOverdue } from "../../lib/terms";
import { getOrgId } from "../lib/tenant";
import {
  buildJournalEntryStatements,
  ledgerHasSource,
  type LedgerEntryInput,
} from "../lib/journal-hash";
import { getFyeMonth, fyWindowFor } from "../lib/fiscal";

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
  const { withSnapshot } = await import("../lib/snapshot");
  // PR 7 — cache-aside snapshot. AR/AP aging is computed live from
  // unpaid invoices + purchase invoices, bucketed by months overdue
  // (the prod-correct source — the old ar_aging / ap_aging snapshot
  // tables are dead). The snapshot caches that computed result and
  // rebuilds whenever either source table changes.
  const data = await withSnapshot(
    c.var.DB,
    {
      tableName: "accounting_aging_snapshot",
      sourceTables: ["invoices", "purchase_invoices"],
    },
    orgId,
    async () => {
      const [invRes, piRes] = await Promise.all([
        c.var.DB.prepare(
          "SELECT customerId, customerName, totalSen, paidAmount, status, dueDate, invoiceDate FROM invoices",
        ).all<{
          customerId: string;
          customerName: string;
          totalSen: number;
          paidAmount: number;
          status: string;
          dueDate: string | null;
          invoiceDate: string | null;
        }>(),
        c.var.DB.prepare(
          "SELECT supplierId, supplierName, amountSen, status, dueDate, invoiceDate FROM purchase_invoices",
        ).all<{
          supplierId: string;
          supplierName: string;
          amountSen: number;
          status: string;
          dueDate: string | null;
          invoiceDate: string | null;
        }>(),
      ]);

      const arMap = new Map<string, ArAgingRow>();
      for (const i of invRes.results ?? []) {
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

// ---------------------------------------------------------------------------
// JOURNALS
// ---------------------------------------------------------------------------
app.get("/journals", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  const [entries, lines] = await Promise.all([
    c.var.DB.prepare(
      "SELECT * FROM journal_entries ORDER BY date DESC, entryNo DESC",
    ).all<JournalEntryRow>(),
    c.var.DB.prepare("SELECT * FROM journal_lines").all<JournalLineRow>(),
  ]);
  const data = (entries.results ?? []).map((e) =>
    rowToJournal(e, lines.results ?? []),
  );
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
    notes: r.notes ?? "",
    isActive: r.isActive === 1,
  };
}

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
         (id, type, name, contactPerson, phone, email, notes, isActive, orgId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        id,
        body.type,
        name,
        body.contactPerson ?? null,
        body.phone ?? null,
        body.email ?? null,
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
      notes: body.notes !== undefined ? body.notes : existing.notes,
      isActive:
        body.isActive === undefined ? existing.isActive : body.isActive ? 1 : 0,
    };
    if (!merged.name) {
      return c.json({ success: false, error: "name cannot be empty" }, 400);
    }
    await c.var.DB.prepare(
      `UPDATE other_parties
          SET name = ?, contactPerson = ?, phone = ?, email = ?, notes = ?, isActive = ?, updatedAt = ?
        WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.contactPerson,
        merged.phone,
        merged.email,
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
  const [legRes, coaRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT accountCode, debitSen, creditSen, postedAt FROM ledger_journal_entries",
    ).all<{
      accountCode: string;
      debitSen: number;
      creditSen: number;
      postedAt: string;
    }>(),
    c.var.DB.prepare(
      "SELECT code, name, type FROM chart_of_accounts",
    ).all<{ code: string; name: string; type: CoaRow["type"] }>(),
  ]);
  const coa = new Map((coaRes.results ?? []).map((a) => [a.code, a] as const));
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  for (const l of legRes.results ?? []) {
    if (String(l.postedAt ?? "").slice(0, 10) > asOf) continue;
    dr.set(l.accountCode, (dr.get(l.accountCode) ?? 0) + (Number(l.debitSen) || 0));
    cr.set(l.accountCode, (cr.get(l.accountCode) ?? 0) + (Number(l.creditSen) || 0));
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
  if (!account) {
    return c.json({ success: false, error: "account is required" }, 400);
  }
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "9999-12-31";
  const acct = await c.var.DB.prepare(
    "SELECT code, name, type FROM chart_of_accounts WHERE code = ?",
  )
    .bind(account)
    .first<{ code: string; name: string; type: CoaRow["type"] }>();
  if (!acct) {
    return c.json({ success: false, error: "Account not found" }, 404);
  }
  const legRes = await c.var.DB.prepare(
    `SELECT id, sourceType, sourceId, debitSen, creditSen, description,
            postedAt
       FROM ledger_journal_entries
      WHERE accountCode = ?
      ORDER BY postedAt ASC, id ASC`,
  )
    .bind(account)
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
  for (const l of legRes.results ?? []) {
    const d10 = String(l.postedAt ?? "").slice(0, 10);
    const delta = debitNormal
      ? (Number(l.debitSen) || 0) - (Number(l.creditSen) || 0)
      : (Number(l.creditSen) || 0) - (Number(l.debitSen) || 0);
    if (d10 < from) {
      openingSen += delta;
      continue;
    }
    if (d10 > to) continue;
    running = (rows.length === 0 ? openingSen : running) + delta;
    rows.push({
      id: l.id,
      postedAt: l.postedAt,
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
        "SELECT accountCode, debitSen, creditSen, postedAt FROM ledger_journal_entries",
      )
      .all<{
        accountCode: string;
        debitSen: number;
        creditSen: number;
        postedAt: string;
      }>(),
    db
      .prepare("SELECT code, name, type FROM chart_of_accounts")
      .all<{ code: string; name: string; type: CoaRow["type"] }>(),
  ]);
  const coa = new Map(
    (coaRes.results ?? []).map((a) => [a.code, a] as const),
  );
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  for (const l of legRes.results ?? []) {
    const d10 = String(l.postedAt ?? "").slice(0, 10);
    if (d10 > endIso) continue;
    dr.set(l.accountCode, (dr.get(l.accountCode) ?? 0) + (Number(l.debitSen) || 0));
    cr.set(l.accountCode, (cr.get(l.accountCode) ?? 0) + (Number(l.creditSen) || 0));
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
    FABRIC: { stock: "330-0001", opening: "701-0001", closing: "701-9991" },
    FABRIC_SEWING: { stock: "330-0002", opening: "701-0002", closing: "701-9992" },
    PLYWOOD: { stock: "330-1001", opening: "702-0001", closing: "702-9991" },
    WOOD: { stock: "330-1001", opening: "702-0001", closing: "702-9991" },
    WD_STRIP: { stock: "330-1002", opening: "702-0002", closing: "702-9992" },
    FOAM: { stock: "330-2001", opening: "703-0001", closing: "703-9999" },
    WEBBING: { stock: "330-3005", opening: "704-0005", closing: "704-9995" },
    PACKING: { stock: "330-4000", opening: "705-0001", closing: "705-9999" },
  },
  wip: { stock: "330-8000", opening: "700-9005", closing: "700-9010" },
  fg: { stock: "330-9000", opening: "600-0000", closing: "620-0000" },
};

// Live inventory value from the real-time cost ledger, as of `cutoffYm`
// (null = now / all time). RM is netted on-hand (receipts − issues) per
// item_group; WIP = issued + labour − completed; FG = completed −
// delivered. No double-count — RM=on-hand, WIP=in-production, FG=unshipped.
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

function bsCategory(
  type: string,
  code: string,
): "CURRENT_ASSET" | "FIXED_ASSET" | "CURRENT_LIABILITY" | "LONG_TERM_LIABILITY" | "EQUITY" {
  const p = parseInt(code.split("-")[0], 10) || 0;
  if (type === "ASSET") return p < 300 ? "FIXED_ASSET" : "CURRENT_ASSET";
  if (type === "LIABILITY") return "CURRENT_LIABILITY";
  return "EQUITY";
}

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
    "SELECT accountCode, debitSen, creditSen, postedAt, sourceType FROM ledger_journal_entries",
  ).all<{
    accountCode: string;
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
  for (const l of legRes.results ?? []) {
    const ym = String(l.postedAt ?? "").slice(0, 7);
    const d = Number(l.debitSen) || 0;
    const cr = Number(l.creditSen) || 0;
    if (l.sourceType !== "year_close" && ymInPeriod(ym, period)) {
      plDr.set(l.accountCode, (plDr.get(l.accountCode) ?? 0) + d);
      plCr.set(l.accountCode, (plCr.get(l.accountCode) ?? 0) + cr);
    }
    if (!endYm || ym <= endYm) {
      bsDr.set(l.accountCode, (bsDr.get(l.accountCode) ?? 0) + d);
      bsCr.set(l.accountCode, (bsCr.get(l.accountCode) ?? 0) + cr);
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
      "SELECT id, customerName, totalSen, invoiceDate, customerId, customerState, status FROM invoices",
    ).all<{
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
    category: ReturnType<typeof bsCategory>;
    balance: number;
    asOfDate: string;
  }[] = [];
  const asOf = endYm ? `${endYm}-28` : new Date().toISOString().slice(0, 10);
  const bsCodes = new Set([...bsDr.keys(), ...bsCr.keys()]);
  for (const code of bsCodes) {
    const acct = coa.get(code);
    if (!acct) continue;
    if (acct.type !== "ASSET" && acct.type !== "LIABILITY" && acct.type !== "EQUITY")
      continue;
    const dr = bsDr.get(code) ?? 0;
    const cr = bsCr.get(code) ?? 0;
    const bal = acct.type === "ASSET" ? dr - cr : cr - dr;
    if (bal === 0) continue;
    balanceSheet.push({
      id: code,
      accountCode: code,
      accountName: acct.name,
      category: bsCategory(acct.type, code),
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

export default app;

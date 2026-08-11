# Houzs Century Trade Finance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track money Houzs Century pays suppliers on Hookka's behalf as per-draw trade-finance debt: 310-0020 becomes a LIABILITY, every draw carries an editable due date, repayment happens through the normal Supplier Payment screen (payee HOUZS CENTURY SDN BHD), and Creditor Aging shows a separate due-date-bucketed block.

**Architecture:** Amounts are NEVER stored twice — a draw's amount is always the live ledger family net (`supplier_payment%`, hidden=0) on the TF account, keyed by the drawing payment's sourceId. Only two things are stored: per-draw metadata (due date) in `trade_finance_draws`, and repayment allocations in `trade_finance_repay_allocs`. Repayments are ordinary supplier payments (method `TF_REPAYMENT`) whose GL is DR TF-account / CR bank. Aging identity: Σ draw outstanding + unallocated = TF account ledger net, printed on the block.

**Tech Stack:** Hono routes (`src/api/routes/accounting.ts`, `src/api/routes/supplier-payments.ts`), pure lib + node:test, React (`src/pages/accounting/index.tsx`, new `src/pages/accounting/tabs/TradeFinanceBlock.tsx`, `src/pages/invoices/supplier-payments.tsx`).

**Spec:** `C:\Users\User\Desktop\Claude\Hookka\财务模块-HouzsCentury-TradeFinance-设计.md`（owner-approved 2026-08-11）

## Global Constraints

- Money = integer sen. Dual-key every D1-era row read. New DB columns snake_case + `src/api/lib/column-rename-map.json` entries.
- Migrations are INERT — every new table MUST be created by a runtime `ensure*` awaited before first use; the migration file is documentation for the owner's SQL editor.
- Ledger is append-only + hash-chained; visibility via `hidden`; the whole `supplier_payment%` FAMILY must be treated together (BUG-2026-08-06-005 discipline).
- Writes that move the books on prod are pressed by the OWNER (the reclass runs inside his explicit Setup click; repayments/draws are his payments).
- UI copy 100% English. `requireFinance` guards every TF mutation.
- Prod facts (2026-08-11): TF account `310-0020 CASH AT BANK - HLBB HOUZS CENTURY` net CR 94,822.92 = 4 draw payments (2× `supplier_payment`, 2× `supplier_payment_restate_post`), zero repayments. Lender supplier `sup-c51b4c45 HOUZS CENTURY SDN BHD`. Default tenor 90 days (owner to confirm; editable per draw).

---

### Task 1: Pure lib `src/lib/trade-finance.ts` — derive draws, buckets, allocation maths

**Files:**
- Create: `src/lib/trade-finance.ts`
- Test: `tests/trade-finance.test.mjs`

**Interfaces (produced — later tasks import these EXACT names):**
```ts
export type TfLegRow = { sourceType: string; sourceId: string; debitSen: number; creditSen: number };
export type TfDrawMeta = { drawSourceId: string; drawDate: string; dueDate: string };
export type TfAlloc = { repayPaymentNo: string; drawSourceId: string; amountSen: number };
export type TfDraw = { drawSourceId: string; drawDate: string; dueDate: string; amountSen: number; repaidSen: number; outstandingSen: number };
export function deriveDraws(legs: TfLegRow[], metas: TfDrawMeta[], allocs: TfAlloc[], repayNos: Set<string>): { draws: TfDraw[]; accountNetSen: number; unallocatedSen: number };
export function addDays(iso: string, days: number): string;
export function tfBucketOf(dueDate: string, todayIso: string): "notDue" | "d1_30" | "d31_60" | "d61_90" | "over90";
export function tfTotals(draws: TfDraw[], todayIso: string): Record<"notDue"|"d1_30"|"d31_60"|"d61_90"|"over90"|"total", number>;
export function clampRepayAlloc(outstandingSen: number, paySen: number): { ok: boolean; error?: string };
```
Rules: a DRAW = per-sourceId net (creditSen − debitSen) > 0, excluding sourceIds in `repayNos`; `amountSen` = that net; `repaidSen` = Σ allocs for it; `outstandingSen` = amount − repaid (floor 0 never — if allocs exceed the net it's data damage, keep the negative visible). `accountNetSen` = Σ(credit−debit) over ALL legs. `unallocatedSen` = accountNetSen − Σ outstanding (catches fund-transfer strays / over-allocs so the block identity always closes). Draws missing a meta row get `dueDate:""` (caller heals). Sort draws dueDate asc then drawDate asc.

- [ ] **Step 1: Write the failing test**

⚠ Import mechanics: open `tests/supplier-payment-alloc.test.mjs` first and copy exactly how it imports a `src/lib/*.ts` module (loader/extension) — use the same form here.

```js
// tests/trade-finance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { deriveDraws, addDays, tfBucketOf, tfTotals, clampRepayAlloc } from "../src/lib/trade-finance.js";

const legs = [
  { sourceType: "supplier_payment", sourceId: "HPV-2607-001", debitSen: 0, creditSen: 100000 },
  { sourceType: "supplier_payment_restate_post:x", sourceId: "HPV-2607-002", debitSen: 0, creditSen: 50000 },
  // a repayment: DR on the TF account under its own payment no
  { sourceType: "supplier_payment", sourceId: "HPV-2608-009", debitSen: 30000, creditSen: 0 },
];
const metas = [
  { drawSourceId: "HPV-2607-001", drawDate: "2026-07-07", dueDate: "2026-10-05" },
  { drawSourceId: "HPV-2607-002", drawDate: "2026-07-24", dueDate: "2026-08-01" },
];
const allocs = [{ repayPaymentNo: "HPV-2608-009", drawSourceId: "HPV-2607-002", amountSen: 30000 }];

test("deriveDraws nets families, excludes repayments, ties the identity", () => {
  const r = deriveDraws(legs, metas, allocs, new Set(["HPV-2608-009"]));
  assert.equal(r.accountNetSen, 120000);
  assert.deepEqual(r.draws.map((d) => [d.drawSourceId, d.amountSen, d.repaidSen, d.outstandingSen]), [
    ["HPV-2607-002", 50000, 30000, 20000], // earlier due date sorts first
    ["HPV-2607-001", 100000, 0, 100000],
  ]);
  assert.equal(r.unallocatedSen, 120000 - 20000 - 100000); // 0 — identity closes
});

test("a voided draw (family nets 0) drops out", () => {
  const r = deriveDraws(
    [
      { sourceType: "supplier_payment", sourceId: "A", debitSen: 0, creditSen: 7000 },
      { sourceType: "supplier_payment_void", sourceId: "A", debitSen: 7000, creditSen: 0 },
    ],
    [{ drawSourceId: "A", drawDate: "2026-07-01", dueDate: "2026-09-29" }], [], new Set(),
  );
  assert.equal(r.draws.length, 0);
  assert.equal(r.accountNetSen, 0);
});

test("buckets by days past DUE date", () => {
  assert.equal(addDays("2026-07-07", 90), "2026-10-05");
  assert.equal(tfBucketOf("2026-08-20", "2026-08-11"), "notDue");
  assert.equal(tfBucketOf("2026-08-11", "2026-08-11"), "notDue"); // due today = not yet overdue
  assert.equal(tfBucketOf("2026-08-01", "2026-08-11"), "d1_30");
  assert.equal(tfBucketOf("2026-06-20", "2026-08-11"), "d31_60");
  assert.equal(tfBucketOf("2026-05-20", "2026-08-11"), "d61_90");
  assert.equal(tfBucketOf("2026-01-01", "2026-08-11"), "over90");
  const t = tfTotals([
    { drawSourceId: "A", drawDate: "", dueDate: "2026-08-01", amountSen: 0, repaidSen: 0, outstandingSen: 500 },
    { drawSourceId: "B", drawDate: "", dueDate: "2026-09-01", amountSen: 0, repaidSen: 0, outstandingSen: 300 },
  ], "2026-08-11");
  assert.equal(t.d1_30, 500); assert.equal(t.notDue, 300); assert.equal(t.total, 800);
});

test("clampRepayAlloc refuses overpay and non-positive", () => {
  assert.equal(clampRepayAlloc(1000, 1000).ok, true);
  assert.equal(clampRepayAlloc(1000, 1001).ok, false);
  assert.equal(clampRepayAlloc(1000, 0).ok, false);
});
```

- [ ] **Step 2: Run** `node --test tests/trade-finance.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/trade-finance.ts
// ---------------------------------------------------------------------------
// Trade-finance draw derivation — PURE. Amounts are never stored: a draw is
// the live ledger family net on the TF account keyed by the drawing payment's
// sourceId, so voids/edits/restates are correct by construction. Stored state
// is only per-draw due dates + repayment allocations (see api/lib).
// ---------------------------------------------------------------------------
export type TfLegRow = { sourceType: string; sourceId: string; debitSen: number; creditSen: number };
export type TfDrawMeta = { drawSourceId: string; drawDate: string; dueDate: string };
export type TfAlloc = { repayPaymentNo: string; drawSourceId: string; amountSen: number };
export type TfDraw = { drawSourceId: string; drawDate: string; dueDate: string; amountSen: number; repaidSen: number; outstandingSen: number };

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function deriveDraws(
  legs: TfLegRow[], metas: TfDrawMeta[], allocs: TfAlloc[], repayNos: Set<string>,
): { draws: TfDraw[]; accountNetSen: number; unallocatedSen: number } {
  const metaBy = new Map(metas.map((m) => [m.drawSourceId, m] as const));
  const repaidBy = new Map<string, number>();
  for (const a of allocs) repaidBy.set(a.drawSourceId, (repaidBy.get(a.drawSourceId) ?? 0) + (Number(a.amountSen) || 0));
  const netBy = new Map<string, number>();
  let accountNetSen = 0;
  for (const l of legs) {
    const net = (Number(l.creditSen) || 0) - (Number(l.debitSen) || 0);
    accountNetSen += net;
    netBy.set(l.sourceId, (netBy.get(l.sourceId) ?? 0) + net);
  }
  const draws: TfDraw[] = [];
  for (const [sourceId, net] of netBy) {
    if (net <= 0 || repayNos.has(sourceId)) continue;
    const meta = metaBy.get(sourceId);
    const repaidSen = repaidBy.get(sourceId) ?? 0;
    draws.push({
      drawSourceId: sourceId,
      drawDate: meta?.drawDate ?? "",
      dueDate: meta?.dueDate ?? "",
      amountSen: net,
      repaidSen,
      outstandingSen: net - repaidSen,
    });
  }
  draws.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.drawDate.localeCompare(b.drawDate));
  const unallocatedSen = accountNetSen - draws.reduce((s, d) => s + d.outstandingSen, 0);
  return { draws, accountNetSen, unallocatedSen };
}

export function tfBucketOf(dueDate: string, todayIso: string): "notDue" | "d1_30" | "d31_60" | "d61_90" | "over90" {
  if (!dueDate || dueDate >= todayIso) return "notDue";
  const days = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000);
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "over90";
}

export function tfTotals(draws: TfDraw[], todayIso: string) {
  const t = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 };
  for (const d of draws) { t[tfBucketOf(d.dueDate, todayIso)] += d.outstandingSen; t.total += d.outstandingSen; }
  return t;
}

export function clampRepayAlloc(outstandingSen: number, paySen: number): { ok: boolean; error?: string } {
  if (!(paySen > 0)) return { ok: false, error: "allocation must be positive" };
  if (paySen > outstandingSen) return { ok: false, error: "allocation exceeds the draw's outstanding balance" };
  return { ok: true };
}
```

- [ ] **Step 4: Run** `node --test tests/trade-finance.test.mjs` → PASS.

- [ ] **Step 5: Commit** `git add src/lib/trade-finance.ts tests/trade-finance.test.mjs && git commit -m "feat(accounting): pure trade-finance draw derivation + due-date buckets"`

---

### Task 2: API lib — TF tables (runtime self-apply), kv config, migration file

**Files:**
- Create: `src/api/lib/trade-finance.ts`
- Create: `migrations-postgres/NNNN_trade_finance.sql` (`ls migrations-postgres | sort | tail -1` → next number)
- Modify: `src/api/lib/column-rename-map.json` — add: `draw_source_id`, `draw_date`, `due_date`, `account_code`, `repay_payment_no`, `amount_sen` (skip any already present), each mapping to its camelCase.

**Interfaces (produced):**
```ts
export type TfSource = { accountCode: string; lenderSupplierId: string; lenderName: string; tenorDays: number };
export async function ensureTfTables(db): Promise<void>;
export async function getTfSources(db): Promise<TfSource[]>;      // kv 'trade_finance_sources', [] when unset
export async function saveTfSources(db, sources: TfSource[], actor: string): Promise<void>;
```

- [ ] **Step 1: Implement `ensureTfTables`** (mirror `ensurePartialPaymentColumns`'s idempotent style):

```ts
export async function ensureTfTables(db: DB): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS trade_finance_draws (
       draw_source_id TEXT PRIMARY KEY,
       account_code   TEXT NOT NULL,
       draw_date      TEXT NOT NULL,
       due_date       TEXT NOT NULL,
       org_id         TEXT NOT NULL DEFAULT 'hookka-001'
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS trade_finance_repay_allocs (
       id              TEXT PRIMARY KEY,
       repay_payment_no TEXT NOT NULL,
       draw_source_id  TEXT NOT NULL,
       amount_sen      BIGINT NOT NULL,
       org_id          TEXT NOT NULL DEFAULT 'hookka-001'
     )`,
  ).run();
}
```

`getTfSources`/`saveTfSources`: copy the `getLabourMap` kv pattern (accounting.ts:9193) — key `trade_finance_sources`, JSON array; save via `INSERT ... ON CONFLICT (key) DO UPDATE` exactly as `PUT /labor/map` (accounting.ts:9571) writes kv.

The migration file mirrors both CREATE TABLEs verbatim with a header comment "runtime self-applied by ensureTfTables — this file documents the schema for the owner's SQL editor".

- [ ] **Step 2: Typecheck + commit** — `npx tsc -p tsconfig.app.json --noEmit`; `git add -A && git commit -m "feat(accounting): trade-finance tables (runtime self-apply) + kv config"`

---

### Task 3: Endpoints — setup (reclass), read (draws+buckets, self-healing), due-date edit

**Files:**
- Modify: `src/api/routes/accounting.ts` — add a `// ---- Trade finance ----` section near the labour block (~L9600)

**Interfaces (produced):**
- `POST /api/accounting/trade-finance/setup` body `{ accountCode, lenderSupplierId, tenorDays, accountName }` — `requireFinance`; ensures tables; **reclasses the account**: `UPDATE chart_of_accounts SET type='LIABILITY', specialAccountType=NULL, name=? WHERE code=?`; saves kv (lenderName read from suppliers); `emitAudit` resource `trade-finance` action `setup` with before/after of the COA row. Idempotent (re-running with same values is a no-op update).
- `GET /api/accounting/trade-finance` → `{ sources: [{ ...TfSource, accountName, accountNetSen, unallocatedSen, totals, draws: TfDraw[] }] }` — for EACH kv source: read legs `SELECT sourceType, sourceId, debitSen, creditSen FROM ledger_journal_entries WHERE accountCode=? AND hidden=0`; read metas + allocs from the two TF tables (dual-key); `repayNos` = distinct `repay_payment_no` in allocs UNION supplier_payments rows with `method='TF_REPAYMENT'`; call `deriveDraws`; **self-heal**: any derived draw whose meta is missing → look up the payment's document date (`SELECT date FROM supplier_payments WHERE paymentNo=? LIMIT 1`, fallback today) and `INSERT INTO trade_finance_draws ... ON CONFLICT (draw_source_id) DO NOTHING` with `due_date = addDays(drawDate, tenorDays)` — this IS the backfill for the 4 existing draws, and the forever safety-net for any future stray. `todayIso` = `new Date().toISOString().slice(0,10)`; totals via `tfTotals`.
- `PUT /api/accounting/trade-finance/draw-due` body `{ drawSourceId, dueDate }` — `requireFinance`, validate `/^\d{4}-\d{2}-\d{2}$/`, UPDATE the row, `emitAudit` action `draw-due-edit`.
- `export async function loadTfDraws(db, source: TfSource): Promise<{ draws: TfDraw[]; accountNetSen: number; unallocatedSen: number }>` — the legs+metas+allocs read (incl. the self-heal INSERT) wrapped around `deriveDraws`; exported so Task 4's repayment branch and Task 5's aging section reuse the identical derivation.

- [ ] **Step 1: Implement the three handlers** (follow the labour endpoints' shape for error handling: try/catch → `c.json({success:false,error},400)`).

- [ ] **Step 2: Typecheck; live-shape smoke via existing dev server if running.**

- [ ] **Step 3: Commit** `git commit -m "feat(accounting): trade-finance setup (account reclass) + draws read with self-healing backfill + due-date edit"`

---

### Task 4: supplier-payments.ts — payFrom allows TF, draw hook, repayment branch, void guards

**Files:**
- Modify: `src/api/routes/supplier-payments.ts` — anchors: create `POST /` payFrom validation (L171-188), batch/audit (L373-406); the second create-path validation (~L1329); restate handler (`/restate`, ~L834+); void/lifecycle handler (grep `applyLifecycle` in this file)
- Modify: `src/api/routes/accounting.ts` — `loadUnappliedSupplierAdvances` (L374): its supplier_payments SELECT gains `AND method != 'TF_REPAYMENT'` (keep the existing CREDIT_NOTE exclusion intact)
- Test: `tests/tf-repayment.test.mjs`

**Interfaces:**
- Consumes: `getTfSources`, `ensureTfTables` (Task 2), `deriveDraws`, `clampRepayAlloc`, `addDays` (Task 1).
- Produces: `POST /api/supplier-payments` gains an optional body field `tfAllocations?: { drawSourceId: string; paySen: number }[]`, honoured ONLY when `supplierId` equals a configured `lenderSupplierId`. Existing behaviour byte-identical for every other supplier.

- [ ] **Step 1: payFrom validation (both create paths + restate)** — replace the SBK/SCH-only check with:

```ts
      const tfSources = await getTfSources(c.var.DB);
      const isTfSource = tfSources.some((s) => s.accountCode === payFrom);
      if (!acct || (acct.specialAccountType !== "SBK" && acct.specialAccountType !== "SCH" && !isTfSource)) {
        return c.json({ success: false, error: "payFrom must be a bank (SBK), cash (SCH), or trade-finance account" }, 400);
      }
```

- [ ] **Step 2: Repayment branch** — at the top of `POST /` after supplier/payFrom validation:

```ts
      const lenderCfg = tfSources.find((s) => s.lenderSupplierId === supplierId);
      if (lenderCfg) {
        // -------- Trade-finance REPAYMENT (owner 2026-08-11) --------
        // Pays DOWN the TF liability: DR TF account / CR the chosen bank.
        await ensureTfTables(c.var.DB);
        if (isTfSource) return c.json({ success: false, error: "A trade-finance repayment cannot be paid FROM the trade-finance account" }, 400);
        const tfAllocs = (body.tfAllocations ?? []) as { drawSourceId: string; paySen: number }[];
        if (!tfAllocs.length) return c.json({ success: false, error: "Pick at least one draw to repay" }, 400);
        // outstanding per draw from the live derivation (same maths as the aging block)
        const { draws } = await loadTfDraws(c.var.DB, lenderCfg); // small helper shared with the GET endpoint
        const byId = new Map(draws.map((d) => [d.drawSourceId, d] as const));
        let total = 0;
        for (const a of tfAllocs) {
          const d = byId.get(String(a.drawSourceId));
          const paySen = Math.round(Number(a.paySen) || 0);
          if (!d) return c.json({ success: false, error: `Unknown draw ${a.drawSourceId}` }, 400);
          const chk = clampRepayAlloc(d.outstandingSen, paySen);
          if (!chk.ok) return c.json({ success: false, error: `${a.drawSourceId}: ${chk.error}` }, 400);
          total += paySen;
        }
        const payNo = await issueDocNumber(c.var.DB, { bankAccountCode: payFrom, direction: "out", dateIso: date });
        const statements: D1PreparedStatement[] = [];
        statements.push(c.var.DB.prepare(
          `INSERT INTO supplier_payments (id, paymentNo, supplierId, supplierName, purchaseInvoiceId,
             date, amountSen, bookedSen, foreignSen, payFxRate, method, reference, notes, orgId)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 'TF_REPAYMENT', ?, ?, ?)`,
        ).bind(`sp-${crypto.randomUUID().slice(0, 8)}`, payNo, supplierId, lenderCfg.lenderName, date,
          total, total, reference ?? "", `Trade finance repayment ${payNo}`, orgId));
        for (const a of tfAllocs) {
          statements.push(c.var.DB.prepare(
            `INSERT INTO trade_finance_repay_allocs (id, repay_payment_no, draw_source_id, amount_sen, org_id)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(`tfa-${crypto.randomUUID().slice(0, 8)}`, payNo, String(a.drawSourceId), Math.round(Number(a.paySen) || 0), orgId));
        }
        const { statements: ls } = await buildJournalEntryStatements(c.var.DB, orgId, [
          { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "supplier_payment", sourceId: payNo, legNo: 1,
            accountCode: lenderCfg.accountCode, debitSen: total, creditSen: 0, description: `TF repayment ${payNo} — ${lenderCfg.lenderName}`, actorUserId, orgId },
          { id: `lje-${crypto.randomUUID().slice(0, 12)}`, sourceType: "supplier_payment", sourceId: payNo, legNo: 2,
            accountCode: payFrom, debitSen: 0, creditSen: total, description: `TF repayment ${payNo}`, actorUserId, orgId },
        ]);
        statements.push(...ls);
        statements.push(bumpSupplierPaymentsRev(c.var.DB));
        await c.var.DB.batch(statements);
        await emitAudit(c, { resource: "supplier-payments", resourceId: payNo, action: "create",
          after: { paymentNo: payNo, payFrom, tfRepayment: true, totalSen: total, allocations: tfAllocs } });
        return c.json({ success: true, data: { paymentNo: payNo, totalBankSen: total } });
      }
```

`loadTfDraws(db, source)` is a small exported helper added in Task 3's section (reads legs+metas+allocs and calls `deriveDraws`) — the GET endpoint and this branch MUST share it.

- [ ] **Step 3: Draw hook** — in the NORMAL create path, right after the successful `await c.var.DB.batch(statements);` (L382):

```ts
      // Paying from a trade-finance source account creates a DRAW (owner
      // 2026-08-11): record its due-date meta. Amounts stay ledger-derived.
      if (isTfSource) {
        const src = tfSources.find((s) => s.accountCode === payFrom)!;
        await ensureTfTables(c.var.DB);
        await c.var.DB.prepare(
          `INSERT INTO trade_finance_draws (draw_source_id, account_code, draw_date, due_date, org_id)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (draw_source_id) DO NOTHING`,
        ).bind(payNo, payFrom, date, addDays(date, src.tenorDays || 90), orgId).run();
      }
```

- [ ] **Step 4: Void guards** — in this file's void/lifecycle handler, BEFORE applying:

```ts
      // A draw with repayments allocated cannot be voided — unallocate first.
      await ensureTfTables(c.var.DB);
      const allocSum = await c.var.DB.prepare(
        `SELECT COALESCE(SUM(amount_sen),0) AS s FROM trade_finance_repay_allocs WHERE draw_source_id = ?`,
      ).bind(paymentNo).first<{ s: number }>();
      if ((Number(allocSum?.s) || 0) > 0) {
        return c.json({ success: false, error: "This payment is a trade-finance draw with repayments allocated to it. Void the repayment first." }, 400);
      }
```

and AFTER a successful void, clean up if the payment was a repayment:

```ts
      await c.var.DB.prepare(`DELETE FROM trade_finance_repay_allocs WHERE repay_payment_no = ?`).bind(paymentNo).run();
```

(delete-by-repay_payment_no is correct on both branches: a non-repayment has no such rows.)

- [ ] **Step 5: Restate blocks TF repayments** — top of the `/restate` handler:

```ts
      const isTfRepay = await c.var.DB.prepare(
        `SELECT 1 AS x FROM supplier_payments WHERE paymentNo = ? AND method = 'TF_REPAYMENT' LIMIT 1`,
      ).bind(paymentNo).first();
      if (isTfRepay) return c.json({ success: false, error: "A trade-finance repayment cannot be edited in place — void it and record it again." }, 400);
```

- [ ] **Step 6: Advance-loader exclusion (regression-tested)** — in `loadUnappliedSupplierAdvances` (accounting.ts:374) add `AND method != 'TF_REPAYMENT'` to its supplier_payments WHERE clause.

```js
// tests/tf-repayment.test.mjs — pin the two text-level invariants that keep
// TF rows out of the advance machinery and PI allocations intact.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("advance loader excludes TF_REPAYMENT rows", () => {
  const src = readFileSync("src/api/routes/accounting.ts", "utf8");
  const fn = src.slice(src.indexOf("function loadUnappliedSupplierAdvances"), src.indexOf("function loadUnappliedSupplierAdvances") + 4000);
  assert.match(fn, /TF_REPAYMENT/);
});

test("repayment branch never bumps purchase_invoices", () => {
  const src = readFileSync("src/api/routes/supplier-payments.ts", "utf8");
  const start = src.indexOf("Trade-finance REPAYMENT");
  assert.notEqual(start, -1);
  const branch = src.slice(start, src.indexOf("Draw hook", start) === -1 ? start + 6000 : src.indexOf("Draw hook", start));
  assert.doesNotMatch(branch, /UPDATE purchase_invoices/);
});
```

(Also extend the pure test file if `loadTfDraws` grows any non-trivial mapping.)

- [ ] **Step 7: Run** `node --test tests/tf-repayment.test.mjs tests/trade-finance.test.mjs` → PASS; `npx tsc -p tsconfig.app.json --noEmit` → clean.

- [ ] **Step 8: Commit** `git commit -m "feat(payments): trade-finance draws + repayment branch (DR TF liability / CR bank), void guards"`

---

### Task 5: `/aging` payload — `tf` section

**Files:**
- Modify: `src/api/routes/accounting.ts` — `/aging` handler (L460): `sourceTables` (L491) + response assembly (after the AP advance block ~L630)

**Interfaces:**
- Produces: aging payload gains `tf: Array<{ lender: string; accountCode: string; accountName: string; tenorDays: number; accountNetSen: number; unallocatedSen: number; totals: {...tfTotals}; draws: Array<TfDraw & { paidSupplier: string }> }>` — `paidSupplier` = the drawing payment's supplierName(s) (`SELECT DISTINCT supplierName FROM supplier_payments WHERE paymentNo = ?`, joined with ", ").

- [ ] **Step 1: Add `"trade_finance_draws", "trade_finance_repay_allocs"` to `sourceTables`** (kv_config is already there — a Setup save rebuilds the snapshot, which also retires the pre-TF cached shape).

- [ ] **Step 2: Build the section** inside the snapshot builder using `getTfSources` + the shared `loadTfDraws` helper + `tfTotals`; empty array when no sources configured.

- [ ] **Step 3: Typecheck + commit** `git commit -m "feat(accounting): creditor aging carries the trade-finance section"`

---

### Task 6: FE — aging block, settings, supplier-payment lender mode

**Files:**
- Create: `src/pages/accounting/tabs/TradeFinanceBlock.tsx` (precedent: AuditLogTab extraction)
- Modify: `src/pages/accounting/index.tsx` — grep `AgingCard` (~L2260): render `<TradeFinanceBlock ... />` directly under the "Accounts Payable Aging" card, fed from the same `/api/accounting/aging` response's `tf` key (extend the `useCachedJson` type at L521)
- Modify: `src/pages/invoices/supplier-payments.tsx` — payFrom options (L169), open-PI load (L207), allocation rows + submit (L339-400)

**TradeFinanceBlock.tsx contract:**
```tsx
export function TradeFinanceBlock({ tf, onChanged }: { tf: TfSectionPayload[] | undefined; onChanged: () => void }) 
```
- Per source: header `TRADE FINANCE — {lender}` + bucket totals strip (Not due / 1-30 / 31-60 / 61-90 / 90+ / Total) + identity line `Total {rm(totals.total)} + unallocated {rm(unallocatedSen)} = account {rm(accountNetSen)}` (red when it doesn't tie).
- Draw table: Draw no · Paid supplier · Draw date · **Due date (inline `<input type="date">`, PUT `/api/accounting/trade-finance/draw-due` on change, then `onChanged()`)** · Amount · Repaid · Outstanding. Sorted as served.
- Header buttons: `Repay` → navigate to the supplier-payment page with `?supplierId=<lenderSupplierId>` (check how that page reads a preselected supplier — it lists suppliers; pass via URL param and add a `useEffect` there to preselect) · `Settings` → collapsible form (account code select of COA accounts, lender supplier select, tenor days, new account name text pre-filled `TRADE FINANCE - <LENDER>`) → confirm dialog spelling out the reclass ("310-0020 becomes a LIABILITY named …, leaves bank lists; ledger untouched") → POST `/api/accounting/trade-finance/setup`.
- Empty state (no kv config): just the Settings form with prefills `310-0020` / HOUZS CENTURY SDN BHD / 90.

**Supplier-payment page lender mode:**
- Fetch `/api/accounting/trade-finance` once; `lenderIds = new Set(sources.map(s => s.lenderSupplierId))`.
- When `selectedSupplierId` ∈ lenderIds: skip the open-PI fetch; instead list that source's `draws` (outstanding > 0) in the SAME grid layout with columns Draw no / Paid supplier / Due date / Outstanding / Pay amount (+ Full checkbox behaving like the PI grid's); hide the Advance input and FX fields; payFrom dropdown EXCLUDES the TF account itself; submit posts `{ supplierId, payFrom, date, reference, tfAllocations: [{drawSourceId, paySen}] }`.
- payFrom options generally: append TF-source accounts to the SBK/SCH list labelled `· trade finance` (so DRAWS remain possible), except in lender mode as above.
- Hide the Edit affordance for payments whose `method === 'TF_REPAYMENT'` (list/detail) — void is the only exit (matches Task 4 Step 5).

- [ ] **Step 1: Build both FE pieces; `npm run dev` walkthrough** — settings prefill → (do NOT press Save against prod DB from dev; visual check only) · aging block renders payload shape (mock via dev staging data if empty) · lender mode grid swaps in.

- [ ] **Step 2: Typecheck + commit** `git commit -m "feat(accounting): trade-finance aging block + settings; supplier-payment lender repayment mode"`

---

### Task 7: Ship + prod runbook (owner presses the writes)

- [ ] **Step 1:** `npm test` full green; `npx tsc -p tsconfig.app.json --noEmit` clean; `git pull origin main --no-edit && git push origin main && git status -sb` (in sync).

- [ ] **Step 2: Verify deploy** — grep live `assets/*.js` for `TradeFinanceBlock` / `tfAllocations`.

- [ ] **Step 3: Owner runbook (send as chat checklist, owner clicks; Claude reads back after each):**
1. Creditor Aging → Trade Finance → Settings：账户 `310-0020`、lender `HOUZS CENTURY SDN BHD`、tenor（**真实天数**）→ Save（确认框写明改性质）。
2. 刷新 aging：4 笔 draw 自动出现（self-heal backfill）、Σ = 94,822.92 = account net、unallocated 0。
3. 逐笔把 due date 改成银行真实到期日。
4. 验 BS/TB：310-0020 在 LIABILITIES 段、名字已改；Cash Book/银行清单不再列它；`/ap-control` 与 `/aging` 的 AP 数字与改造前分毫不变。
5. （有还款时）Supplier Payment → HOUZS CENTURY → 勾 draw → post；验 GL 两腿、aging 桶移动、TB 平。

- [ ] **Step 4: Docs** — WORK-TRACKER entry → ✅ with commits + verified numbers; CODEBASE-MAP accounting section notes the TF tables/endpoints/section; BUG-HISTORY untouched unless something surfaced; CHECKPOINT-交接.md gets the new-state paragraph.

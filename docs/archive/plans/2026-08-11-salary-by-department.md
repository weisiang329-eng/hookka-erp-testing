> **ARCHIVED / SUPERSEDED — stopped being true 2026-08-11.** Every task shipped that day even though its checkboxes are still unticked: Task 1 `src/lib/salary-dept.ts` (added `97d50070`) + `tests/salary-dept.test.mjs`; Tasks 2/3 the `salaryByDept` payload and `GET /labor/departments` in `src/api/routes/accounting.ts`; Task 4 the `dept:` pseudo-lines at `src/pages/forecast.tsx:143,192-195`; Task 5 the stacked card at `src/pages/finance-dashboard.tsx:69,329-345`. Two details drifted from the plan: the shipped `salaryByDept` row type carries an extra `forecastSen?` field (`finance-dashboard.tsx:69`), and `salShownCount` is computed by filtering rather than by subtraction (`:335`). Do NOT re-run this as a build plan. Kept for history only; do not treat as current.

# Salary by Department (Production Salary card + Forecast dept rows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The finance-dashboard "Production Salary" card becomes a per-department stacked chart with Cost-Structure-style Show chips, and the Forecast page keys salaries per department (750-x lines derived).

**Architecture:** Department data comes from `payslips` (the only place the dept dimension exists), aggregated once per dashboard build by a shared pure function. Forecast dept rows ride the existing `forecast_pnl` kv blob as `dept:<CODE>` pseudo-lines (the same trick the `cat:<NAME>` material rows use). One shared pure rule decides when account-level 750-x forecast entries are superseded by dept rows, so FE and BE can never double-count.

**Tech Stack:** Hono routes (`src/api/routes/accounting.ts`), React + recharts (`src/pages/finance-dashboard.tsx`, `src/pages/forecast.tsx`), node:test `.mjs` tests.

**Spec:** `C:\Users\User\Desktop\Claude\Hookka\财务模块-工资部门占比-设计.md`（owner-approved 2026-08-11）

## Global Constraints

- Money = integer sen everywhere; rounding via `roundSen` only if dividing (we only sum here).
- Read DB rows dual-keyed: `r.camelCase ?? r.snake_case` (payslips is a D1-era table).
- `DASH_PAYLOAD_V` is **"v6"** today → bump to **"v7"** in the same commit that changes the payload shape.
- UI copy 100% English. Owner-facing docs Chinese.
- Before push: `npx tsc -p tsconfig.app.json --noEmit` (ignore only the 3 jsbarcode/@zxing errors) + full `npm test` via pre-commit (never `--no-verify`).
- Non-production departments: OUT OF SCOPE (owner 2026-08-11 「先不要理」). Design must merely not break when they appear later.

---

### Task 1: Shared pure lib `salary-dept.ts` (per-month dept aggregation + forecast supersede rule)

**Files:**
- Create: `src/lib/salary-dept.ts`
- Test: `tests/salary-dept.test.mjs`

**Interfaces:**
- Produces: `groupPayslipsByMonthDept(rows): Map<string, { dept: string; costSen: number }[]>` where `rows` are raw payslip rows `{ period, departmentCode, grossPaySen|gross_pay_sen, epfEmployerSen|epf_employer_sen, socsoEmployerSen|socso_employer_sen, eisEmployerSen|eis_employer_sen }` — cost = gross + employer EPF/SOCSO/EIS (same maths as `aggregateLabour`, accounting.ts:9275).
- Produces: `monthHasDeptForecast(pct): boolean` and `forecastEntryKind(code): "dept" | "labourAccount" | "other"` — the supersede rule: **when a month's `pct` map has ANY `dept:` key, DIRECT_LABOUR account entries in that month are ignored** by every consumer.
- Consumed by: Task 2 (dashboard endpoint), Task 4 (forecast page calc).

- [ ] **Step 1: Write the failing test**

⚠ Import mechanics: open `tests/supplier-payment-alloc.test.mjs` (or `tests/discount-alloc.test.mjs`) FIRST and copy exactly how those tests import a `src/lib/*.ts` module (loader/extension) — use the same form here.

```js
// tests/salary-dept.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { groupPayslipsByMonthDept, monthHasDeptForecast, forecastEntryKind } from "../src/lib/salary-dept.js";

test("groups payslip rows by month and department, cost = gross + employer statutory", () => {
  const m = groupPayslipsByMonthDept([
    { period: "2026-07", departmentCode: "FAB_CUT", grossPaySen: 100000, epfEmployerSen: 13000, socsoEmployerSen: 1700, eisEmployerSen: 200 },
    { period: "2026-07", departmentCode: "FAB_CUT", gross_pay_sen: 50000, epf_employer_sen: 6500, socso_employer_sen: 850, eis_employer_sen: 100 },
    { period: "2026-07", departmentCode: "FOAM", grossPaySen: 30000, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
    { period: "2026-06", departmentCode: "FOAM", grossPaySen: 10000, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
  ]);
  assert.deepEqual(m.get("2026-07"), [
    { dept: "FAB_CUT", costSen: 172350 },
    { dept: "FOAM", costSen: 30000 },
  ]);
  assert.deepEqual(m.get("2026-06"), [{ dept: "FOAM", costSen: 10000 }]);
});

test("blank department lands in (unassigned); CANCELLED rows are the CALLER's filter", () => {
  const m = groupPayslipsByMonthDept([
    { period: "2026-07", departmentCode: "", grossPaySen: 1000, epfEmployerSen: 0, socsoEmployerSen: 0, eisEmployerSen: 0 },
  ]);
  assert.deepEqual(m.get("2026-07"), [{ dept: "(unassigned)", costSen: 1000 }]);
});

test("supersede rule: any dept: key disables labour-account entries for that month", () => {
  assert.equal(monthHasDeptForecast({ "dept:FAB_CUT": { bp: 500 } }), true);
  assert.equal(monthHasDeptForecast({ "750-0010": { bp: 500 } }), false);
  assert.equal(forecastEntryKind("dept:FAB_CUT"), "dept");
  assert.equal(forecastEntryKind("750-0010"), "labourAccount");
  assert.equal(forecastEntryKind("750-0040"), "labourAccount");
  assert.equal(forecastEntryKind("900-S002"), "other");
  assert.equal(forecastEntryKind("cat:FABRIC"), "other");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/salary-dept.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/salary-dept.ts
// ---------------------------------------------------------------------------
// Department-dimension salary maths, shared by the dashboard endpoint and the
// Forecast page. The department dimension exists ONLY in payslips — never in
// the GL — so both consumers aggregate the same raw rows with this one rule.
// Cost = gross pay + employer EPF/SOCSO/EIS (identical to aggregateLabour on
// the Labour tab, so the card's Σdepartments always equals that tab's total).
// ---------------------------------------------------------------------------

export type PayslipDeptRow = {
  period?: string | null;
  departmentCode?: string | null;
  grossPaySen?: number | null; gross_pay_sen?: number | null;
  epfEmployerSen?: number | null; epf_employer_sen?: number | null;
  socsoEmployerSen?: number | null; socso_employer_sen?: number | null;
  eisEmployerSen?: number | null; eis_employer_sen?: number | null;
};

export type DeptCost = { dept: string; costSen: number };

export function groupPayslipsByMonthDept(rows: PayslipDeptRow[]): Map<string, DeptCost[]> {
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const ym = String(r.period ?? "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    const dept = String(r.departmentCode ?? "").trim() || "(unassigned)";
    const cost =
      (Number(r.grossPaySen ?? r.gross_pay_sen) || 0) +
      (Number(r.epfEmployerSen ?? r.epf_employer_sen) || 0) +
      (Number(r.socsoEmployerSen ?? r.socso_employer_sen) || 0) +
      (Number(r.eisEmployerSen ?? r.eis_employer_sen) || 0);
    const m = byMonth.get(ym) ?? new Map<string, number>();
    m.set(dept, (m.get(dept) ?? 0) + cost);
    byMonth.set(ym, m);
  }
  const out = new Map<string, DeptCost[]>();
  for (const [ym, m] of byMonth) {
    out.set(
      ym,
      [...m.entries()].map(([dept, costSen]) => ({ dept, costSen })).sort((a, b) => a.dept.localeCompare(b.dept)),
    );
  }
  return out;
}

// --- Forecast supersede rule ------------------------------------------------
// A month that carries ANY `dept:` entry forecasts labour AT DEPARTMENT LEVEL;
// its DIRECT_LABOUR account entries (750-x) are display-only leftovers and
// MUST be ignored by every consumer, or the month double-counts.
const LABOUR_ACCOUNT_RE = /^750-/;

export function forecastEntryKind(code: string): "dept" | "labourAccount" | "other" {
  if (code.startsWith("dept:")) return "dept";
  if (LABOUR_ACCOUNT_RE.test(code)) return "labourAccount";
  return "other";
}

export function monthHasDeptForecast(pct: Record<string, unknown> | undefined | null): boolean {
  for (const k of Object.keys(pct ?? {})) if (k.startsWith("dept:")) return true;
  return false;
}
```

Note: `forecastEntryKind` keys off the `750-` prefix rather than `pnlBucketFor` so the pure lib stays dependency-free; every DIRECT_LABOUR account in this COA is 750-x (verified in prod COA 2026-08-11) and `pnl-bucket.ts` maps 750→DIRECT_LABOUR by the same prefix.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/salary-dept.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/salary-dept.ts tests/salary-dept.test.mjs
git commit -m "feat(accounting): shared per-department salary aggregation + forecast supersede rule"
```

---

### Task 2: Dashboard endpoint — `salaryByDept` per bucket + dept forecast + payslips in sourceTables + v7

**Files:**
- Modify: `src/api/routes/accounting.ts` — anchors: `DASH_PAYLOAD_V` (~L9790), `sourceTables` array (~L9801), per-month P&L loop (`for (const ym of allMonths) { if (ym > nowYm) continue;` ~L9994), forecast slice loop (~L10164-10188), bucket assembly `rows = buckets.map` (~L10207, `labourBase` ~L10266)

**Interfaces:**
- Consumes: `groupPayslipsByMonthDept`, `forecastEntryKind`, `monthHasDeptForecast` from `src/lib/salary-dept.ts` (Task 1).
- Produces (payload): each dashboard row gains `salaryByDept: { dept: string; costSen: number }[]` (bucket-summed, sorted by dept). Forecast slices treat `dept:` entries as DIRECT_LABOUR. Task 5 (card FE) consumes `row.salaryByDept`.

- [ ] **Step 1: Import + query payslips once**

At the top of the file where other `src/lib` imports sit, add:

```ts
import { groupPayslipsByMonthDept, forecastEntryKind, monthHasDeptForecast } from "../../lib/salary-dept";
```

Right after the `headByMonth`/`unitsByMonth` blocks (~L9982), add:

```ts
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
```

- [ ] **Step 2: Bucket assembly — sum dept maps over the bucket's months**

Inside `rows = buckets.map((b) => { ... })`, next to the headcount/units loop (~L10249), add:

```ts
    const salDept = new Map<string, number>();
    for (const ym of b.months) {
      for (const d of salByMonth.get(ym) ?? []) salDept.set(d.dept, (salDept.get(d.dept) ?? 0) + d.costSen);
    }
```

and in the returned object, directly under `labourBase: {...},` add:

```ts
      salaryByDept: [...salDept.entries()]
        .map(([dept, costSen]) => ({ dept, costSen }))
        .filter((d) => d.costSen !== 0)
        .sort((a, b2) => a.dept.localeCompare(b2.dept)),
```

- [ ] **Step 3: Forecast slice loop — dept entries are labour; superseded 750-x entries are skipped**

In the `for (const [ym, m] of Object.entries(fcMonths))` loop (~L10164), compute the flag once before the second inner loop:

```ts
    const deptForecast = monthHasDeptForecast(m.pct);
```

then modify the classification loop (~L10174): at its TOP add:

```ts
      const kind = forecastEntryKind(code);
      if (kind === "dept") { const amt = fcLineAmt(m, v); slice.labour += amt; slice.cogs += amt; continue; }
      if (kind === "labourAccount" && deptForecast) continue; // superseded — dept rows own this month's labour
```

(keep the existing `cat:`/bucket logic below untouched — `dept:` must be handled BEFORE the `coaDash.get(code)` lookup, because a pseudo-code has no COA row and would otherwise fall into the materials fallback).

- [ ] **Step 4: sourceTables + payload version**

- In the `sourceTables` array (~L9801) add `"payslips"` with a comment: `// salaryByDept reads payslips — without it a payroll edit leaves the card stale`.
- Change `const DASH_PAYLOAD_V = "v6";` → `const DASH_PAYLOAD_V = "v7"; // v7: + salaryByDept (per-department wage bill)`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: clean (only the 3 known jsbarcode/@zxing sandbox errors).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/accounting.ts
git commit -m "feat(accounting): dashboard payload carries salaryByDept; dept: forecast rows count as labour (v7)"
```

---

### Task 3: `GET /labor/departments` (seed list for the Forecast page)

**Files:**
- Modify: `src/api/routes/accounting.ts` — insert directly after `app.get("/labor/preview", ...)` (~L9425)
- Test: `tests/salary-dept.test.mjs` (no new test — endpoint is a thin DISTINCT; covered by typecheck + live verify)

**Interfaces:**
- Produces: `GET /api/accounting/labor/departments` → `{ success: true, data: { departments: string[] } }` (distinct non-cancelled payslip departmentCodes, org-scoped, sorted). Consumed by Task 4.

- [ ] **Step 1: Implement**

```ts
// The Forecast page seeds its per-department salary rows from the departments
// that have ever appeared on a payslip (owner 2026-08-11). Non-production
// departments will simply show up here once they exist — nothing to change.
app.get("/labor/departments", async (c) => {
  const denied = await requirePermission(c, "accounting", "read");
  if (denied) return denied;
  try {
    const res = await c.var.DB.prepare(
      `SELECT DISTINCT departmentCode FROM payslips WHERE orgId = ? AND status != 'CANCELLED'`,
    )
      .bind(getOrgId(c))
      .all<{ departmentCode: string | null; department_code: string | null }>();
    const departments = [...new Set(
      (res.results ?? []).map((r) => String(r.departmentCode ?? r.department_code ?? "").trim()).filter(Boolean),
    )].sort();
    return c.json({ success: true, data: { departments } });
  } catch {
    return c.json({ success: true, data: { departments: [] } });
  }
});
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc -p tsconfig.app.json --noEmit` → clean.

```bash
git add src/api/routes/accounting.ts
git commit -m "feat(accounting): GET /labor/departments for the forecast dept rows"
```

---

### Task 4: Forecast page — "Salaries by department" rows; 750-x becomes derived

**Files:**
- Modify: `src/pages/forecast.tsx` — anchors: load `useEffect` (~L103), `lines` useMemo (~L144, `labour: byBucket("DIRECT_LABOUR")` L178), `calc` (~L197), the render loop that prints the labour section rows (grep `DIRECT LABOUR` / `lines.labour` in the JSX), save handler (grep `PUT` / `save` — it serializes `months` back to `{bp|amtSen}`)

**Interfaces:**
- Consumes: `GET /api/accounting/labor/departments` (Task 3); `monthHasDeptForecast`/`forecastEntryKind` from `src/lib/salary-dept.ts` (Task 1).
- Produces: kv `forecast_pnl` months gain `dept:<CODE>` entries (same `{bp}|{amtSen}` cell shape — the save path serializes them like any other line, zero backend change).

- [ ] **Step 1: Fetch departments**

Add to the load `Promise.all` a 4th fetch `fetch("/api/accounting/labor/departments").then(r => r.json())`, store `const [depts, setDepts] = useState<string[]>([])`, `setDepts(...data.departments ?? [])`. Also union in any `dept:` codes already present in saved months (so a keyed dept survives even if its payslips vanish):

```ts
const savedDepts = new Set<string>();
for (const mm of Object.values(next)) for (const k of Object.keys(mm.pct)) if (k.startsWith("dept:")) savedDepts.add(k.slice(5));
setDepts((live) => [...new Set([...live, ...savedDepts])].sort());
```

- [ ] **Step 2: Build dept pseudo-rows; labour accounts become derived**

In the `lines` useMemo, replace `labour: byBucket("DIRECT_LABOUR"),` with:

```ts
      // Owner 2026-08-11: salaries are FORECAST PER DEPARTMENT. The dept rows
      // are keyable pseudo-lines (`dept:<CODE>`, same trick as `cat:`); the
      // 750-x account rows stay visible but DERIVED once a month has dept data.
      labour: depts.map((d) => ({ code: `dept:${d}`, name: d, type: "COST" }) as CoaAcct),
      labourAccounts: byBucket("DIRECT_LABOUR"),
```

(add `depts` to the useMemo dependency array). Keep `cogsRows` as `[...lines.materials, ...lines.direct, ...lines.labour, ...lines.overhead, ...legacyLabourRows]` where:

```ts
  // Legacy months keyed 750-x directly; those cells still count WHERE no dept
  // rows exist for that month (the shared supersede rule, mirrored server-side).
  const legacyLabourRows = lines.labourAccounts;
```

- [ ] **Step 3: `calc` honours the supersede rule**

In `calc(ym)`, replace `const cogs = sum(cogsRows);` with:

```ts
    const deptMode = monthHasDeptForecast(m?.pct);
    const sumGuard = (rows: CoaAcct[]) =>
      rows.reduce((s, r) => (deptMode && forecastEntryKind(r.code) === "labourAccount" ? s : s + amt(r.code)), 0);
    const cogs = sumGuard(cogsRows);
```

(import both helpers from `@/lib/salary-dept`).

- [ ] **Step 4: Render**

In the COGS section JSX where `lines.labour` rows render under the "DIRECT LABOUR" group header, render:
1. the dept rows (keyable cells exactly like any line — they already flow through `setPctStr`/`setAmtStr` since they're ordinary rows with pseudo-codes);
2. then the `lines.labourAccounts` rows with cells swapped to a derived display: for each month, if `monthHasDeptForecast(months[ym]?.pct)` render a grey non-editable cell showing `-` for individual 750-x lines and add ONE summary row `Derived from departments` whose per-month value = Σ dept `amt()`; if the month has NO dept entries, render the normal editable cell (legacy months keep working).

Follow the existing row JSX (copy the exact cell markup used by material `cat:` rows — grey placeholder styling is already there via the derived-value placeholder pattern).

- [ ] **Step 5: Manual check in dev**

Run: `npm run dev` → open `/forecast`: 8 dept rows appear under DIRECT LABOUR; keying `dept:FAB_CUT` 5% greys the 750-x cells for that month; a legacy month (if any had 750-0010 keyed) still shows its figure and totals unchanged. Verify month totals: COGS moves by the dept amounts.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc -p tsconfig.app.json --noEmit
git add src/pages/forecast.tsx
git commit -m "feat(forecast): salaries keyed per department; 750-x lines derived (supersede rule shared with dashboard)"
```

---

### Task 5: Production Salary card — stacked departments + Show chips

**Files:**
- Modify: `src/pages/finance-dashboard.tsx` — anchors: `Row` type (~L53, add field), `labourData` useMemo (~L295), Production Salary card JSX (~L667-753); copy chip/stack patterns from the Cost Structure card (~L756-845: `CS_COLOURS`, chips block L780-818, stacked `Bar` loop L827-842, `<ChartTip shares />`)

**Interfaces:**
- Consumes: `row.salaryByDept` from Task 2's payload.

- [ ] **Step 1: Type + data**

Add to `Row`: `salaryByDept?: { dept: string; costSen: number }[];`

Below `labourData`, add:

```ts
  // Departments present anywhere in the window (chips = union, stable order).
  const salDepts = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows ?? []) for (const d of r.salaryByDept ?? []) s.add(d.dept);
    return [...s].sort();
  }, [rows]);
  const [salHidden, setSalHidden] = useState<Set<string>>(new Set());
  const salShownCount = salDepts.length - salHidden.size;
  // Chart rows: one key per department + the forecast line + drawn-% helper
  // (mirrors csData: __drawnpct__ prints only when a single band is drawn).
  const salData = useMemo(
    () =>
      (rows ?? []).map((r) => {
        const sales = r.actual?.sales ?? null;
        const rec: Record<string, number | string | null> = { label: r.label + (r.partial ? " *" : ""), forecast: r.forecast?.labour ?? null };
        let drawn = 0;
        for (const d of r.salaryByDept ?? []) {
          rec[d.dept] = d.costSen;
          if (!salHidden.has(d.dept)) drawn += d.costSen;
        }
        rec.__sales__ = sales; // ChartTip shares divides by this
        rec.__drawnpct__ = sales && sales !== 0 ? Math.round((drawn / sales) * 10000) / 100 : null;
        return rec;
      }),
    [rows, salHidden],
  );
```

Check how `csData` feeds `ChartTip shares` its sales base (grep `__sales__` / how shares are computed in `ChartTip`) and use the SAME field contract — if ChartTip derives shares differently (e.g. from a prop), copy that exact mechanism instead of inventing `__sales__`.

- [ ] **Step 2: Card JSX**

In the Production Salary card (~L672):
- Under the `<h3>` header row, insert the chips block copied from the CS card (L780-818) with `salDepts`/`salHidden`/`setSalHidden` and the same colour indexing `CS_COLOURS[i % CS_COLOURS.length]`, including Show all / Clear buttons.
- In the `ComposedChart`, REPLACE the single `<Bar yAxisId="amt" dataKey="amount" .../>` with the stacked loop:

```tsx
{salDepts.map((dept, i) =>
  salHidden.has(dept) ? null : (
    <Bar key={dept} yAxisId="amt" dataKey={dept} name={dept} stackId="sal" maxBarSize={38}
      fill={CS_COLOURS[i % CS_COLOURS.length]}>
      {salShownCount === 1 && (
        <LabelList dataKey="__drawnpct__" position="top" offset={6}
          formatter={(v: unknown) => (typeof v === "number" ? `${v.toFixed(2)}%` : "")}
          style={{ fontSize: 10, fill: "#6B5C32" }} />
      )}
    </Bar>
  ),
)}
```

- Switch the chart's `data={labourData}` → `data={salData}` and `<Tooltip content={<ChartTip />} />` → `<ChartTip shares />` (same as CS card).
- KEEP: forecast dashed `Line` (dataKey `forecast`), both unit-axis `Line`s (`perHead`/`perUnit`) — merge those fields into `salData` rows (copy `perHead`/`perUnit`/`headcount`/`units` computation from `labourData` into the same map, or spread: build `salData` FROM `labourData` by index: `...labourData[i]` then add dept keys).
- KEEP the whole table + the RM/unit warning paragraph untouched (it reads `labourData` — leave that memo in place).
- Header caption: after the account-codes span add `<span className="ml-1 text-[11px] text-[#9CA3AF]">RM + % of sales</span>`.

- [ ] **Step 3: Verify in dev**

`npm run dev` → `/finance-dashboard`: stacked colours per dept; chip toggles a band; one-dept mode prints % on top; tooltip lists每部门 RM + share; forecast dashed line + RM/head + RM/unit + table all still render. Confirm Σbands ≙ Amount row for the same period.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc -p tsconfig.app.json --noEmit
git add src/pages/finance-dashboard.tsx
git commit -m "feat(dashboard): Production Salary card stacks departments with Show chips (owner 2026-08-11)"
```

---

### Task 6: Ship + live verification + docs

- [ ] **Step 1: Full test run**

Run: `npm test` (or let pre-commit do it). Expected: all green (3657+ tests).

- [ ] **Step 2: Push main**

```bash
git pull origin main --no-edit
git push origin main
git status -sb   # MUST show in sync with origin (parallel-session rule)
```

- [ ] **Step 3: Verify prod (read-only)**

- Grep the deployed bundle: fetch `erp.hookka.com` `assets/*.js` for `salaryByDept` (new chunk hash).
- `GET /api/accounting/dashboard` (cache-bust) → rows carry `salaryByDept`; pick 2026-07: Σdept costSen = 6,984,7xx sen ≙ `GET /api/accounting/labor/preview?month=2026-07` totalSen (exact).
- Forecast page: key one dept % into a future month, save, dashboard forecast labour reflects it (then clear it, save — leave prod data as found).

- [ ] **Step 4: Update docs**

- `docs/WORK-TRACKER.md`: flip the 2026-08-11 entry's feature-1 half to ✅ with commits + verification numbers.
- `docs/CODEBASE-MAP.md` accounting section: note `salaryByDept` in the dashboard payload + `/labor/departments` (update-on-touch rule).
- Commit docs: `git commit -m "docs: salary-by-department shipped"`.

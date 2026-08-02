// ---------------------------------------------------------------------------
// Hookka AI — named report templates.
//
// Each skill is a small declarative spec the assistant can invoke by name:
//
//   { name: "monthly_sales_summary", description: "...", params: {...},
//     execute: async (c, params) => ExportResult }
//
// Skills are cheaper than free-form prompting — the operator says
// "monthly sales summary for May" and we generate the same Excel every
// time, without the model burning tool calls re-deriving the SQL.
//
// Each skill receives the active Hono Context and the parameter bag from
// the model's tool call. It produces a finished export (already uploaded
// to storage with a signed URL) which the tool wrapper returns to the
// model as a tool_result.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";
import { getOrgId } from "./tenant";
import {
  buildExcelWorkbook,
  buildSimpleTablePdf,
  uploadExportAndSign,
  CONTENT_TYPES,
  MAX_EXPORT_ROWS,
  type ExportResult,
} from "./assistant-exports";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function senToRM(sen: number | null | undefined): number {
  const n = typeof sen === "number" ? sen : Number(sen ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function ymd(v: unknown): string {
  if (typeof v !== "string") return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : v.slice(0, 10);
}

// Default to "this month" when caller doesn't supply both bounds.
function defaultMonthBounds(periodFrom?: string, periodTo?: string): {
  from: string;
  to: string;
  label: string;
} {
  const now = new Date();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  // Last day of this month at 23:59:59 — use day 0 of NEXT month.
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const monthEnd = nextMonth.toISOString().slice(0, 10);
  const from = ymd(periodFrom) || monthStart;
  const to = ymd(periodTo) || monthEnd;
  return { from, to, label: `${from} to ${to}` };
}

// ---------------------------------------------------------------------------
// Skill type
// ---------------------------------------------------------------------------

export type ReportTemplate = {
  name: string;
  description: string;
  paramHints: Record<string, string>; // human description of each param
  execute: (
    c: Context<Env>,
    params: Record<string, unknown>,
  ) => Promise<ExportResult & { previewSummary?: string }>;
};

// ---------------------------------------------------------------------------
// monthly_sales_summary — one sheet per hub, totals at bottom
// ---------------------------------------------------------------------------

const monthlySalesSummary: ReportTemplate = {
  name: "monthly_sales_summary",
  description:
    "Sales orders for a period grouped by hub (KL/PG/SRW/SBH/other). One Excel sheet per hub, sorted by date. Includes per-hub subtotal row.",
  paramHints: {
    periodFrom: "Start date YYYY-MM-DD (default: first day of current month).",
    periodTo: "End date YYYY-MM-DD (default: last day of current month).",
    customer: "Optional customer name fragment to narrow the list.",
  },
  execute: async (c, params) => {
    const orgId = getOrgId(c);
    const { from, to, label } = defaultMonthBounds(
      params.periodFrom as string | undefined,
      params.periodTo as string | undefined,
    );
    const customer =
      typeof params.customer === "string" && params.customer.trim().length > 0
        ? params.customer.trim().toLowerCase()
        : null;

    const wheres = [
      "orgId = ?",
      "created_at >= ?",
      "created_at <= ?",
    ];
    const args: unknown[] = [orgId, from, `${to} 23:59:59`];
    if (customer) {
      wheres.push("LOWER(customerName) LIKE ?");
      args.push(`%${customer}%`);
    }
    const rows = await c.var.DB.prepare(
      // `hubName` — sales_orders has hub_id / hub_name, never a bare `hub`.
      `SELECT id, companySOId, customerName, customerPOId, status, hubName,
              totalSen, customerDeliveryDate, created_at AS createdAt
       FROM sales_orders WHERE ${wheres.join(" AND ")}
       ORDER BY created_at ASC LIMIT ${MAX_EXPORT_ROWS}`,
    )
      .bind(...args)
      .all<{
        id: string;
        companySOId: string | null;
        customerName: string | null;
        customerPOId: string | null;
        status: string | null;
        hubName: string | null;
        totalSen: number | null;
        customerDeliveryDate: string | null;
        createdAt: string | null;
      }>();

    const results = rows.results ?? [];
    // Bucket by hub. Treat null/empty as "OTHER".
    const buckets = new Map<string, typeof results>();
    for (const r of results) {
      const hub = (r.hubName ?? "").trim().toUpperCase() || "OTHER";
      const list = buckets.get(hub) ?? [];
      list.push(r);
      buckets.set(hub, list);
    }
    // Stable hub order: KL, PG, SRW, SBH, then any others alphabetical.
    const preferredOrder = ["KL", "PG", "SRW", "SBH"];
    const hubs = [
      ...preferredOrder.filter((h) => buckets.has(h)),
      ...Array.from(buckets.keys())
        .filter((h) => !preferredOrder.includes(h))
        .sort(),
    ];

    const sheets = hubs.length > 0
      ? hubs.map((hub) => {
          const list = buckets.get(hub) ?? [];
          const total = list.reduce((s, r) => s + (r.totalSen ?? 0), 0);
          const sheetRows: Array<Record<string, unknown>> = list.map((r) => ({
            soId: r.companySOId ?? r.id,
            customer: r.customerName ?? "",
            customerPO: r.customerPOId ?? "",
            status: r.status ?? "",
            totalRM: senToRM(r.totalSen),
            customerDeliveryDate: r.customerDeliveryDate ?? "",
            createdAt: (r.createdAt ?? "").slice(0, 10),
          }));
          sheetRows.push({
            soId: "TOTAL",
            customer: `${list.length} orders`,
            customerPO: "",
            status: "",
            totalRM: senToRM(total),
            customerDeliveryDate: "",
            createdAt: "",
          });
          return { name: `Hub ${hub}`, rows: sheetRows };
        })
      : [{ name: "Sales", rows: [] }];

    const bytes = buildExcelWorkbook(sheets);
    const filename =
      typeof params.filename === "string" && params.filename.trim()
        ? String(params.filename)
        : `monthly-sales-summary-${from}-to-${to}.xlsx`;
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.xlsx,
    );
    return {
      ...uploaded,
      rowCount: results.length,
      previewSummary: `Period ${label}: ${results.length} sales orders across ${hubs.length} hub(s).`,
    };
  },
};

// ---------------------------------------------------------------------------
// customer_outstanding_pos — customer POs (Houzs etc) not yet linked to a SO
// ---------------------------------------------------------------------------

const customerOutstandingPos: ReportTemplate = {
  name: "customer_outstanding_pos",
  description:
    "Customer POs we've recorded but not yet matched to a sales order. Reads sales_orders.customerPOId column for the LAST 90 days where status is DRAFT. Excel output.",
  paramHints: {
    customer: "Optional customer name fragment to narrow the list.",
    days: "Lookback window in days (default 90).",
  },
  execute: async (c, params) => {
    const orgId = getOrgId(c);
    const days = Math.max(
      1,
      Math.min(365, Number(params.days) > 0 ? Number(params.days) : 90),
    );
    const customer =
      typeof params.customer === "string" && params.customer.trim().length > 0
        ? params.customer.trim().toLowerCase()
        : null;

    const wheres = [
      "orgId = ?",
      "customerPOId IS NOT NULL",
      "LENGTH(TRIM(COALESCE(customerPOId, ''))) > 0",
      `created_at >= NOW() - INTERVAL '${days} days'`,
      "UPPER(status) IN ('DRAFT','PENDING','PENDING_PRODUCTION','UNCONFIRMED')",
    ];
    const args: unknown[] = [orgId];
    if (customer) {
      wheres.push("LOWER(customerName) LIKE ?");
      args.push(`%${customer}%`);
    }
    const rows = await c.var.DB.prepare(
      `SELECT id, companySOId, customerPOId, customerName, status, totalSen,
              created_at AS createdAt
       FROM sales_orders WHERE ${wheres.join(" AND ")}
       ORDER BY created_at DESC LIMIT ${MAX_EXPORT_ROWS}`,
    )
      .bind(...args)
      .all<{
        id: string;
        companySOId: string | null;
        customerPOId: string | null;
        customerName: string | null;
        status: string | null;
        totalSen: number | null;
        createdAt: string | null;
      }>();

    const results = rows.results ?? [];
    const sheetRows = results.map((r) => ({
      customerPO: r.customerPOId ?? "",
      soId: r.companySOId ?? r.id,
      customer: r.customerName ?? "",
      status: r.status ?? "",
      totalRM: senToRM(r.totalSen),
      createdAt: (r.createdAt ?? "").slice(0, 10),
    }));
    const bytes = buildExcelWorkbook([
      { name: "Outstanding POs", rows: sheetRows },
    ]);
    const filename =
      typeof params.filename === "string" && params.filename.trim()
        ? String(params.filename)
        : `customer-outstanding-pos-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.xlsx,
    );
    return {
      ...uploaded,
      rowCount: results.length,
      previewSummary: `Found ${results.length} outstanding customer POs in the last ${days} days.`,
    };
  },
};

// ---------------------------------------------------------------------------
// employee_efficiency_weekly — per-employee efficiency for a week
// ---------------------------------------------------------------------------

const employeeEfficiencyWeekly: ReportTemplate = {
  name: "employee_efficiency_weekly",
  description:
    "Per-employee efficiency for a date range. Excel: jobs completed, planned vs actual minutes, efficiency %. Defaults to the last 7 days.",
  paramHints: {
    periodFrom: "Start date YYYY-MM-DD (default: 7 days ago).",
    periodTo: "End date YYYY-MM-DD (default: today).",
    department: "Optional department code filter (e.g. SEW, UPH).",
  },
  execute: async (c, params) => {
    const orgId = getOrgId(c);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const from = ymd(params.periodFrom as string | undefined) || weekAgo;
    const to = ymd(params.periodTo as string | undefined) || today;
    const dept =
      typeof params.department === "string" && params.department.trim().length > 0
        ? params.department.trim().toUpperCase()
        : null;

    const wheres = [
      "orgId = ?",
      "UPPER(status) = 'COMPLETED'",
      "completedDate >= ?",
      "completedDate <= ?",
    ];
    const args: unknown[] = [orgId, from, to];
    if (dept) {
      wheres.push("UPPER(departmentCode) = ?");
      args.push(dept);
    }
    const rows = await c.var.DB.prepare(
      `SELECT pic1Id, pic1Name, pic2Id, pic2Name, departmentCode,
              estMinutes, actualMinutes
       FROM job_cards WHERE ${wheres.join(" AND ")} LIMIT ${MAX_EXPORT_ROWS}`,
    )
      .bind(...args)
      .all<{
        pic1Id: string | null;
        pic1Name: string | null;
        pic2Id: string | null;
        pic2Name: string | null;
        departmentCode: string | null;
        estMinutes: number;
        actualMinutes: number | null;
      }>();

    type Bucket = {
      id: string;
      name: string;
      department: string;
      jobs: number;
      plannedMin: number;
      actualMin: number;
    };
    const byPerson = new Map<string, Bucket>();
    for (const r of rows.results ?? []) {
      const persons: Array<{ id: string | null; name: string | null }> = [
        { id: r.pic1Id, name: r.pic1Name },
      ];
      if (r.pic2Id) persons.push({ id: r.pic2Id, name: r.pic2Name });
      for (const p of persons) {
        if (!p.id) continue;
        const o =
          byPerson.get(p.id) ?? {
            id: p.id,
            name: p.name ?? "",
            department: r.departmentCode ?? "",
            jobs: 0,
            plannedMin: 0,
            actualMin: 0,
          };
        o.jobs += 1;
        const share = persons.length;
        o.plannedMin += (r.estMinutes ?? 0) / share;
        o.actualMin += (r.actualMinutes ?? 0) / share;
        byPerson.set(p.id, o);
      }
    }
    const list = Array.from(byPerson.values())
      .map((b) => ({
        employeeId: b.id,
        employeeName: b.name,
        department: b.department,
        jobsCompleted: b.jobs,
        plannedMinutes: Math.round(b.plannedMin),
        actualMinutes: Math.round(b.actualMin),
        efficiencyPct:
          b.actualMin > 0
            ? Math.round((b.plannedMin / b.actualMin) * 1000) / 10
            : null,
      }))
      .sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    const bytes = buildExcelWorkbook([{ name: "Efficiency", rows: list }]);
    const filename =
      typeof params.filename === "string" && params.filename.trim()
        ? String(params.filename)
        : `employee-efficiency-${from}-to-${to}.xlsx`;
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.xlsx,
    );
    return {
      ...uploaded,
      rowCount: list.length,
      previewSummary: `Period ${from} to ${to}: ${list.length} employees credited with completed jobs.`,
    };
  },
};

// ---------------------------------------------------------------------------
// production_overdue_report — PDF, formatted overdue PO list
// ---------------------------------------------------------------------------

const productionOverdueReport: ReportTemplate = {
  name: "production_overdue_report",
  description:
    "Production orders past their targetEndDate but not completed. PDF report with totals.",
  paramHints: {
    asOf: "Cutoff date YYYY-MM-DD (default: today).",
  },
  execute: async (c, params) => {
    const orgId = getOrgId(c);
    const asOf = ymd(params.asOf as string | undefined) || new Date().toISOString().slice(0, 10);

    const rows = await c.var.DB.prepare(
      `SELECT poNo, salesOrderNo, customerName, currentDepartment, progress,
              startDate, targetEndDate
       FROM production_orders
       WHERE orgId = ? AND targetEndDate IS NOT NULL
         AND targetEndDate < ?
         AND UPPER(status) NOT IN ('COMPLETED','CANCELLED')
       ORDER BY targetEndDate ASC LIMIT ${MAX_EXPORT_ROWS}`,
    )
      .bind(orgId, asOf)
      .all<{
        poNo: string | null;
        salesOrderNo: string | null;
        customerName: string | null;
        currentDepartment: string | null;
        progress: number | null;
        startDate: string | null;
        targetEndDate: string | null;
      }>();

    const results = rows.results ?? [];
    const tableRows = results.map((r) => [
      r.poNo ?? "",
      r.salesOrderNo ?? "",
      r.customerName ?? "",
      r.currentDepartment ?? "",
      r.progress != null ? `${Math.round(r.progress * 100) / 100}%` : "-",
      r.targetEndDate ?? "",
    ]);

    const bytes = await buildSimpleTablePdf({
      title: "Production Overdue Report",
      subtitle: `As of ${asOf} · ${results.length} overdue PO(s)`,
      columns: ["PO", "SO", "Customer", "Dept", "Progress", "Target End"],
      rows: tableRows,
      totals: [`Total: ${results.length}`, "", "", "", "", ""],
      footer: `Hookka AI · production_overdue_report · generated ${new Date().toISOString().slice(0, 10)}`,
    });
    const filename =
      typeof params.filename === "string" && params.filename.trim()
        ? String(params.filename)
        : `production-overdue-${asOf}.pdf`;
    const uploaded = await uploadExportAndSign(
      c.env,
      orgId,
      filename,
      bytes,
      CONTENT_TYPES.pdf,
    );
    return {
      ...uploaded,
      rowCount: results.length,
      previewSummary: `As of ${asOf}: ${results.length} production order(s) overdue.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const REPORT_TEMPLATES: ReportTemplate[] = [
  monthlySalesSummary,
  customerOutstandingPos,
  employeeEfficiencyWeekly,
  productionOverdueReport,
];

const TEMPLATE_BY_NAME = new Map<string, ReportTemplate>(
  REPORT_TEMPLATES.map((t) => [t.name, t]),
);

export function getReportTemplate(name: string): ReportTemplate | null {
  return TEMPLATE_BY_NAME.get(name) ?? null;
}

export function listReportTemplates(): Array<{
  name: string;
  description: string;
  paramHints: Record<string, string>;
}> {
  return REPORT_TEMPLATES.map((t) => ({
    name: t.name,
    description: t.description,
    paramHints: t.paramHints,
  }));
}

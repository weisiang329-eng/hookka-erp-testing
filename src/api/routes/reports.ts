// ---------------------------------------------------------------------------
// Daily reports — efficiency (yesterday), production schedule (today),
// overdue (current).
//
// Endpoints:
//   GET  /api/reports/efficiency?date=YYYY-MM-DD          (auth, HTML)
//   GET  /api/reports/efficiency.json?date=YYYY-MM-DD     (auth, JSON for UI)
//   POST /api/reports/efficiency/send  body={date?,to?}   (auth, on-demand send)
//   POST /api/internal/reports/efficiency-trigger          (cron, x-cron-secret)
//
// The internal trigger reads CRON_SECRET via x-cron-secret header. External
// cron service (cron-job.org / GitHub Action) hits it daily at 12pm SGT.
//
// Mount points (see src/api/worker.ts):
//   app.route("/api/reports", reports)
//   app.route("/api/internal/reports", reportsInternal)
//
// The /api/internal/* path is added to PUBLIC_PATHS (no session needed) and
// guarded purely by CRON_SECRET. See src/api/lib/auth-middleware.ts.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { sendMail } from "../lib/email";
import {
  collectEfficiencyData,
  renderEfficiencyHtml,
  renderEfficiencyEmailText,
} from "../lib/efficiency-report";
import {
  collectScheduleData,
  renderScheduleHtml,
  renderScheduleEmailText,
  collectOverdueData,
  renderOverdueHtml,
  renderOverdueEmailText,
} from "../lib/schedule-overdue-report";
import { collectComplianceData } from "../lib/compliance-report";
import {
  collectBriefData,
  renderBriefHtml,
  renderBriefEmailText,
} from "../lib/production-brief";
import {
  collectOperationsReport,
  type OperationsPeriodKind,
} from "../lib/operations-report";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();
export default app;

// ---------------------------------------------------------------------------
// Date helpers — SGT (UTC+8). Yesterday-in-SGT for the cron default.
// ---------------------------------------------------------------------------

function ymdInSgt(d: Date): string {
  // Shift by +8h and slice the ISO date portion.
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function yesterdayYmdSgt(): string {
  const now = new Date();
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return ymdInSgt(y);
}

function todayYmdSgt(): string {
  return ymdInSgt(new Date());
}

// Add N days to a YYYY-MM-DD (positive or negative). YMD-only arithmetic —
// avoids the +8h SGT shift drifting at month/year boundaries.
function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Walk back from `fromYmd` (NOT inclusive) day-by-day until we find a YMD
// that is neither Sunday nor in the public-holidays set. Used by the
// efficiency cron so Monday 12pm sends Saturday's report (not Sunday's,
// which would be empty). Bounded at 14 hops as a safety net — if Hookka
// ever has 14 PHs in a row we have bigger problems.
function previousWorkingDay(fromYmd: string, holidays: Set<string>): string {
  let cur = fromYmd;
  for (let i = 0; i < 14; i++) {
    cur = addDays(cur, -1);
    const dow = sgtDayOfWeek(cur);
    if (dow === 0) continue; // Sunday
    if (holidays.has(cur)) continue;
    return cur;
  }
  return addDays(fromYmd, -1); // fall back to literal yesterday
}

function parseDateParam(
  q: string | undefined,
  fallback: () => string = yesterdayYmdSgt,
): string {
  if (typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return fallback();
}

// Day-of-week 0..6 (Sun..Sat) for a YYYY-MM-DD string interpreted in SGT.
// We compare the date as UTC-midnight which is fine because the YMD string
// is already SGT-anchored (todayYmdSgt produces it that way).
function sgtDayOfWeek(ymd: string): number {
  const d = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return -1;
  return d.getUTCDay(); // 0 = Sunday
}

// Read kv_config['public_holidays'] (JSON array of YYYY-MM-DD). Returns a Set
// — same shape as payslips.ts / worker.ts already use. Cheap to call once
// per cron fire (single SELECT + parse).
async function loadPublicHolidays(c: {
  var: Env["Variables"];
}): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const row = await c.var.DB
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("public_holidays")
      .first<{ value: string | null }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) {
          if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
            out.add(d);
          }
        }
      }
    }
  } catch {
    /* malformed / missing — treat as no holidays */
  }
  return out;
}

// Returns null when SGT-today is a working day, or a reason string when it
// is Sunday or a declared public holiday. Cron triggers skip on non-null;
// manual /send paths bypass this check.
async function nonWorkingDayReason(c: {
  var: Env["Variables"];
}): Promise<string | null> {
  const today = todayYmdSgt();
  if (sgtDayOfWeek(today) === 0) return `Sunday (${today})`;
  const holidays = await loadPublicHolidays(c);
  if (holidays.has(today)) return `public holiday (${today})`;
  return null;
}

// ---------------------------------------------------------------------------
// Recipient resolution — DAILY_REPORT_RECIPIENTS env var (comma-separated)
// takes precedence. Fallback: all SUPER_ADMIN users in the users table.
// ---------------------------------------------------------------------------

async function resolveRecipients(
  c: { env: Env["Bindings"]; var: Env["Variables"] },
): Promise<string[]> {
  const env = c.env as Env["Bindings"] & { DAILY_REPORT_RECIPIENTS?: string };
  const raw = (env.DAILY_REPORT_RECIPIENTS ?? "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  }
  // Fallback — query SUPER_ADMIN users. Schema: users(roleId='SUPER_ADMIN',
  // isActive=1, email NOT NULL).
  type Row = { email: string };
  const r = await c.var.DB
    .prepare(
      `SELECT email FROM users WHERE roleId = 'SUPER_ADMIN' AND isActive = 1 AND email IS NOT NULL`,
    )
    .all<Row>();
  return (r.results ?? []).map((x) => x.email).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Constant-time string compare for the CRON_SECRET check.
// ---------------------------------------------------------------------------

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// GET /api/reports/efficiency — returns the rendered HTML so a logged-in
// operator can open it in a new tab and print to PDF / paper.
// ---------------------------------------------------------------------------

app.get("/efficiency", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  // Default to the previous working day (skip Sunday + PH) so an operator
  // who hits the URL on Monday morning gets Saturday's report, not
  // Sunday's empty one. Explicit ?date= always wins.
  const q = c.req.query("date");
  let date: string;
  if (typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q)) {
    date = q;
  } else {
    const holidays = await loadPublicHolidays(c);
    date = previousWorkingDay(todayYmdSgt(), holidays);
  }
  try {
    const data = await collectEfficiencyData(c.var.DB, date);
    const html = renderEfficiencyHtml(data);
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[reports/efficiency] failed:", err);
    return c.json(
      { success: false, error: "report generation failed" },
      500,
    );
  }
});

// JSON variant — surfaces the same data as the HTML report for in-app charts.
app.get("/efficiency.json", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const q = c.req.query("date");
  let date: string;
  if (typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q)) {
    date = q;
  } else {
    const holidays = await loadPublicHolidays(c);
    date = previousWorkingDay(todayYmdSgt(), holidays);
  }
  try {
    const data = await collectEfficiencyData(c.var.DB, date);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/efficiency.json] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/operations.json?period=daily|weekly|monthly&date=YYYY-MM-DD
// The Operations Report (newspaper). One payload, all sections, scoped to the
// period's date range. Reuses existing calc logic so numbers tie to the system.
// ---------------------------------------------------------------------------

app.get("/operations.json", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;

  const rawPeriod = c.req.query("period");
  const period: OperationsPeriodKind =
    rawPeriod === "daily" || rawPeriod === "weekly" || rawPeriod === "monthly"
      ? rawPeriod
      : "monthly";

  const q = c.req.query("date");
  const date =
    typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayYmdSgt();

  try {
    const orgId = getOrgId(c);
    const data = await collectOperationsReport(c.var.DB, orgId, period, date);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/operations.json] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/reports/efficiency/send — manual send-now from the UI button.
// Body: { date?: "YYYY-MM-DD", to?: string | string[] }
// ---------------------------------------------------------------------------

app.post("/efficiency/send", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  return c.json(await dispatchReport(c, "efficiency"));
});

// ---------------------------------------------------------------------------
// GET /api/reports/schedule — today's production plan grouped by department.
// ---------------------------------------------------------------------------

app.get("/schedule", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const date = parseDateParam(c.req.query("date"), todayYmdSgt);
  try {
    const data = await collectScheduleData(c.var.DB, date);
    return new Response(renderScheduleHtml(data), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[reports/schedule] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

app.get("/schedule.json", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const date = parseDateParam(c.req.query("date"), todayYmdSgt);
  try {
    const data = await collectScheduleData(c.var.DB, date);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/schedule.json] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/overdue — currently overdue items grouped by department.
// ---------------------------------------------------------------------------

app.get("/overdue", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const date = parseDateParam(c.req.query("date"), todayYmdSgt);
  try {
    const data = await collectOverdueData(c.var.DB, date);
    return new Response(renderOverdueHtml(data), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[reports/overdue] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

app.get("/overdue.json", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  const date = parseDateParam(c.req.query("date"), todayYmdSgt);
  try {
    const data = await collectOverdueData(c.var.DB, date);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/overdue.json] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Production Morning Brief (Production Agent Phase 1).
//   GET  /api/reports/brief        — HTML (open in tab / print)
//   GET  /api/reports/brief.json   — JSON for the dashboard card
//   POST /api/reports/brief/send   — manual send-now
//   POST /api/internal/reports/brief-trigger — 07:00 MYT cron (see below)
// ---------------------------------------------------------------------------

async function buildBrief(
  c: {
    env: Env["Bindings"];
    var: Env["Variables"];
    req: { query(name: string): string | undefined };
  },
  includeAi: boolean,
) {
  const date = parseDateParam(c.req.query("date"), todayYmdSgt);
  const holidays = await loadPublicHolidays(c);
  const prev = previousWorkingDay(date, holidays);
  return collectBriefData(
    c.var.DB,
    date,
    prev,
    includeAi
      ? (c.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY
      : undefined,
  );
}

app.get("/brief", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  try {
    // Full HTML view includes the AI focus paragraph (one Claude call).
    const data = await buildBrief(c, true);
    return new Response(renderBriefHtml(data), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[reports/brief] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

app.get("/brief.json", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  try {
    // Dashboard-card variant: NO AI call (fast + free on every page load).
    const data = await buildBrief(c, false);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/brief.json] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

app.post("/brief/send", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  return c.json(await dispatchReport(c, "brief"));
});

// ---------------------------------------------------------------------------
// GET /api/reports/compliance.json — Daily Report. Process / SOP exceptions
// across the order → delivery → invoice + procurement chains, plus overdue
// orders and low-efficiency workers. JSON only (no HTML / email / cron for v1).
// ---------------------------------------------------------------------------

app.get("/compliance.json", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;
  try {
    const data = await collectComplianceData(c.var.DB, todayYmdSgt());
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/compliance.json] failed:", err);
    return c.json({ success: false, error: "report generation failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/internal/reports/efficiency-trigger — cron entry point.
// Auth: x-cron-secret header must match env.CRON_SECRET. No session check.
// ---------------------------------------------------------------------------

export const internal = new Hono<Env>();

type ReportKind = "efficiency" | "schedule" | "overdue" | "brief";

async function authCron(c: {
  env: Env["Bindings"];
  req: { header(name: string): string | undefined };
  json: <T>(body: T, status?: number) => Response;
}): Promise<Response | null> {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error("[reports/cron] CRON_SECRET unset or too short — refusing");
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  return null;
}

async function dispatchReport(
  c: { env: Env["Bindings"]; var: Env["Variables"]; req: { json(): Promise<unknown> } },
  kind: ReportKind,
): Promise<{
  ok: boolean;
  date: string;
  sent: number;
  failed: number;
  errors?: string[];
}> {
  let body: { date?: string; to?: string | string[] } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  // Date resolution:
  //   - efficiency: previous working day (skip Sun + PH walking back from today).
  //     Monday 12pm → Saturday's report (not Sunday's empty one).
  //   - schedule / overdue: today (the cron only fires on working days, so
  //     today is by construction a working day — see cronGate).
  //   - body.date always wins as override (manual backfill).
  let date: string;
  if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    date = body.date;
  } else if (kind === "efficiency") {
    const holidays = await loadPublicHolidays(c);
    date = previousWorkingDay(todayYmdSgt(), holidays);
  } else {
    date = todayYmdSgt();
  }
  const overrideTo = Array.isArray(body.to)
    ? body.to
    : typeof body.to === "string"
      ? body.to.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const recipients =
    overrideTo.length > 0 ? overrideTo : await resolveRecipients(c);
  if (recipients.length === 0) {
    console.warn(`[reports/${kind}-trigger] no recipients — skipping send`);
    return { ok: false, date, sent: 0, failed: 0, errors: ["no recipients"] };
  }
  return runAndSendReport(c, kind, date, recipients);
}

// Crons skip on Sundays + declared public holidays (kv_config['public_holidays']).
// Wei Siang's rule: "8am / 12pm only on working days — if it's a non-working
// day, don't send." Manual /send endpoints below intentionally bypass this so
// an operator can pull a report mid-Sunday from the UI if they need it.
async function cronGate(
  c: {
    env: Env["Bindings"];
    var: Env["Variables"];
    req: { header(n: string): string | undefined; json(): Promise<unknown> };
    json: <T>(body: T, status?: number) => Response;
  },
  kind: ReportKind,
): Promise<Response | null> {
  const authDenied = await authCron(c);
  if (authDenied) return authDenied;
  const skip = await nonWorkingDayReason(c);
  if (skip) {
    console.log(`[reports/${kind}-trigger] skipping — ${skip}`);
    return c.json({
      ok: true,
      skipped: true,
      reason: skip,
      sent: 0,
      failed: 0,
    });
  }
  return null;
}

internal.post("/efficiency-trigger", async (c) => {
  const gated = await cronGate(c, "efficiency");
  if (gated) return gated;
  return c.json(await dispatchReport(c, "efficiency"));
});

internal.post("/schedule-trigger", async (c) => {
  const gated = await cronGate(c, "schedule");
  if (gated) return gated;
  return c.json(await dispatchReport(c, "schedule"));
});

internal.post("/overdue-trigger", async (c) => {
  const gated = await cronGate(c, "overdue");
  if (gated) return gated;
  return c.json(await dispatchReport(c, "overdue"));
});

internal.post("/brief-trigger", async (c) => {
  const gated = await cronGate(c, "brief");
  if (gated) return gated;
  return c.json(await dispatchReport(c, "brief"));
});

// Manual send-now endpoints for schedule + overdue (parallel to /efficiency/send).
app.post("/schedule/send", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  return c.json(await dispatchReport(c, "schedule"));
});
app.post("/overdue/send", async (c) => {
  const denied = await requirePermission(c, "production-orders", "read");
  if (denied) return denied;
  return c.json(await dispatchReport(c, "overdue"));
});

// ---------------------------------------------------------------------------
// Shared engine — collect data, render HTML + text, fan-out email via Brevo.
// One switch on `kind` keeps the cron + manual-send paths DRY.
// ---------------------------------------------------------------------------

async function runAndSendReport(
  c: { env: Env["Bindings"]; var: Env["Variables"] },
  kind: ReportKind,
  date: string,
  recipients: string[],
): Promise<{
  ok: boolean;
  date: string;
  sent: number;
  failed: number;
  errors?: string[];
}> {
  const env = c.env as Env["Bindings"];
  let html: string;
  let text: string;
  let subject: string;

  if (kind === "brief") {
    // Morning Brief (Production Agent Phase 1): today's plan + CNC queue +
    // overdue + yesterday's actuals + drift + optional AI focus.
    const holidays = await loadPublicHolidays(c);
    const prev = previousWorkingDay(date, holidays);
    const data = await collectBriefData(
      c.var.DB,
      date,
      prev,
      (c.env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY,
    );
    html = renderBriefHtml(data);
    text = renderBriefEmailText(data);
    subject = `[Hookka] Production Morning Brief — ${date} (${data.overdue.totals.salesOrders} overdue · CNC ~${data.cnc.referenceDays}d)`;
  } else if (kind === "efficiency") {
    const data = await collectEfficiencyData(c.var.DB, date);
    html = renderEfficiencyHtml(data);
    text = renderEfficiencyEmailText(data);
    subject = `[Hookka] Daily Efficiency Report — ${date} (${data.totals.efficiencyPct}% overall)`;
  } else if (kind === "schedule") {
    const data = await collectScheduleData(c.var.DB, date);
    html = renderScheduleHtml(data);
    text = renderScheduleEmailText(data);
    subject = `[Hookka] Production Schedule — ${date} (${data.totals.jobCards} JC · ${data.totals.quantity} units)`;
  } else {
    const data = await collectOverdueData(c.var.DB, date);
    html = renderOverdueHtml(data);
    text = renderOverdueEmailText(data);
    subject = `[Hookka] Overdue Report — ${date} (${data.totals.salesOrders} SOs · worst ${data.totals.worstDays}d)`;
  }

  const from =
    env.RESEND_FROM_EMAIL ||
    "Hookka Manufacturing ERP <noreply@hookka.com>";
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    const r = await sendMail(env, from, { to, subject, html, text });
    if (r.ok) sent += 1;
    else {
      failed += 1;
      errors.push(`${to}: ${r.error ?? "unknown"}`);
      console.warn(
        `[reports/${kind}] send to ${to} failed: ${r.error ?? "unknown"}`,
      );
    }
  }
  return {
    ok: failed === 0,
    date,
    sent,
    failed,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

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

function parseDateParam(
  q: string | undefined,
  fallback: () => string = yesterdayYmdSgt,
): string {
  if (typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return fallback();
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
  const date = parseDateParam(c.req.query("date"));
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
  const date = parseDateParam(c.req.query("date"));
  try {
    const data = await collectEfficiencyData(c.var.DB, date);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[reports/efficiency.json] failed:", err);
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
// POST /api/internal/reports/efficiency-trigger — cron entry point.
// Auth: x-cron-secret header must match env.CRON_SECRET. No session check.
// ---------------------------------------------------------------------------

export const internal = new Hono<Env>();

type ReportKind = "efficiency" | "schedule" | "overdue";

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
  const fallback = kind === "efficiency" ? yesterdayYmdSgt : todayYmdSgt;
  const date = parseDateParam(body.date, fallback);
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

internal.post("/efficiency-trigger", async (c) => {
  const denied = await authCron(c);
  if (denied) return denied;
  return c.json(await dispatchReport(c, "efficiency"));
});

internal.post("/schedule-trigger", async (c) => {
  const denied = await authCron(c);
  if (denied) return denied;
  return c.json(await dispatchReport(c, "schedule"));
});

internal.post("/overdue-trigger", async (c) => {
  const denied = await authCron(c);
  if (denied) return denied;
  return c.json(await dispatchReport(c, "overdue"));
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

  if (kind === "efficiency") {
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
    subject = `[Hookka] Overdue Report — ${date} (${data.totals.jobCards} items · worst ${data.totals.worstDays}d)`;
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

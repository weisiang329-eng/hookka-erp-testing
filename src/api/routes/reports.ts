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

function parseDateParam(q: string | undefined): string {
  if (typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  return yesterdayYmdSgt();
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
  let body: { date?: string; to?: string | string[] } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const date = parseDateParam(body.date);
  const overrideTo = Array.isArray(body.to)
    ? body.to
    : typeof body.to === "string"
      ? body.to.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const recipients =
    overrideTo.length > 0 ? overrideTo : await resolveRecipients(c);
  if (recipients.length === 0) {
    return c.json(
      { success: false, error: "no recipients configured" },
      400,
    );
  }
  const result = await runAndSendEfficiency(c, date, recipients);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/internal/reports/efficiency-trigger — cron entry point.
// Auth: x-cron-secret header must match env.CRON_SECRET. No session check.
// ---------------------------------------------------------------------------

export const internal = new Hono<Env>();

internal.post("/efficiency-trigger", async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || expected.length < 16) {
    console.error(
      "[reports/efficiency-trigger] CRON_SECRET unset or too short — refusing",
    );
    return c.json({ ok: false, error: "service unavailable" }, 503);
  }
  const given = c.req.header("x-cron-secret") || "";
  if (!(await constantTimeEqual(given, expected))) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  let body: { date?: string; to?: string | string[] } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const date = parseDateParam(body.date);
  const overrideTo = Array.isArray(body.to)
    ? body.to
    : typeof body.to === "string"
      ? body.to.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const recipients =
    overrideTo.length > 0 ? overrideTo : await resolveRecipients(c);
  if (recipients.length === 0) {
    console.warn(
      "[reports/efficiency-trigger] no recipients — skipping send",
    );
    return c.json({ ok: false, error: "no recipients" }, 200);
  }
  const result = await runAndSendEfficiency(c, date, recipients);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Shared engine — collect data, render HTML + text, fan-out email via Brevo.
// ---------------------------------------------------------------------------

async function runAndSendEfficiency(
  c: { env: Env["Bindings"]; var: Env["Variables"] },
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
  const data = await collectEfficiencyData(c.var.DB, date);
  const html = renderEfficiencyHtml(data);
  const text = renderEfficiencyEmailText(data);
  const subject = `[Hookka] Daily Efficiency Report — ${date} (${data.totals.efficiencyPct}% overall)`;
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
        `[reports/efficiency] send to ${to} failed: ${r.error ?? "unknown"}`,
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

// ---------------------------------------------------------------------------
// fe-rum.ts — Front-End RUM event sink.
//
// Receives batched events from src/lib/fe-rum.ts and writes one
// Analytics Engine data point per event. The /admin/health dashboard
// reads them back via the GET /api/admin/health/fe-* endpoints in
// admin-health.ts.
//
// Mounted at /api/fe-rum (worker.ts). Sits BEHIND authMiddleware so
// only logged-in sessions can emit — public traffic never reaches it.
// We don't gate on SUPER_ADMIN because every user emits.
//
// AE schema (matches the consumer queries in admin-health.ts):
//
//   Errors:
//     blob1 = "fe_error"
//     blob2 = route (pathname, e.g. /sales/edit/0001)
//     blob3 = msg   (first 200 chars)
//     blob4 = stack (first 400 chars, "\n" → " | ")
//     blob5 = userId (orgId-scoped; SUPER_ADMIN can still read aggregate)
//     indexes = ["fe_error"]
//
//   Perf:
//     blob1 = "fe_perf"
//     blob2 = route (pathname)
//     blob3 = metric (longtask | lcp | fcp | nav | ttfb)
//     blob5 = userId
//     double1 = value_ms
//     indexes = ["fe_perf"]
//
// We DO NOT echo the events back in the response — RUM is fire-and-
// forget from the FE perspective. Body is `{ events: [...] }`, response
// is `{ ok: true, n: N }`.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type ErrorEv = {
  kind: "error";
  route: string;
  msg: string;
  stack: string;
  ts: number;
};
type PerfEv = {
  kind: "perf";
  route: string;
  metric: string;
  value: number;
  ts: number;
};
type AnyEv = ErrorEv | PerfEv;

// Conservative per-request cap. Matches the FE batch size; a malicious
// client trying to flood AE would hit this and get truncated.
const MAX_EVENTS_PER_BATCH = 50;

app.post("/event", async (c) => {
  let body: { events?: AnyEv[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid json" }, 400);
  }
  const events = Array.isArray(body?.events) ? body.events : [];
  const trimmed = events.slice(0, MAX_EVENTS_PER_BATCH);

  // Get the AE writer. Mirrors the pattern in observability.ts —
  // we accept the binding being absent (mock dev mode) and silently
  // no-op. No 500s for missing telemetry config.
  const ae = (c.env as unknown as {
    ERP_METRICS?: {
      writeDataPoint: (dp: {
        indexes?: string[];
        blobs?: string[];
        doubles?: number[];
      }) => void;
    };
  }).ERP_METRICS;

  // userId for per-user filtering (future drill-down). orgId is the
  // tenant marker; userId is the specific actor. Both come from the
  // auth middleware's c.set() calls.
  const userId =
    ((c as unknown as { get: (k: string) => unknown }).get("userId") as
      | string
      | undefined) ?? "";

  for (const ev of trimmed) {
    if (!ev || typeof ev !== "object") continue;
    try {
      if (ev.kind === "error") {
        const e = ev as ErrorEv;
        ae?.writeDataPoint?.({
          indexes: ["fe_error"],
          blobs: [
            "fe_error",
            String(e.route ?? "").slice(0, 200),
            String(e.msg ?? "").slice(0, 200),
            String(e.stack ?? "").slice(0, 400),
            userId.slice(0, 64),
          ],
        });
      } else if (ev.kind === "perf") {
        const p = ev as PerfEv;
        const value = Number(p.value);
        if (!Number.isFinite(value)) continue;
        ae?.writeDataPoint?.({
          indexes: ["fe_perf"],
          blobs: [
            "fe_perf",
            String(p.route ?? "").slice(0, 200),
            String(p.metric ?? "").slice(0, 32),
            "",
            userId.slice(0, 64),
          ],
          doubles: [value],
        });
      }
    } catch {
      // Best-effort — swallow AE errors so a broken telemetry binding
      // never breaks the FE.
    }
  }

  return c.json({ ok: true, n: trimmed.length });
});

export default app;

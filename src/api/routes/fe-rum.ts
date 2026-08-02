// ---------------------------------------------------------------------------
// fe-rum.ts — Front-End RUM event sink.
//
// Receives batched events from src/lib/fe-rum.ts and writes one
// Analytics Engine data point per event. The /admin/health dashboard
// reads them back via the GET /api/admin/health/fe-* endpoints in
// admin-health.ts.
//
// Mounted at /api/fe-rum (worker.ts). PUBLIC path (auth-middleware
// PUBLIC_PATHS, 2026-05-28): beacons fire even when the session is expired
// or still resolving, so gating on auth just produced 401 floods and dropped
// the error data we want. Soft-auth still attaches userId when a valid
// session is present; anonymous beacons record with empty userId. The
// MAX_EVENTS_PER_BATCH cap below is the abuse guard for the open endpoint.
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

// ---------------------------------------------------------------------------
// Known-benign front-end noise, dropped at ingestion.
//
// These are best-effort camera-constraint rejections on /worker/scan:
// focusMode and torch are unsupported on many lenses (iOS Safari especially),
// and a MediaStreamTrack goes "invalid" whenever the camera is torn down while
// a constraint call is still in flight (mode switch, tab backgrounded, scan
// ended). scan.tsx already absorbs them functionally — every applyConstraints
// carries .catch (fix 4d542343). But warehouse phones keep the scanner open
// across shifts, so a device still running a pre-fix bundle keeps emitting them
// as unhandled rejections, and no client-side change can reach a client that
// never reloads. Dropping them here, at the sink, is the only layer that works
// regardless of bundle age — and it keeps the error feed honest so a REAL
// scanner regression is not buried under this steady background hiss.
//
// Deliberately narrow: exact substrings of documented-benign messages, so a
// new/different camera error still surfaces.
const BENIGN_FE_ERROR_PATTERNS = [
  "the associated track is in an invalid state",
  "unsupported focusmode",
  "setphotooptions failed",
];

function isBenignFeError(msg: string): boolean {
  const m = msg.toLowerCase();
  return BENIGN_FE_ERROR_PATTERNS.some((p) => m.includes(p));
}

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
// Per-API-call timing (slow / failed / aborted calls only — fast successes
// are dropped client-side to keep the AE stream signal-rich). Added
// 2026-06-29 so /admin/health can answer "which user's Dashboard is stuck
// on which API call". AE schema:
//   blob1 = "fe_api"
//   blob2 = route (where on the app the call originated)
//   blob3 = endpoint (/api/path, no query)
//   blob4 = method (GET/POST/...)
//   blob5 = userId
//   blob6 = status (string — 0 means aborted/timeout)
//   double1 = duration_ms
//   indexes = ["fe_api"]
type ApiEv = {
  kind: "api";
  route: string;
  endpoint: string;
  method: string;
  status: number;
  value: number;
  ts: number;
};
// Page-stuck heartbeat — fires at 15s when a route's shell rendered but no
// API call returned 2xx. The signal everyone's been missing: "user is sitting
// on a blank loading screen and we don't even know it". AE schema:
//   blob1 = "fe_stuck"
//   blob2 = route
//   blob5 = userId
//   double1 = ms_elapsed (always 15000ish, but logged for future tuning)
//   indexes = ["fe_stuck"]
type StuckEv = {
  kind: "stuck";
  route: string;
  value: number;
  ts: number;
};
type AnyEv = ErrorEv | PerfEv | ApiEv | StuckEv;

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
        // Drop known-benign camera noise from stale scanner clients before it
        // reaches the feed (see BENIGN_FE_ERROR_PATTERNS).
        if (isBenignFeError(String(e.msg ?? ""))) continue;
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
      } else if (ev.kind === "api") {
        const a = ev as ApiEv;
        const value = Number(a.value);
        if (!Number.isFinite(value)) continue;
        ae?.writeDataPoint?.({
          indexes: ["fe_api"],
          blobs: [
            "fe_api",
            String(a.route ?? "").slice(0, 200),
            String(a.endpoint ?? "").slice(0, 200),
            String(a.method ?? "GET").slice(0, 8),
            userId.slice(0, 64),
            String(a.status ?? 0).slice(0, 8),
          ],
          doubles: [value],
        });
      } else if (ev.kind === "stuck") {
        const s = ev as StuckEv;
        const value = Number(s.value);
        if (!Number.isFinite(value)) continue;
        ae?.writeDataPoint?.({
          indexes: ["fe_stuck"],
          blobs: [
            "fe_stuck",
            String(s.route ?? "").slice(0, 200),
            "",
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

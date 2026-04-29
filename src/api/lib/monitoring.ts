// ---------------------------------------------------------------------------
// monitoring (worker) — backend error reporting facade for the Hono app
// running on Cloudflare Pages Functions.
//
// Same shape + philosophy as `src/lib/monitoring.ts` (frontend):
//   - No-op when SENTRY_DSN env var is unset/empty.
//   - When set, dynamically imports `toucan-js` (Sentry-compatible SDK
//     for Cloudflare Workers). Falls back gracefully if the package is
//     not installed — the build never breaks on a fresh clone.
//
// Usage from a Hono error handler:
//
//   app.onError((err, c) => {
//     reportWorkerError(err, c.env.SENTRY_DSN, {
//       request: c.req.url,
//       method: c.req.method,
//     });
//     return c.json({ success: false, error: "Internal error" }, 500);
//   });
//
// Sprint 5, Goal 8 — see PROGRAM-EXECUTION.md.
// ---------------------------------------------------------------------------

type ToucanLike = {
  setRequest?: (req: Request) => void;
  setExtras?: (extras: Record<string, unknown>) => void;
  captureException: (err: unknown) => void;
};

let cachedCtor: ((dsn: string) => ToucanLike) | null = null;
let resolveAttempted = false;

async function resolveToucan(): Promise<((dsn: string) => ToucanLike) | null> {
  if (resolveAttempted) return cachedCtor;
  resolveAttempted = true;
  try {
    // toucan-js exposes a default Toucan class. Dynamic import via string
    // variable keeps both the worker bundle and TypeScript resolution
    // happy when the package isn't installed (it's OPTIONAL).
    const toucanPkg = "toucan-js";
    const mod = await import(/* @vite-ignore */ toucanPkg).catch(() => null);
    if (!mod) return null;
    const Toucan = (mod as { default?: unknown }).default ?? mod;
    if (typeof Toucan !== "function") return null;
    cachedCtor = (dsn: string) =>
      new (Toucan as new (opts: { dsn: string }) => ToucanLike)({ dsn });
    return cachedCtor;
  } catch {
    return null;
  }
}

/**
 * Report a worker-side exception to Sentry/GlitchTip when a DSN is
 * configured. No-ops otherwise.
 *
 * Always logs to console.error so `wrangler tail` still surfaces the
 * error during local dev (where SENTRY_DSN is typically unset).
 */
export async function reportWorkerError(
  err: unknown,
  dsn: string | undefined,
  extras?: Record<string, unknown>,
): Promise<void> {
  // Always log — wrangler tail / Cloudflare logs are the primary signal in
  // OSS / self-host installs that don't run a Sentry instance.
  // eslint-disable-next-line no-console
  console.error("[worker]", err, extras ?? {});

  if (!dsn) return;
  const ctor = await resolveToucan();
  if (!ctor) return;

  try {
    const client = ctor(dsn);
    if (extras) client.setExtras?.(extras);
    client.captureException(err);
  } catch (reportErr) {
    // eslint-disable-next-line no-console
    console.warn("[worker/monitoring] toucan-js report failed:", reportErr);
  }
}

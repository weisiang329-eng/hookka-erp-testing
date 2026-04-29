// ---------------------------------------------------------------------------
// monitoring — frontend error reporting facade.
//
// Goals:
//   1. Capture unhandled errors + promise rejections in production so we
//      see them when a user reports "the page is broken" without needing
//      a screen-share to peer at the DevTools console.
//   2. Stay dependency-free in OSS / self-host installs that don't want a
//      Sentry/GlitchTip account. The `init()` call is a no-op when
//      `VITE_SENTRY_DSN` is unset or empty — production builds in that
//      mode ship zero error-reporting bytes.
//   3. When a DSN IS present, dynamically import `@sentry/react` so the
//      ~80KB Sentry SDK loads off the critical path. Wrap the dynamic
//      import in a try/catch — if the package isn't installed (likely on
//      a fresh clone before `npm install`), we degrade to a console-only
//      stub so the build never breaks.
//
// Sprint 5, Goal 8 — see PROGRAM-EXECUTION.md.
// ---------------------------------------------------------------------------

type SentryLike = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown, ctx?: Record<string, unknown>) => void;
  captureMessage: (msg: string, ctx?: Record<string, unknown>) => void;
  setUser: (user: { id?: string; email?: string; username?: string } | null) => void;
};

// Tiny console-only fallback used when no DSN is set or @sentry/react is
// not installed. Keeps the `import { captureException } from
// "@/lib/monitoring"` surface available in every build.
const consoleStub: SentryLike = {
  init: () => {},
  captureException: (err) => {
    // eslint-disable-next-line no-console
    console.error("[monitoring/stub] captureException:", err);
  },
  captureMessage: (msg) => {
    // eslint-disable-next-line no-console
    console.warn("[monitoring/stub] captureMessage:", msg);
  },
  setUser: () => {},
};

let activeClient: SentryLike = consoleStub;

/**
 * Initialise error reporting. Safe to call at module load time — the
 * function itself is synchronous and dispatches a fire-and-forget dynamic
 * import when a DSN is present. The dynamic import resolves to the
 * console-stub if the SDK package isn't installed.
 *
 * Call once from `src/main.tsx`, before `createRoot(...).render(...)`.
 */
export function initMonitoring(): void {
  // import.meta.env.VITE_SENTRY_DSN is statically replaced by Vite at
  // build time. Empty string / undefined → no-op path.
  const dsn =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.VITE_SENTRY_DSN as string | undefined)
      : undefined;
  if (!dsn) return;

  void (async () => {
    try {
      // Dynamic import keeps the SDK bytes out of the main chunk.
      // The package is OPTIONAL — if it's not installed we fall back
      // gracefully rather than failing the build.
      // Dynamic import via a string variable so TypeScript doesn't try to
      // resolve `@sentry/react` at compile time — the package is OPTIONAL,
      // and a fresh clone won't have it installed. Vite still recognises
      // this as a dynamic import for chunking purposes.
      const sentryPkg = "@sentry/react";
      const mod = await import(/* @vite-ignore */ sentryPkg).catch(() => null);
      if (!mod) {
        // eslint-disable-next-line no-console
        console.info(
          "[monitoring] VITE_SENTRY_DSN is set but @sentry/react is not installed; staying on the console stub.",
        );
        return;
      }
      const Sentry = mod as unknown as SentryLike & {
        BrowserTracing?: new () => unknown;
      };
      Sentry.init({
        dsn,
        // Trace 10 % of transactions in prod by default; bump via env var
        // for short-term investigations.
        tracesSampleRate: Number(import.meta.env?.VITE_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
        environment: import.meta.env?.MODE,
        // Avoid replaying any sensitive form input by default. The shop's
        // PI / customer addresses are PII; we'd rather miss a repro than
        // ship a body to a third party without an explicit opt-in.
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
      });
      activeClient = Sentry;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[monitoring] Sentry init failed; continuing on stub:", err);
    }
  })();

  // Always wire global handlers — even when the SDK isn't loaded yet,
  // captureException still no-ops via the stub. Once the SDK is ready
  // (a few hundred ms later), subsequent errors flow to Sentry.
  if (typeof window !== "undefined") {
    window.addEventListener("error", (ev) => {
      activeClient.captureException(ev.error ?? ev.message);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      activeClient.captureException(ev.reason);
    });
  }
}

export function captureException(
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  activeClient.captureException(err, ctx);
}

export function captureMessage(
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  activeClient.captureMessage(msg, ctx);
}

export function setMonitoringUser(
  user: { id?: string; email?: string; username?: string } | null,
): void {
  activeClient.setUser(user);
}

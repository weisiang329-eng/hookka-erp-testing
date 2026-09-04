import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, FlaskConical, ExternalLink, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cachedFetchJsonResult } from "@/lib/cached-fetch";

// ---------------------------------------------------------------------------
// Dashboard Prototype — a five-view dashboard (Sales & Customers, Delivery
// Orders, Inventory, Purchase Orders, Employee Performance) mounted inside the
// ERP for review.
//
// TWO OF THE FIVE VIEWS READ THE DATABASE. Sales Orders and Employees are fed
// by GET /api/dashboard/prototype. Delivery, Inventory and Purchase have no
// live source wired yet and still render the seeded sample generator — the
// page states that on each of those views rather than letting a reader assume
// all five are equally real.
//
// WHY AN IFRAME, and not a ported React page:
// the prototype carries ~1,000 lines of GLOBAL css — bare `*`, `body`,
// `h1, h2, h3`, a `:root` custom-property block, and generic class names
// (.panel, .kpi, .tab, .stack, .controls). Dropped into the SPA those collide
// with Tailwind v4's preflight and with the ERP's own `.kpi` rule in
// index.css. A separate document is complete isolation in both directions,
// exact fidelity to the reviewed design, and one file to delete when the
// prototype is retired.
//
// WHY `srcdoc`, and not `src="/dashboard-prototype.html"`:
// src/api/worker.ts sets `X-Frame-Options: DENY`, which blocks framing even
// same-origin. Whether that header actually reaches a file served out of
// public/ is UNMEASURED — the Pages Functions catch-alls cover only /api/* and
// /assets/*, so it probably does not, but "probably" is not a measurement and
// the failure mode is a blank panel in production. `srcdoc` performs no framed
// navigation at all, so the question cannot arise either way.
//
// HOW THE DATA GETS IN:
// the payload is inlined as a <script> tag ahead of the prototype's own script.
// It has to arrive BEFORE that script runs — the prototype builds its month and
// day buckets at module scope, and a postMessage landing afterwards would mean
// rebuilding state that was already derived. Injecting into the document the
// frame is created from removes the ordering problem entirely.
// ---------------------------------------------------------------------------

const FEED_URL = "/api/dashboard/prototype";

type Availability = { live: boolean; reason?: string };
type Feed = {
  success?: boolean;
  meta?: {
    orgId?: string;
    generatedAt?: string;
    months?: string[];
    config?: { efficiencyTargetPct?: number; workingHoursPerDay?: number };
  };
  availability?: Record<string, Availability>;
};

export default function DashboardPrototypePage() {
  const [shell, setShell] = useState<string | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedFailed, setFeedFailed] = useState(false);
  const [shellFailed, setShellFailed] = useState(false);
  const [frameHeight, setFrameHeight] = useState(600);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const standaloneUrlRef = useRef<string | null>(null);

  // ~280KB of markup, kept out of the main bundle by the dynamic import —
  // the same ?raw pattern src/pages/admin/health.tsx uses for BUG-HISTORY.md.
  useEffect(() => {
    let alive = true;
    import("./dashboard-prototype.html?raw")
      .then((mod) => alive && setShell(mod.default))
      .catch(() => alive && setShellFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    cachedFetchJsonResult<Feed>(FEED_URL)
      .then((res) => {
        if (!alive) return;
        if (res.ok && res.data?.success) setFeed(res.data);
        else setFeedFailed(true);
      })
      .catch(() => alive && setFeedFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // The document the frame is built from. Rebuilt only when one of its two
  // inputs changes, because assigning srcdoc reloads the frame and throws away
  // whatever month or employee the reviewer had selected.
  const doc = useMemo(() => {
    if (!shell) return null;
    if (!feed) return shell; // sample mode: the prototype's own fallback
    // JSON is inlined into a <script>, so the one sequence that could end that
    // element early has to be neutralised. `<` is escaped rather than `</script`
    // specifically: it also covers `<!--`, which legacy HTML parsing treats as
    // a comment opener inside a script and which would swallow the payload.
    const json = JSON.stringify(feed).replace(/</g, "\\u003c");
    return shell.replace(
      "<script>",
      `<script>window.__HOOKKA_REAL__=${json};</script>\n<script>`,
    );
  }, [shell, feed]);

  // The frame is sized to its OWN content height, reported by the prototype
  // itself via postMessage (see the ResizeObserver script at the bottom of
  // dashboard-prototype.html) — not clamped to whatever's left in the
  // viewport. Clamping made the report grow its own internal scrollbar the
  // moment content exceeded that box: a page-inside-a-page, instead of this
  // page scrolling as one normal flow like the rest of the app. Reset to a
  // sane default on every new `doc` (tab/theme reload) so a stale tall
  // height doesn't linger under shorter content until the next report.
  useEffect(() => {
    setFrameHeight(600);
  }, [doc]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const el = frameRef.current;
      if (!el || event.source !== el.contentWindow) return;
      const data = event.data as { source?: string; height?: number } | null;
      if (data?.source !== "hookka-dashboard-prototype" || typeof data.height !== "number") return;
      setFrameHeight(Math.max(400, Math.ceil(data.height)));
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // A blob: URL rather than document.write into "" — that left the tab on
  // "about:blank" forever, so hitting refresh (or a browser restoring the
  // tab) reloaded literal about:blank and threw the whole report away. A
  // blob URL is a real, reloadable address: the browser holds the content
  // by that URL until it's revoked, so refresh re-renders the identical
  // document instead of going blank. Revoke the PREVIOUS one (not this one)
  // before minting a new one — revoking immediately would break refresh on
  // whichever tab is still open showing it; this only leaks one extra blob
  // between clicks, cleaned up on the next click or on unmount.
  const openStandalone = () => {
    if (!doc) return;
    if (standaloneUrlRef.current) URL.revokeObjectURL(standaloneUrlRef.current);
    // charset=utf-8 explicit: a blob has no HTTP Content-Type header to fall
    // back on, so without either this or the shell's own <meta charset>, the
    // browser has to guess the encoding — and guessed Windows-1252 for a
    // mostly-ASCII document with occasional UTF-8 multibyte punctuation
    // (em dash, middot, curly quotes), turning every one of them into "Â·"
    // / "â€"" garbage. Both are now set; this one is belt-and-suspenders.
    const url = URL.createObjectURL(new Blob([doc], { type: "text/html;charset=utf-8" }));
    standaloneUrlRef.current = url;
    window.open(url, "_blank");
  };

  useEffect(() => {
    return () => {
      if (standaloneUrlRef.current) URL.revokeObjectURL(standaloneUrlRef.current);
    };
  }, []);

  const live = !!feed;
  const sampleViews = feed?.availability
    ? Object.entries(feed.availability)
        .filter(([, v]) => !v.live)
        .map(([k]) => k)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-raisin">
            <FlaskConical className="h-5 w-5 text-taupe" />
            Dashboard Prototype
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-text-secondary">
            A design prototype of the reporting dashboard. Sales Orders and
            Employees read the live database; Delivery, Inventory and Purchase
            Orders are still sample data and are labelled as such inside.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {live ? (
            <Badge className="border border-accent-green bg-transparent text-accent-green">
              Live · Sales + Employees
            </Badge>
          ) : (
            <Badge className="border border-accent-amber bg-transparent text-accent-amber">
              Sample data — not live
            </Badge>
          )}
          <button
            type="button"
            onClick={openStandalone}
            disabled={!doc}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:bg-taupe-10 hover:text-raisin disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open full screen
          </button>
        </div>
      </div>

      {/* Stated once at the top as well as inside the frame. Someone who
          screenshots the page header and nothing else should still not be able
          to mistake the sample views for reports. */}
      {live && sampleViews.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-3 py-2 text-sm text-text-secondary">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-accent-amber" />
          <span>
            <strong className="text-raisin">{sampleViews.join(", ")}</strong>{" "}
            {sampleViews.length === 1 ? "is" : "are"} still showing generated
            sample figures — no live source is wired for{" "}
            {sampleViews.length === 1 ? "it" : "them"} yet.
          </span>
        </div>
      )}
      {feedFailed && (
        <div className="flex items-start gap-2 rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-3 py-2 text-sm text-text-secondary">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-accent-amber" />
          <span>
            The live feed could not be read, so <strong>every</strong> view below
            is sample data. Reload to try again.
          </span>
        </div>
      )}

      {shellFailed ? (
        <div className="rounded-lg border border-border bg-white p-8 text-center text-sm text-text-secondary">
          The prototype could not be loaded. Reload the page to try again.
        </div>
      ) : !doc ? (
        <div className="flex h-64 items-center justify-center rounded-lg border border-border bg-white">
          <Loader2 className="h-5 w-5 animate-spin text-taupe" />
          <span className="ml-2 text-sm text-text-secondary">
            Loading prototype…
          </span>
        </div>
      ) : (
        <iframe
          ref={frameRef}
          srcDoc={doc}
          title="Dashboard prototype"
          // No allow-same-origin: the frame is handed its data up front and
          // needs no access to the app's origin, storage or cookies. Withholding
          // it means a bug in there can never reach anything out here.
          sandbox="allow-scripts"
          style={{ height: frameHeight }}
          className="w-full rounded-lg border border-border bg-white"
        />
      )}
    </div>
  );
}

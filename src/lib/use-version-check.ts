// useVersionCheck — detect when a new deploy lands while the SPA is open.
//
// How it works:
//   1. The running bundle knows its deterministic SemVer/channel/SHA identity.
//   2. Every `intervalMs`, refetch `/version.json` past the CDN.
//   3. When the release ID differs, call `onNewVersion` exactly once. The
//      dashboard offers a reload rather than discarding an in-progress form.
//   4. During partial CDN propagation, fall back to comparing the first Vite
//      script hash in index.html so older deployments still self-update.

import { useEffect, useRef } from "react";
import { RELEASE } from "./release";

function extractFirstScriptHash(html: string): string | null {
  // Matches <script src="/assets/index-<hash>.js"> — both the entry and
  // any preloaded module (whichever comes first).
  const m = html.match(/<script[^>]+src="[^"]*\/assets\/([^"]+)"/);
  return m ? m[1] : null;
}

export function parseReleaseId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const releaseId = (value as { releaseId?: unknown }).releaseId;
  return typeof releaseId === "string" && releaseId.length > 0 ? releaseId : null;
}

export function useVersionCheck({
  intervalMs = 5 * 60 * 1000, // 5 min
  onNewVersion,
}: {
  intervalMs?: number;
  onNewVersion: () => void;
}) {
  const baselineRef = useRef<string | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    // Capture the baseline hash from the page that's currently running.
    const existing = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[src*="/assets/"]'),
    )
      .map((s) => {
        const m = s.src.match(/\/assets\/([^"?]+)/);
        return m ? m[1] : null;
      })
      .find((v) => Boolean(v)) as string | null;
    baselineRef.current = existing;

    let stopped = false;
    const check = async () => {
      if (stopped || firedRef.current) return;
      if (document.hidden) return;
      try {
        // The emitted manifest carries SemVer + channel + exact commit SHA.
        // It is easier to correlate with deploys than an opaque chunk hash.
        const manifestRes = await fetch(
          `/version.json?v=${encodeURIComponent(RELEASE.releaseId)}`,
          {
            cache: "no-store",
            credentials: "same-origin",
          },
        );
        if (manifestRes.ok) {
          let currentReleaseId: string | null = null;
          try {
            currentReleaseId = parseReleaseId(await manifestRes.json());
          } catch {
            // Cloudflare's SPA fallback can briefly return index.html with a
            // 200 for a not-yet-propagated manifest. Use the asset fallback.
          }
          if (currentReleaseId && currentReleaseId !== RELEASE.releaseId) {
            firedRef.current = true;
            onNewVersion();
          }
          if (currentReleaseId) return;
        }

        // Compatibility fallback for a partially propagated deploy where the
        // new manifest is temporarily unavailable but index.html is live.
        const res = await fetch(`/?v=${Date.now()}`, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const html = await res.text();
        const current = extractFirstScriptHash(html);
        if (current && baselineRef.current && current !== baselineRef.current) {
          firedRef.current = true;
          onNewVersion();
        }
      } catch {
        // Network hiccup is fine — try again next interval.
      }
    };

    const id = window.setInterval(check, intervalMs);
    // Also check when the tab regains focus (user came back after a while).
    const onFocus = () => { void check(); };
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    // First quick check 30s after mount — don't wait the full interval on
    // the very first load.
    const firstId = window.setTimeout(check, 30_000);

    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearTimeout(firstId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, onNewVersion]);
}

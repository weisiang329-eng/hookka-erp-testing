// ---------------------------------------------------------------------------
// Robust clipboard copy with HTTP-safe fallbacks.
//
// `navigator.clipboard.writeText()` only works in **secure contexts**
// (HTTPS or localhost). When the page is served over plain HTTP — or
// when a permissions policy / sandbox blocks it — the modern API throws
// silently, and the user sees a click that does nothing.
//
// Strategy:
//   1. Try the modern Clipboard API.
//   2. Fall back to the legacy `document.execCommand('copy')` via a
//      temporary off-screen textarea. Deprecated, but still implemented
//      by every shipping browser and works on plain HTTP.
//   3. If both fail, return `{ ok: false, manual: true }` so the caller
//      can render a manual-copy modal (selectable text input).
//
// Returns:
//   - `{ ok: true }`   — copied to clipboard, no UI needed.
//   - `{ ok: false, manual: true }` — caller should show a manual-copy UI
//     with the text pre-selected.
// ---------------------------------------------------------------------------

export type CopyResult = { ok: true } | { ok: false; manual: true };

export async function copyText(text: string): Promise<CopyResult> {
  // --- Strategy 1: modern Clipboard API (secure context only) ---------
  // Optional-chain because Clipboard isn't defined in some embedded
  // WebViews. Wrap in try/catch because the browser may reject if the
  // document isn't focused or the permissions policy denies write.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      // Fall through to legacy path.
    }
  }

  // --- Strategy 2: legacy execCommand via off-screen textarea ---------
  // The textarea must be IN the DOM and selected for `copy` to find a
  // selection range. We hide it offscreen rather than display:none
  // because some browsers refuse to select hidden inputs.
  if (typeof document !== "undefined" && document.body) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      // execCommand is deprecated but still the only HTTP-safe path.
      // eslint-disable-next-line no-restricted-syntax -- legacy fallback for non-secure contexts
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return { ok: true };
    } catch {
      // Fall through to manual-copy fallback.
    }
  }

  // --- Strategy 3: surrender, ask the caller to render a manual UI ----
  return { ok: false, manual: true };
}

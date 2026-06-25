// ---------------------------------------------------------------------------
// app-origin.ts — canonical origin for anything we BAKE INTO a QR / printed
// link / sticker.
//
// QR + sticker URLs encode `window.location.origin` (FE) or the request origin
// (server) — i.e. whatever domain you PRINTED from. Production is reachable on
// BOTH the official custom domain `erp.hookka.com` AND the legacy Cloudflare
// fallback `hookka-erp-testing.pages.dev` (same site, same DB). Owner 2026-06-26:
// the "ERP testing" pages.dev domain is the OLD one — wherever we can, show
// `erp.hookka.com` instead ("比较好看").
//
// So: canonicalize ONLY the prod fallback host → the custom domain. Staging
// (`staging.…pages.dev`), preview (`<hash>.…pages.dev`), erp.hookka.com itself,
// and localhost are LEFT AS-IS — their QRs must keep pointing at their own
// site/DB or an external phone scan would open the wrong environment. Scanning
// stays path-based + domain-agnostic, so existing pages.dev stickers keep
// resolving regardless.
// ---------------------------------------------------------------------------

const PROD_FALLBACK_HOST = "hookka-erp-testing.pages.dev";
const PROD_CANONICAL_ORIGIN = "https://erp.hookka.com";

/**
 * Map the legacy prod fallback origin to the official custom domain; return
 * every other origin (staging / preview / custom domain / localhost) unchanged.
 * Pure (takes the origin string) so the server can use it too.
 */
export function canonicalizeOrigin(origin: string): string {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === PROD_FALLBACK_HOST) return PROD_CANONICAL_ORIGIN;
    return origin;
  } catch {
    return origin;
  }
}

/**
 * FE convenience: the canonical origin to bake into a QR / printed link from
 * the browser. Empty string in non-browser contexts.
 */
export function appOrigin(): string {
  if (typeof window === "undefined" || !window.location?.origin) return "";
  return canonicalizeOrigin(window.location.origin);
}

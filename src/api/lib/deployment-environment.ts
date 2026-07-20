const PRODUCTION_PAGES_HOST = "hookka-erp-testing.pages.dev";

function hostname(requestUrl: string): string | null {
  try {
    return new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Cloudflare Pages preview/branch deployments cannot override the top-level
 * wrangler ENVIRONMENT variable reliably. The request hostname is therefore
 * the authoritative signal used by both database routing and observability.
 */
export function isPreviewHostname(requestUrl: string): boolean {
  const host = hostname(requestUrl);
  if (!host || host === PRODUCTION_PAGES_HOST) return false;
  return host.endsWith(`.${PRODUCTION_PAGES_HOST}`);
}

export function runtimeEnvironment(
  requestUrl: string,
  configuredEnvironment?: string,
): string {
  if (isPreviewHostname(requestUrl)) return "staging";
  return configuredEnvironment?.trim() || "production";
}

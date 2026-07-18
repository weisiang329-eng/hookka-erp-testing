// ---------------------------------------------------------------------------
// native/index.ts — the bridge between the existing web app and the iOS shell.
//
// Hookka ships TWO installable apps from this one codebase (see
// public/manifest.webmanifest and public/manifest-erp.webmanifest):
//   • Hookka Worker Portal  → /worker  (shop floor: punch, scan job cards, pay)
//   • Hookka ERP            → /m       (office mobile)
// Both are being wrapped in a Capacitor iOS shell for the App Store.
//
// DESIGN RULE — the web app must not notice this exists.
// There is deliberately NO `import` of @capacitor/*` anywhere in src/. Capacitor
// injects a `window.Capacitor` bridge at runtime inside the native shell, so we
// feature-detect that global instead of taking a dependency. Consequences:
//   1. `package.json` gains nothing; the Vite bundle is byte-identical for web.
//   2. Every helper below is SAFE to call in a plain browser — it returns
//      null/false so callers fall through to the existing web implementation.
//   3. No build flag, no separate entry point, no forked components.
// This is the additive rule applied to a whole platform: the native app ADDS
// capability, it never replaces the path that already works in Safari/Chrome.
//
// Plugins are addressed by name off the bridge rather than imported, so a plugin
// that is not installed in a given app target simply reports unavailable instead
// of failing the bundle.
// ---------------------------------------------------------------------------

/** Which of the two apps this shell was built as. Set in capacitor.*.config.ts. */
export type HookkaAppId = "worker" | "erp";

type PluginCall = (...args: unknown[]) => Promise<unknown>;
type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, Record<string, PluginCall> | undefined>;
};

function bridge(): CapacitorBridge | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return cap ?? null;
}

/**
 * True only inside the Capacitor iOS/Android shell. False in every browser,
 * including an installed PWA — an installed PWA still runs the web paths, which
 * is exactly what we want (it keeps working with no app-store dependency).
 */
export function isNativeApp(): boolean {
  const cap = bridge();
  try {
    return typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : false;
  } catch {
    return false;
  }
}

/** "ios" | "android" | "web". Cheap enough to call in a render. */
export function nativePlatform(): string {
  const cap = bridge();
  try {
    return typeof cap?.getPlatform === "function" ? cap.getPlatform() : "web";
  } catch {
    return "web";
  }
}

/** True on the real iOS app (not iOS Safari). */
export function isIosApp(): boolean {
  return isNativeApp() && nativePlatform() === "ios";
}

/**
 * Which app this build is. Read from a global the native shell injects
 * (see the two capacitor configs). Defaults by URL so the helper is still
 * meaningful on the web, where /worker and /m are the same two surfaces.
 */
export function hookkaAppId(): HookkaAppId {
  const injected = (window as unknown as { __HOOKKA_APP__?: string }).__HOOKKA_APP__;
  if (injected === "worker" || injected === "erp") return injected;
  if (typeof location !== "undefined" && location.pathname.startsWith("/worker")) return "worker";
  return "erp";
}

/**
 * Fetch a plugin's method table, or null when the plugin isn't present.
 * Never throws — an absent plugin is a normal, expected state on web.
 */
export function plugin(name: string): Record<string, PluginCall> | null {
  const p = bridge()?.Plugins?.[name];
  return p && typeof p === "object" ? p : null;
}

/**
 * Call a plugin method defensively. Returns null when the plugin/method is
 * missing OR the call rejects (e.g. the user denied a permission), so callers
 * can treat "no native result" as one branch instead of wrapping every call in
 * its own try/catch. Real errors are logged, never surfaced as a crash — a
 * factory phone must not lose a punch because a plugin misbehaved.
 */
export async function callPlugin<T = unknown>(
  pluginName: string,
  method: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const p = plugin(pluginName);
  const fn = p?.[method];
  if (typeof fn !== "function") return null;
  try {
    return (await fn(args ?? {})) as T;
  } catch (err) {
    console.warn(`[native] ${pluginName}.${method} failed:`, err);
    return null;
  }
}

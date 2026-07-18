// ---------------------------------------------------------------------------
// native/scanner.ts — native QR/barcode scan, with the web path left intact.
//
// The web scanner (src/pages/m/components/ScanSheet.tsx and the worker portal's
// /worker/scan) decodes with jsQR over a getUserMedia preview. That works, but
// on a phone it is noticeably slower than the platform decoder and it holds a
// full-rate video loop on the main thread — which matters on the shop floor,
// where a worker scans dozens of job cards in a row.
//
// Inside the iOS shell we hand the job to the native scanner instead. Outside
// it, `scanBarcode()` returns { available: false } and the caller keeps using
// the existing overlay — unchanged, untouched, still the only path in Safari.
//
// Contract deliberately matches what ScanSheet already emits: the decoded
// STRING (typically a `${origin}/m/<slug>/<id>` or job-card URL), so a caller
// can swap in the native result without changing its routing logic.
// ---------------------------------------------------------------------------
import { callPlugin, isNativeApp, plugin } from "./index";

const PLUGIN = "BarcodeScanner";

export type ScanOutcome =
  /** Native scanning isn't available — caller must fall back to the web overlay. */
  | { available: false }
  /** Native scan ran. `value` is null when the user cancelled or denied camera. */
  | { available: true; value: string | null };

/** True when the native scanner plugin is present (iOS/Android shell only). */
export function hasNativeScanner(): boolean {
  return isNativeApp() && plugin(PLUGIN) !== null;
}

/**
 * Ask for camera permission, if the plugin exposes that API.
 * Returns true when scanning may proceed. A plugin without an explicit
 * permission API is assumed to prompt on first scan (iOS does this itself when
 * NSCameraUsageDescription is present), so we optimistically return true.
 */
async function ensureCameraPermission(): Promise<boolean> {
  const p = plugin(PLUGIN);
  if (!p) return false;
  if (typeof p.checkPermissions !== "function") return true;

  const checked = await callPlugin<{ camera?: string }>(PLUGIN, "checkPermissions");
  const state = checked?.camera;
  if (state === "granted" || state === "limited") return true;

  if (typeof p.requestPermissions === "function") {
    const asked = await callPlugin<{ camera?: string }>(PLUGIN, "requestPermissions");
    const after = asked?.camera;
    return after === "granted" || after === "limited";
  }
  return false;
}

/**
 * Run one native scan. Resolves when the user scans something, cancels, or
 * denies the camera — it never rejects, so a scan failure can't break a punch
 * or a job-card lookup.
 *
 * Usage keeps the web path as the default branch:
 *
 *   const r = await scanBarcode();
 *   if (!r.available) { setScanSheetOpen(true); return; }   // existing overlay
 *   if (r.value) handleScanned(r.value);
 */
export async function scanBarcode(): Promise<ScanOutcome> {
  if (!hasNativeScanner()) return { available: false };

  const permitted = await ensureCameraPermission();
  if (!permitted) return { available: true, value: null };

  // capacitor-mlkit exposes `scan()` returning { barcodes: [{ rawValue }] };
  // the community plugin exposes `startScan()` returning { hasContent, content }.
  // Support both so the app target can swap plugins without touching callers.
  const p = plugin(PLUGIN);

  if (typeof p?.scan === "function") {
    const res = await callPlugin<{ barcodes?: Array<{ rawValue?: string; displayValue?: string }> }>(
      PLUGIN,
      "scan",
    );
    const first = res?.barcodes?.[0];
    const value = first?.rawValue ?? first?.displayValue ?? null;
    return { available: true, value: value || null };
  }

  if (typeof p?.startScan === "function") {
    const res = await callPlugin<{ hasContent?: boolean; content?: string }>(PLUGIN, "startScan");
    const value = res?.hasContent ? (res.content ?? null) : null;
    return { available: true, value: value || null };
  }

  return { available: false };
}

/**
 * Stop an in-flight scan (the community plugin makes the webview transparent
 * during scanning, so an unmounting screen must call this). No-op when the
 * plugin doesn't need it.
 */
export async function stopScan(): Promise<void> {
  if (!hasNativeScanner()) return;
  await callPlugin(PLUGIN, "stopScan");
}

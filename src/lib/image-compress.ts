// ---------------------------------------------------------------------------
// image-compress — off-main-thread photo compression for POD / service-case
// uploads.
//
// The legacy path (`FileReader.readAsDataURL` → `<img>` decode →
// `canvas.drawImage` → `canvas.toDataURL`) does ALL of decode, scale, and
// encode on the JS main thread. On a low-end Android phone over 4G, five
// 10 MB photos sequentially freezes the UI for 3-8 seconds — long enough for
// the page to feel broken and the user to back out.
//
// Modern browsers expose two APIs that move the work off the main thread:
//   - `createImageBitmap(file, { resizeWidth, resizeQuality })` — decodes
//     and downscales in a worker pool, returning an ImageBitmap.
//   - `OffscreenCanvas.convertToBlob({ type, quality })` — encodes JPEG
//     off-thread, returning a Blob.
//
// Together they let the main thread stay interactive while the photo is
// being processed. The fallback path (Safari < 16.4, ancient Android) uses
// the original FileReader/canvas pipeline so we never break uploads.
//
// Sprint 5, Goal 1 — see PROGRAM-EXECUTION.md.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DIMENSION = 1280;
const DEFAULT_JPEG_QUALITY = 0.85;

export type CompressOptions = {
  /** Longest side, in pixels, after resize. Defaults to 1280. */
  maxDim?: number;
  /** JPEG encoder quality, 0..1. Defaults to 0.85. */
  quality?: number;
};

function offscreenSupported(): boolean {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap !== "undefined" &&
    // Safari 16.4+ added convertToBlob; older Safari has OffscreenCanvas
    // only as a stub. Feature-test the actual method.
    "convertToBlob" in OffscreenCanvas.prototype
  );
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Failed to read encoded blob"));
    r.readAsDataURL(blob);
  });
}

/**
 * Off-main-thread compression path. Uses `createImageBitmap` (which decodes
 * + downscales in a worker pool) and `OffscreenCanvas.convertToBlob` (which
 * encodes JPEG off-thread). The main thread only spends time on the final
 * Blob → data URL step.
 */
async function compressOffscreen(
  file: File,
  maxDim: number,
  quality: number,
): Promise<string> {
  // First decode at full size to read dimensions. We can't pass resizeWidth
  // unconditionally because it forces width regardless of orientation, and
  // we want to constrain the LONGEST side.
  const probe = await createImageBitmap(file);
  const longest = Math.max(probe.width, probe.height);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const targetW = Math.max(1, Math.round(probe.width * scale));
  const targetH = Math.max(1, Math.round(probe.height * scale));
  probe.close();

  // Re-decode at the target size. This is what actually moves heavy lifting
  // off the main thread on Chromium / Firefox.
  const bitmap = await createImageBitmap(file, {
    resizeWidth: targetW,
    resizeHeight: targetH,
    resizeQuality: "medium",
  });

  try {
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality,
    });
    return await blobToDataUrl(blob);
  } finally {
    bitmap.close();
  }
}

/**
 * Legacy main-thread fallback. Identical to the original inline function
 * that used to live in POD-dialog / service-cases — kept here so older
 * browsers still work (Safari < 16.4, very old Android WebView).
 */
async function compressLegacy(
  file: File,
  maxDim: number,
  quality: number,
): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("Failed to read file"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Failed to decode image"));
    i.src = dataUrl;
  });
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Compress an image file to a JPEG data URL, preferring off-main-thread APIs.
 *
 * - On modern browsers: decode + resize + encode happen on a worker pool;
 *   main thread only blocks on the final base64 conversion.
 * - On older browsers: falls back to the synchronous FileReader/canvas path.
 * - Throws if the file is not a decodable image.
 *
 * @example
 *   const dataUrl = await compressImage(file, { maxDim: 1280, quality: 0.7 });
 */
export async function compressImage(
  file: File,
  opts: CompressOptions = {},
): Promise<string> {
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIMENSION;
  const quality = opts.quality ?? DEFAULT_JPEG_QUALITY;

  if (offscreenSupported()) {
    try {
      return await compressOffscreen(file, maxDim, quality);
    } catch (err) {
      // Fall through to legacy on any unexpected OffscreenCanvas failure
      // (some Android WebView builds expose the API but throw on
      // convertToBlob for HEIC inputs).
      // eslint-disable-next-line no-console
      console.warn("[compressImage] off-thread path failed, falling back:", err);
    }
  }
  return compressLegacy(file, maxDim, quality);
}

/**
 * Return true if the browser supports the off-main-thread compression path.
 * UI may use this to decide whether to show progress spinners (the legacy
 * path runs synchronously enough that a spinner just flashes).
 */
export function supportsOffscreenCompress(): boolean {
  return offscreenSupported();
}

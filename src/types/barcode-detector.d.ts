// Ambient typing for the native Barcode Detection API.
//
// Android Chrome (and Chromium-based Android browsers) ship a built-in,
// hardware-accelerated barcode/QR detector under `window.BarcodeDetector`.
// It locks onto small, angled, or slightly-blurred QR stickers far more
// reliably than the pure-JS jsQR fallback we use on iOS Safari (which has
// no native detector). TypeScript's lib.dom doesn't declare it yet, so we
// declare just the slice we call from the worker scan page.
//
// All usage is feature-detected at runtime (`"BarcodeDetector" in window`),
// so the optional `window.BarcodeDetector` here is the correct shape.

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

interface Window {
  BarcodeDetector?: BarcodeDetectorConstructor;
}

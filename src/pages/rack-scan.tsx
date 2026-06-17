// Public rack stock-in page — opened by warehouse staff scanning the QR
// printed on a physical rack (/r/<rackId>). Intentionally standalone (no
// dashboard / worker-portal chrome), mobile-first, NO LOGIN — the rack id in
// the URL is the entry point, and the backend (/api/public/rack-qr) only
// performs the one forward action (stock items INTO this rack) the office
// rack-overview page already allows. Mirrors the public /d/:token DO-scan
// page's mounting + visual style.
//
// Flow:
//   1. On mount, GET the rack summary (label + current item count).
//   2. Open an in-page camera scanner. Each decoded ITEM QR is looked up via
//      the backend; a recognised item is added to a local list (qty bumps on a
//      re-scan of the same sticker). An item that's currently in a DIFFERENT
//      rack prompts Move-here / Skip; an item already in THIS rack just adds.
//   3. Tap the big "Stock In (N)" button (two-tap arm→confirm, like DO-scan) to
//      POST the list. On success the list clears; on error it's kept for retry.
//
// The camera loop is a trimmed copy of /worker/scan's: getUserMedia → a RAF
// tick that feeds frames to the phone's native BarcodeDetector when present,
// else jsQR (QR) + a lazily dynamic-imported ZXing decoder (QR + Code 128).
// No auto-zoom (kept simple); an optional torch toggle where the lens supports
// it. The barcode ROI keeps the ~0.20 height-band invariant from the worker
// page — a taller band breaks Code 128 decoding.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertTriangle,
  Boxes,
  Camera,
  CheckCircle2,
  Flashlight,
  PackageCheck,
  Trash2,
  X,
} from "lucide-react";
import jsQR from "jsqr";
import { csrfHeaders } from "@/lib/csrf";

// ── Backend shapes (API contract — see routes/public-rack-qr.ts) ──────────
type RackSummary = { rackId: string; rackLabel: string; itemCount: number };

type ItemLookup = {
  found: boolean;
  productionOrderId: string | null;
  productName: string | null;
  poNo: string | null;
  // When set AND different from the scanned rack, the item currently lives in
  // another rack — the UI offers Move-here / Skip before adding the line.
  currentRackId: string | null;
  currentRackLabel: string | null;
};

// One accumulated stock-in line. `productionOrderId` is the dedupe key for
// system items; manual / null-PO items dedupe by productName instead.
type Line = {
  productionOrderId: string | null;
  productName: string;
  poNo: string | null;
  qty: number;
};

// An item found in a DIFFERENT rack, parked until the user taps Move / Skip.
type PendingMove = {
  line: Line;
  currentRackLabel: string;
};

// ── Camera scanner (trimmed copy of /worker/scan) ─────────────────────────
// Decode-mode toggle: "qr" reads a square sticker full-frame; "barcode" draws a
// wide, short reticle and decodes ONLY the row centred in that band so stacked
// Code 128 rows don't all fire. The 0.20 ROI-height band is a known invariant —
// a too-tall band breaks Code 128 decoding (see worker/scan.tsx).
type ScanMode = "qr" | "barcode";

export default function RackScanPage() {
  const { rackId } = useParams();

  // ── Rack summary (mount fetch) ───────────────────────────────────────────
  const [summary, setSummary] = useState<RackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Accumulated stock-in list ────────────────────────────────────────────
  const [lines, setLines] = useState<Line[]>([]);
  // The cross-rack Move/Skip prompt for the most recent ambiguous scan.
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  // Transient one-line scan feedback (recognised / not-recognised / bumped).
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  // ── Stock-in submit (two-tap arm→confirm, like DO-scan) ──────────────────
  const [armed, setArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  // ── Camera state ─────────────────────────────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>("qr");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // ZXing decoder (QR + Code 128) for the no-BarcodeDetector path (iOS Safari).
  // Lazily dynamic-imported on first scan; null until ready (jsQR carries QR).
  const zxingRef = useRef<((img: ImageData) => string | null) | null>(null);
  const zxingLoadingRef = useRef<Promise<void> | null>(null);
  // De-dupe the decode→lookup pipeline: a single sticker held in frame fires
  // many frames; remember the last raw value + when, so we don't spam the
  // backend or double-count. A different value, or the same value after a short
  // cooldown, is allowed through.
  const lastRawRef = useRef<{ value: string; at: number }>({ value: "", at: 0 });
  // A lookup is in flight — gate the loop so frames don't pile up requests.
  const lookupBusyRef = useRef(false);
  // scanMode mirrored to a ref so the long-lived tick loop reads the current
  // mode without being torn down on every toggle (the effect still re-runs on
  // scanMode to swap the reticle, but the closure stays in sync regardless).
  const scanModeRef = useRef<ScanMode>(scanMode);
  useEffect(() => {
    scanModeRef.current = scanMode;
  }, [scanMode]);

  const ensureZxing = useCallback((): Promise<void> => {
    if (zxingRef.current) return Promise.resolve();
    if (zxingLoadingRef.current) return zxingLoadingRef.current;
    zxingLoadingRef.current = import("@zxing/library")
      .then((zx) => {
        const reader = new zx.MultiFormatReader();
        const hints = new Map<number, unknown>();
        hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
          zx.BarcodeFormat.QR_CODE,
          zx.BarcodeFormat.CODE_128,
        ]);
        hints.set(zx.DecodeHintType.TRY_HARDER, true);
        reader.setHints(hints);
        zxingRef.current = (img: ImageData) => {
          // RGBA → BT.601 luma (RGBLuminanceSource wants precomputed luminance).
          const { data, width, height } = img;
          const gray = new Uint8ClampedArray(width * height);
          for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
            gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
          }
          try {
            const res = reader.decodeWithState(
              new zx.BinaryBitmap(
                new zx.HybridBinarizer(
                  new zx.RGBLuminanceSource(gray, width, height),
                ),
              ),
            );
            return res ? res.getText() : null;
          } catch {
            return null; // NotFoundException — no code in this frame
          }
        };
      })
      .catch(() => {
        // Load failed — leave jsQR (QR-only) as the fallback; retry next call.
        zxingLoadingRef.current = null;
      });
    return zxingLoadingRef.current;
  }, []);

  // ── Mount: load the rack summary ─────────────────────────────────────────
  // No synchronous setState before the first await — `loading` starts true and
  // every write lands in the async continuation (react-hooks/set-state-in-effect),
  // matching the do-scan page's mount pattern.
  const load = useCallback(async () => {
    if (!rackId) return;
    try {
      const r = await fetch(
        `/api/public/rack-qr/${encodeURIComponent(rackId)}`,
        { cache: "no-store" },
      );
      setLoadError(null);
      const j = (await r.json().catch(() => ({}))) as Partial<RackSummary> & {
        error?: string;
      };
      if (!r.ok || !j.rackId) {
        setSummary(null);
        setLoadError(
          j.error ||
            "Rack not found. Please ask the Hookka office for a freshly printed rack QR.",
        );
      } else {
        setSummary({
          rackId: j.rackId,
          rackLabel: j.rackLabel || j.rackId,
          itemCount: j.itemCount ?? 0,
        });
      }
    } catch {
      setSummary(null);
      setLoadError("Network error. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [rackId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount (public page, no session deps); same pattern as do-scan.tsx
    void load();
  }, [load]);

  // ── List mutation helpers ────────────────────────────────────────────────
  // Add a found item, bumping qty when it's already in the list. Dedupe by
  // productionOrderId for system items; by productName for manual / null-PO ones.
  const addLine = useCallback((line: Line) => {
    setDoneMsg(null);
    setLines((prev) => {
      const next = [...prev];
      const i = next.findIndex((x) =>
        line.productionOrderId
          ? x.productionOrderId === line.productionOrderId
          : x.productionOrderId === null && x.productName === line.productName,
      );
      if (i >= 0) {
        next[i] = { ...next[i], qty: next[i].qty + 1 };
      } else {
        next.push({ ...line, qty: 1 });
      }
      return next;
    });
  }, []);

  // ── Decode → item lookup ─────────────────────────────────────────────────
  // Each decoded raw code is looked up against the backend item endpoint. The
  // raw string is sent verbatim (URL-encoded) so the backend owns the parse —
  // this page makes no assumption about the sticker shape.
  const handleDecoded = useCallback(
    async (raw: string) => {
      if (!rackId || !raw) return;
      // De-dupe: ignore the same raw value fired again within 1.2s (a sticker
      // sits in frame for many ticks). A genuine re-scan after the cooldown,
      // or a different sticker, passes — qty bumps happen via addLine, not here.
      const now = performance.now();
      if (
        raw === lastRawRef.current.value &&
        now - lastRawRef.current.at < 1200
      ) {
        return;
      }
      lastRawRef.current = { value: raw, at: now };
      if (lookupBusyRef.current) return;
      lookupBusyRef.current = true;
      try {
        const r = await fetch(
          `/api/public/rack-qr/${encodeURIComponent(rackId)}/item?code=${encodeURIComponent(raw)}`,
          { cache: "no-store" },
        );
        const j = (await r.json().catch(() => ({}))) as ItemLookup & {
          error?: string;
        };
        if (!r.ok || !j || j.found === false) {
          setPendingMove(null);
          // Keep the message short — show the human label if the raw is long.
          const shown = raw.length > 28 ? `${raw.slice(0, 28)}…` : raw;
          setScanMsg(`Not recognised: ${shown}`);
          return;
        }
        const name = j.productName || j.poNo || "Item";
        const line: Line = {
          productionOrderId: j.productionOrderId,
          productName: name,
          poNo: j.poNo,
          qty: 1,
        };
        // In a DIFFERENT rack → park for a Move / Skip decision. (Equal rack
        // ids, or no current rack, just add — see below.)
        if (j.currentRackId && j.currentRackId !== rackId) {
          setScanMsg(null);
          setPendingMove({
            line,
            currentRackLabel: j.currentRackLabel || j.currentRackId,
          });
          return;
        }
        // Already in THIS rack, or not racked anywhere → add / bump qty.
        setPendingMove(null);
        addLine(line);
        setScanMsg(`Added: ${name}`);
      } catch {
        setScanMsg("Network error — scan again.");
      } finally {
        lookupBusyRef.current = false;
      }
    },
    [rackId, addLine],
  );

  // ── Camera control ───────────────────────────────────────────────────────
  const stopScan = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {
        /* */
      }
    }
    setScanning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  // Torch / flashlight — best-effort (Android Chrome exposes `torch` via
  // applyConstraints; iOS Safari doesn't, so the button only shows when the lens
  // reports it). A dim warehouse is a top cause of a Code 128 "won't scan".
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      /* torch is best-effort — never break the scan over it */
    }
  }, [torchOn]);

  const startScan = useCallback(async () => {
    if (scanning) return;
    setCameraError(null);
    setScanMsg(null);
    try {
      // Rear camera, sharp feed — small / arm's-length stickers need the detail.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      // Best-effort continuous autofocus — a fixed-focus lens leaves the sticker
      // blurry; surface the torch button only when this lens supports it.
      try {
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean })
          | undefined;
        if (caps?.focusMode && caps.focusMode.includes("continuous")) {
          await track.applyConstraints({
            advanced: [
              { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
            ],
          });
        }
        setTorchSupported(!!caps?.torch);
      } catch {
        /* focus tuning is a nicety, never block the scan on it */
      }
      setScanning(true);
      // Video attach + RAF loop happens in the effect below.
    } catch (e) {
      // Distinguish a hard permission Block (browser remembers, re-prompt won't
      // show — only the user can unblock at the address bar) from no-camera/HTTPS.
      const name = e instanceof DOMException ? e.name : "";
      setCameraError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera blocked. Allow camera access for this site (tap the lock icon in the address bar), then tap Scan again."
          : "Could not open the camera. Make sure no other app is using it and that this page is on https.",
      );
    }
  }, [scanning]);

  // Wire the stream into <video> and run the per-frame decode loop while
  // scanning. Re-runs on scanMode to swap the reticle / decode path.
  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.setAttribute("playsinline", "true"); // iOS: no fullscreen hijack
    video.muted = true;
    video.play().catch(() => {});

    if (!scanCanvasRef.current) {
      scanCanvasRef.current = document.createElement("canvas");
    }
    const canvas = scanCanvasRef.current;

    // Native, hardware-accelerated detector (Android Chrome) reads small /
    // angled / blurred stickers off the live <video>. Absent on iOS Safari →
    // jsQR (QR) + ZXing (QR + Code 128) fallback.
    let nativeDetector: BarcodeDetectorLike | null = null;
    if (typeof window !== "undefined" && window.BarcodeDetector) {
      try {
        nativeDetector = new window.BarcodeDetector({
          formats: ["qr_code", "code_128"],
        });
      } catch {
        try {
          nativeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
        } catch {
          nativeDetector = null;
        }
      }
    }
    void ensureZxing();

    let stopped = false;
    let lastDecode = 0;
    const THROTTLE_MS = nativeDetector ? 60 : 90;

    // Map the on-screen aim box to a crop rect in RAW VIDEO pixels for barcode
    // mode. FULL WIDTH (a Code 128 only decodes with its entire width + quiet
    // zones present), TIGHT centred HEIGHT band (~0.20 of the frame) so stacked
    // rows above/below are excluded. The 0.20 band is a known invariant — a
    // taller band breaks Code 128 decoding (worker/scan.tsx).
    const aimRoi = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const sh = Math.max(1, Math.round(vh * 0.2));
      const sw = vw;
      const sx = 0;
      const sy = Math.round((vh - sh) / 2);
      return { sx, sy, sw, sh };
    };

    const onHit = (data: string) => {
      if (stopped || !data) return;
      // The scanner stays OPEN — each hit feeds the lookup and the worker keeps
      // scanning more items into the rack. handleDecoded de-dupes a held sticker.
      void handleDecoded(data);
    };

    const tick = async () => {
      if (stopped) return;
      const now = performance.now();
      const mode = scanModeRef.current;
      if (
        now - lastDecode >= THROTTLE_MS &&
        video.videoWidth > 0 &&
        video.readyState >= 2
      ) {
        lastDecode = now;
        if (nativeDetector) {
          try {
            const codes = await nativeDetector.detect(video);
            if (stopped) return;
            if (mode === "barcode") {
              // Only a Code 128 whose vertical centre sits in the aim band, and
              // among those the one nearest centre wins — stacked rows ignored.
              const cy = video.videoHeight / 2;
              const roiHalf = aimRoi().sh / 2;
              let best: { v: string; d: number } | null = null;
              for (const c of codes) {
                if (!c.rawValue) continue;
                const fmt = (c as { format?: string }).format;
                if (fmt && fmt !== "code_128") continue;
                const bb = (c as { boundingBox?: { y: number; height: number } })
                  .boundingBox;
                const d = bb ? Math.abs(bb.y + bb.height / 2 - cy) : 0;
                if (bb && d > roiHalf) continue; // outside the aim band → ignore
                if (!best || d < best.d) best = { v: c.rawValue, d };
              }
              if (best) {
                onHit(best.v);
                return;
              }
            } else if (codes.length > 0 && codes[0].rawValue) {
              onHit(codes[0].rawValue);
              return;
            }
          } catch {
            // Exposed but flaky — drop to the canvas path for the rest of the session.
            nativeDetector = null;
          }
        } else {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            if (mode === "barcode") {
              // Decode ONLY the centred ROI band (matches the on-screen box):
              // full width, ~0.20 height. ~5x fewer pixels than the full frame
              // (fast on iOS Safari) and excludes neighbouring stacked rows.
              const { sx, sy, sw, sh } = aimRoi();
              const s = Math.min(1, 1280 / sw);
              const cw = Math.max(1, Math.round(sw * s));
              const ch = Math.max(1, Math.round(sh * s));
              canvas.width = cw;
              canvas.height = ch;
              ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
              let imageData: ImageData | null = null;
              try {
                imageData = ctx.getImageData(0, 0, cw, ch);
              } catch {
                imageData = null;
              }
              const zxDecode = zxingRef.current;
              if (!zxDecode) {
                void ensureZxing(); // self-heal if the chunk hasn't loaded yet
              } else if (imageData) {
                const zxText = zxDecode(imageData);
                if (zxText) {
                  onHit(zxText);
                  return;
                }
              }
            } else {
              // QR mode: full frame, jsQR first then ZXing (QR + Code 128).
              const scale = Math.min(1, 960 / Math.max(vw, vh));
              const cw = Math.max(1, Math.round(vw * scale));
              const ch = Math.max(1, Math.round(vh * scale));
              canvas.width = cw;
              canvas.height = ch;
              ctx.drawImage(video, 0, 0, cw, ch);
              let imageData: ImageData | null = null;
              try {
                imageData = ctx.getImageData(0, 0, cw, ch);
              } catch {
                imageData = null;
              }
              if (imageData) {
                const code = jsQR(imageData.data, cw, ch, {
                  inversionAttempts: "attemptBoth",
                });
                if (code && code.data) {
                  onHit(code.data);
                  return;
                }
                const zxDecode = zxingRef.current;
                if (zxDecode) {
                  const zxText = zxDecode(imageData);
                  if (zxText) {
                    onHit(zxText);
                    return;
                  }
                }
              }
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(() => void tick());
    };
    rafRef.current = requestAnimationFrame(() => void tick());

    return () => {
      stopped = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scanning, handleDecoded, ensureZxing]);

  // Tear down the stream if the page unmounts mid-scan.
  useEffect(() => {
    return () => {
      stopScan();
    };
  }, [stopScan]);

  // ── Move / Skip resolution for a cross-rack item ─────────────────────────
  const resolveMove = useCallback(
    (move: boolean) => {
      setPendingMove((cur) => {
        if (cur && move) {
          // Add the line — the backend stock-in performs the actual move.
          addLine(cur.line);
          setScanMsg(`Moving here: ${cur.line.productName}`);
        } else if (cur) {
          setScanMsg(`Skipped: ${cur.line.productName}`);
        }
        return null;
      });
    },
    [addLine],
  );

  const removeLine = useCallback((line: Line) => {
    setLines((prev) =>
      prev.filter((x) =>
        line.productionOrderId
          ? x.productionOrderId !== line.productionOrderId
          : !(x.productionOrderId === null && x.productName === line.productName),
      ),
    );
  }, []);

  // ── Stock In (two-tap arm→confirm) ───────────────────────────────────────
  const totalQty = lines.reduce((s, x) => s + x.qty, 0);

  const handleStockIn = useCallback(async () => {
    if (!rackId || submitting || lines.length === 0) return;
    // First tap arms, second tap confirms — same guard as the DO-scan button.
    if (!armed) {
      setArmed(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(
        `/api/public/rack-qr/${encodeURIComponent(rackId)}/stock-in`,
        {
          method: "POST",
          // csrfHeaders: cookieless public users send no CSRF header (silently
          // omitted); a logged-in staff phone carries the session cookie and the
          // backend then requires the echo — include it so both paths work.
          headers: csrfHeaders(),
          body: JSON.stringify({
            items: lines.map((x) => ({
              productionOrderId: x.productionOrderId,
              productName: x.productName,
              poNo: x.poNo,
              qty: x.qty,
            })),
          }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        count?: number;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        // Keep the list so the worker can retry.
        setSubmitError(j.error || "Stock-in failed. Please try again.");
        return;
      }
      const n = j.count ?? totalQty;
      const label = summary?.rackLabel || rackId;
      setDoneMsg(`✓ Stocked ${n} into ${label}`);
      setScanMsg(null);
      setLines([]);
      // Reflect the new total in the rack header.
      setSummary((s) => (s ? { ...s, itemCount: s.itemCount + n } : s));
    } catch {
      setSubmitError("Network error. Please check your connection and try again.");
    } finally {
      setArmed(false);
      setSubmitting(false);
    }
  }, [rackId, submitting, lines, armed, totalQty, summary]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#F0ECE9]">
      {/* Header — mirrors the DO-scan dark bar. */}
      <header className="bg-[#1F1D1B] text-white">
        <div className="max-w-xl mx-auto px-4 py-5 flex items-center gap-3">
          <div className="h-9 w-9 rounded bg-[#6B5C32] flex items-center justify-center">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Rack Stock-In</h1>
            <p className="text-xs text-gray-400">HOOKKA INDUSTRIES</p>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-4 pb-12">
        {loading && (
          <div className="rounded-xl bg-white p-8 text-center shadow-sm border border-[#E6E0D9]">
            <div className="h-8 w-8 mx-auto rounded-full border-4 border-[#6B5C32] border-t-transparent animate-spin" />
            <p className="mt-3 text-sm text-gray-500">Looking up rack...</p>
          </div>
        )}

        {!loading && loadError && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-[#E8B2A1]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-[#9A3A2D] shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-[#9A3A2D]">Rack not found</p>
                <p className="text-sm text-[#9A3A2D] mt-1">{loadError}</p>
              </div>
            </div>
          </div>
        )}

        {!loading && summary && (
          <>
            {/* Rack header card */}
            <div className="rounded-xl bg-[#1F1D1B] text-white p-4 shadow-sm">
              <p className="text-xs uppercase tracking-widest text-gray-400">
                Rack
              </p>
              <p className="text-2xl font-bold mt-0.5">{summary.rackLabel}</p>
              <p className="text-xs text-gray-400 mt-1">
                Currently holds{" "}
                <span className="font-semibold text-white">
                  {summary.itemCount}
                </span>{" "}
                item{summary.itemCount === 1 ? "" : "s"}.
              </p>
            </div>

            {/* Success banner (last stock-in). */}
            {doneMsg && (
              <div className="rounded-xl bg-[#4F7C3A] text-white p-5 text-center shadow-sm">
                <CheckCircle2 className="h-12 w-12 mx-auto" strokeWidth={2.5} />
                <p className="text-lg font-bold mt-2">{doneMsg}</p>
                <p className="text-sm opacity-90 mt-1">
                  Scan more items to keep stocking this rack.
                </p>
              </div>
            )}

            {/* ── Camera scanner ──────────────────────────────────────────── */}
            {scanning ? (
              <div className="rounded-xl overflow-hidden bg-black shadow-sm border border-[#E6E0D9]">
                <div className="relative">
                  <video
                    ref={videoRef}
                    className="w-full h-[58vh] object-cover bg-black"
                    playsInline
                    muted
                  />
                  {/* Aim reticle. The barcode box dims (full-width feel + short
                      band) cue the ~0.20 ROI; QR shows a centred square. */}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    {scanMode === "barcode" ? (
                      <div className="w-[86vw] max-w-[440px] h-[88px] rounded-lg border-2 border-white/90 shadow-[0_0_0_2000px_rgba(0,0,0,0.35)]" />
                    ) : (
                      <div className="w-[66vw] max-w-[300px] aspect-square rounded-lg border-2 border-white/90 shadow-[0_0_0_2000px_rgba(0,0,0,0.35)]" />
                    )}
                  </div>
                  {/* Top controls: close + torch. */}
                  <div className="absolute top-2 right-2 flex gap-2">
                    {torchSupported && (
                      <button
                        type="button"
                        onClick={() => void toggleTorch()}
                        className={`h-10 w-10 rounded-full flex items-center justify-center ${
                          torchOn ? "bg-[#9C6F1E] text-white" : "bg-black/55 text-white"
                        }`}
                        aria-label="Toggle flashlight"
                      >
                        <Flashlight className="h-5 w-5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={stopScan}
                      className="h-10 w-10 rounded-full bg-black/55 text-white flex items-center justify-center"
                      aria-label="Close camera"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  {/* Mode toggle. */}
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex rounded-full bg-black/55 p-1 text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setScanMode("qr")}
                      className={`px-4 py-1.5 rounded-full ${
                        scanMode === "qr" ? "bg-white text-[#1F1D1B]" : "text-white"
                      }`}
                    >
                      QR
                    </button>
                    <button
                      type="button"
                      onClick={() => setScanMode("barcode")}
                      className={`px-4 py-1.5 rounded-full ${
                        scanMode === "barcode" ? "bg-white text-[#1F1D1B]" : "text-white"
                      }`}
                    >
                      Barcode
                    </button>
                  </div>
                </div>
                {/* Live scan feedback strip. */}
                <div className="bg-[#1F1D1B] px-4 py-2.5 text-center text-sm text-white min-h-[40px] flex items-center justify-center">
                  {scanMsg || "Point at an item QR…"}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void startScan()}
                className="w-full rounded-xl bg-[#6B5C32] active:bg-[#5a4d2a] text-white py-4 text-lg font-bold shadow-sm flex items-center justify-center gap-2"
              >
                <Camera className="h-5 w-5" />
                {lines.length > 0 ? "Scan more items" : "Scan items"}
              </button>
            )}

            {/* Camera error (permission / no camera). */}
            {cameraError && (
              <div className="rounded-xl bg-white p-4 shadow-sm border border-[#E8B2A1]">
                <p className="text-sm text-[#9A3A2D]">{cameraError}</p>
              </div>
            )}

            {/* Cross-rack Move / Skip prompt. */}
            {pendingMove && (
              <div className="rounded-xl bg-[#FBF1DF] p-4 shadow-sm border border-[#E8D3A1] space-y-3">
                <div className="flex items-start gap-2 text-sm text-[#9C6F1E]">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-px" />
                  <p>
                    <span className="font-semibold">
                      {pendingMove.line.productName}
                    </span>{" "}
                    is currently in Rack{" "}
                    <span className="font-semibold">
                      {pendingMove.currentRackLabel}
                    </span>
                    . Move it into {summary.rackLabel}?
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => resolveMove(true)}
                    className="flex-1 rounded-xl bg-[#9C6F1E] active:bg-[#835D19] text-white py-3 text-sm font-bold"
                  >
                    Move here
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveMove(false)}
                    className="flex-1 rounded-xl bg-white border border-[#E6E0D9] text-gray-600 py-3 text-sm font-semibold"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}

            {/* ── Accumulated stock-in list ──────────────────────────────── */}
            <div className="rounded-xl bg-white shadow-sm border border-[#E6E0D9] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-base font-bold text-[#1F1D1B]">
                  Items to stock in
                </p>
                {totalQty > 0 && (
                  <span className="text-sm font-semibold text-[#6B5C32]">
                    {totalQty} item{totalQty === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              {lines.length === 0 ? (
                <p className="text-sm text-gray-500 py-2">
                  Nothing scanned yet. Tap{" "}
                  <span className="font-medium">Scan items</span> and point at an
                  item QR — each scan adds one.
                </p>
              ) : (
                <ul className="divide-y divide-[#EFEAE5]">
                  {lines.map((it) => (
                    <li
                      key={it.productionOrderId ?? `name:${it.productName}`}
                      className="flex items-center gap-2 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[#1F1D1B]">
                          {it.productName}
                        </p>
                        {it.poNo && (
                          <p className="truncate text-xs text-gray-500">
                            {it.poNo}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-[#1F1D1B]">
                        ×{it.qty}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeLine(it)}
                        className="shrink-0 text-gray-400 active:text-[#9A3A2D] p-1"
                        aria-label={`Remove ${it.productName}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {submitError && (
                <p className="text-sm text-[#9A3A2D]">{submitError}</p>
              )}

              <button
                type="button"
                disabled={lines.length === 0 || submitting}
                onClick={() => void handleStockIn()}
                className="w-full rounded-xl bg-[#9C6F1E] active:bg-[#835D19] text-white py-4 text-lg font-bold shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {submitting ? (
                  <span className="h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : (
                  <PackageCheck className="h-5 w-5" />
                )}
                {armed
                  ? `Tap again to confirm — Stock In (${totalQty})`
                  : `Stock In (${totalQty})`}
              </button>
              {armed && !submitting && (
                <button
                  type="button"
                  onClick={() => setArmed(false)}
                  className="w-full rounded-xl bg-white border border-[#E6E0D9] text-gray-600 py-2.5 text-sm font-medium"
                >
                  Cancel
                </button>
              )}
            </div>

            <p className="text-[10px] text-center text-gray-400">
              For other changes, contact the Hookka office.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

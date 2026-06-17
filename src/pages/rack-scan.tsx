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
//      the backend. PER-PIECE: every FG/WIP/packing QR is a UNIQUE token for
//      ONE physical piece, so each NEW QR value adds ONE line (qty 1) carrying
//      the piece's description + Sales Order number; re-scanning a QR already in
//      the list is rejected ("Already added" + error beep), never bumped — so 9
//      distinct stickers = 9 lines. An item currently in a DIFFERENT rack
//      prompts Move-here / Skip; one already in THIS rack just records the piece.
//   3. Tap the big "Stock In (N)" button (two-tap arm→confirm, like DO-scan) to
//      POST the list. On success the list clears; on error it's kept for retry.
//
// The camera loop is a trimmed copy of /worker/scan's: getUserMedia → a RAF
// tick that feeds frames to the phone's native BarcodeDetector when present,
// else jsQR (QR) + a lazily dynamic-imported ZXing decoder (QR + Code 128).
// No auto-zoom (kept simple); an optional torch toggle where the lens supports
// it. BOTH modes decode the FULL frame — QR reads a Code 128 fine precisely
// because it is full-frame, so barcode mode matches it (no cropped ROI). A
// short ~80ms WebAudio blip confirms every successful add ("滴"); a lower
// double tone signals not-recognised / wrong-rack. The scanner stays open and
// keeps decoding after each hit so items are scanned continuously, with a
// per-value de-dup so one held sticker adds exactly once.

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
  // Per-piece (owner's model): the Sales Order this piece belongs to + a clear
  // human description (productName + size, e.g. "1013 King Size Headboard").
  salesOrderNo: string | null;
  description: string | null;
  // When set AND different from the scanned rack, the item currently lives in
  // another rack — the UI offers Move-here / Skip before adding the line.
  currentRackId: string | null;
  currentRackLabel: string | null;
};

// One accumulated stock-in line = ONE unique physical piece.
//
// PER-PIECE MODEL: every FG/WIP/packing QR is a UNIQUE token for ONE piece, so
// the list is keyed by `rawValue` (the exact decoded QR string). A new QR value
// adds one line (qty is always 1 — a sticker is a single piece); re-scanning a
// QR already in the list is rejected ("Already added"), never bumped. So 9
// distinct stickers → 9 lines; the same sticker rescanned → ignored.
type Line = {
  rawValue: string; // the decoded QR string — the unique per-piece key
  productionOrderId: string | null;
  productName: string; // clear description shown to the worker
  poNo: string | null;
  salesOrderNo: string | null;
  qty: number; // always 1 (kept for the POST contract / totals)
};

// An item found in a DIFFERENT rack, parked until the user taps Move / Skip.
type PendingMove = {
  line: Line;
  currentRackLabel: string;
};

// ── Camera scanner (trimmed copy of /worker/scan) ─────────────────────────
// Decode-mode toggle: "qr" reads a square sticker, "barcode" a Code 128. BOTH
// decode the FULL video frame — QR mode reads a Code 128 today only because it
// is full-frame, and a cropped ROI was what stopped barcode mode decoding, so
// barcode mode matches QR exactly. The toggle now only swaps the reticle shape
// + the native-detector format hint; the captured pixels are identical.
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
  // cooldown (DEDUP_MS), is allowed through. Set SYNCHRONOUSLY on the very first
  // hit (before any await) so two back-to-back frames can't both pass — this is
  // the guard that stops one physical scan adding a line twice.
  const lastRawRef = useRef<{ value: string; at: number }>({ value: "", at: 0 });
  // A lookup is in flight — gate so frames decoded during the async round-trip
  // don't pile up requests (belt-and-braces with the value de-dup).
  const lookupBusyRef = useRef(false);
  // Lazily-created WebAudio context for the scan "滴" blip. Created on the first
  // user gesture (Start / tapping the video) so autoplay policy lets it sound;
  // null until then. Reused for every beep thereafter.
  const audioCtxRef = useRef<AudioContext | null>(null);
  // scanMode mirrored to a ref so the long-lived tick loop reads the current
  // mode without being torn down on every toggle. The loop effect deliberately
  // omits scanMode from its deps; this ref keeps the running closure in sync so
  // QR/Barcode switches take effect on the very next frame, camera uninterrupted.
  const scanModeRef = useRef<ScanMode>(scanMode);
  useEffect(() => {
    scanModeRef.current = scanMode;
  }, [scanMode]);

  // Ignore the SAME decoded string for this long so one barcode held in frame
  // adds exactly once; a DIFFERENT item passes immediately.
  const DEDUP_MS = 1500;

  // ── Scan feedback beep ("滴") ─────────────────────────────────────────────
  // Lazily create one AudioContext on a user gesture, then play a short tone.
  // `ok` → a single bright ~880Hz blip (the "滴" the owner wants on every add);
  // not-ok → a lower, doubled tone for "not recognised" / "wrong rack". Wrapped
  // in try/catch so audio never breaks scanning on a locked-down browser.
  const ensureAudio = useCallback(() => {
    if (audioCtxRef.current) return audioCtxRef.current;
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      audioCtxRef.current = new Ctor();
    } catch {
      audioCtxRef.current = null;
    }
    return audioCtxRef.current;
  }, []);

  const beep = useCallback(
    (ok: boolean) => {
      try {
        const ctx = ensureAudio();
        if (!ctx) return;
        // A gesture-created context can still be suspended on iOS — resume it.
        if (ctx.state === "suspended") void ctx.resume();
        const play = (freq: number, startAt: number, durMs: number) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          // Tiny attack/decay envelope so the blip doesn't click.
          gain.gain.setValueAtTime(0.0001, startAt);
          gain.gain.exponentialRampToValueAtTime(0.32, startAt + 0.008);
          gain.gain.exponentialRampToValueAtTime(
            0.0001,
            startAt + durMs / 1000,
          );
          osc.connect(gain).connect(ctx.destination);
          osc.start(startAt);
          osc.stop(startAt + durMs / 1000 + 0.02);
        };
        const t0 = ctx.currentTime;
        if (ok) {
          play(880, t0, 80); // single bright "滴"
        } else {
          play(300, t0, 110); // lower, doubled → clearly "not added"
          play(300, t0 + 0.16, 110);
        }
      } catch {
        /* audio is best-effort — never break the scan over it */
      }
    },
    [ensureAudio],
  );

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
  // Synchronous membership gate for PER-PIECE de-dup. Mirrors the raw QR values
  // currently in `lines`. We consult/claim it SYNCHRONOUSLY (state updates are
  // async/batched, so reading `lines` here would be stale) — this is what makes
  // "already added?" a reliable yes/no even for two back-to-back camera frames.
  // Kept in sync on add (here), on remove, and on submit-clear.
  const addedValuesRef = useRef<Set<string>>(new Set());

  // Add ONE unique piece, keyed by its raw QR value. PER-PIECE: a QR value
  // already recorded is a re-scan of the SAME physical sticker → NOT added and
  // NOT bumped (returns false so the caller shows "Already added" + the error
  // beep). A new QR value pushes one line at qty 1.
  const addPiece = useCallback((line: Line): boolean => {
    if (addedValuesRef.current.has(line.rawValue)) return false; // dup sticker
    addedValuesRef.current.add(line.rawValue);
    setDoneMsg(null);
    setLines((prev) => [...prev, { ...line, qty: 1 }]);
    return true;
  }, []);

  // ── Decode → item lookup ─────────────────────────────────────────────────
  // Each decoded raw code is looked up against the backend item endpoint. The
  // raw string is sent verbatim (URL-encoded) so the backend owns the parse —
  // this page makes no assumption about the sticker shape.
  const handleDecoded = useCallback(
    async (raw: string) => {
      if (!rackId || !raw) return;
      // Throttle the held-sticker frame burst: ignore the same raw value fired
      // again within DEDUP_MS (a held sticker decodes every frame). This check +
      // the synchronous ref write below run BEFORE any await, so two back-to-
      // back frames carrying the same code can't both reach the backend. A
      // different sticker, or the same one after the cooldown, passes — and the
      // permanent per-piece de-dup (addedValuesRef) then decides add vs
      // "Already added", so a sticker is recorded exactly once regardless.
      const now = performance.now();
      if (
        raw === lastRawRef.current.value &&
        now - lastRawRef.current.at < DEDUP_MS
      ) {
        return;
      }
      // Claim this value synchronously (no await in between) — the de-dup gate.
      lastRawRef.current = { value: raw, at: now };
      // Second guard: a lookup already in flight (the async round-trip) — drop
      // this frame entirely so requests can't pile up.
      if (lookupBusyRef.current) return;
      lookupBusyRef.current = true;
      try {
        // PER-PIECE: this exact QR is already listed → SAME sticker rescanned.
        // Tell the worker, skip the backend, never add a duplicate / bump.
        if (addedValuesRef.current.has(raw)) {
          setPendingMove(null);
          setScanMsg("Already added — this piece is already in the list.");
          beep(false);
          return;
        }
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
          beep(false);
          return;
        }
        // Description (productName + size) is the clear label the owner wants;
        // fall back through productName / poNo so a line is never blank.
        const desc = j.description || j.productName || j.poNo || "Item";
        const line: Line = {
          rawValue: raw, // unique per-piece key
          productionOrderId: j.productionOrderId,
          productName: desc,
          poNo: j.poNo,
          salesOrderNo: j.salesOrderNo,
          qty: 1,
        };
        // In a DIFFERENT rack → park for a Move / Skip decision. (Equal rack
        // ids, or no current rack, just add — see below.) Lower tone: nothing
        // was added yet, the worker must choose Move / Skip.
        if (j.currentRackId && j.currentRackId !== rackId) {
          setScanMsg(null);
          setPendingMove({
            line,
            currentRackLabel: j.currentRackLabel || j.currentRackId,
          });
          beep(false);
          return;
        }
        // Already in THIS rack, or not racked anywhere → record ONE piece + "滴"
        // (qty 1, keyed by the raw QR). addPiece returns false only if this
        // exact QR is already listed → "Already added" + error tone.
        setPendingMove(null);
        if (addPiece(line)) {
          setScanMsg(`Added: ${desc}`);
          beep(true);
        } else {
          setScanMsg("Already added — this piece is already in the list.");
          beep(false);
        }
      } catch {
        setScanMsg("Network error — scan again.");
        // Allow an immediate retry of this same value after a network blip.
        lastRawRef.current = { value: "", at: 0 };
      } finally {
        lookupBusyRef.current = false;
      }
    },
    [rackId, addPiece, beep],
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
    // Prime the AudioContext on this user gesture so the scan "滴" can sound
    // (browser autoplay policy blocks audio created outside a gesture).
    const ac = ensureAudio();
    if (ac && ac.state === "suspended") void ac.resume();
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
  }, [scanning, ensureAudio]);

  // Wire the stream into <video> and run the per-frame decode loop while
  // scanning. Deliberately does NOT depend on scanMode — the loop reads the
  // live mode via scanModeRef, so toggling QR/Barcode never tears down the
  // camera (a teardown would drop the in-flight scan and re-prompt).
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

    // Feed a decoded value to the lookup. The scanner stays OPEN — each hit
    // adds an item and the loop keeps decoding so the next item scans straight
    // away (PROBLEM 1: continuous scan). handleDecoded de-dupes a held sticker
    // so one physical scan adds exactly once (PROBLEM 3).
    const onHit = (data: string) => {
      if (stopped || !data) return;
      void handleDecoded(data);
    };

    // Barcode aim box → isolate ONE Code 128. Full WIDTH (every bar + both
    // quiet zones) × a centred ~30% HEIGHT band, matching the rectangle reticle.
    // Barcode mode decodes ONLY this band so the worker grabs the sticker they
    // point at — not whichever of several stacked codes decodes first ("还没确定
    // 要抓哪一个就 scan 了", owner 2026-06-17). QR mode keeps the full frame (a
    // rack QR can sit anywhere). The band is tall enough for ZXing to read yet
    // excludes the rows above/below.
    const aimRoi = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const sh = Math.max(1, Math.round(vh * 0.3));
      return { sx: 0, sy: Math.round((vh - sh) / 2), sw: vw, sh };
    };

    const tick = async () => {
      if (stopped) return;
      const now = performance.now();
      const mode = scanModeRef.current;
      // The decoded value for THIS frame, if any. We set it then fall through
      // to the single RAF reschedule at the bottom — crucially we never early-
      // `return` on a hit, which is exactly what used to kill the loop after
      // the first item (PROBLEM 1). onHit + the de-dup window make a repeat of
      // the same frame's value a no-op, so falling through is safe.
      let hit: string | null = null;
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
              // Only the Code 128 whose vertical centre falls INSIDE the aim
              // band wins; a neighbour above/below is ignored so the worker
              // grabs the sticker they point at, not whichever decodes first
              // (owner 2026-06-17). Nearest-to-centre among the in-band codes.
              const cy = video.videoHeight / 2;
              const roiHalf = aimRoi().sh / 2;
              let best: { v: string; d: number } | null = null;
              for (const c of codes) {
                if (!c.rawValue) continue;
                const fmt = (c as { format?: string }).format;
                if (fmt && fmt !== "code_128") continue;
                const bb = (
                  c as { boundingBox?: { y: number; height: number } }
                ).boundingBox;
                const d = bb ? Math.abs(bb.y + bb.height / 2 - cy) : 0;
                if (bb && d > roiHalf) continue; // outside the aim band → ignore
                if (!best || d < best.d) best = { v: c.rawValue, d };
              }
              if (best) hit = best.v;
            } else if (codes.length > 0 && codes[0].rawValue) {
              hit = codes[0].rawValue;
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
              // Decode ONLY the centred aim band (full width × ~30% height) so
              // the worker isolates the one sticker they point at out of a
              // stacked sheet — not whichever Code 128 decodes first. ~1280px
              // working width keeps the bars sharp. ZXing is the sole Code 128
              // decoder on iOS (jsQR is QR-only, so it's skipped here).
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
              if (imageData) {
                const zxDecode = zxingRef.current;
                if (!zxDecode) {
                  void ensureZxing(); // self-heal if the chunk hasn't loaded yet
                } else {
                  const zxText = zxDecode(imageData);
                  if (zxText) hit = zxText;
                }
              }
            } else {
              // QR mode — full frame (a rack QR can sit anywhere in view).
              // jsQR (QR only) first, then ZXing as a QR fallback.
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
                if (code && code.data) hit = code.data;
                if (!hit) {
                  const zxDecode = zxingRef.current;
                  if (!zxDecode) {
                    void ensureZxing(); // self-heal if the chunk hasn't loaded yet
                  } else {
                    const zxText = zxDecode(imageData);
                    if (zxText) hit = zxText;
                  }
                }
              }
            }
          }
        }
      }
      if (hit) onHit(hit);
      // ALWAYS reschedule — the loop must keep running after a hit so the next
      // item scans immediately (PROBLEM 1).
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
      // Release the WebAudio context on unmount (browsers cap how many exist).
      const ac = audioCtxRef.current;
      if (ac) {
        audioCtxRef.current = null;
        try {
          void ac.close();
        } catch {
          /* */
        }
      }
    };
  }, [stopScan]);

  // ── Move / Skip resolution for a cross-rack item ─────────────────────────
  const resolveMove = useCallback(
    (move: boolean) => {
      const cur = pendingMove;
      if (!cur) return;
      setPendingMove(null);
      if (move) {
        // Record the piece — the backend stock-in performs the actual move.
        // addPiece de-dups by raw QR, so re-confirming the same sticker is safe.
        if (addPiece(cur.line)) {
          setScanMsg(`Moving here: ${cur.line.productName}`);
          beep(true); // confirmed add → the same "滴"
        } else {
          setScanMsg("Already added — this piece is already in the list.");
          beep(false);
        }
      } else {
        setScanMsg(`Skipped: ${cur.line.productName}`);
      }
    },
    [pendingMove, addPiece, beep],
  );

  // Remove ONE piece by its raw QR key, and release that key from the
  // per-piece de-dup Set so the SAME sticker can be re-scanned afterwards.
  const removeLine = useCallback((line: Line) => {
    addedValuesRef.current.delete(line.rawValue);
    setLines((prev) => prev.filter((x) => x.rawValue !== line.rawValue));
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
            // PER-PIECE: one entry per unique scanned sticker, qty 1. Send the
            // description (what the rack row will read) + the SO number so the
            // backend writes one row per piece carrying both.
            items: lines.map((x) => ({
              productionOrderId: x.productionOrderId,
              productName: x.productName,
              description: x.productName,
              poNo: x.poNo,
              salesOrderNo: x.salesOrderNo,
              qty: 1,
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
      // Clear the per-piece de-dup keys so a fresh batch can scan cleanly.
      addedValuesRef.current.clear();
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
                  {/* Aim reticle. In barcode mode this rectangle is REAL — only
                      a Code 128 inside the band is decoded, so the worker aims
                      at the one sticker they want. QR mode decodes the full
                      frame (a square guide is enough). Tapping the overlay also
                      (re)primes the beep audio on iOS. */}
                  <div
                    onClick={() => {
                      const ac = ensureAudio();
                      if (ac && ac.state === "suspended") void ac.resume();
                    }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    {scanMode === "barcode" ? (
                      <div className="pointer-events-none w-[86vw] max-w-[440px] h-[88px] rounded-lg border-2 border-white/90 shadow-[0_0_0_2000px_rgba(0,0,0,0.35)]" />
                    ) : (
                      <div className="pointer-events-none w-[66vw] max-w-[300px] aspect-square rounded-lg border-2 border-white/90 shadow-[0_0_0_2000px_rgba(0,0,0,0.35)]" />
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
                  {/* PER-PIECE: one row per unique sticker, keyed by its raw QR
                      value. No ×qty badge — each row IS one piece. Shows the
                      description + the piece's Sales Order number. */}
                  {lines.map((it) => (
                    <li
                      key={it.rawValue}
                      className="flex items-center gap-2 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-[#1F1D1B]">
                          {it.productName}
                        </p>
                        {(it.salesOrderNo || it.poNo) && (
                          <p className="truncate text-xs text-gray-500">
                            {it.salesOrderNo
                              ? `SO ${it.salesOrderNo}`
                              : it.poNo}
                          </p>
                        )}
                      </div>
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

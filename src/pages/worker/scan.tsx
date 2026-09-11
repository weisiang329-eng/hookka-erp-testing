// ============================================================
// /worker/scan — Simplified worker-facing scanner
//
// Worker-focused version of /production/scan with three big
// differences:
//   1. No "pick your name" dropdown — the scan is always attributed
//      to the authenticated worker via their token.
//   2. Single giant "Start work on this card" button instead of the
//      multi-step admin flow.
//   3. Mobile-first layout — stacked card + big tap targets.
//
// Camera path (primary):
//   - Tap "Scan QR" → open an in-page full-screen camera overlay
//     driven by getUserMedia. Frames go through the phone's native
//     BarcodeDetector when present (Android Chrome — fast, reads small /
//     blurry stickers), else a jsQR fallback (iOS Safari). On first decode
//     we auto-submit and close the overlay. Feels instant.
//     Requires HTTPS on non-localhost origins (see vite.config).
//   - "Upload photos" picks ONE OR MANY images from the gallery. Files
//     are queued and decoded one at a time; after each scan-complete
//     the next file auto-advances. Workers can snap a bunch of QR
//     stickers throughout the shift and batch-scan at the end.
//
// Lookup / scan-complete hits a single set of endpoints rooted at
// /api/production-orders. (Earlier revisions carried a parallel "test" flow
// so the old and new FIFO implementations could coexist; that fork was
// retired when the rewrite shipped — every path goes through the one
// endpoint now.)
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
  Camera,
  Search,
  CheckCircle2,
  AlertTriangle,
  Lock,
  X,
  ChevronRight,
  Images,
  Flashlight,
  ZoomOut,
  Pointer,
} from "lucide-react";
import jsQR from "jsqr";
import { useT } from "@/lib/worker-i18n";
import { workerFetch, WORKER_ME_KEY } from "@/layouts/WorkerLayout";
import {
  parseStickerData,
  parseJobCardBarcode,
  parseRackQr,
  parseItemQr,
} from "@/lib/qr-utils";
import { deriveBarcodeToken } from "@/lib/job-card-id";
import { deriveWipName } from "@/lib/wip-name";
import { todayYmdMY } from "@/lib/utils";
import { z } from "zod";
import {
  asSequenceLockRefusal,
  blockingDepartments,
  type SequenceLockRefusal,
} from "@/lib/sequence-unlock";

// Loose passthrough envelopes — runtime validation at boundaries while
// keeping the page's local Order/JobCard types as the typed view of `data`.
const POListEnvelope = z
  .object({
    success: z.boolean().optional(),
    data: z.array(z.unknown()).optional(),
  })
  .passthrough();
const ScanCompleteEnvelope = z
  .object({
    success: z.boolean().optional(),
    requiresConfirmation: z.boolean().optional(),
    warning: z.object({ code: z.string(), message: z.string() }).optional(),
    error: z.string().optional(),
    // Backend error code (ALREADY_PIC1 / ALREADY_PIC2 / PIC_FULL / …). Lets the
    // page route a PACKING already-done response to the rack picker (BUG-2026-06-08).
    code: z.string().optional(),
    // Upstream sequence lock — which departments must finish first, and whether
    // this user may release it. Parsed by src/lib/sequence-unlock.ts, which is
    // the ONE place that reads this shape across all five screens.
    blockedBy: z.array(z.unknown()).optional(),
    canSelfUnlock: z.boolean().optional(),
    data: z
      .object({
        assignedSlot: z.number().optional(),
        // Fan-out endpoints (scan-complete-dept / -shared) return this true on
        // a rescan of an already-finished variant (no slot filled) so the page
        // can show "already complete" instead of a misleading green ✓.
        alreadyComplete: z.boolean().optional(),
        // Shared / dept fan-out endpoints (scan-complete-shared / -dept) return
        // the department they actually completed; used to label the ✓ card.
        deptCode: z.string().optional(),
        // Human label for that dept ("Fabric Sewing" / "Upholstery") + who's
        // on the 2 PIC slots — shown on the ✓ / already-full card (Wei Siang
        // 2026-06-15: completion / 已满 must say BY WHOM).
        deptLabel: z.string().optional(),
        completedBy: z.array(z.string()).optional(),
        jobCard: z.unknown().optional(),
        fifoRedirected: z.boolean().optional(),
        scannedPoNo: z.string().optional(),
        assignedPoNo: z.string().optional(),
        assignedPoId: z.string().optional(),
        fifoDueDate: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const HistoryEnvelope = z
  .object({
    success: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

type PiecePic = {
  pieceNo: number;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedAt: string | null;
  lastScanAt: string | null;
  boundStickerKey: string | null;
};

type JobCard = {
  id: string;
  departmentCode: string;
  departmentName: string;
  status: string;
  dueDate: string;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  estMinutes: number;
  // WIP metadata from the BOM — present when the order has been expanded
  // into Divan / Headboard / Foam / Fabric pieces. `wipLabel` is the
  // human-facing name shown on the scan card and the printed sticker
  // (e.g. `8" Divan- 5FT (WD)`); `wipCode` is the short BOM code.
  wipKey?: string;
  wipCode?: string;
  wipType?: string;
  wipLabel?: string;
  wipQty?: number;
  // Per-piece PIC slots for the B-flow sticker-binding scan path. Present
  // on every JC seeded post-Y-rewrite. The client pre-checks the slot for
  // the currently-scanned pieceNo to give a fast "you already did this"
  // warning before round-tripping to the server.
  piecePics?: PiecePic[];
};

type Order = {
  id: string;
  poNo: string;
  customerName: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  sizeCode?: string;
  fabricCode: string;
  quantity: number;
  // SOFA vs BEDFRAME vs ACCESSORY — drives the fallback WIP naming below
  // (BEDFRAME orders have distinct Divan / HB / Foam / Fabric pieces that
  // share a PO).
  itemCategory?: string;
  jobCards: JobCard[];
};

// Thin adapter — every surface that shows a piece name uses the same
// derivation via deriveWipName in @/lib/wip-name.
function wipNameFor(jc: JobCard, po: Order): string {
  return deriveWipName({
    wipLabel: jc.wipLabel,
    departmentCode: jc.departmentCode,
    productName: po.productName,
    productCode: po.productCode,
    itemCategory: po.itemCategory,
    sizeLabel: po.sizeLabel,
  });
}

// One option in the "multi-WIP chooser" — same PO number but different
// pieces (Divan vs Headboard on a bedframe order). We show the worker a
// tappable list so they can pick the piece they're working on.
type WipOption = { order: Order; jobCard: JobCard };

// Optional piece metadata decoded from the QR payload. When a qty=2 Divan
// is scanned the sticker carries `p=1&t=2` (or `p=2&t=2`) so we can tell
// piece 1 from piece 2 on the same job card and show "Piece 1 of 2" on
// the card. Undefined for older stickers / manual entry.
type PieceInfo = { pieceNo: number; totalPieces: number };

type Result =
  | { kind: "idle" }
  | {
      kind: "lookup";
      order: Order;
      jobCard: JobCard;
      piece?: PieceInfo;
      // Shared Sew/Uph compartment sticker (carries wk= but no op/dept). When
      // set, Complete routes to scan-complete-shared with this wipKey and the
      // server decides FAB_SEW vs UPHOLSTERY from the worker's own section.
      wipKey?: string;
      // Code 128 schedule scan: complete the WHOLE WIP (every piece) in one
      // tap via /scan-complete + completeWholeCard, dept-agnostic.
      wholeCard?: boolean;
    }
  // When manual entry by PO number, or a QR whose opId went stale, yields
  // multiple matching job cards (e.g. a bedframe PO produces both Divan
  // and Headboard), surface them all so the worker disambiguates. Never
  // silently auto-pick — that's how a Divan scan ended up marking HB done.
  | { kind: "choices"; options: WipOption[]; piece?: PieceInfo }
  | {
      kind: "success";
      slot: 1 | 2;
      jobCard: JobCard;
      order: Order;
      piece?: PieceInfo;
      // True when the server reported the variant was ALREADY complete (a
      // rescan that filled no slot). Renders an amber "already complete"
      // header instead of the green ✓ so the worker isn't told they just did
      // work they didn't. BUG-2026-06-08.
      alreadyComplete?: boolean;
      // Secondary line on the ✓ / already card — e.g. "已满:2 人 (Ali + Siti)"
      // or "完成人:Ali" so a shared scan says BY WHOM (Wei Siang 2026-06-15).
      detail?: string;
      // Sticker-binding FIFO — when the scanned sticker's own JC wasn't
      // the oldest same-spec candidate, the server routed the completion
      // to an earlier PO. Surfaces so the worker knows "you scanned X but
      // the work counted toward Y (due earlier)".
      fifoRedirected?: boolean;
      scannedPoNo?: string;
      assignedPoNo?: string;
      assignedPoId?: string;
      fifoDueDate?: string;
    }
  | { kind: "error"; message: string; decoded?: string }
  // The step before this one is not finished (owner 2026-09-06). Its own kind,
  // not an "error": nothing went wrong and nothing needs reporting — it is
  // simply not this bench's turn yet. Rendering it as a red failure would teach
  // the floor that the system is broken, which is how a lock gets routed
  // around. During the shadow phase the worker may release it themselves.
  | {
      kind: "blocked";
      refusal: SequenceLockRefusal;
      retry: () => void;
    }
  // Department QR (owner 2026-06-11): "I am now working in <dept>" — the
  // day's hours re-route to this department (and, for per-line QRs, this
  // Sofa/Bedframe line) from `time` until the next scan or punch-out.
  | { kind: "deptscan"; deptName: string; category: string | null; time: string }
  // Owner 2026-06-26 unified scan model: the scanned sticker belongs to a
  // DIFFERENT department than the worker's CURRENT one (latest dept-QR scan /
  // punch) — block it and show the "wrong department" popup instead of letting
  // them complete someone else's work (which also mis-attributed their time).
  | { kind: "deptBlock"; currentDept: string; stickerDept: string };

// Shape of /api/worker/history — we pass from=today&to=today so we
// only get today's slice. Fields unused on this page are elided from
// the local type. WIP metadata comes through so the completed list can
// show the piece name (e.g. `8" Divan- 5FT (WD)`) rather than the
// generic productCode, which is ambiguous on bedframe POs where Divan
// and Headboard share the same productCode.
type TodaySnapshot = {
  completed: Array<{
    jobCardId: string;
    productCode: string;
    productName: string;
    departmentCode: string;
    estMinutes: number;
    // Per-piece fields — /history now splits by piecePic. A qty=2 Divan
    // where this worker did both pieces returns `piecesWorked: 2`,
    // `totalPieces: 2`, `myMinutes: 20` (full JC est since solo). Used to
    // expand the "Today's completed" list into one row per physical piece.
    myMinutes?: number;
    piecesWorked?: number;
    totalPieces?: number;
    completedDate: string | null;
    wipLabel?: string;
    wipCode?: string;
    itemCategory?: string;
    sizeLabel?: string;
  }>;
  totals: {
    workedMinutes: number;
    productionMinutes: number;
    efficiencyPct: number;
  };
};

function mins2hrs(mins: number): string {
  return (mins / 60).toFixed(1);
}

// Passive camera-permission probe (mirrors the GPS probeLocationState on the
// home page). navigator.permissions.query reports the current grant WITHOUT
// showing a prompt. We use it to: (a) know we already hold the grant so we can
// skip the prompt-explanation/UX churn, and (b) keep the call honest about what
// is and isn't possible — getUserMedia is still required to obtain a stream, but
// a 'granted' result means that call resolves silently (no re-prompt) on any
// browser that persists the grant. Returns 'unsupported' where the Permissions
// API or the 'camera' descriptor isn't available (notably iOS Safari), so the
// caller falls through to the normal getUserMedia path unchanged.
type CameraPermState = "granted" | "denied" | "prompt" | "unsupported";
async function probeCameraState(): Promise<CameraPermState> {
  try {
    const perms = (
      navigator as unknown as {
        permissions?: {
          query?: (d: { name: string }) => Promise<{ state: string }>;
        };
      }
    ).permissions;
    if (!perms?.query) return "unsupported";
    // The 'camera' descriptor is not in every browser's PermissionName union —
    // querying it can throw (TypeError) where unsupported; treat that as
    // 'unsupported' rather than an error.
    const status = await perms.query({ name: "camera" });
    if (
      status.state === "granted" ||
      status.state === "denied" ||
      status.state === "prompt"
    ) {
      return status.state;
    }
    return "unsupported";
  } catch {
    return "unsupported";
  }
}

// 2026-08-01 — camera constraint calls are FIRE-AND-FORGET PROMISES.
//
// Health reported these as unhandled JS errors on /worker/scan over 24h:
//     "The associated Track is in an invalid state"  x16
//     "Unsupported focusMode."                        x5
//
// Every call site looked guarded:
//     try { void track.applyConstraints({...}); } catch { /* best-effort */ }
// but applyConstraints() returns a Promise. try/catch only sees a SYNCHRONOUS
// throw, so the catch block could never fire for these — the rejection escaped
// as an unhandled rejection and landed in the error feed. The guards were
// decorative.
//
// Both messages are normal on real hardware: focusMode is unsupported on many
// lenses (iOS Safari especially), and the track goes "invalid" whenever the
// camera is torn down while a constraint call is still in flight — switching
// modes, backgrounding the tab, ending the scan. They are not bugs to fix,
// they are conditions to absorb. Each call now carries .catch() so they stay
// best-effort in fact, not just in comment.

export default function WorkerScanPage() {
  const t = useT();
  const [params] = useSearchParams();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [loading, setLoading] = useState(false);

  // Live camera path — opens a fullscreen overlay with a <video> element
  // showing the rear camera. A RAF loop grabs frames into a hidden canvas
  // and feeds the pixels to jsQR. On a decode hit we stop the stream and
  // auto-submit. If getUserMedia rejects (HTTPS required, permission
  // denied, no camera) we show a message and the user can still use the
  // Take photo / Upload fallbacks.
  const [liveScanning, setLiveScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  // Whether the lens exposes a zoom range (iOS Safari often doesn't) — gates the
  // zoom-reset button so it never shows as a dead no-op control.
  const [zoomSupported, setZoomSupported] = useState(false);
  // Scan mode (Wei Siang 2026-06-16): the square QR reticle framed 2-3 of the
  // schedule's stacked Code 128 rows at once and couldn't lock onto any. A
  // dedicated "barcode" mode draws a WIDE, short reticle and decodes ONLY the
  // code centred in that horizontal band — so the worker aims at one barcode and
  // the other rows are ignored. "qr" mode keeps the square full-frame behaviour.
  const [scanMode, setScanMode] = useState<"qr" | "barcode">("qr");
  // Barcode mode is tap-to-scan (owner 2026-06-27): the live loop only DETECTS a
  // barcode in view and flips this true → the aim frame turns blue ("ready, tap
  // it"); the actual scan happens on the worker's tap (tapScanBarcode). True only
  // while a barcode is framed; reset on stop / mode switch so it never lingers.
  const [barcodeSeen, setBarcodeSeen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // ZXing decoder for the fallback path (iOS Safari / no BarcodeDetector).
  // jsQR reads QR only; ZXing reads QR + Code 128. Loaded lazily (dynamic
  // import, scoped to this route) the first time a camera/upload scan runs;
  // until ready the ref is null and jsQR carries QR. The ref holds a closure
  // that turns an ImageData into the decoded text (or null) so no ZXing types
  // leak into the hot tick loop.
  const zxingRef = useRef<
    ((img: ImageData) => { text: string; cy: number } | null) | null
  >(null);
  const zxingLoadingRef = useRef<Promise<void> | null>(null);
  // Lens zoom state lifted to refs so a tap-to-reset control (outside the scan
  // loop) can zoom back out — the QR auto-zoom-on-fail would otherwise leave the
  // worker stuck zoomed in with no way back (Wei Siang 2026-06-17).
  const zoomTrackRef = useRef<MediaStreamTrack | null>(null);
  const zoomRangeRef = useRef<{ min: number; max: number } | null>(null);
  const curZoomRef = useRef(0);
  // Set true when the worker taps zoom-out, so the auto-zoom-on-fail loop stops
  // yanking the lens back in (without this the reset wasn't durable — it re-zoomed
  // within ~1.1s). Reset to false at the start of each scan session.
  const autoZoomSuppressedRef = useRef(false);
  const ensureZxing = useCallback((): Promise<void> => {
    if (zxingRef.current) return Promise.resolve();
    if (zxingLoadingRef.current) return zxingLoadingRef.current;
    zxingLoadingRef.current = import("@zxing/library")
      .then((zx) => {
        const reader = new zx.MultiFormatReader();
        const hints = new Map<number, unknown>();
        // Enable QR + a spread of common 1D symbologies (owner 2026-06-27: catch
        // codes from any angle / position). CODE_128 is our schedule barcode; the
        // rest (CODE_39 / EAN / UPC / ITF) cost little extra under TRY_HARDER and
        // let an off-the-shelf product barcode also resolve. The downstream lookup
        // still guards on a real WIP/PO, so an unrecognised symbology → Not Found.
        hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
          zx.BarcodeFormat.QR_CODE,
          zx.BarcodeFormat.CODE_128,
          zx.BarcodeFormat.CODE_39,
          zx.BarcodeFormat.EAN_13,
          zx.BarcodeFormat.EAN_8,
          zx.BarcodeFormat.UPC_A,
          zx.BarcodeFormat.UPC_E,
          zx.BarcodeFormat.ITF,
        ]);
        // TRY_HARDER spends more cycles per frame to catch faint / angled codes —
        // the core sensitivity lever. ALSO_INVERTED reads light-on-dark prints.
        hints.set(zx.DecodeHintType.TRY_HARDER, true);
        try {
          // ALSO_INVERTED isn't in every @zxing build's enum TYPINGS — reading
          // it as a direct member was a TS2339 compile error on CI's pinned
          // @zxing (local had it, so it slipped through) and FAILED THE DEPLOY.
          // Read via an index cast so it compiles on any version, and skip at
          // runtime when the value is absent.
          const dhtAny = zx.DecodeHintType as unknown as Record<string, number>;
          if (dhtAny.ALSO_INVERTED != null) {
            (hints as unknown as Map<number, boolean>).set(
              dhtAny.ALSO_INVERTED,
              true,
            );
          }
        } catch {
          /* older @zxing without ALSO_INVERTED — TRY_HARDER still applies */
        }
        reader.setHints(hints);
        zxingRef.current = (img: ImageData) => {
          // RGBA → BT.601 luma (RGBLuminanceSource wants precomputed luminance
          // for a Uint8ClampedArray, not RGBA).
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
            if (!res) return null;
            // Vertical centre of the decoded code (normalised 0..1) from its
            // result points. NOTE: considerHit no longer gates on this — barcode
            // fires INSTANTLY like QR (2026-06-18). cy is kept only for signature
            // parity / a possible future nearest-centre SELECTION tie-break. It
            // must NEVER be used to REJECT a decode — a cy/band reject was the
            // "扫不到" regression. No points → 0.5.
            let cy = 0.5;
            try {
              const pts = res.getResultPoints?.() ?? [];
              if (pts.length) {
                let sum = 0;
                for (const p of pts) sum += p.getY();
                cy = sum / pts.length / height;
              }
            } catch {
              cy = 0.5;
            }
            return { text: res.getText(), cy };
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

  // Tap-to-reset zoom: the QR auto-zoom can leave the lens zoomed in with no way
  // back out; this returns it to the widest setting (Wei Siang 2026-06-17:
  // "QR auto zoom 了不能 zoom 回来小").
  const resetZoom = useCallback(() => {
    const track = zoomTrackRef.current;
    const range = zoomRangeRef.current;
    if (!track || !range) return;
    curZoomRef.current = range.min;
    autoZoomSuppressedRef.current = true; // durable — stop auto-zoom re-escalating
    try {
      void track.applyConstraints({
        advanced: [{ zoom: range.min } as unknown as MediaTrackConstraintSet],
      }).catch(() => {
          /* best-effort — a rejected applyConstraints (Unsupported
             focusMode, Track in an invalid state) must not surface as
             an unhandled rejection; see the header note. */
        });
    } catch {
      /* best-effort */
    }
  }, []);

  // Batch-upload path — worker snaps a bunch of QR stickers during the
  // shift, then uploads them all at once from the gallery. Files are
  // queued and decoded one at a time; after each scan-complete we auto-
  // dequeue the next photo so the worker just keeps tapping "Complete".
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [decoding, setDecoding] = useState(false);
  const [queue, setQueue] = useState<File[]>([]);
  // Snapshot of the batch at the moment the worker selected files —
  // lets us show "2 of 5" without the total shrinking as we dequeue.
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchIndex, setBatchIndex] = useState(0);

  // Today's perf snapshot — loaded on mount, refreshed after each scan
  const [today, setToday] = useState<TodaySnapshot | null>(null);

  // Packing rack picker — shown AFTER a Packing completion (Wei Siang: scan →
  // Complete → then pick the rack below). Options come from /api/worker/racks
  // (the warehouse catalog, Rack 1-20); the choice is saved via
  // /api/worker/packing-rack. Reset per scan in handleConfirmScan.
  const [racks, setRacks] = useState<{ rack: string; occupied: boolean }[]>([]);
  const [rackChoice, setRackChoice] = useState("");
  const [savingRack, setSavingRack] = useState(false);
  const [rackSaved, setRackSaved] = useState(false);
  // Bulk rack stock-in (#52): scan a rack QR (HKRACK:) to enter the mode, then
  // each FG/packing/PO scan accumulates into a list; one "Stock In" puts them
  // all into that rack. Additive — never touches the decode loop or the normal
  // WIP lookup. rackStockInRef mirrors the state so the memoised handleDecoded
  // reads the current value without being re-created on every scan.
  const [rackStockIn, setRackStockIn] = useState<{
    rackId: string;
    items: Array<{
      poId: string;
      poNo: string;
      productCode: string;
      productName: string;
      qty: number;
      manual?: boolean;
    }>;
  } | null>(null);
  const rackStockInRef = useRef(rackStockIn);
  useEffect(() => {
    rackStockInRef.current = rackStockIn;
  }, [rackStockIn]);
  const [rackStockingIn, setRackStockingIn] = useState(false);
  const [rackStockMsg, setRackStockMsg] = useState("");
  // Tiny on-screen diagnostic for barcode mode (Wei Siang 2026-06-17, after
  // several "没反应" rounds): shows video dims, ROI, ZXing-loaded, decode
  // attempts + last raw read, so a failure is observable on the phone instead
  // of guessed at. Updated ~1.5x/sec from the scan loop; QR mode never sets it.
  const [scanDbg, setScanDbg] = useState("");

  // Pull worker ID + home department from cached /me so we can auto-attribute
  // the scan AND show the card for the worker's OWN section on a shared
  // Sew/Uph sticker (女工部 → Fabric Sewing, 男工部 → Upholstery).
  const { workerId, workerDept } = (() => {
    try {
      const raw = localStorage.getItem(WORKER_ME_KEY);
      if (raw) {
        const w = JSON.parse(raw) as { id?: string; departmentCode?: string };
        return {
          workerId: w.id || "",
          workerDept: (w.departmentCode || "").toUpperCase(),
        };
      }
    } catch {
      /* ignore */
    }
    return { workerId: "", workerDept: "" };
  })();
  // Sewing section (女工部) = Fabric Sewing + Fabric Cutting; everyone else
  // (Upholstery, Framing, Foam, …) is treated as the upholstery/man section.
  const isSewWorker = workerDept === "FAB_SEW" || workerDept === "FAB_CUT";
  const isUphWorker = workerDept === "UPHOLSTERY";

  // Guarded — a failed today-snapshot must not break the scanner,
  // which is the primary purpose of this page.
  const loadToday = useCallback(async () => {
    try {
      const d = todayYmdMY();
      const res = await workerFetch(
        `/api/worker/history?from=${d}&to=${d}`,
      );
      const raw = await res.json();
      const j = HistoryEnvelope.parse(raw);
      if (j.success) setToday(j.data as TodaySnapshot);
    } catch {
      /* leave today null — snapshot section just won't render */
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- run loadToday once on mount; setState lives inside the async callback */
  useEffect(() => {
    loadToday();
  }, [loadToday]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Warehouse rack catalog for the Packing rack picker (loaded once on mount).
  const loadRacks = useCallback(async () => {
    try {
      const res = await workerFetch("/api/worker/racks");
      const j = (await res.json()) as {
        success?: boolean;
        data?: { rack: string; occupied: boolean }[];
      };
      if (j.success && Array.isArray(j.data)) {
        // Natural sort so the picker reads Rack 1, 2, 3 … 10, 11 … 20 in order.
        // (The API's `ORDER BY rack` is lexical, so "Rack 10" sorts before
        // "Rack 2" and the list looks jumbled — Wei Siang 2026-06-10.)
        setRacks(
          [...j.data].sort((a, b) =>
            a.rack.localeCompare(b.rack, undefined, { numeric: true }),
          ),
        );
      }
    } catch {
      /* leave empty — the picker just won't populate */
    }
  }, []);
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot rack catalog load on mount */
  useEffect(() => {
    loadRacks();
  }, [loadRacks]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Save the chosen rack onto the packing job card (works even after complete).
  const saveRack = useCallback(async (jobCardId: string, rack: string) => {
    if (!rack) return;
    setSavingRack(true);
    try {
      const res = await workerFetch("/api/worker/packing-rack", {
        method: "POST",
        body: JSON.stringify({ jobCardId, rackingNumber: rack }),
      });
      const j = (await res.json()) as { success?: boolean };
      if (res.ok && j.success) setRackSaved(true);
    } catch {
      /* leave unsaved — the worker can tap Save again */
    } finally {
      setSavingRack(false);
    }
  }, []);

  // #52 — submit the accumulated rack stock-in list to the worker bulk endpoint.
  const submitRackStockIn = useCallback(async () => {
    const rs = rackStockInRef.current;
    if (!rs || rs.items.length === 0) return;
    setRackStockingIn(true);
    setRackStockMsg("");
    try {
      const res = await workerFetch("/api/worker/rack-bulk-stock-in", {
        method: "POST",
        body: JSON.stringify({
          rackLocationId: rs.rackId,
          items: rs.items.map((x) => ({
            productCode: x.productCode,
            productName: x.productName,
            productionOrderId: x.manual ? undefined : x.poId,
            qty: x.qty,
          })),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        count?: number;
        error?: string;
      };
      if (res.ok && j.ok) {
        setRackStockMsg(`✓ Stocked ${j.count ?? rs.items.length} into ${rs.rackId}`);
        setRackStockIn({ rackId: rs.rackId, items: [] });
      } else {
        setRackStockMsg(j.error || "Stock-in failed, please retry");
      }
    } catch {
      setRackStockMsg("Stock-in failed, please retry");
    } finally {
      setRackStockingIn(false);
    }
  }, []);

  // Pure lookup — no state mutation.
  //
  // Job-card id hit → single match (QR scan by op= is always unambiguous).
  // PO-number / order-id hit → return EVERY job card in the matching
  // order(s), optionally filtered by `deptHint`. A bedframe PO produces
  // both Divan and Headboard job cards under one order, so if we only
  // returned the "first active" one the worker could silently complete
  // the wrong piece (scan Divan sticker → mark HB done). Instead we
  // surface the full list and let the chooser handle the pick.
  const findMatches = useCallback(
    async (
      term: string,
      deptHint?: string,
    ): Promise<WipOption[]> => {
      // Worker-scoped lookup: returns ONLY the PO(s) matching `term`, gated by
      // X-Worker-Token (workerFetch attaches it). Replaces the old
      // fetchJson("/api/production-orders") which pulled the whole list and
      // 401'd for worker callers — that endpoint is dashboard-only.
      const qs = new URLSearchParams({ q: term });
      if (deptHint) qs.set("dept", deptHint);
      const res = await workerFetch(`/api/worker/scan-lookup?${qs.toString()}`);
      // Degrade gracefully: a non-OK response or a non-JSON / odd-shape body
      // must NOT throw here. An uncaught throw bubbles to the caller's catch and
      // shows the scary "出错了 / Something went wrong" card (Wei Siang
      // 2026-06-17: barcode scan → something went wrong) instead of a useful
      // "Not found". res.ok guard + safeParse turn any backend hiccup into an
      // empty result, so the worker sees "Not found: <token>" and can retry.
      if (!res.ok) return [];
      const json = await res.json().catch(() => null);
      const pr = json ? POListEnvelope.safeParse(json) : null;
      if (!pr?.success) return [];
      const env = pr.data;
      if (!env.success || !env.data) return [];
      const orders = env.data as unknown as Order[];
      // Job-card id / barcode token — unique → return the single hit and stop.
      // Match the stored id directly (a QR sticker's op=<id>) OR the short
      // schedule-barcode token re-derived from (poId, wipKey, dept).
      for (const o of orders) {
        const jc = o.jobCards.find(
          (j) =>
            j.id === term ||
            deriveBarcodeToken(j.id, j.departmentCode) === term,
        );
        if (jc) return [{ order: o, jobCard: jc }];
      }
      // PO number / order id — collect ALL job cards in the matching
      // orders. Filter by deptHint when the QR encoded a `dept=` so we
      // only show (Divan WD vs HB WD) instead of the full pipeline.
      const matches: WipOption[] = [];
      for (const o of orders) {
        if (o.poNo.toLowerCase() === term.toLowerCase() || o.id === term) {
          const dept = deptHint?.toUpperCase();
          const cards = dept
            ? o.jobCards.filter((j) => j.departmentCode.toUpperCase() === dept)
            : o.jobCards;
          for (const jc of cards) matches.push({ order: o, jobCard: jc });
        }
      }
      return matches;
    },
    [],
  );

  // Owner 2026-06-26 unified scan model: a worker may only complete WIPs for
  // their CURRENT department (= the dept QR they last scanned, else their punch
  // / home dept). Resolve the scanned card's department and, if it differs,
  // surface the "wrong department" popup and STOP (the worker must scan that
  // dept's QR first). Fail-open: any lookup error → don't block (never wedge a
  // legitimate scan because the current-dept check hiccuped).
  const blockIfWrongDept = useCallback(
    async (jc: JobCard): Promise<boolean> => {
      const stickerDept = (jc.departmentCode || "").trim().toUpperCase();
      if (!stickerDept) return false; // unknown dept (e.g. shared sticker) — don't block here
      try {
        const res = await workerFetch("/api/worker/current-dept");
        if (!res.ok) return false;
        const j = (await res.json().catch(() => null)) as {
          success?: boolean;
          data?: { currentDept?: string };
        } | null;
        const cur = (j?.data?.currentDept || "").trim().toUpperCase();
        if (cur && cur !== stickerDept) {
          setResult({ kind: "deptBlock", currentDept: cur, stickerDept });
          return true;
        }
      } catch {
        /* fail-open */
      }
      return false;
    },
    [],
  );

  const doLookup = useCallback(
    async (query?: string) => {
      const term = (query ?? input).trim();
      if (!term) return;
      setLoading(true);
      setResult({ kind: "idle" });
      try {
        const matches = await findMatches(term);
        if (matches.length === 1) {
          setResult({ kind: "lookup", ...matches[0] });
        } else if (matches.length > 1) {
          setResult({ kind: "choices", options: matches });
        } else {
          setResult({ kind: "error", message: `Not found: ${term}` });
        }
      } catch {
        setResult({ kind: "error", message: t("common.error") });
      } finally {
        setLoading(false);
      }
    },
    [input, t, findMatches],
  );

  // Turn a decoded QR payload into a lookup — factored out so both the
  // live-scan loop and the file-based decoder share one path.
  //
  // Fallback strategy: our stickers encode BOTH a job-card id (`op=`) and
  // a PO number (`po=`). We try the op id first (most specific); if it
  // misses — typically because the test data got re-imported and the
  // job-card id rotated — we retry with the PO number FILTERED BY DEPT.
  // Without the dept filter, scanning a Divan WOOD_CUT sticker would fall
  // back to the PO and auto-pick the first "active" job card, which could
  // be the HB piece. The dept filter keeps the fallback scoped to same-
  // dept WIPs only (Divan WD vs HB WD) so the chooser surfaces them.
  //
  // `p` / `t` from the QR payload get threaded through as a `PieceInfo`
  // so the lookup card can show "Piece 2 of 3" — scanning sticker 1/2 vs
  // 2/2 on a qty=2 job card is otherwise indistinguishable.
  const handleDecoded = useCallback(
    async (raw: string) => {
      // Packing/FG stickers now encode the PUBLIC rack page (/p/<token>) so a
      // storekeeper with NO Worker-Portal login can scan + choose a rack. But the
      // INTERNAL scan must STILL do the full flow (mark complete + set rack, and
      // it repeats on a 2nd/3rd scan). We do NOT rebuild that flow — we resolve
      // the token back to its poNo + piece label and rewrite the value as the
      // LEGACY `op=FG-PACKING` deep-link this handler already understands, so
      // every downstream behaviour (completion, rack picker, rack stock-in mode)
      // is the EXISTING, unchanged code. The public /p/ page is untouched.
      const pToken = /\/p\/([0-9a-f]{64})(?:[/?#]|$)/i.exec(raw);
      if (pToken) {
        let rebuilt = "";
        try {
          const r = await fetch(`/api/public/rack-write/${pToken[1]}`, {
            credentials: "include",
          });
          const j = (await r.json().catch(() => null)) as {
            success?: boolean;
            data?: { poNo?: string; description?: string };
          } | null;
          if (r.ok && j?.success && j.data?.poNo) {
            const origin =
              typeof window !== "undefined" && window.location?.origin
                ? window.location.origin
                : "";
            rebuilt = `${origin}/worker/scan?op=FG-PACKING&po=${encodeURIComponent(
              j.data.poNo,
            )}&pn=${encodeURIComponent(j.data.description ?? "")}`;
          }
        } catch {
          /* network/parse fail → handled as not-recognised below */
        }
        if (!rebuilt) {
          setResult({ kind: "error", message: t("common.error"), decoded: raw });
          return;
        }
        // Rewrite the scanned value to the legacy FG-PACKING deep-link; every
        // line below this point is the existing, unchanged handler.
        raw = rebuilt;
      }
      // Rack bulk stock-in (#52). A rack QR (HKRACK:<id>) enters/keeps the mode;
      // while in it, every subsequent FG/packing/PO scan is ADDED to that rack's
      // list instead of doing a normal WIP lookup. Checked first so a rack scan
      // never falls into the job-card path.
      const scannedRackId = parseRackQr(raw);
      if (scannedRackId) {
        setRackStockMsg("");
        setRackStockIn((prev) =>
          prev && prev.rackId === scannedRackId
            ? prev
            : { rackId: scannedRackId, items: prev?.items ?? [] },
        );
        setResult({ kind: "idle" });
        return;
      }
      if (rackStockInRef.current) {
        // Manual item QR (HKITEM:<name>[|<code>]) — a non-system item; add it by
        // its name, no PO lookup.
        const manualItem = parseItemQr(raw);
        if (manualItem) {
          const key = `manual:${manualItem.code || manualItem.name}`;
          setRackStockMsg("");
          setRackStockIn((prev) => {
            if (!prev) return prev;
            const items = [...prev.items];
            const i = items.findIndex((x) => x.poId === key);
            if (i >= 0) {
              items[i] = { ...items[i], qty: items[i].qty + 1 };
            } else {
              items.push({
                poId: key,
                poNo: "Manual",
                productCode: manualItem.code || manualItem.name,
                productName: manualItem.name,
                qty: 1,
                manual: true,
              });
            }
            return { ...prev, items };
          });
          return;
        }
        // Only FG/packing stickers (op=FG-*) stock IN here. A dept-changeover QR
        // or a WIP job-card barcode must STILL do its normal action even with the
        // rack panel open — otherwise a worker who forgot to tap 退出 silently
        // loses a dept clock-in or a WIP completion (audit C1, 2026-06-17). So if
        // this isn't an FG sticker, DON'T return — fall through to the handlers
        // below.
        const rs0 = parseStickerData(raw);
        const isFgSticker = !!rs0?.opId && /^FG-/i.test(rs0.opId);
        if (isFgSticker && rs0?.poNo) {
          let order: Order | undefined;
          try {
            order = (await findMatches(rs0.poNo))[0]?.order;
          } catch {
            order = undefined;
          }
          if (!order) {
            setRackStockMsg(`Not recognised: ${rs0.poNo}`);
            return;
          }
          const matched = order;
          setRackStockMsg("");
          setRackStockIn((prev) => {
            if (!prev) return prev;
            const items = [...prev.items];
            const i = items.findIndex((x) => x.poId === matched.id);
            if (i >= 0) {
              items[i] = { ...items[i], qty: items[i].qty + 1 };
            } else {
              items.push({
                poId: matched.id,
                poNo: matched.poNo,
                productCode: matched.productCode,
                productName: matched.productName || matched.productCode,
                qty: 1,
              });
            }
            return { ...prev, items };
          });
          return;
        }
        // Not a stock-in item → fall through to dept-scan / WIP / normal lookup.
      }
      // A manual item QR (HKITEM:) scanned OUTSIDE rack stock-in mode has no PO
      // to look up — show what it is + how to use it, not a blank "not found".
      const manualOutside = parseItemQr(raw);
      if (manualOutside) {
        setResult({
          kind: "error",
          message: `Manual item: ${manualOutside.name}. Scan a rack QR first to stock it in.`,
          decoded: raw,
        });
        return;
      }
      // Department QR (deptscan=<CODE> in the QR's URL) — not a job card.
      // Tells payroll "I am now working in this department"; handled before
      // any sticker parsing so it can never fall into the JC lookup.
      const deptScan = /[?&]deptscan=([A-Za-z_]+)/.exec(raw);
      if (deptScan) {
        const code = decodeURIComponent(deptScan[1]).toUpperCase();
        // Per-line QR (owner v2): deptcat=SOFA / BEDFRAME / ACCESSORY tells
        // payroll WHICH line, not just which department.
        const catMatch = /[?&]deptcat=([A-Za-z_]+)/.exec(raw);
        const cat = catMatch ? decodeURIComponent(catMatch[1]).toUpperCase() : null;
        setLoading(true);
        setResult({ kind: "idle" });
        try {
          const res = await workerFetch("/api/worker/dept-scan", {
            method: "POST",
            body: JSON.stringify({ departmentCode: code, category: cat }),
          });
          const j = (await res.json().catch(() => ({}))) as {
            success?: boolean;
            error?: string;
            data?: { departmentName?: string; category?: string | null; time?: string };
          };
          if (j?.success && j.data) {
            setResult({
              kind: "deptscan",
              deptName: j.data.departmentName || code,
              category: j.data.category ?? null,
              time: j.data.time || "",
            });
          } else {
            setResult({
              kind: "error",
              message:
                j?.error === "PUNCH_IN_FIRST"
                  ? t("scan.deptNeedPunchIn")
                  : t("common.error"),
            });
          }
        } catch {
          setResult({ kind: "error", message: t("common.error") });
        } finally {
          setLoading(false);
        }
        return;
      }
      // Code 128 WIP barcode (HKJC:<jobCardId>) printed on the Production
      // Schedule — the linear-scan twin of the QR for the no-sticker depts
      // (Woodcutting / Framing / Webbing). It's a bare id, not a URL, so it's
      // handled before parseStickerData. One scan completes the WHOLE WIP
      // (every piece → the scanning worker), matching the owner's "mark this
      // item complete" intent and the no-sticker batch workflow.
      const barcodeJcId = parseJobCardBarcode(raw);
      if (barcodeJcId) {
        setInput(barcodeJcId);
        setLoading(true);
        setResult({ kind: "idle" });
        setRackChoice("");
        setRackSaved(false);
        try {
          const matches = await findMatches(barcodeJcId);
          // BUG-2026-08-13-145. This was `… ?? matches[0]`, and `matches[0]`
          // is NOT interchangeable with "the card that was scanned".
          // `findMatches` has two branches: an id/token branch that returns the
          // ONE exact hit, and a PO-number branch that returns EVERY job card
          // on the order. The `.find` misses on the token form (the match was
          // on `deriveBarcodeToken`, not on the stored id), so `matches[0]` was
          // the working path — and it is also what a many-card result hands
          // back, arbitrarily. The card then went out under `wholeCard: true`,
          // i.e. the worker completes an entire card they never scanned.
          //
          // So accept `matches[0]` only when it is the ONLY claimant. Being the
          // sole candidate is an observation; being first in a list of several
          // is a guess. Same rule the `parsed.jobCardId` path 50 lines below
          // already applies by having no fallback at all.
          const hit =
            matches.find((m) => m.jobCard.id === barcodeJcId) ??
            (matches.length === 1 ? matches[0] : undefined);
          if (hit) {
            if (await blockIfWrongDept(hit.jobCard)) return;
            setResult({ kind: "lookup", ...hit, wholeCard: true });
          } else {
            setResult({
              kind: "error",
              message: `Not found: ${barcodeJcId}`,
              decoded: raw,
            });
          }
        } catch {
          setResult({ kind: "error", message: t("common.error"), decoded: raw });
        } finally {
          setLoading(false);
        }
        return;
      }
      const parsed = parseStickerData(raw);
      const primaryTerm = parsed?.opId || raw;
      const deptHint = parsed?.deptCode;
      const piece: PieceInfo | undefined =
        parsed?.pieceNo && parsed?.totalPieces
          ? { pieceNo: parsed.pieceNo, totalPieces: parsed.totalPieces }
          : undefined;
      // For an FG-sentinel sticker (FG-FAB_CUT / FG-FAB_SEW) show the PO
      // number in the box, not the raw sentinel — the worker shouldn't see
      // "FG-FABCUT".
      setInput(
        (parsed?.wipKey ||
          parsed?.compartment ||
          /^FG-[A-Z_]+$/.test(primaryTerm)) &&
          parsed?.poNo
          ? parsed.poNo
          : primaryTerm,
      );
      setLoading(true);
      setResult({ kind: "idle" });
      setRackChoice("");
      setRackSaved(false);
      try {
        // FG-PACKING stickers now also carry jc=<packing job_card id> (TASK 2).
        // The card id is immune to poNo drift — the very reason the po= lookup
        // can dead-end at the LOGIN page on an external phone. Resolve by it
        // FIRST: a single clean hit short-circuits to the SAME lookup card the
        // po=/pn= flow would build (the PACKING card keeps its real jc id →
        // rack picker + per-piece Complete are the existing, unchanged code).
        // Anything else falls through to every existing path below, so old
        // stickers (no jc) and drifted/rotated ids behave exactly as before.
        if (parsed?.jobCardId) {
          const jcMatches = await findMatches(parsed.jobCardId);
          const hit = jcMatches.find((m) => m.jobCard.id === parsed.jobCardId);
          if (hit) {
            if (await blockIfWrongDept(hit.jobCard)) return;
            setResult({ kind: "lookup", ...hit, piece });
            return;
          }
        }
        // Shared Sew/Uph compartment sticker. The QR carries EITHER the short
        // compartment code (c=<subtype>, e.g. DIVAN / SOFA_BASE — the low-density
        // form that scans reliably) OR the legacy full wipKey (wk=). Resolve the
        // ONE matching compartment card on this PO and show it directly — never
        // the multi-card chooser. (A Divan sticker must complete the Divan, not
        // prompt Divan-vs-Headboard.) The completing department is decided
        // server-side from the worker's section; for the lookup card we show the
        // earliest-incomplete dept of this compartment so the shown dept matches.
        if ((parsed?.wipKey || parsed?.compartment) && parsed?.poNo) {
          const wkCards = (await findMatches(parsed.poNo)).filter((m) =>
            parsed.wipKey
              ? (m.jobCard.wipKey || "") === parsed.wipKey
              : (m.jobCard.wipKey || "").split("::")[2] === parsed.compartment,
          );
          if (wkCards.length > 0) {
            const sew = wkCards.find(
              (m) => m.jobCard.departmentCode === "FAB_SEW",
            );
            const uph = wkCards.find(
              (m) => m.jobCard.departmentCode === "UPHOLSTERY",
            );
            const sewOpen =
              !!sew &&
              sew.jobCard.status !== "COMPLETED" &&
              sew.jobCard.status !== "TRANSFERRED";
            // Show the card for the WORKER'S OWN section, NOT whichever stage is
            // open (Wei Siang 2026-06-15): a 女工部 scan always shows Fabric
            // Sewing — even after Sewing is done it reports "already done", it
            // never auto-jumps to Upholstery; a 男工部 scan always shows
            // Upholstery. The server makes the final call from the token; this
            // only chooses which card to display. Unknown section → legacy
            // sew-open heuristic.
            const pick =
              (isSewWorker
                ? (sew ?? uph)
                : isUphWorker
                  ? (uph ?? sew)
                  : sewOpen
                    ? sew
                    : (uph ?? sew)) ?? wkCards[0];
            if (pick) {
              setResult({
                kind: "lookup",
                order: pick.order,
                jobCard: pick.jobCard,
                piece,
                // carry the resolved card's FULL wipKey (a c= sticker only had the
                // subtype) so handleConfirmScan routes to scan-complete-shared.
                wipKey: pick.jobCard.wipKey || parsed.wipKey,
              });
              return;
            }
          }
          // didn't resolve on this PO — fall through to the normal lookup / error
          // paths so the worker still gets a meaningful message.
        }
        // Merged FG-level sticker — opId is a dept sentinel, not a real jc id,
        // so findMatches by opId would be empty. Jump to the PO lookup filtered
        // by the dept embedded in the sentinel. FAB_CUT / FAB_SEW swap the
        // match's jobCard id to the sentinel so it routes to the fan-out
        // endpoints (scan-complete-dept / -shared). Any OTHER FG sticker (e.g.
        // FG-PACKING on the finished-good packing label) KEEPS its real jc id
        // so it routes to the normal per-piece /scan-complete (and the PACKING
        // success card shows the rack picker).
        const fgMatch = /^FG-([A-Z_]+)$/.exec(primaryTerm);
        const isFanoutSentinel =
          fgMatch?.[1] === "FAB_CUT" || fgMatch?.[1] === "FAB_SEW";
        let matches = fgMatch && parsed?.poNo
          ? (await findMatches(parsed.poNo, fgMatch[1])).map((m) => ({
              ...m,
              jobCard: isFanoutSentinel
                ? { ...m.jobCard, id: primaryTerm }
                : m.jobCard,
            }))
          : await findMatches(primaryTerm, deptHint);
        if (matches.length === 0 && parsed?.poNo && parsed.poNo !== primaryTerm && !fgMatch) {
          // PO fallback — visible to the user so they understand the
          // lookup shifted scope when the op id went cold. Pass deptHint
          // through so we don't merge Divan + HB job cards together.
          setInput(parsed.poNo);
          matches = await findMatches(parsed.poNo, deptHint);
        }
        // FG dept sentinels (FG-PACKING) carry pn=<box piece label>. A multi-
        // compartment PO (bedframe Divan + Headboard) returns >1 dept card;
        // narrow to the ONE whose wipLabel contains the box label so the worker
        // isn't prompted to pick. If it can't narrow to exactly one, keep the
        // list as-is (falls through to the chooser — safe + backward compatible).
        if (fgMatch && parsed?.pieceLabel && matches.length > 1) {
          const want = parsed.pieceLabel.trim().toUpperCase();
          const narrowed = matches.filter((m) =>
            (m.jobCard.wipLabel ?? "").toUpperCase().includes(want),
          );
          if (narrowed.length === 1) matches = narrowed;
        }
        if (matches.length === 1) {
          // Show the lookup card and STOP — the worker must tap the big
          // "Complete" button to commit. (Wei Siang 2026-06-04: a bare scan
          // auto-completing was too easy to trigger by accident — a stray
          // QR in view would mark a job done. Require an explicit confirm
          // tap. The lookup card already renders the item details + a
          // Complete / Cancel pair; handleConfirmScan runs only on tap.)
          if (await blockIfWrongDept(matches[0].jobCard)) return;
          setResult({ kind: "lookup", ...matches[0], piece });
        } else if (matches.length > 1) {
          setResult({ kind: "choices", options: matches, piece });
        } else {
          // Preserve the raw QR string so the worker sees the photo DID
          // decode — the problem is that neither the job-card id nor the
          // PO number is in the current data set.
          setResult({
            kind: "error",
            message: `Not found: ${primaryTerm}${parsed?.poNo && parsed.poNo !== primaryTerm ? ` / ${parsed.poNo}` : ""}`,
            decoded: raw,
          });
        }
      } catch {
        setResult({ kind: "error", message: t("common.error"), decoded: raw });
      } finally {
        setLoading(false);
      }
    },
    [findMatches, t, isSewWorker, isUphWorker],
  );

  // If the page is opened from a sticker URL (the phone's native camera, or a
  // tapped link) like /worker/scan?op=… or ?wk=…, run the FULL url through the
  // same decoder the in-app camera uses so EVERY sticker shape is processed on
  // open — including the shared Sew/Uph compartment sticker (wk=, which has NO
  // op). Declared AFTER handleDecoded so there's no use-before-declare. Before
  // this, only `op` was handled, so a Fabric Sewing wk sticker opened by URL did
  // nothing at all ("完全没有反应").
  useEffect(() => {
    // deptscan: a department/line QR scanned with the phone's NATIVE camera
    // (not the in-app scanner) also lands here as a URL — without this gate
    // entry the wall poster would open the page and silently do nothing.
    if (params.get("op") || params.get("wk") || params.get("deptscan")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot deep-link hydrate on mount; handleDecoded sets state synchronously
      void handleDecoded(window.location.href);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Live camera scan ----------

  const stopLiveScan = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch { /* */ }
    }
    setLiveScanning(false);
    setTorchOn(false);
    setBarcodeSeen(false);
    setTorchSupported(false);
  }, []);

  // Torch / flashlight toggle. A dim warehouse / loading bay is a top cause of a
  // Code 128 "scan 不到" — the camera can't resolve the thin bars without light.
  // Best-effort: only Android Chrome exposes `torch` via applyConstraints (iOS
  // Safari doesn't), so the button only renders when getCapabilities() reports
  // it (see the camera-init block) and a failed toggle is swallowed.
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

  const startLiveScan = useCallback(async () => {
    // Can't start twice — and don't redundantly re-acquire. If a live stream is
    // already held (the scanner is open, or a previous open didn't fully tear
    // down), reuse it instead of calling getUserMedia again. A second
    // getUserMedia is the redundant request that some browsers surface as a
    // fresh permission churn, so we avoid it whenever we still own a stream.
    if (liveScanning) return;
    if (streamRef.current && streamRef.current.getVideoTracks().some((tr) => tr.readyState === "live")) {
      setLiveScanning(true);
      return;
    }
    setResult({ kind: "idle" });
    // Passive pre-check: if the Permissions API says the camera is already
    // granted, getUserMedia below resolves WITHOUT a prompt — we still must
    // call it to obtain the stream, but we know not to expect (or explain) a
    // prompt. A 'denied' result means getUserMedia will reject instantly with
    // NotAllowedError (no prompt either) — handled by the catch below. We do
    // NOT branch behaviour on the result (getUserMedia is required regardless);
    // the probe just keeps the flow honest and avoids any prompt-explanation UX
    // firing when the grant already exists. Unsupported (iOS Safari) → fall
    // through unchanged.
    void probeCameraState();
    try {
      // Prefer the rear camera. Ask for a sharp feed (1080p) — small or
      // arm's-length QR stickers need the extra detail to lock on. The
      // native detector handles full-res fine, and the jsQR fallback
      // downscales from a sharper source than before.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          // 1440p soft "ideal" — the browser gives the closest the lens supports
          // (falls back to 1080p on older phones, never fails). More pixels let
          // both decode paths resolve a small / far / angled sticker QR (owner
          // 2026-07-03, mirrors the rack-scan sensitivity fix).
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      streamRef.current = stream;
      // Best-effort: ask the camera for continuous autofocus. A big reason a
      // QR "won't scan" is the lens sitting at a fixed focus so the sticker
      // stays blurry — continuous AF keeps it sharp as the worker moves the
      // phone. Silently ignored on hardware/browsers that don't expose it.
      try {
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & {
              focusMode?: string[];
              torch?: boolean;
            })
          | undefined;
        if (caps?.focusMode && caps.focusMode.includes("continuous")) {
          await track.applyConstraints({
            advanced: [
              { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
            ],
          });
        }
        // Surface the torch button only when this lens actually supports it.
        setTorchSupported(!!caps?.torch);
      } catch {
        /* focus tuning is a nicety, never block the scan on it */
      }
      setLiveScanning(true);
      // Video element attach + RAF loop happens in the effect below.
    } catch (e) {
      // Tell a PERMISSION block apart from no-camera/HTTPS problems. After a
      // hard "Block" the browser remembers and getUserMedia rejects instantly
      // WITHOUT showing the prompt again — no code can force it back, so the
      // only fix is the worker unblocking it at the address bar. (A dismissed
      // prompt stays "ask": every new tap on Scan QR re-prompts — that part
      // already works.) Everything else keeps the generic message + the
      // Take photo / Upload photo fallbacks.
      const name = e instanceof DOMException ? e.name : "";
      setResult({
        kind: "error",
        message:
          name === "NotAllowedError" || name === "SecurityError"
            ? t("scan.cameraDenied")
            : t("scan.cameraFail"),
      });
    }
  }, [liveScanning, t]);

  // When liveScanning flips on, wire the stream into the <video> and
  // start the per-frame jsQR loop. Cleanup on flip-off / unmount.
  useEffect(() => {
    if (!liveScanning) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.setAttribute("playsinline", "true"); // iOS: no fullscreen hijack
    video.muted = true;
    video.play().catch(() => {});

    // Shared offscreen canvas — cheaper than allocating on every tick.
    if (!scanCanvasRef.current) {
      scanCanvasRef.current = document.createElement("canvas");
    }
    const canvas = scanCanvasRef.current;

    // Primary path: the phone's native, hardware-accelerated QR detector
    // (Android Chrome). It reads small / angled / slightly-blurred stickers
    // straight off the live <video> — the cases where jsQR struggles. We
    // fall back to jsQR (iOS Safari, older browsers) when it's absent, or
    // mid-session if a device exposes it but throws on detect.
    let nativeDetector: BarcodeDetectorLike | null = null;
    if (typeof window !== "undefined" && window.BarcodeDetector) {
      try {
        // Read the square QR plus a spread of common 1D symbologies (owner
        // 2026-06-27 sensitivity ask). code_128 is the Production-Schedule
        // barcode; the rest let any off-the-shelf product barcode resolve too.
        // On Android Chrome this is the fast hardware path for all of them.
        nativeDetector = new window.BarcodeDetector({
          formats: [
            "qr_code",
            "code_128",
            "code_39",
            "ean_13",
            "ean_8",
            "upc_a",
            "upc_e",
            "itf",
          ],
        });
      } catch {
        // A device that rejects the wider list still gets QR + Code 128; failing
        // that, QR only. Anything missing falls to the ZXing path below.
        try {
          nativeDetector = new window.BarcodeDetector({
            formats: ["qr_code", "code_128"],
          });
        } catch {
          try {
            nativeDetector = new window.BarcodeDetector({
              formats: ["qr_code"],
            });
          } catch {
            nativeDetector = null;
          }
        }
      }
    }
    // iOS Safari / older browsers have no BarcodeDetector. jsQR reads QR only,
    // so kick off the ZXing loader (reads QR + Code 128) for the fallback path.
    void ensureZxing();

    let stopped = false;
    let lastDecode = 0;
    // Native detect is cheap → scan more often (~16/s); jsQR is heavier (~11/s).
    const THROTTLE_MS = nativeDetector ? 60 : 90;

    // Adaptive zoom-on-fail (Wei Siang 2026-06-15: auto-zoom for dense codes).
    // Read the lens zoom range ONCE. Easy codes decode in the first ~1.8s at the
    // default zoom and never trigger this; only a code the worker has been
    // pointing at with no luck — a small / dense Code 128 — escalates the zoom so
    // it fills more of the frame. Capped at 60% of the range so it never tunnels
    // in so far that framing becomes impossible, and it resets every scan session
    // (a fresh getUserMedia starts at default zoom). Best-effort: silently off
    // where the platform doesn't expose zoom (most desktops / some phones).
    const zoomTrack = stream.getVideoTracks?.()[0] ?? null;
    zoomTrackRef.current = zoomTrack;
    let zoomRange: { min: number; max: number } | null = null;
    let lastZoomAt = 0;
    // Focus-pulse state (owner 2026-06-27): held perfectly still, the lens stops
    // re-hunting and the frame stays soft → nothing decodes (the "只有动的时候才
    //扫到"). We periodically nudge autofocus to mimic that movement.
    let lastFocusPulseAt = 0;
    let focusPulseDir = 1;
    try {
      const zc = (
        zoomTrack?.getCapabilities?.() as
          | (MediaTrackCapabilities & { zoom?: { min?: number; max?: number } })
          | undefined
      )?.zoom;
      if (
        zc &&
        typeof zc.min === "number" &&
        typeof zc.max === "number" &&
        zc.max > zc.min
      ) {
        zoomRange = { min: zc.min, max: zc.max };
      }
    } catch {
      zoomRange = null;
    }
    zoomRangeRef.current = zoomRange;
    curZoomRef.current = zoomRange ? zoomRange.min : 0;
    autoZoomSuppressedRef.current = false;
    setZoomSupported(!!zoomRange);
    const scanStartedAt = performance.now();
    // Reset the lens to its widest on every (re)start so toggling modes doesn't
    // inherit the previous mode's zoom — a zoomed-in lens crops a wide barcode.
    if (zoomRange && zoomTrack) {
      try {
        void zoomTrack.applyConstraints({
          advanced: [{ zoom: zoomRange.min } as unknown as MediaTrackConstraintSet],
        }).catch(() => {
          /* best-effort — a rejected applyConstraints (Unsupported
             focusMode, Track in an invalid state) must not surface as
             an unhandled rejection; see the header note. */
        });
      } catch {
        /* best-effort */
      }
    }

    const onHit = (data: string) => {
      if (stopped || !data) return;
      stopped = true;
      // Cyan confirm flash so QR matches the barcode tap feedback — both modes now
      // flash 青色 on a successful read (owner 2026-06-18). QR has no tap point, so
      // centre the ring on the video; a brief delay lets it show before the overlay
      // unmounts for the result card.
      const v = videoRef.current;
      if (v && v.clientWidth > 0) {
        setTapFx({ x: v.clientWidth / 2, y: v.clientHeight / 2, state: "hit" });
      }
      // eslint-disable-next-line no-restricted-syntax -- brief one-shot delay so the cyan confirm is visible before navigating
      window.setTimeout(() => {
        stopLiveScan();
        void handleDecoded(data);
      }, 250);
    };

    // Barcode-mode diagnostic counters (drive scanDbg).
    let bcN = 0;
    let bcLast = "";
    let bcDbgAt = 0;
    // Barcode = TAP-TO-PICK (owner 2026-06-18). The printed schedule stacks 3-4
    // Code 128s ~1cm apart, ALL near frame centre — so NO automatic rule can win:
    // instant-fire grabbed a NEIGHBOUR before the worker aimed, and any hold never
    // completed because the nearest-centre winner FLICKERS between the stacked rows
    // (→ "完全没有反应"). Both poles are unwinnable for AUTO selection on a dense
    // stack. So barcode mode does NOT auto-fire from this loop at all: the worker
    // TAPS the exact row he wants and `tapScanBarcode` decodes a FULL-WIDTH band
    // around the tap (one-shot — a thin band on a deliberate tap can NEVER cause
    // the continuous "扫不到" an always-on crop did; a miss just buzzes for a
    // re-tap). The loop below still decodes but considerHit ignores it in barcode
    // mode. QR mode is unchanged: one sticker in view → fire on first decode.
    // See [[project_hookka_barcode_roi]].
    // Owner 2026-06-27: barcode scanning must be MORE sensitive — auto-fire on
    // the full-frame decode (off-centre / angled / left-right-diagonal codes
    // included), with the SAME cyan/red ring feedback as QR. The loop already
    // decodes the FULL frame and, in barcode mode, picks the SINGLE code nearest
    // the frame centre (a SELECTION that biases toward the row the worker aimed
    // at without ever rejecting). So auto-fire now flows through for BOTH modes;
    // tap-to-pick (tapScanBarcode) remains as a deliberate disambiguation for a
    // dense stacked schedule. The nearest-centre selection upstream keeps a lone
    // barcode reliably caught while still favouring the aimed row when several
    // are visible.
    const considerHit = (data: string, _cy = 0.5) => {
      if (stopped || !data) return;
      onHit(data); // QR + barcode: instant, full-frame, nearest-centre selected
    };

    const tick = async () => {
      if (stopped) return;
      const now = performance.now();
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
            if (scanMode === "barcode") {
              // Owner 2026-06-27: DO NOT auto-fire in barcode mode. A stacked
              // schedule shows 3-4 barcodes in one frame and auto-picking the
              // nearest-centre code grabbed the WRONG row ("它会随便检测"). Instead
              // we only DETECT whether a (non-QR) barcode is in view → the overlay
              // turns its aim frame BLUE ("显蓝色") so the worker knows it's ready,
              // and he TAPS the exact row he wants (tapScanBarcode decodes the
              // tapped row) to actually scan it. No fire here.
              let seen = false;
              for (const c of codes) {
                if (!c.rawValue) continue;
                const fmt = (c as { format?: string }).format;
                if (fmt && fmt === "qr_code") continue; // QR mode owns QR
                seen = true;
                break;
              }
              setBarcodeSeen(seen);
              // fall through to reschedule (no fire, no zoom in barcode mode)
            } else if (codes.length > 0 && codes[0].rawValue) {
              considerHit(codes[0].rawValue);
              return;
            }
          } catch {
            // Exposed but flaky — drop to jsQR for the rest of the session.
            nativeDetector = null;
          }
        } else {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            if (scanMode === "barcode") {
              // Decode the FULL frame — exactly like QR mode, which reads this
              // same Code 128 fine. A cropped band is what kept breaking barcode
              // mode ("扫不到"); the stable-hold (considerHit) is what lets the
              // worker aim, so no crop is needed. ~1280px working width keeps the
              // Code 128 bars sharp. ZXing is the sole Code 128 decoder on iOS.
              const s = Math.min(1, 1280 / Math.max(vw, vh));
              const cw = Math.max(1, Math.round(vw * s));
              const ch = Math.max(1, Math.round(vh * s));
              canvas.width = cw;
              canvas.height = ch;
              ctx.drawImage(video, 0, 0, cw, ch);
              let imageData: ImageData | null = null;
              try {
                imageData = ctx.getImageData(0, 0, cw, ch);
              } catch {
                imageData = null;
              }
              // jsQR is QR-only — ZXing is the SOLE Code 128 decoder on iOS. If it
              // hasn't loaded yet (cold start) or its chunk 404'd after a redeploy,
              // keep (re)kicking the import so barcode mode self-heals instead of
              // staying silently dead.
              const zxDecode = zxingRef.current;
              if (!zxDecode) {
                void ensureZxing();
                if (now - bcDbgAt > 600) {
                  bcDbgAt = now;
                  setScanDbg(`v:${vw}×${vh} zx:loading… n:${bcN}`);
                }
              } else if (imageData) {
                const zx = zxDecode(imageData);
                bcN++;
                if (zx) bcLast = zx.text;
                if (now - bcDbgAt > 600) {
                  bcDbgAt = now;
                  setScanDbg(
                    `v:${vw}×${vh} full zx:✓ n:${bcN} ${bcLast ? bcLast.slice(0, 14) : "—"}`,
                  );
                }
                // Owner 2026-06-27: detect-only, NO auto-fire (see native path).
                // A decoded barcode in view → blue "tap to scan" cue; the worker
                // taps the row he wants (tapScanBarcode) to scan it. iOS has no
                // bbox/centre selection so auto-pick would be a coin-flip among a
                // stacked list — exactly what tap-to-pick avoids.
                setBarcodeSeen(!!zx);
              }
            } else {
              // QR mode: full frame, jsQR first then ZXing (reads QR + Code 128).
              // Decode at 1440px (was 960) so a small / far / angled sticker QR
              // keeps enough module detail for the finder patterns to resolve.
              const scale = Math.min(1, 1440 / Math.max(vw, vh));
              const cw = Math.max(1, Math.round(vw * scale));
              const ch = Math.max(1, Math.round(vh * scale));
              canvas.width = cw;
              canvas.height = ch;
              ctx.drawImage(video, 0, 0, cw, ch);
              let imageData: ImageData | null = null;
              try {
                imageData = ctx.getImageData(0, 0, cw, ch);
              } catch {
                // CORS-tainted canvas — shouldn't happen with local video,
                // but guard anyway so the loop doesn't die.
                imageData = null;
              }
              if (imageData) {
                // attemptBoth also reads inverted (light-on-dark) prints; the
                // small extra cost is worth the higher hit rate on a phone.
                const code = jsQR(imageData.data, cw, ch, {
                  inversionAttempts: "attemptBoth",
                });
                if (code && code.data) {
                  considerHit(code.data);
                  return;
                }
                // jsQR is QR-only — ZXing adds Code 128 (and QR) on the fallback
                // path (iOS/older browsers). Loaded lazily; null until ready.
                const zxDecode = zxingRef.current;
                if (zxDecode) {
                  const zx = zxDecode(imageData);
                  if (zx) {
                    onHit(zx.text); // QR mode: instant, no aim box
                    return;
                  }
                }
              }
            }
          }
        }
      }
      // Adaptive zoom-on-fail — QR mode ONLY. Zoom crops a wide barcode's ends,
      // so barcode mode never zooms (the worker fills the band by moving closer).
      // Gentler than before (Wei Siang 2026-06-16: "zoom 过头了"): caps at 35% of
      // range and steps 12%, so it nudges a small QR into focus without tunnelling
      // past the code. Time-guarded so an easy code (decoded in the first ~1.8s)
      // never zooms.
      if (
        scanMode === "qr" &&
        !autoZoomSuppressedRef.current &&
        zoomRange &&
        zoomTrack &&
        now - scanStartedAt > 1800 &&
        now - lastZoomAt > 1100
      ) {
        const cap = zoomRange.min + (zoomRange.max - zoomRange.min) * 0.35;
        if (curZoomRef.current < cap) {
          lastZoomAt = now;
          curZoomRef.current = Math.min(
            cap,
            curZoomRef.current + (zoomRange.max - zoomRange.min) * 0.12,
          );
          try {
            void zoomTrack.applyConstraints({
              advanced: [{ zoom: curZoomRef.current } as unknown as MediaTrackConstraintSet],
            }).catch(() => {
          /* best-effort — a rejected applyConstraints (Unsupported
             focusMode, Track in an invalid state) must not surface as
             an unhandled rejection; see the header note. */
        });
          } catch {
            /* zoom is best-effort; never break the scan loop */
          }
        }
      }
      // Focus pulse — BOTH modes. After ~1.1s with no decode, give autofocus a
      // nudge so a perfectly-still phone still resolves the code (mimics the
      // movement that currently makes it work). A tiny zoom oscillation (±2% of
      // range around the current zoom, NOT stored so it never drifts/overshoots)
      // forces most lenses to re-focus; we also re-assert continuous AF. All
      // best-effort — silently no-ops where the lens exposes neither (then
      // tap-to-scan + the moving aim line are the fallback).
      if (now - lastDecode > 1100 && now - lastFocusPulseAt > 1100 && zoomTrack) {
        lastFocusPulseAt = now;
        if (zoomRange) {
          const span = (zoomRange.max - zoomRange.min) || 1;
          focusPulseDir = -focusPulseDir;
          const target = Math.min(
            zoomRange.max,
            Math.max(
              zoomRange.min,
              curZoomRef.current + focusPulseDir * span * 0.02,
            ),
          );
          try {
            void zoomTrack.applyConstraints({
              advanced: [{ zoom: target } as unknown as MediaTrackConstraintSet],
            }).catch(() => {
          /* best-effort — a rejected applyConstraints (Unsupported
             focusMode, Track in an invalid state) must not surface as
             an unhandled rejection; see the header note. */
        });
          } catch {
            /* zoom not exposed (iOS Safari often) — fall through to AF re-assert */
          }
        }
        try {
          void zoomTrack.applyConstraints({
            advanced: [
              { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
            ],
          }).catch(() => {
          /* best-effort — a rejected applyConstraints (Unsupported
             focusMode, Track in an invalid state) must not surface as
             an unhandled rejection; see the header note. */
        });
        } catch {
          /* focusMode not controllable — best-effort */
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
    // scanMode in deps: toggling QR<->Barcode tears down + restarts THIS loop
    // (the stream persists — startLiveScan owns it), so the new mode's decode
    // path + reticle take effect immediately.
  }, [liveScanning, handleDecoded, stopLiveScan, ensureZxing, scanMode]);

  // Make sure we tear down the stream if the component unmounts mid-scan.
  useEffect(() => {
    return () => {
      stopLiveScan();
    };
  }, [stopLiveScan]);

  // The bottom-nav "Scan" tab deep-links here as /worker/scan?camera=1 so one
  // tap jumps straight to the live camera — no Scan QR button tap. Auto-open
  // the camera once on mount when that flag is present; a plain /worker/scan
  // visit (e.g. for manual entry) does NOT auto-open. startLiveScan owns its
  // permission/error handling, so a denied camera just surfaces the normal
  // error state rather than throwing.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot: auto-open the
     camera on mount when the nav tab deep-links with ?camera=1; startLiveScan's
     internal setState is intentional (same pattern as the ?op= hydrate above) */
  useEffect(() => {
    if (params.get("camera") === "1") {
      startLiveScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ---------- File-based decode (camera capture / gallery upload) ----------

  const decodeFromFile = useCallback(
    async (file: File) => {
      setDecoding(true);
      setResult({ kind: "idle" });
      try {
        const bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load")); };
          img.src = url;
        });
        // Down-scale huge camera photos so decoding stays fast on
        // low-end phones. 1280px on the long edge is plenty for QR.
        const MAX_DIM = 1280;
        const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(bitmap, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "attemptBoth",
        });
        let decoded: string | null = code?.data || null;
        if (!decoded) {
          // jsQR is QR-only — try ZXing (QR + Code 128) for an uploaded
          // barcode photo (the Code 128 printed on the Production Schedule).
          await ensureZxing();
          // Uploaded photo: no aim box (single code per photo) — take the text.
          decoded = zxingRef.current?.(imageData)?.text ?? null;
        }
        if (!decoded) {
          setResult({ kind: "error", message: t("scan.decodeFail") });
          return;
        }
        await handleDecoded(decoded);
      } catch {
        setResult({ kind: "error", message: t("scan.decodeFail") });
      } finally {
        setDecoding(false);
      }
    },
    [handleDecoded, t, ensureZxing],
  );

  // Barcode TAP-TO-PICK: the worker taps the exact barcode row he wants on a
  // stacked schedule; we decode a FULL-WIDTH band (~22% height) around the tap so
  // ONLY that row is read (the rows above/below are excluded), then fire it. It is
  // a ONE-SHOT on the tap — a band that misses just buzzes for a re-tap, so it can
  // NEVER cause the continuous "扫不到" an always-on crop did (owner 2026-06-18).
  // Tap feedback (owner 2026-06-18: "完全不知道它能被点击，看起来完全没反应").
  // A ring blooms at the exact tap point so the worker SEES the tap registered;
  // it turns red if no bars sat on that row (a re-tap cue). PURELY VISUAL — it
  // never touches the decode band / ROI / coordinate mapping. {x,y} are px within
  // the video's overflow container (the video is inset-0, so its rect == it).
  const [tapFx, setTapFx] = useState<
    { x: number; y: number; state: "scan" | "hit" | "miss" } | null
  >(null);
  useEffect(() => {
    if (!tapFx) return;
    // "scan" stays up long enough to cover the tap-decode burst so the ring
    // doesn't vanish mid-scan; "hit" is a brief cyan confirm; "miss" lingers as a
    // re-tap cue.
    const ttl =
      tapFx.state === "scan" ? 1600 : tapFx.state === "hit" ? 500 : 850;
    // eslint-disable-next-line no-restricted-syntax -- one-shot auto-clear timer with proper effect cleanup; useTimeout would need a nullable-delay dance for the same result
    const id = window.setTimeout(() => setTapFx(null), ttl);
    return () => window.clearTimeout(id);
  }, [tapFx]);

  const tapScanBarcode = useCallback(
    async (e: React.PointerEvent<HTMLVideoElement>) => {
      // Works in BOTH modes (owner 2026-06-27): held-still auto-scan can't force
      // the lens to re-focus on iPhone Safari, so tap-to-scan is the reliable
      // path. Barcode = a band around the tapped row (stacked-list pick); QR =
      // the full frame. Either way the tap grabs a BURST of fresh frames and
      // decodes the sharpest, so the worker just aims and taps.
      const isQr = scanMode === "qr";
      const video = videoRef.current;
      if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
      const rect = video.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Instant ACK at the tap point — shows BEFORE the (async) decode so the
      // worker always sees that his tap landed, even on a miss.
      setTapFx({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        state: "scan",
      });
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      // object-cover: the frame is scaled to COVER the element, overflow cropped +
      // centred. Map the tap's Y back to the intrinsic frame so the band lands on
      // the exact row the worker pointed at.
      const scale = Math.max(rect.width / vw, rect.height / vh);
      const offsetY = (vh * scale - rect.height) / 2;
      const intrinsicY = Math.min(
        Math.max(0, (e.clientY - rect.top + offsetY) / scale),
        vh,
      );
      // QR: decode the FULL frame. Barcode: a band around the tapped row so a
      // stacked list still picks the row the worker aimed at.
      const bandH = isQr ? vh : Math.max(48, Math.round(vh * 0.22));
      const bandTop = isQr
        ? 0
        : Math.min(
            Math.max(0, Math.round(intrinsicY - bandH / 2)),
            Math.max(0, vh - bandH),
          );
      // Cap the decode buffer width so a full-frame QR burst stays fast.
      const decScale = Math.min(1, 1280 / vw);
      const cw = Math.max(1, Math.round(vw * decScale));
      const ch = Math.max(1, Math.round(bandH * decScale));
      // A SEPARATE canvas (not the tick loop's scanCanvasRef) so the live decode
      // loop and this tap decode never race on the same buffer.
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      // Decode a BURST of fresh frames around the tap, not just one. A single
      // grabbed frame is often motion-blurred / mid-focus, so an aimed tap used
      // to MISS and the worker had to tap again and again (owner 2026-06-18:
      // "有点不敏感，点了好几次都点不到"). Re-grab the SAME band over ~1s of fresh
      // frames — first clean frame wins — which is exactly what makes live QR feel
      // instant. The band stays pinned to the tapped row, so this is still
      // tap-to-pick (never grabs a stacked neighbour).
      await ensureZxing();
      const zx = zxingRef.current;
      const detector =
        typeof window !== "undefined" && window.BarcodeDetector
          ? (() => {
              // Widen to common 1D symbologies (owner 2026-06-27); fall back
              // through narrower sets if a device rejects the full list.
              try {
                return new window.BarcodeDetector({
                  formats: [
                    "code_128",
                    "code_39",
                    "ean_13",
                    "ean_8",
                    "upc_a",
                    "upc_e",
                    "itf",
                    "qr_code",
                  ],
                });
              } catch {
                try {
                  return new window.BarcodeDetector({
                    formats: ["code_128", "qr_code"],
                  });
                } catch {
                  return null;
                }
              }
            })()
          : null;
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      let decoded: string | null = null;
      for (let attempt = 0; attempt < 32 && !decoded; attempt++) {
        if (video.videoWidth === 0) break; // camera closed mid-burst
        ctx.drawImage(video, 0, bandTop, vw, bandH, 0, 0, cw, ch);
        // Native first. Barcode: among codes in the band pick the one nearest the
        // band centre (the tapped row). QR: take the first code found.
        if (detector) {
          try {
            const codes = await detector.detect(canvas);
            let best: { v: string; d: number } | null = null;
            for (const c of codes) {
              if (!c.rawValue) continue;
              if (isQr) {
                best = { v: c.rawValue, d: 0 };
                break;
              }
              const bb = (
                c as { boundingBox?: { y: number; height: number } }
              ).boundingBox;
              const d = bb ? Math.abs(bb.y + bb.height / 2 - ch / 2) : 0;
              if (!best || d < best.d) best = { v: c.rawValue, d };
            }
            if (best) decoded = best.v;
          } catch {
            /* native flaky this frame → jsQR / ZXing */
          }
        }
        // jsQR (QR-only, reads inverted via attemptBoth) — the strongest QR
        // reader on iOS where there's no native detector.
        if (!decoded && isQr) {
          try {
            const img = ctx.getImageData(0, 0, cw, ch);
            const code = jsQR(img.data, cw, ch, {
              inversionAttempts: "attemptBoth",
            });
            if (code && code.data) decoded = code.data;
          } catch {
            /* tainted canvas guard → ZXing */
          }
        }
        // ZXing fallback — reads QR + Code 128. The only barcode decoder on iOS;
        // also a second chance for QR. Every frame when native is absent, else
        // every other frame to keep the burst snappy.
        if (!decoded && zx && (!detector || attempt % 2 === 1)) {
          let img: ImageData | null = null;
          try {
            img = ctx.getImageData(0, 0, cw, ch);
          } catch {
            img = null;
          }
          if (img) {
            const r = zx(img);
            if (r) decoded = r.text;
          }
        }
        if (decoded) break;
        await nextFrame();
      }
      if (decoded) {
        try {
          navigator.vibrate?.(30);
        } catch {
          /* haptics best-effort */
        }
        // Flash the ring CYAN ("青色" = scanned!) so the worker clearly SEES the
        // tap landed on a real barcode, then hand off to the result card.
        setTapFx((p) => (p ? { ...p, state: "hit" } : null));
        for (let k = 0; k < 18 && video.videoWidth !== 0; k++) {
          await nextFrame();
        }
        setTapFx(null);
        stopLiveScan();
        void handleDecoded(decoded);
      } else {
        // No bars on the tapped row — flip the ring red + buzz so the worker
        // re-taps ON the barcode. One-shot, so this is NEVER the continuous "扫不到".
        setTapFx((p) => (p ? { ...p, state: "miss" } : null));
        try {
          navigator.vibrate?.([15, 35, 15]);
        } catch {
          /* */
        }
      }
    },
    [scanMode, stopLiveScan, handleDecoded, ensureZxing],
  );

  // Pop the next file from the queue and decode it. Called after each
  // scan-complete / cancel so the worker stays in flow when batch-scanning.
  const processNextInQueue = useCallback(
    (remaining: File[]) => {
      if (remaining.length === 0) {
        setQueue([]);
        setBatchIndex(0);
        setBatchTotal(0);
        return;
      }
      const [next, ...rest] = remaining;
      setQueue(rest);
      setBatchIndex((i) => i + 1);
      decodeFromFile(next);
    },
    [decodeFromFile],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      // Always reset so picking the same file twice still fires onChange.
      e.target.value = "";
      if (files.length === 0) return;
      // Start batch: decode the first photo now, queue the rest. The
      // "N of M" counter uses batchTotal (set once) / batchIndex.
      const [first, ...rest] = files;
      setBatchTotal(files.length);
      setBatchIndex(1);
      setQueue(rest);
      decodeFromFile(first);
    },
    [decodeFromFile],
  );

  // `opts.unlock` — releases the upstream sequence lock and re-posts the SAME
  // scan, so the worker never walks back to the sticker to scan twice. The
  // server records a scan_override_audit row for every release.
  //
  // This replaces `force`, which guarded the prerequisiteMet soft-warning
  // deleted in 760d08b3 (2026-06-08) and had been dead ever since — no endpoint
  // read it, and the comment describing a "202 round-trip" described a response
  // nothing returned any more.
  async function handleConfirmScan(
    opts?: {
      // Releases the upstream sequence lock and re-posts the same scan
      // (owner 2026-09-06). This replaces `force`, which guarded the
      // prerequisiteMet warning removed in 760d08b3 and had been dead ever
      // since — no endpoint read it.
      unlock?: { reason: string };
      ctx?: {
        order: Order;
        jobCard: JobCard;
        piece?: PieceInfo;
        wipKey?: string;
        wholeCard?: boolean;
      };
    },
  ) {
    // Accept either a caller-supplied ctx (auto-submit path right after
    // QR decode, before React has flushed the new `result`), a fresh
    // lookup, or a confirm-dialog continue. All three carry the
    // order+jobCard context we need to re-post (plus wipKey for a shared
    // compartment sticker, so Complete / Continue route to the shared resolver).
    const ctx =
      opts?.ctx ??
      (result.kind === "lookup"
        ? {
            order: result.order,
            jobCard: result.jobCard,
            piece: result.piece,
            wipKey: result.wipKey,
            wholeCard: result.wholeCard,
          }
        : null);
    if (!ctx) return;
    if (!workerId) {
      setResult({ kind: "error", message: t("common.error") });
      return;
    }
    setLoading(true);
    setRackChoice("");
    setRackSaved(false);
    try {
      // FG-level merged sticker. The QR's opId is the sentinel "FG-<DEPT>" so
      // one scan flips every matching dept card on the PO. Two routes:
      //   - FG-FAB_SEW is the SHARED Sew/Uph sticker: the completing dept is
      //     resolved from WHO scans (sewing worker → FAB_SEW, upholstery worker
      //     → UPHOLSTERY), so we DON'T send a deptCode — scan-complete-shared
      //     reads the section from the worker token.
      //   - FG-FAB_CUT (and any other FG-<DEPT>) → scan-complete-dept with the
      //     sticker's own dept.
      // A real jc id (non-FG, e.g. Packing) is the per-piece FIFO route below.
      // Shared Sew/Uph compartment sticker (wk=). Routes to scan-complete-shared
      // with the compartment's wipKey + the physical piece; the server resolves
      // FAB_SEW vs UPHOLSTERY from the worker's section. Takes precedence over
      // the legacy FG-FAB_SEW sentinel path below (kept for stickers printed for
      // wipKey-less rows).
      const cardDept = (ctx.jobCard.departmentCode || "").toUpperCase();
      const fgMatch = /^FG-([A-Z_]+)$/.exec(ctx.jobCard.id);
      const fgDept = fgMatch?.[1];
      // Route by the card's DEPARTMENT, not just the sticker shape, so a card
      // reached by MANUAL ENTRY (or any non-sticker lookup) also hits the
      // worker-open fan-out endpoints. The per-JC /scan-complete is worker-limited
      // to PACKING, so a manually-entered Fab Sew / Upholstery / Fab Cut card used
      // to fail with "only enabled for Packing".
      // wipKey for the shared endpoint: a wk sticker / sofa supplies ctx.wipKey;
      // a manual lookup of a Sew/Uph card falls back to the card's own wipKey. An
      // FG-<DEPT> sentinel deliberately keeps NO wipKey (whole-dept fan-out).
      const sharedWk =
        ctx.wipKey ??
        (!fgDept && (cardDept === "FAB_SEW" || cardDept === "UPHOLSTERY")
          ? ctx.jobCard.wipKey
          : undefined);
      const isShared =
        !!sharedWk ||
        fgDept === "FAB_SEW" ||
        cardDept === "FAB_SEW" ||
        cardDept === "UPHOLSTERY";
      const isFabCut = fgDept === "FAB_CUT" || cardDept === "FAB_CUT";
      // Code 128 schedule scan → complete the WHOLE WIP via the per-card
      // /scan-complete (dept-agnostic): the barcode is per job card, so we know
      // the exact card and don't need the shared/dept fan-out resolution.
      const wholeCard = !!ctx.wholeCard;
      const endpoint =
        wholeCard
          ? `/api/production-orders/${ctx.order.id}/scan-complete`
          : isShared
            ? `/api/production-orders/${ctx.order.id}/scan-complete-shared`
            : isFabCut
              ? `/api/production-orders/${ctx.order.id}/scan-complete-dept`
              : `/api/production-orders/${ctx.order.id}/scan-complete`;
      const payload =
        wholeCard
          ? {
              jobCardId: ctx.jobCard.id,
              workerId,
              completeWholeCard: true,
              ...(opts?.unlock ? { unlock: opts.unlock } : {}),
            }
          : isShared
          ? {
              workerId,
              // wipKey: complete only THIS compartment (Divan, not Headboard); a
              // sofa BASE fans out to the whole variant server-side. Absent for an
              // FG-FAB_SEW sentinel sticker (whole-dept).
              ...(sharedWk ? { wipKey: sharedWk } : {}),
              // per-piece: which physical piece this sticker is (from QR p=)
              pieceNo: ctx.piece?.pieceNo,
              ...(opts?.unlock ? { unlock: opts.unlock } : {}),
            }
          : isFabCut
            ? { deptCode: "FAB_CUT", workerId, ...(opts?.unlock ? { unlock: opts.unlock } : {}) }
            : {
            jobCardId: ctx.jobCard.id,
            workerId,
            // Piece-level routing: the QR carries `p=<pieceNo>&t=<total>` so
            // the backend knows which physical piece on this JC was scanned.
            // For a qty=2 Divan the two stickers have p=1 and p=2 — the
            // server uses this to bind the sticker to a piecePic slot via
            // FIFO and route subsequent scans of the same sticker back to
            // that slot (enables 2-worker share on a single piece). Defaults
            // to 1 server-side if omitted, so manual entry still works.
            pieceNo: ctx.piece?.pieceNo,
            // Releasing the upstream sequence lock. The server records a
            // scan_override_audit row for every one.
            ...(opts?.unlock ? { unlock: opts.unlock } : {}),
          };
      const res = await workerFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const raw = await res.json();
      const data = ScanCompleteEnvelope.parse(raw);
      // Upstream sequence lock (owner 2026-09-06). Replaces the note that stood
      // here since 2026-06-08 saying responses are success-or-error only — a
      // third answer exists again: "not your turn yet".
      //
      // `opts.unlock` re-posts the SAME scan with the release attached, so the
      // worker never walks back to the sticker and scans a second time.
      const refusal = asSequenceLockRefusal(raw);
      if (refusal) {
        setResult({
          kind: "blocked",
          refusal,
          retry: () =>
            void handleConfirmScan({
              ...(opts ?? {}),
              unlock: { reason: "Released on the shop floor" },
            }),
        });
        return;
      }
      if (data.success && data.data) {
        setResult({
          kind: "success",
          // The dept / shared fan-out endpoints (FAB_CUT scan-complete-dept,
          // FAB_SEW scan-complete-shared) don't return jobCard/assignedSlot —
          // fall back to the scanned card so the ✓ card renders a real WIP
          // name + dept instead of crashing on wipNameFor(undefined).
          slot: (data.data.assignedSlot as 1 | 2) ?? 1,
          // For a shared sticker, stamp the dept the SERVER actually completed
          // (FAB_SEW vs UPHOLSTERY, resolved from the worker's section) so the ✓
          // card shows the right department, not whichever compartment card we
          // happened to display before the tap.
          jobCard: (() => {
            const base = (data.data.jobCard as JobCard) ?? ctx.jobCard;
            const respDept = data.data.deptCode;
            return respDept ? { ...base, departmentCode: respDept } : base;
          })(),
          order: ctx.order,
          piece: ctx.piece,
          alreadyComplete: !!data.data.alreadyComplete,
          // Who's on the PIC slots — shown under the ✓ so a shared Sew/Uph
          // completion says BY WHOM (1 or 2 names).
          detail:
            data.data.completedBy && data.data.completedBy.length > 0
              ? t("scan.completedBy").replace(
                  "{who}",
                  data.data.completedBy.join(" + "),
                )
              : undefined,
          // FIFO diagnostic — server tells us if the scan was routed to a
          // DIFFERENT PO (older due date). Surfaces on the success card so
          // the worker isn't confused when the Production Sheet row they
          // scanned stays WAITING (the work counted for an earlier PO).
          fifoRedirected: data.data.fifoRedirected,
          scannedPoNo: data.data.scannedPoNo,
          assignedPoNo: data.data.assignedPoNo,
          assignedPoId: data.data.assignedPoId,
          fifoDueDate: data.data.fifoDueDate,
        });
        loadToday();
        // Batch mode: auto-advance to the next queued photo after a short
        // beat so the worker sees the ✓ flash.
        if (queue.length > 0) {
          const rest = queue;
          // Brief pause so the worker sees the success flash before we move
          // to the next queued photo. Scheduled inside the scan-submit
          // event-style callback, not a React lifecycle effect.
          // eslint-disable-next-line no-restricted-syntax -- one-shot UX pause inside scan-submit event handler
          setTimeout(() => {
            processNextInQueue(rest);
          }, 700);
        }
      } else {
        // C (BUG-2026-06-08): a PACKING "already done / full" response must
        // STILL let the worker fill / change the rack. Route those codes to the
        // amber "already complete" card (which renders the rack picker for
        // PACKING) instead of a dead-end red error screen.
        const respJc = data.data?.jobCard as JobCard | undefined;
        const isAlreadyCode =
          data.code === "ALREADY_PIC1" ||
          data.code === "ALREADY_PIC2" ||
          data.code === "PIC_FULL";
        const respDept = (
          (data.data?.deptCode as string | undefined) ||
          respJc?.departmentCode ||
          ""
        ).toUpperCase();
        const isPackingAlready = isAlreadyCode && respDept === "PACKING";
        // Shared Sew/Uph "already done / 2 people full" is NOT a hard error —
        // show the amber "already done" card stamped with the worker's OWN dept
        // and WHO holds the 2 slots, never a red error / dept jump (Wei Siang
        // 2026-06-15).
        const isSharedFull =
          isAlreadyCode &&
          (respDept === "FAB_SEW" || respDept === "UPHOLSTERY");
        if (isPackingAlready || isSharedFull) {
          const names = (data.data?.completedBy as string[] | undefined) ?? [];
          const deptLabel = (data.data?.deptLabel as string | undefined) || "";
          const detail =
            data.code === "PIC_FULL" && deptLabel
              ? t("scan.sectionFull").replace("{dept}", deptLabel) +
                (names.length
                  ? " " +
                    t("scan.completedBy").replace("{who}", names.join(" + "))
                  : "")
              : names.length
                ? t("scan.completedBy").replace("{who}", names.join(" + "))
                : undefined;
          setResult({
            kind: "success",
            slot: (data.data?.assignedSlot as 1 | 2) ?? 1,
            // Stamp the worker's resolved dept so the card never shows the
            // other section even if we displayed its card pre-tap.
            jobCard: isSharedFull
              ? { ...(respJc ?? ctx.jobCard), departmentCode: respDept }
              : (respJc ?? ctx.jobCard),
            order: ctx.order,
            piece: ctx.piece,
            alreadyComplete: true,
            detail,
          });
          loadToday();
        } else {
          setResult({
            kind: "error",
            message: data.error || t("common.error"),
          });
        }
      }
    } catch {
      setResult({ kind: "error", message: t("common.error") });
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setInput("");
    // Cancel in batch mode = skip this photo and advance to the next.
    if (queue.length > 0) {
      const rest = queue;
      processNextInQueue(rest);
      return;
    }
    // Not in batch mode — clear any residual batch counters too.
    setBatchTotal(0);
    setBatchIndex(0);
    setResult({ kind: "idle" });
  }

  // Shared panel style — used by both the primary two-button row and
  // the multi-WIP chooser card for visual consistency. Bold line is the
  // WIP name (e.g. "8\" Divan- 5FT (WD)") so the worker can see at a
  // glance whether they're picking the Divan or the Headboard piece —
  // the root cause of earlier "scanned Divan, marked HB done" confusion.
  const wipChoiceCard = (opt: WipOption, piece?: PieceInfo) => (
    <button
      key={`${opt.order.id}:${opt.jobCard.id}`}
      type="button"
      onClick={() => setResult({ kind: "lookup", ...opt, piece })}
      className="w-full flex items-center justify-between gap-3 px-3 py-3 rounded-lg border border-[#D8D2CC] bg-white active:bg-[#F0ECE9]"
    >
      <div className="min-w-0 text-left">
        <p className="text-xs text-[#8A8680]">
          {opt.order.poNo} · {opt.order.customerName}
        </p>
        <p className="text-base font-bold leading-tight mt-0.5 truncate">
          {wipNameFor(opt.jobCard, opt.order)}
        </p>
        <p className="text-xs text-[#5A5550] truncate">
          {opt.jobCard.wipCode ? `${opt.jobCard.wipCode} · ` : ""}
          {opt.order.productCode} · {opt.order.sizeLabel}
        </p>
        <p className="mt-1 text-[11px]">
          <span className="px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#5A5550] font-semibold">
            {opt.jobCard.departmentCode}
          </span>{" "}
          <span className="text-[#8A8680]">· {opt.jobCard.status}</span>
        </p>
      </div>
      <ChevronRight className="h-5 w-5 text-[#8A8680] shrink-0" />
    </button>
  );

  // "Photo N of M" badge for batch uploads. Rendered as a sticky strip
  // above the results so the worker always sees their progress through
  // the batch. Hidden for single-photo uploads (batchTotal ≤ 1).
  const batchActive = batchTotal > 1;
  const batchLabel = batchActive
    ? t("scan.batchProgress").replace("{i}", String(batchIndex)).replace("{n}", String(batchTotal))
    : "";

  return (
    <div className="space-y-4 pt-2">
      <h1 className="text-xl font-bold">{t("scan.title")}</h1>

      {/* Batch-upload progress badge */}
      {batchActive && (
        <div className="bg-[#3E6570]/10 border border-[#3E6570]/30 text-[#1F4149] rounded-lg px-3 py-2 flex items-center gap-2 text-sm">
          <Images className="h-4 w-4 shrink-0" />
          <span className="font-semibold">{batchLabel}</span>
          {queue.length === 0 && result.kind === "success" && (
            <span className="ml-auto text-xs text-[#3E6570]">
              {t("scan.batchDone").replace("{n}", String(batchTotal))}
            </span>
          )}
        </div>
      )}

      {/* Input area (always visible until success) */}
      {result.kind !== "success" && (
        <div className="bg-white rounded-xl p-4 border border-[#D8D2CC]">
          {/* Primary action: live scan (auto-decode). Requires HTTPS on
              non-localhost origins — see vite.config.ts basicSsl(). */}
          <button
            type="button"
            onClick={startLiveScan}
            disabled={decoding || loading || liveScanning}
            className="w-full h-24 mb-3 rounded-lg bg-[#3E6570] hover:bg-[#355863] active:bg-[#2F4E58] text-white flex flex-col items-center justify-center gap-1 disabled:opacity-60"
          >
            <Camera className="h-7 w-7" />
            <span className="text-base font-semibold">{t("scan.liveScan")}</span>
          </button>

          {/* Batch upload — worker snaps a bunch of QR stickers throughout
              the shift, then picks them all at once. `multiple` lets the
              native picker return an array; we queue them and decode one
              at a time. */}
          <button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={decoding || loading || liveScanning}
            className="w-full h-16 mb-3 rounded-lg border border-[#D8D2CC] bg-white active:bg-[#F0ECE9] flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <Images className="h-5 w-5 text-[#6B5C32]" />
            <span className="text-sm font-semibold text-[#3D3832]">
              {t("scan.uploadPhoto")}
            </span>
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
          {decoding && (
            <div className="mb-3 flex items-center justify-center gap-2 text-sm text-[#6B5C32]">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#6B5C32] border-t-transparent" />
              {t("scan.decoding")}
            </div>
          )}
          <div className="text-center text-sm font-semibold text-[#4B5563] mb-1">
            {t("scan.manual")}
          </div>
          <div className="text-center text-xs text-[#8A7F73] mb-2">
            {t("scan.manualHint")}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLookup()}
              placeholder={t("scan.manualPlaceholder")}
              className="flex-1 h-12 px-3 rounded border border-[#D8D2CC] bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#6B5C32] focus:border-[#6B5C32]"
            />
            <button
              type="button"
              onClick={() => doLookup()}
              disabled={loading || !input.trim()}
              className="h-12 px-5 rounded bg-[#6B5C32] hover:bg-[#5a4d2a] text-white disabled:opacity-60"
            >
              {loading ? (
                <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : (
                <Search className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* #52 — Rack bulk stock-in panel. Visible whenever a rack QR has been
          scanned; the worker keeps scanning FG/packing stickers (each adds a
          line) then taps Stock In to put them all into this rack. */}
      {rackStockIn && (
        <div className="bg-white rounded-xl p-4 border border-amber-300 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-[#1F1D1B]">
              📦 Stock in to {rackStockIn.rackId}
            </p>
            <button
              type="button"
              onClick={() => {
                setRackStockIn(null);
                setRackStockMsg("");
              }}
              className="text-xs text-[#6B5C32] underline"
            >
              Exit
            </button>
          </div>
          <p className="text-xs text-[#6B7280]">
            Keep scanning FG / packing stickers — each adds one. Tap Stock In
            when done.
          </p>
          {rackStockIn.items.length === 0 ? (
            <p className="text-sm text-[#6B7280] py-2">Nothing scanned yet.</p>
          ) : (
            <ul className="divide-y divide-[#EFEAE5]">
              {rackStockIn.items.map((it) => (
                <li
                  key={it.poId}
                  className="flex items-center justify-between py-1.5 text-sm"
                >
                  <span className="truncate">
                    {it.productName}
                    <span className="text-xs text-[#6B7280]"> · {it.poNo}</span>
                  </span>
                  <span className="shrink-0 font-semibold">× {it.qty}</span>
                </li>
              ))}
            </ul>
          )}
          {rackStockMsg && (
            <p className="text-sm font-medium text-[#6B5C32]">{rackStockMsg}</p>
          )}
          <button
            type="button"
            disabled={rackStockIn.items.length === 0 || rackStockingIn}
            onClick={submitRackStockIn}
            className="w-full h-12 rounded-full bg-[#6B5C32] text-white font-bold text-base active:bg-[#5a4d2a] disabled:opacity-40"
          >
            {rackStockingIn
              ? "Stocking in…"
              : `Stock In (${rackStockIn.items.reduce((s, x) => s + x.qty, 0)})`}
          </button>
        </div>
      )}

      {/* Multi-WIP chooser — shown when manual PO lookup returned multiple
          job cards, or a QR scan fell back to PO after the op id went
          stale. On a bedframe PO with Divan + HB under one order, this
          is the only thing standing between the worker and silently
          completing the wrong piece. */}
      {result.kind === "choices" && (
        <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] space-y-2">
          <p className="text-sm font-semibold text-[#1F1D1B]">
            {t("scan.pickOneWip")}
          </p>
          <div className="space-y-2">
            {result.options.map((opt) => wipChoiceCard(opt, result.piece))}
          </div>
          <button
            type="button"
            onClick={reset}
            className="w-full text-sm text-[#5A5550] py-1"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {/* Lookup result — bold heading is the WIP name (e.g. Divan 5FT (WD))
          NOT the generic product code, so the worker can tell at a glance
          whether the scan hit the Divan or Headboard piece. The piece
          badge ("Piece 1 of 2") is driven by the p=&t= on the sticker QR. */}
      {result.kind === "lookup" && (() => {
        const wipName = wipNameFor(result.jobCard, result.order);
        // Client-side duplicate guard. Prefer the PIECE-level slot when
        // piecePics are available — a qty=2 Divan has two independent
        // stickers, so sharing one of them shouldn't block the other. Only
        // fall back to the JC-level pic1/pic2 when piecePics is absent
        // (older seed data or A-flow JCs).
        const pieceSlot =
          result.piece && result.jobCard.piecePics
            ? result.jobCard.piecePics.find(
                (s) => s.pieceNo === result.piece!.pieceNo,
              ) || null
            : null;
        // For a PER-PIECE scan (result.piece set), the duplicate check must look
        // ONLY at THIS piece's slot — never fall back to the card-level pic, which
        // is the aggregate of OTHER pieces and would wrongly block the same worker
        // from scanning a DIFFERENT piece ("you already scanned this piece" when
        // scanning Divan #2 or the Headboard after Divan #1). Card-level fallback
        // applies only to single (non-per-piece) cards.
        const checkPic1 = result.piece
          ? (pieceSlot?.pic1Id ?? null)
          : result.jobCard.pic1Id;
        const checkPic2 = result.piece
          ? (pieceSlot?.pic2Id ?? null)
          : result.jobCard.pic2Id;
        const selfSlot =
          workerId && checkPic1 === workerId
            ? 1
            : workerId && checkPic2 === workerId
              ? 2
              : 0;
        const bothSlotsFilled =
          !!checkPic1 && !!checkPic2 && selfSlot === 0;
        const blocked = selfSlot > 0 || bothSlotsFilled;
        return (
          <div className="bg-white rounded-xl p-4 border border-[#D8D2CC] space-y-3">
            <div>
              <p className="text-xs text-[#8A8680]">
                {result.order.poNo} · {result.order.customerName}
              </p>
              <p className="text-lg font-bold leading-tight mt-0.5">
                {wipName}
              </p>
              <p className="text-sm text-[#5A5550]">
                {result.jobCard.wipCode ? `${result.jobCard.wipCode} · ` : ""}
                {result.order.productCode} · {result.order.sizeLabel}
              </p>
              {result.piece && (
                <p className="mt-1.5 inline-block text-[11px] font-semibold px-2 py-0.5 rounded bg-[#6B5C32] text-white">
                  {t("scan.pieceOf")
                    .replace("{i}", String(result.piece.pieceNo))
                    .replace("{n}", String(result.piece.totalPieces))}
                </p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="bg-[#F0ECE9] rounded px-3 py-2">
                <p className="text-[11px] text-[#8A8680] uppercase">Department</p>
                <p className="font-semibold">{result.jobCard.departmentCode}</p>
              </div>
              <div className="bg-[#F0ECE9] rounded px-3 py-2">
                <p className="text-[11px] text-[#8A8680] uppercase">Status</p>
                <p className="font-semibold">{result.jobCard.status}</p>
              </div>
              {/* Planned production time for this job card — lets the worker
                  eyeball "this should take ~N min" before committing. The
                  back-end tracks actual vs. planned via the scan-complete
                  endpoint; estMinutes is what's credited on completion. */}
              <div className="bg-[#F0ECE9] rounded px-3 py-2">
                <p className="text-[11px] text-[#8A8680] uppercase">Prod Time</p>
                <p className="font-semibold">
                  {result.jobCard.estMinutes > 0
                    ? `${result.jobCard.estMinutes} min`
                    : "—"}
                </p>
              </div>
            </div>
            {(() => {
              // Show PIC names for THIS piece when piecePics are available,
              // otherwise fall back to the JC-level legacy pic1Name/pic2Name.
              const showPic1 = pieceSlot?.pic1Name ?? result.jobCard.pic1Name;
              const showPic2 = pieceSlot?.pic2Name ?? result.jobCard.pic2Name;
              if (!showPic1 && !showPic2) return null;
              return (
                <p className="text-xs text-[#5A5550]">
                  PIC: {showPic1 || "—"}
                  {showPic2 ? ` / ${showPic2}` : ""}
                </p>
              );
            })()}
            {/* Duplicate guard — friendly warning, not an error, because
                the card itself isn't in a bad state; we're just preventing
                the worker from double-crediting themselves for one piece. */}
            {blocked && (
              <div className="flex items-start gap-2 bg-[#FFF8E1] border border-[#F6D672] rounded px-3 py-2 text-sm text-[#7A5B1A]">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {selfSlot > 0
                    ? t("scan.alreadyDone")
                    : t("scan.bothSlotsFilled")}
                </span>
              </div>
            )}
            {/* Re-scan-to-fill-rack: a Packing card that's ALREADY completed
                shows the rack picker right here, so the worker can come back any
                time and fill / change the rack (Wei Siang: "I can fill it
                later"). A fresh card has no picker here — it completes first and
                the success screen shows the picker. */}
            {result.jobCard.departmentCode === "PACKING" &&
              (result.jobCard.status === "COMPLETED" ||
                result.jobCard.status === "TRANSFERRED") && (
                <div className="bg-[#F0ECE9] rounded-lg p-3">
                  <p className="text-xs font-semibold text-[#5A5550] mb-1.5">
                    Rack number
                  </p>
                  {rackSaved ? (
                    <p className="text-sm font-semibold text-[#3E6570]">
                      ✓ Rack saved: {rackChoice}
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        value={rackChoice}
                        onChange={(e) => setRackChoice(e.target.value)}
                        className="flex-1 h-10 rounded border border-[#D8D2CC] text-sm px-2"
                      >
                        <option value="">— Select rack —</option>
                        {racks.map((r) => (
                          <option key={r.rack} value={r.rack}>
                            {r.rack}
                            {r.occupied ? " (occupied)" : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!rackChoice || savingRack}
                        onClick={() => saveRack(result.jobCard.id, rackChoice)}
                        className="h-10 px-4 rounded bg-[#3E6570] text-white font-semibold text-sm disabled:opacity-50"
                      >
                        {savingRack ? "…" : "Save"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            <button
              type="button"
              onClick={() => handleConfirmScan()}
              disabled={loading || blocked}
              className="w-full h-14 rounded-lg bg-[#3E6570] hover:bg-[#355863] text-white text-lg font-semibold disabled:opacity-60 transition-colors"
            >
              {loading ? t("common.loading") : t("scan.complete")}
            </button>
            <button
              type="button"
              onClick={reset}
              className="w-full text-sm text-[#5A5550] py-1"
            >
              {t("common.cancel")}
            </button>
          </div>
        );
      })()}

      {/* Success — show the WIP name + piece badge too, so the worker sees
          exactly which piece they just completed. */}
      {result.kind === "success" && (
        <div
          className={`${result.alreadyComplete ? "bg-[#7A5B1A]" : "bg-[#3E6570]"} text-white rounded-xl p-6 text-center`}
        >
          <CheckCircle2 className="h-12 w-12 mx-auto mb-3" />
          <p className="text-xl font-bold mb-1">
            {result.alreadyComplete
              ? t("scan.alreadyDone")
              : `${t("scan.complete")} ✓`}
          </p>
          <p className="text-base font-semibold opacity-95">
            {wipNameFor(result.jobCard, result.order)}
          </p>
          <p className="text-sm opacity-90 mt-1">
            {result.order.poNo} · {result.jobCard.departmentCode}
          </p>
          {result.detail && (
            <p className="text-sm font-semibold opacity-95 mt-1">
              {result.detail}
            </p>
          )}
          {result.piece && (
            <p className="text-xs opacity-90 mt-1">
              {t("scan.pieceOf")
                .replace("{i}", String(result.piece.pieceNo))
                .replace("{n}", String(result.piece.totalPieces))}
            </p>
          )}
          {!result.alreadyComplete && (
            <p className="text-xs opacity-75 mt-1">PIC slot {result.slot}</p>
          )}

          {/* Packing rack picker — Wei Siang: after Complete, pick the rack
              below. Options from the warehouse catalog; saved independently of
              the completion (also works when re-scanning a finished card). */}
          {result.jobCard.departmentCode === "PACKING" && (
            <div className="mt-4 bg-white/10 rounded-lg p-3 text-left">
              <p className="text-xs font-semibold opacity-90 mb-1.5">
                Rack number
              </p>
              {rackSaved ? (
                <p className="text-sm font-semibold">✓ Rack saved: {rackChoice}</p>
              ) : (
                <div className="flex gap-2">
                  <select
                    value={rackChoice}
                    onChange={(e) => setRackChoice(e.target.value)}
                    className="flex-1 h-10 rounded bg-white text-[#1F1D1B] text-sm px-2"
                  >
                    <option value="">— Select rack —</option>
                    {racks.map((r) => (
                      <option key={r.rack} value={r.rack}>
                        {r.rack}
                        {r.occupied ? " (occupied)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!rackChoice || savingRack}
                    onClick={() => saveRack(result.jobCard.id, rackChoice)}
                    className="h-10 px-4 rounded bg-white text-[#1F1D1B] font-semibold text-sm disabled:opacity-50"
                  >
                    {savingRack ? "…" : "Save"}
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            className="mt-5 h-11 px-5 rounded bg-white text-[#1F1D1B] font-semibold text-sm"
          >
            {t("scan.title")}
          </button>
        </div>
      )}

      {/* Error */}
      {/* Department QR confirmation — "now working in <dept>". */}
      {result.kind === "deptscan" && (
        <div className="bg-[#F1F7F3] border border-[#BFD9C8] rounded-xl p-4 text-[#2A6B4A] flex items-start gap-2">
          <CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {t("scan.deptScanOk")}: {result.deptName}
              {result.category
                ? ` · ${result.category.charAt(0)}${result.category.slice(1).toLowerCase()}`
                : ""}
              {result.time ? ` · ${result.time}` : ""}
            </p>
            <p className="text-sm mt-0.5">{t("scan.deptScanHint")}</p>
          </div>
        </div>
      )}

      {result.kind === "error" && (
        <div className="bg-[#FDF6F4] border border-[#F5C5BF] rounded-xl p-4 text-[#9A3A2D] flex items-start gap-2">
          <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t("common.error")}</p>
            <p className="text-sm mt-0.5 break-words">{result.message}</p>
            {/* When we have a decoded QR payload but no match, show it so
                the worker can see the QR WAS readable — the problem is
                data-side, not camera-side. */}
            {result.decoded && (
              <p className="mt-1.5 text-[10px] text-[#9A3A2D]/70 break-all tabular-nums">
                QR: {result.decoded}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Upstream sequence lock (owner 2026-09-06). AMBER, not red: nothing
          went wrong and there is nothing to report — it is simply not this
          bench's turn yet. Dressing it as a failure teaches the floor that the
          system is broken, which is how a lock ends up being routed around.

          The worker is standing, one-handed, often holding the piece: big type,
          the blocking departments as a LIST (a convergence step names three),
          and one action. */}
      {result.kind === "blocked" && (
        <div className="bg-[#FAEFCB] border border-[#E8D9A8] rounded-xl p-4 text-[#7A5610]">
          <div className="flex items-start gap-2">
            <Lock className="h-6 w-6 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-lg font-bold leading-tight">Not this step yet</p>
              <p className="mt-2 text-sm">Finish first:</p>
              <ul className="mt-1 space-y-0.5">
                {blockingDepartments(result.refusal).map((d) => (
                  <li key={d} className="text-xl font-bold leading-snug">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {result.refusal.canSelfUnlock && (
            <button
              type="button"
              // Two taps on purpose: the first opens the confirm, the second
              // commits. A single big button next to a camera view is a
              // mis-tap waiting to happen, and every release is audited.
              onClick={() => {
                if (
                  window.confirm(
                    "Unlock and complete this step anyway? This will be recorded.",
                  )
                ) {
                  result.retry();
                }
              }}
              className="mt-4 w-full rounded-lg bg-[#7A5610] px-4 py-3 text-base font-semibold text-white active:bg-[#5E420C]"
            >
              Unlock and complete
            </button>
          )}
          <p className="mt-2 text-center text-[11px] text-[#7A5610]/70">
            Later this will need a supervisor.
          </p>
        </div>
      )}

      {/* Wrong-department block (owner 2026-06-26 unified scan model). The
          scanned sticker belongs to a department the worker is NOT currently in
          — they must scan that department's QR first. */}
      {result.kind === "deptBlock" && (
        <div className="bg-[#FDF6F4] border border-[#F5C5BF] rounded-xl p-4 text-[#9A3A2D]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Wrong department</p>
              <p className="text-sm mt-1 break-words">
                You are in <strong>{result.currentDept}</strong>. This sticker is
                for <strong>{result.stickerDept}</strong>.
              </p>
              <div className="mt-2 rounded-md bg-[#FAEEDA] p-2.5 text-xs leading-relaxed text-[#854F0B]">
                Scan the <strong>{result.stickerDept}</strong> department QR first
                to switch, then scan this sticker again.
              </div>
              <button
                type="button"
                onClick={() => setResult({ kind: "idle" })}
                className="mt-3 h-9 rounded-lg border border-[#D8D2CC] bg-white px-4 text-sm font-semibold text-[#5A5550]"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================================
          LIVE CAMERA OVERLAY
          Full-viewport camera feed with a transparent aiming frame.
          Frames are sampled ~16×/sec (native) or ~11×/sec (jsQR) by the RAF
          loop above; the first decode closes the overlay and auto-submits
          via handleDecoded.
          ========================================================== */}
      {/* Portal to <body> so NOTHING in the worker layout (the fixed bottom
          nav, the sticky header) can paint over the camera — the overlay was
          "漏风" at the bottom where the nav peeked through (Wei Siang). At body
          level z-[60] sits above the nav's z-30 unconditionally. */}
      {liveScanning &&
        createPortal(
          <div className="fixed inset-0 z-[60] bg-black flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <span className="text-sm font-semibold">
              {scanMode === "barcode" ? t("scan.modeBarcode") : t("scan.modeQr")}
            </span>
            <div className="flex items-center gap-2">
              {torchSupported && (
                <button
                  type="button"
                  onClick={toggleTorch}
                  className={`h-9 w-9 rounded-full flex items-center justify-center ${
                    torchOn
                      ? "bg-amber-400 text-black"
                      : "bg-white/10 text-white active:bg-white/20"
                  }`}
                  aria-label="Torch"
                >
                  <Flashlight className="h-5 w-5" />
                </button>
              )}
              <button
                type="button"
                onClick={stopLiveScan}
                className="h-9 w-9 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"
                aria-label={t("scan.cancel")}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              onPointerUp={tapScanBarcode}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted
            />
            {/* Zoom-out — the QR auto-zoom can leave the lens zoomed in with no
                way back; tap to widen again (Wei Siang 2026-06-17). Barcode mode
                never auto-zooms, so this is QR-only. */}
            {scanMode === "qr" && zoomSupported && (
              <button
                type="button"
                onClick={resetZoom}
                className="absolute bottom-4 right-4 h-11 w-11 rounded-full bg-black/55 text-white flex items-center justify-center active:bg-black/75"
                aria-label="Reset zoom"
              >
                <ZoomOut className="h-5 w-5" />
              </button>
            )}
            {/* Aiming frame — a square for QR. In BARCODE mode it's just a loose
                "barcodes here" guide: the worker TAPS the exact row he wants
                (tapScanBarcode reads a band around the tap), so there's no centre
                to line up against — hence no centre line. */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className="relative"
                style={
                  scanMode === "barcode"
                    ? { width: "86vw", maxWidth: "440px", height: "118px" }
                    : { width: "min(70vw, 70vh)", aspectRatio: "1 / 1" }
                }
              >
                {/* Aim-frame corners. In barcode mode they turn CYAN the moment a
                    barcode is framed (owner 2026-06-27: "显蓝色") so the worker
                    knows it's ready to tap. */}
                {(() => {
                  const c =
                    scanMode === "barcode" && barcodeSeen
                      ? "border-cyan-300"
                      : "border-white";
                  return (
                    <>
                      <span className={`absolute left-0 top-0 h-10 w-10 border-t-4 border-l-4 ${c} rounded-tl-lg`} />
                      <span className={`absolute right-0 top-0 h-10 w-10 border-t-4 border-r-4 ${c} rounded-tr-lg`} />
                      <span className={`absolute left-0 bottom-0 h-10 w-10 border-b-4 border-l-4 ${c} rounded-bl-lg`} />
                      <span className={`absolute right-0 bottom-0 h-10 w-10 border-b-4 border-r-4 ${c} rounded-br-lg`} />
                    </>
                  );
                })()}
                {/* Moving scan line (owner 2026-06-27): a gold sweep up/down the
                    aim frame — live-scanning feedback + a nudge to keep the phone
                    slightly moving so autofocus keeps re-hunting. The real lever
                    is the focus pulse in the decode loop; this line is the cue. */}
                <style>{`@keyframes hookkaScanLine{0%{top:6%;opacity:.25}50%{top:90%;opacity:1}100%{top:6%;opacity:.25}}`}</style>
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-2 right-2 h-[2px] rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, rgba(201,169,97,0.95), transparent)",
                    boxShadow: "0 0 8px 1px rgba(201,169,97,0.7)",
                    animation: "hookkaScanLine 2s ease-in-out infinite",
                  }}
                />
                {/* no centre line — barcode is tap-to-pick now. The badge says
                    "Tap to scan", and flips to a CYAN "Detected — tap to scan"
                    once a barcode is in view so the worker taps the row he wants. */}
                {scanMode === "barcode" && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold animate-pulse ${
                        barcodeSeen
                          ? "bg-cyan-400/90 text-black"
                          : "bg-black/55 text-white"
                      }`}
                    >
                      <Pointer className="h-3.5 w-3.5" />
                      {barcodeSeen
                        ? t("scan.tapHintBarcodeReady")
                        : t("scan.tapHintBarcode")}
                    </span>
                  </span>
                )}
              </div>
            </div>
            {/* Tap ACK ring at the tap point (centre for QR). WHITE = scanning,
                CYAN ("青色") = scanned OK, RED = nothing decodable there → re-tap.
                Shown in BOTH modes now: barcode tap + QR success both flash it.
                Auto-clears via the tapFx effect. */}
            {tapFx && (
              <span
                className="pointer-events-none absolute z-20"
                style={{
                  left: tapFx.x,
                  top: tapFx.y,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <span
                  className={`block rounded-full animate-ping ring-2 ${
                    tapFx.state === "miss"
                      ? "bg-red-400/30 ring-red-300"
                      : tapFx.state === "hit"
                        ? "bg-cyan-300/50 ring-cyan-200"
                        : "bg-white/20 ring-white/80"
                  }`}
                  style={{ width: 72, height: 72 }}
                />
                <span
                  className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                    tapFx.state === "miss"
                      ? "bg-red-400"
                      : tapFx.state === "hit"
                        ? "bg-cyan-300"
                        : "bg-white"
                  }`}
                  style={{ width: 13, height: 13 }}
                />
              </span>
            )}
          </div>
          <div className="px-4 pb-7 pt-3 flex flex-col items-center gap-3">
            <p className="text-white/90 text-center text-sm">
              {scanMode === "barcode"
                ? t("scan.aimHintBarcode")
                : t("scan.aimHint")}
            </p>
            {scanMode === "barcode" && scanDbg && (
              <p className="font-mono text-[10px] leading-tight text-white/40">
                {scanDbg}
              </p>
            )}
            {/* Big mode toggle at the BOTTOM-centre so it's in thumb reach
                (Wei Siang 2026-06-16: the top one was too high to tap). */}
            <button
              type="button"
              onClick={() => {
                setBarcodeSeen(false);
                setScanMode((m) => (m === "qr" ? "barcode" : "qr"));
              }}
              className="w-full max-w-xs h-12 rounded-full bg-white text-black font-bold text-base active:bg-white/80"
            >
              {scanMode === "qr"
                ? t("scan.switchToBarcode")
                : t("scan.switchToQr")}
            </button>
          </div>
        </div>,
          document.body,
        )}

      {/* ==========================================================
          TODAY'S SNAPSHOT
          ----------------------------------------------------------
          Appears under the scanner whenever we're idle or post-
          success. Hidden during an active lookup / chooser to avoid
          crowding out the confirm button on small screens.
          ========================================================== */}
      {result.kind !== "lookup" && result.kind !== "choices" && today && (
        <>
          {/* Today KPI row */}
          <div className="grid grid-cols-3 gap-2">
            <Kpi label="Work hrs" value={mins2hrs(today.totals.workedMinutes)} />
            <Kpi
              label="Prod hrs"
              value={mins2hrs(today.totals.productionMinutes)}
            />
            <Kpi
              label="Efficiency"
              value={`${today.totals.efficiencyPct}%`}
              tone={
                today.totals.efficiencyPct >= 80
                  ? "good"
                  : today.totals.efficiencyPct >= 60
                    ? "warn"
                    : "bad"
              }
            />
          </div>

          {/* Today's completed products — one row per PHYSICAL PIECE.
             A qty=2 Divan JC where this worker did both pieces produces
             TWO rows (each worth myMinutes/piecesWorked). That matches
             the shop-floor mental model: "each piece I scanned = one
             unit of production" rather than "each job card = one row". */}
          {(() => {
            // Flatten: for each completed JC, emit N rows (N = piecesWorked).
            // Each row gets this worker's share of the JC's myMinutes split
            // across the pieces they actually touched. Legacy A-flow JCs
            // with no piecePics fall through as a single row (piecesWorked=1).
            type PieceRow = {
              key: string;
              departmentCode: string;
              productCode: string;
              productName: string;
              wipLabel?: string;
              wipCode?: string;
              itemCategory?: string;
              sizeLabel?: string;
              perPieceMins: number;
              pieceIdx: number;
              totalPieces: number;
            };
            const pieceRows: PieceRow[] = [];
            for (const c of today.completed) {
              const pc = Math.max(1, c.piecesWorked || 1);
              const tp = Math.max(pc, c.totalPieces || pc);
              const mineTotal = c.myMinutes ?? c.estMinutes;
              const per = Math.round(mineTotal / pc);
              for (let i = 0; i < pc; i++) {
                pieceRows.push({
                  key: `${c.jobCardId}::${i + 1}`,
                  departmentCode: c.departmentCode,
                  productCode: c.productCode,
                  productName: c.productName,
                  wipLabel: c.wipLabel,
                  wipCode: c.wipCode,
                  itemCategory: c.itemCategory,
                  sizeLabel: c.sizeLabel,
                  perPieceMins: per,
                  pieceIdx: i + 1,
                  totalPieces: tp,
                });
              }
            }
            return (
              <div className="bg-white rounded-xl border border-[#D8D2CC] overflow-hidden">
                <div className="px-3 py-2 bg-[#1B2B44] text-white">
                  <p className="text-xs font-bold uppercase tracking-wide">
                    Today's completed ({pieceRows.length})
                  </p>
                </div>
                <div className="px-3 pb-2">
                  <div className="grid grid-cols-[auto_1fr_auto] gap-2 py-2 text-[10px] font-bold uppercase tracking-wide text-[#8A8680] bg-[#EAF3E5] -mx-3 px-3">
                    <span>Dept</span>
                    <span>Product</span>
                    <span className="text-right">Mins</span>
                  </div>
                  {pieceRows.length === 0 ? (
                    <div className="py-4 text-center text-xs text-[#8A8680]">
                      Nothing completed yet — scan one 👆
                    </div>
                  ) : (
                    pieceRows.map((r) => {
                      const label = deriveWipName({
                        wipLabel: r.wipLabel,
                        departmentCode: r.departmentCode,
                        productName: r.productName,
                        productCode: r.productCode,
                        itemCategory: r.itemCategory,
                        sizeLabel: r.sizeLabel,
                      });
                      return (
                        <div
                          key={r.key}
                          className="grid grid-cols-[auto_1fr_auto] gap-2 py-2 text-sm border-t border-[#F0ECE9] items-center"
                        >
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#5A5550] font-semibold whitespace-nowrap">
                            {r.departmentCode}
                          </span>
                          <span
                            className="text-xs truncate"
                            title={`${label} · ${r.productCode} · piece ${r.pieceIdx}/${r.totalPieces}`}
                          >
                            {label}
                            {r.totalPieces > 1 && (
                              <span className="ml-1 text-[10px] text-[#8A8680]">
                                ({r.pieceIdx}/{r.totalPieces})
                              </span>
                            )}
                          </span>
                          <span className="tabular-nums text-right font-semibold">
                            {r.perPieceMins}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

// ---------- tiny UI helper ----------
function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-[#2A6B4A]"
      : tone === "warn"
        ? "text-[#9C6F1E]"
        : tone === "bad"
          ? "text-[#9A3A2D]"
          : "text-[#1F1D1B]";
  return (
    <div className="bg-white rounded-xl p-3 border border-[#D8D2CC] text-center">
      <p className="text-[10px] uppercase tracking-wide text-[#8A8680] font-semibold">
        {label}
      </p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  );
}

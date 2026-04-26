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
//     driven by getUserMedia. Each frame runs through jsQR; on first
//     decode we auto-submit and close the overlay. Feels instant.
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
import { useSearchParams } from "react-router-dom";
import {
  Camera,
  Search,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronRight,
  Images,
} from "lucide-react";
import jsQR from "jsqr";
import { useT } from "@/lib/worker-i18n";
import { workerFetch, WORKER_ME_KEY } from "@/layouts/WorkerLayout";
import { parseStickerData } from "@/lib/qr-utils";
import { deriveWipName } from "@/lib/wip-name";
import { fetchJson } from "@/lib/fetch-json";
import { z } from "zod";

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
    data: z
      .object({
        assignedSlot: z.number().optional(),
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
  | { kind: "lookup"; order: Order; jobCard: JobCard; piece?: PieceInfo }
  // When manual entry by PO number, or a QR whose opId went stale, yields
  // multiple matching job cards (e.g. a bedframe PO produces both Divan
  // and Headboard), surface them all so the worker disambiguates. Never
  // silently auto-pick — that's how a Divan scan ended up marking HB done.
  | { kind: "choices"; options: WipOption[]; piece?: PieceInfo }
  // Soft warning — server returned HTTP 202 with `requiresConfirmation`.
  // The worker acknowledges and re-posts with `force: true` on Continue.
  | {
      kind: "confirm";
      order: Order;
      jobCard: JobCard;
      piece?: PieceInfo;
      warning: { code: string; message: string };
    }
  | {
      kind: "success";
      slot: 1 | 2;
      jobCard: JobCard;
      order: Order;
      piece?: PieceInfo;
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
  | { kind: "error"; message: string; decoded?: string };

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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);

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

  // Pull worker ID from cached /me so we can auto-attribute the scan.
  const workerId = (() => {
    try {
      const raw = localStorage.getItem(WORKER_ME_KEY);
      if (raw) return (JSON.parse(raw) as { id?: string }).id || "";
    } catch {
      /* ignore */
    }
    return "";
  })();

  // Guarded — a failed today-snapshot must not break the scanner,
  // which is the primary purpose of this page.
  const loadToday = useCallback(async () => {
    try {
      const d = new Date().toISOString().slice(0, 10);
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
      const data = await fetchJson("/api/production-orders", POListEnvelope);
      if (!data.success || !data.data) return [];
      const orders = data.data as unknown as Order[];
      // Job-card id — unique → return the single hit and stop.
      for (const o of orders) {
        const jc = o.jobCards.find((j) => j.id === term);
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

  // If the page is opened from a QR deep-link like /worker/scan?op=xxx,
  // look it up immediately.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot QR deep-link hydrate on mount */
  useEffect(() => {
    const op = params.get("op");
    if (op) {
      setInput(op);
      doLookup(op);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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
      const parsed = parseStickerData(raw);
      const primaryTerm = parsed?.opId || raw;
      const deptHint = parsed?.deptCode;
      const piece: PieceInfo | undefined =
        parsed?.pieceNo && parsed?.totalPieces
          ? { pieceNo: parsed.pieceNo, totalPieces: parsed.totalPieces }
          : undefined;
      setInput(primaryTerm);
      setLoading(true);
      setResult({ kind: "idle" });
      try {
        // Merged FG-level sticker (e.g. FG-FAB_CUT) — opId is a dept
        // sentinel, not a real jc id, so findMatches by opId would come
        // back empty. Jump straight to the PO lookup, filtered by the
        // dept embedded in the sentinel, and swap the match's jobCard id
        // to the sentinel so downstream scan-complete routes to the
        // fan-out endpoint.
        const fgMatch = /^FG-([A-Z_]+)$/.exec(primaryTerm);
        let matches = fgMatch && parsed?.poNo
          ? (await findMatches(parsed.poNo, fgMatch[1])).map((m) => ({
              ...m,
              jobCard: { ...m.jobCard, id: primaryTerm },
            }))
          : await findMatches(primaryTerm, deptHint);
        if (matches.length === 0 && parsed?.poNo && parsed.poNo !== primaryTerm && !fgMatch) {
          // PO fallback — visible to the user so they understand the
          // lookup shifted scope when the op id went cold. Pass deptHint
          // through so we don't merge Divan + HB job cards together.
          setInput(parsed.poNo);
          matches = await findMatches(parsed.poNo, deptHint);
        }
        if (matches.length === 1) {
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
    [findMatches, t],
  );

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
  }, []);

  const startLiveScan = useCallback(async () => {
    // Can't start twice
    if (liveScanning) return;
    setResult({ kind: "idle" });
    try {
      // Prefer the rear camera. Keep resolution modest so decode stays
      // fast on low-end phones.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setLiveScanning(true);
      // Video element attach + RAF loop happens in the effect below.
    } catch {
      setResult({ kind: "error", message: t("scan.cameraFail") });
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

    let stopped = false;
    let lastDecode = 0;
    const THROTTLE_MS = 120; // ~8 decodes / second

    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      if (now - lastDecode >= THROTTLE_MS && video.videoWidth > 0 && video.readyState >= 2) {
        lastDecode = now;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        // Downscale so jsQR doesn't chew on 1280x720 every tick.
        const scale = Math.min(1, 640 / Math.max(vw, vh));
        const cw = Math.max(1, Math.round(vw * scale));
        const ch = Math.max(1, Math.round(vh * scale));
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
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
            const code = jsQR(imageData.data, cw, ch, {
              inversionAttempts: "dontInvert",
            });
            if (code && code.data) {
              stopped = true;
              stopLiveScan();
              void handleDecoded(code.data);
              return;
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [liveScanning, handleDecoded, stopLiveScan]);

  // Make sure we tear down the stream if the component unmounts mid-scan.
  useEffect(() => {
    return () => {
      stopLiveScan();
    };
  }, [stopLiveScan]);

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
        if (!code || !code.data) {
          setResult({ kind: "error", message: t("scan.decodeFail") });
          return;
        }
        await handleDecoded(code.data);
      } catch {
        setResult({ kind: "error", message: t("scan.decodeFail") });
      } finally {
        setDecoding(false);
      }
    },
    [handleDecoded, t],
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

  // `opts.force` — when true, adds `force: true` to the request body so
  // the server bypasses the soft-warning guards (PREREQUISITE_NOT_MET /
  // UPSTREAM_LOCKED) and records an audit row in scan_override_audit.
  // Used by the confirm dialog's Continue button after the worker
  // acknowledges the warning on a prior 202 round-trip.
  async function handleConfirmScan(opts?: { force?: boolean }) {
    // Accept either a fresh lookup OR a confirm-dialog continue. Both
    // carry the order+jobCard context we need to re-post.
    const ctx =
      result.kind === "lookup"
        ? { order: result.order, jobCard: result.jobCard, piece: result.piece }
        : result.kind === "confirm"
          ? { order: result.order, jobCard: result.jobCard, piece: result.piece }
          : null;
    if (!ctx) return;
    if (!workerId) {
      setResult({ kind: "error", message: t("common.error") });
      return;
    }
    setLoading(true);
    try {
      // FG-level merged sticker (today: FAB_CUT). The QR's opId is the
      // sentinel "FG-<DEPT>" so we route to scan-complete-dept, which
      // flips every matching dept card on the PO in one request. The
      // per-piece FIFO routing below doesn't apply to a merged sticker
      // because it spans multiple physical pieces by design.
      const fgMatch = /^FG-([A-Z_]+)$/.exec(ctx.jobCard.id);
      const endpoint = fgMatch
        ? `/api/production-orders/${ctx.order.id}/scan-complete-dept`
        : `/api/production-orders/${ctx.order.id}/scan-complete`;
      const payload = fgMatch
        ? { deptCode: fgMatch[1], workerId, ...(opts?.force ? { force: true } : {}) }
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
            // Forced overrides bypass the PREREQUISITE_NOT_MET / UPSTREAM_LOCKED
            // soft warnings. Server records an audit row in scan_override_audit.
            ...(opts?.force ? { force: true } : {}),
          };
      const res = await workerFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const raw = await res.json();
      const data = ScanCompleteEnvelope.parse(raw);
      // Soft-warning path — server returned HTTP 202 with
      // `requiresConfirmation`. Surface the confirm dialog instead of
      // treating it as an error.
      if (res.status === 202 && data.requiresConfirmation) {
        setResult({
          kind: "confirm",
          order: ctx.order,
          jobCard: ctx.jobCard,
          piece: ctx.piece,
          warning: data.warning || {
            code: "UNKNOWN",
            message: t("common.error"),
          },
        });
        return;
      }
      if (data.success && data.data) {
        setResult({
          kind: "success",
          slot: data.data.assignedSlot as 1 | 2,
          jobCard: data.data.jobCard as JobCard,
          order: ctx.order,
          piece: ctx.piece,
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
        setResult({
          kind: "error",
          message: data.error || t("common.error"),
        });
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
          <div className="text-center text-xs text-[#8A7F73] mb-2">
            {t("scan.manual")}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLookup()}
              placeholder="PO number or job card ID"
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
        const checkPic1 = pieceSlot?.pic1Id ?? result.jobCard.pic1Id;
        const checkPic2 = pieceSlot?.pic2Id ?? result.jobCard.pic2Id;
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

      {/* Soft-warning confirm dialog — shown when the server returned
          HTTP 202 with requiresConfirmation (PREREQUISITE_NOT_MET or
          UPSTREAM_LOCKED). The worker either acknowledges and continues
          (re-posts with force:true, which records an audit row) or
          cancels back to the scanner. Same colour palette as the main
          lookup card so the jump feels contained, not alarming. */}
      {result.kind === "confirm" && (
        <div className="bg-[#FFF8E1] border border-[#F6D672] rounded-xl p-4 space-y-3">
          <div className="flex items-start gap-2 text-[#7A5B1A]">
            <AlertTriangle className="h-5 w-5 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold text-base">
                {t("common.confirm")}
              </p>
              <p className="text-sm mt-0.5 break-words">
                {result.warning.message}
              </p>
              <p className="text-xs mt-1 text-[#9C6F1E]">
                {result.order.poNo} · {wipNameFor(result.jobCard, result.order)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleConfirmScan({ force: true })}
            disabled={loading}
            className="w-full h-12 rounded-lg bg-[#3E6570] hover:bg-[#355863] text-white font-semibold disabled:opacity-60"
          >
            {loading ? t("common.loading") : t("common.continue")}
          </button>
          <button
            type="button"
            onClick={reset}
            className="w-full h-10 rounded-lg border border-[#D8D2CC] bg-white text-[#5A5550] font-semibold"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {/* Success — show the WIP name + piece badge too, so the worker sees
          exactly which piece they just completed. */}
      {result.kind === "success" && (
        <div className="bg-[#3E6570] text-white rounded-xl p-6 text-center">
          <CheckCircle2 className="h-12 w-12 mx-auto mb-3" />
          <p className="text-xl font-bold mb-1">{t("scan.complete")} ✓</p>
          <p className="text-base font-semibold opacity-95">
            {wipNameFor(result.jobCard, result.order)}
          </p>
          <p className="text-sm opacity-90 mt-1">
            {result.order.poNo} · {result.jobCard.departmentCode}
          </p>
          {result.piece && (
            <p className="text-xs opacity-90 mt-1">
              {t("scan.pieceOf")
                .replace("{i}", String(result.piece.pieceNo))
                .replace("{n}", String(result.piece.totalPieces))}
            </p>
          )}
          <p className="text-xs opacity-75 mt-1">PIC slot {result.slot}</p>

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
              <p className="mt-1.5 text-[10px] text-[#9A3A2D]/70 break-all font-mono">
                QR: {result.decoded}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ==========================================================
          LIVE CAMERA OVERLAY
          Full-viewport camera feed with a transparent aiming frame.
          Frames are sampled ~8×/sec by the RAF loop above; first jsQR
          hit closes the overlay and auto-submits via handleDecoded.
          ========================================================== */}
      {liveScanning && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 text-white">
            <span className="text-sm font-semibold">{t("scan.liveScan")}</span>
            <button
              type="button"
              onClick={stopLiveScan}
              className="h-9 w-9 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"
              aria-label={t("scan.cancel")}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted
            />
            {/* Aiming frame */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className="relative"
                style={{ width: "min(70vw, 70vh)", aspectRatio: "1 / 1" }}
              >
                <span className="absolute left-0 top-0 h-10 w-10 border-t-4 border-l-4 border-white rounded-tl-lg" />
                <span className="absolute right-0 top-0 h-10 w-10 border-t-4 border-r-4 border-white rounded-tr-lg" />
                <span className="absolute left-0 bottom-0 h-10 w-10 border-b-4 border-l-4 border-white rounded-bl-lg" />
                <span className="absolute right-0 bottom-0 h-10 w-10 border-b-4 border-r-4 border-white rounded-br-lg" />
              </div>
            </div>
          </div>
          <div className="px-4 py-3 text-white/90 text-center text-sm">
            {t("scan.aimHint")}
          </div>
        </div>
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
                          <span className="font-mono text-right font-semibold">
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

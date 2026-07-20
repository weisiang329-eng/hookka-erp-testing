// ============================================================
// Shared announcement media — used by /worker home (live + popup) AND
// /worker/me (past-announcements archive). Extracted so both surfaces render
// notice attachments identically.
//
// Design (owner-approved 2026-06-26):
//   • Photos → uniform SQUARE cover tiles in a 2-col grid (object-cover so
//     tall/wide/portrait all tile cleanly). >2 photos → "+N" overlay on the
//     last visible tile. Tap opens a FULLSCREEN letterboxed lightbox
//     (object-contain, never cropped) with close / counter / prev-next + swipe.
//   • Video → tile with a centered play-circle; tap plays inline with controls.
//   • PDF / other → a file chip (icon + filename + ext) that opens the
//     worker-token proxy URL in a new tab.
//
// IMPORTANT: media is served via the worker-token proxy
// `/api/worker/ann-files/:id/download` (NOT /api/files — that's cookie-gated
// and 401s on the phone). Keep using this exact URL.
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Play,
  FileText,
  Download,
  ImageOff,
} from "lucide-react";
import { getWorkerToken } from "@/lib/worker-session";

// One media file attached to a notice (image/video/PDF). The bytes live in the
// shared /api/files store; render inline by `mime`.
export type AnnouncementAttachment = {
  fileId: string;
  name: string;
  mime: string;
  size?: number;
};

// Office → worker announcement. The office types ONE language; the backend
// auto-translates title+body into all four worker-portal languages on POST and
// returns them here. Each worker sees the version matching their chosen portal
// language, falling back to the original posted title/body.
export type Announcement = {
  id: string;
  title: string;
  body: string;
  createdAt: string | null;
  translations?: Record<
    "en" | "ms" | "zh" | "my",
    { title: string; body: string }
  > | null;
  attachments?: AnnouncementAttachment[];
  // Category — GENERAL | WARNING | SOP | LEARNING (normalized server-side;
  // missing/unknown → GENERAL). Drives the colored pill badge on every surface.
  category?: "GENERAL" | "WARNING" | "SOP" | "LEARNING";
  // When the office last tapped "Remind" on this notice (ISO) or null. The
  // worker popup uses this for the ONE legitimate re-pop: a notice already
  // tapped "Got it" re-pops only when remindedAt is newer than this device's
  // local ack timestamp. See acknowledgeAnnouncements / refreshAnnouncements.
  remindedAt?: string | null;
};

// NOTE: localizeAnnouncement / fmtDay are intentionally NOT exported from this
// file — exporting non-component functions alongside a component trips the
// react-refresh/only-export-components lint rule. They live as small local
// copies in each consumer (worker/index.tsx, worker/me.tsx). Only the
// component + types are shared from here.

// Worker-token proxy (NOT /api/files — that's cookie-gated and 401s on the
// phone, which is why announcement media never rendered before).
function fileHref(fileId: string): string {
  // Append the worker token as ?wt= so native <img>/<video>/<a download> loads
  // (which can't set the X-Worker-Token header) still authenticate against the
  // proxy — without this they 401 "Not authenticated" and nothing opens. The
  // proxy accepts ?wt= only on this read-only announcement-file route.
  const wt = getWorkerToken();
  const base = `/api/worker/ann-files/${fileId}/download`;
  return wt ? `${base}?wt=${encodeURIComponent(wt)}` : base;
}

// HEIC / HEIF (iPhone's default photo format) cannot be decoded by <img> on
// most non-Safari browsers — it just renders a broken icon. Detect it so we can
// fall back to an "open original" chip (the OS that took the photo CAN open it,
// and Chrome/Android increasingly decodes it too). Best-effort by mime + ext.
function isHeic(att: AnnouncementAttachment): boolean {
  const mime = (att.mime || "").toLowerCase();
  if (mime === "image/heic" || mime === "image/heif") return true;
  return /\.(heic|heif)$/i.test(att.name || "");
}

function extLabel(att: AnnouncementAttachment): string {
  const mime = att.mime || "";
  if (mime === "application/pdf" || /\.pdf$/i.test(att.name || "")) return "PDF";
  const m = /\.([a-z0-9]+)$/i.exec(att.name || "");
  if (m) return m[1].toUpperCase();
  const sub = mime.split("/")[1];
  return sub ? sub.toUpperCase() : "FILE";
}

// Fullscreen image lightbox. Letterboxed (object-contain — never cropped),
// dark bg, close button, "n / N" counter, prev/next arrows + swipe. This is the
// real SPA so fixed positioning is fine.
function PhotoLightbox({
  photos,
  startIndex,
  onClose,
}: {
  photos: AnnouncementAttachment[];
  startIndex: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIndex);
  const total = photos.length;
  const go = useCallback(
    (delta: number) => {
      setIdx((cur) => (cur + delta + total) % total);
    },
    [total],
  );

  // Keyboard nav (desktop / external keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Swipe between photos.
  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  };

  const cur = photos[idx];
  // Per-photo broken flag (keyed by index) so a failed decode in the lightbox
  // shows a placeholder + "open original" instead of a blank dark screen.
  const [brokenIdx, setBrokenIdx] = useState<Set<number>>(new Set());
  const curBroken = brokenIdx.has(idx);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      {/* Close */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white active:bg-white/25"
      >
        <X className="h-5 w-5" />
      </button>

      {/* Counter */}
      {total > 1 && (
        <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white">
          {idx + 1} / {total}
        </div>
      )}

      {/* Prev / Next */}
      {total > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="Previous"
            className="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white active:bg-white/25"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="Next"
            className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white active:bg-white/25"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Image — letterboxed, never cropped. On a load failure, a placeholder
          with an "Open original" link (uses the same token-bearing URL) so the
          worker is never stuck at a blank dark screen. */}
      {cur && !curBroken && (
        <img
          src={fileHref(cur.fileId)}
          alt={cur.name || "image"}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onError={() =>
            setBrokenIdx((prev) => {
              const next = new Set(prev);
              next.add(idx);
              return next;
            })
          }
          className="max-h-[90vh] max-w-[92vw] object-contain"
        />
      )}
      {cur && curBroken && (
        <div
          className="flex flex-col items-center gap-3 px-8 text-center text-white/80"
          onClick={(e) => e.stopPropagation()}
        >
          <ImageOff className="h-10 w-10" />
          <p className="text-sm">This image could not be displayed.</p>
          <a
            href={fileHref(cur.fileId)}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold active:bg-white/25"
          >
            Open original
          </a>
        </div>
      )}
    </div>
  );
}

// Render an announcement's media on the phone. Kept compact so a long media
// list doesn't crowd the small screen (~380px column).
export function AnnouncementMedia({
  attachments,
}: {
  attachments?: AnnouncementAttachment[];
}) {
  // Lightbox state — which photo (by index into the photos-only list) is open.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  if (!attachments || attachments.length === 0) return null;

  // Renderable photos = image/* EXCEPT HEIC/HEIF (which <img> can't decode on
  // most browsers). HEIC images fall through to the "others" chip list so the
  // worker gets a working "open original" link instead of a broken tile.
  const photos = attachments.filter(
    (a) => (a.mime || "").startsWith("image/") && !isHeic(a),
  );
  const others = attachments.filter(
    (a) => !(a.mime || "").startsWith("image/") || isHeic(a),
  );

  // Photos: show at most 2 tiles; if >2, overlay "+N" on the second tile.
  const MAX_TILES = 2;
  const visiblePhotos = photos.slice(0, MAX_TILES);
  const hiddenCount = photos.length - visiblePhotos.length;

  return (
    <div className="mt-2 space-y-2">
      {/* Photo grid — uniform square cover tiles, 2 columns. */}
      {visiblePhotos.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {visiblePhotos.map((att, i) => {
            const isLast = i === visiblePhotos.length - 1;
            const showMore = isLast && hiddenCount > 0;
            return (
              <PhotoTile
                key={att.fileId}
                att={att}
                showMore={showMore}
                hiddenCount={hiddenCount}
                onOpen={() => setLightboxIdx(i)}
              />
            );
          })}
        </div>
      )}

      {/* Non-image attachments: video tiles + file chips. */}
      {others.map((att) => {
        const href = fileHref(att.fileId);
        const mime = att.mime || "";
        if (mime.startsWith("video/")) {
          return <VideoTile key={att.fileId} src={href} />;
        }
        // PDF / other → file chip that opens in a new tab.
        return (
          <a
            key={att.fileId}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-[#E2DDD8] bg-[#FAFAF8] px-3 py-2 text-xs font-medium text-[#5A5550] active:bg-[#F3EFE9]"
          >
            <FileText className="h-4 w-4 shrink-0 text-[#9A3A2D]" />
            <span className="min-w-0 flex-1 truncate">
              {att.name || "Attachment"}
            </span>
            <span className="shrink-0 rounded bg-[#EDE7E0] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#8A6F3A]">
              {extLabel(att)}
            </span>
            <Download className="h-4 w-4 shrink-0 text-[#8A8680]" />
          </a>
        );
      })}

      {lightboxIdx !== null && photos.length > 0 && (
        <PhotoLightbox
          photos={photos}
          startIndex={Math.min(lightboxIdx, photos.length - 1)}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}

// Single photo tile (square cover). If the image fails to load — a missing
// file_assets row (404), an undecodable format, or a network drop — it swaps to
// a graceful "image unavailable" placeholder instead of the browser's broken
// glyph, and stops trying to open the (also-broken) lightbox.
function PhotoTile({
  att,
  showMore,
  hiddenCount,
  onOpen,
}: {
  att: AnnouncementAttachment;
  showMore: boolean;
  hiddenCount: number;
  onOpen: () => void;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="relative flex aspect-square w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-[#E2DDD8] bg-[#F3EFE9] text-[#9A948C]">
        <ImageOff className="h-6 w-6" />
        <span className="px-2 text-center text-[10px] leading-tight">
          Image unavailable
        </span>
        {showMore && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-2xl font-bold text-white">
            +{hiddenCount}
          </span>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative block aspect-square w-full overflow-hidden rounded-lg border border-[#E2DDD8] bg-[#F3EFE9]"
    >
      <img
        src={fileHref(att.fileId)}
        alt={att.name || "image"}
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
      {showMore && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-2xl font-bold text-white">
          +{hiddenCount}
        </span>
      )}
    </button>
  );
}

// Video tile — a poster-less black tile with a centered play-circle overlay.
// Tapping swaps in the native <video controls> and autoplays. If the format
// can't be decoded by this browser (e.g. a .mov / video/quicktime on Android
// Chrome), the <video> fires onError and we fall back to an "Open video" chip
// that hands the file to the OS player via the same token-bearing URL — so a
// posted clip is never a dead black box.
function VideoTile({ src }: { src: string }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-lg border border-[#E2DDD8] bg-[#FAFAF8] px-3 py-2 text-xs font-medium text-[#5A5550] active:bg-[#F3EFE9]"
      >
        <Play className="h-4 w-4 shrink-0 fill-[#9A3A2D] text-[#9A3A2D]" />
        <span className="min-w-0 flex-1 truncate">Video</span>
        <span className="shrink-0 rounded bg-[#EDE7E0] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#8A6F3A]">
          Open
        </span>
        <Download className="h-4 w-4 shrink-0 text-[#8A8680]" />
      </a>
    );
  }

  if (playing) {
    return (
      <video
        src={src}
        controls
        autoPlay
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        className="w-full rounded-lg border border-[#E2DDD8] bg-black"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label="Play video"
      className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-[#E2DDD8] bg-black"
    >
      <video
        src={src}
        preload="metadata"
        muted
        playsInline
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full object-cover opacity-70"
      />
      <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-black/55">
        <Play className="h-7 w-7 fill-white text-white" />
      </span>
    </button>
  );
}

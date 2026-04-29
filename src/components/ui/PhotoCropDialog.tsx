// ---------------------------------------------------------------------------
// PhotoCropDialog — square (or arbitrary aspect ratio) photo crop dialog.
//
// Why inline canvas instead of `react-easy-crop`?
//   The library is well-built (~12KB gz) but adding a dependency for a single
//   page felt heavier than necessary. The interactions we need are small:
//     - Pan (drag the image inside a fixed-aspect viewport)
//     - Zoom (slider scales the image around its center)
//     - Extract (HTMLCanvasElement renders the cropped region as JPEG)
//   The whole thing fits in ~250 lines and gives us full control over the
//   visual style (matches the rest of the ModalOverlay-based dialogs in the
//   app). No new transitive deps in package-lock either.
//
// Design notes:
//   - The image is rendered as an HTMLImageElement positioned absolutely
//     inside a square crop window. We track (offsetX, offsetY) in CSS pixels
//     and a `zoom` multiplier. The image's "natural" CSS size at zoom=1 is
//     calculated to *cover* the crop window (whichever edge is shorter scales
//     up to fill it). Zoom only ever increases scale; we never shrink below
//     "cover" since that would expose blank space inside the crop.
//   - We clamp pan so the image edges can't drift into the crop window — i.e.
//     when the user releases a drag near the corner, the image snaps back so
//     it still covers the crop area.
//   - On Save we re-render at the source image's native pixel density so the
//     output isn't blurred by the on-screen scale factor. Output is JPEG at
//     quality 0.85 with longest side capped at 1280px (matches compressImage
//     in @/lib/image-compress so downstream behavior is identical).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

const OUTPUT_MAX_DIM = 1280;
const OUTPUT_QUALITY = 0.85;

type Props = {
  open: boolean;
  imageDataUrl: string;
  /** Width / height ratio of the crop window. Defaults to 1 (square). */
  aspectRatio?: number;
  onCancel: () => void;
  onConfirm: (croppedDataUrl: string) => void;
};

export function PhotoCropDialog({
  open,
  imageDataUrl,
  aspectRatio = 1,
  onCancel,
  onConfirm,
}: Props) {
  // Source image dimensions — captured once after the image decodes.
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  // Viewport (the on-screen crop window) dimensions, measured after layout so
  // we can clamp pan in CSS pixels.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Transform state.
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Drag tracking.
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // Reset transform whenever the dialog re-opens with a fresh image.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot reset when the dialog opens or the source image changes */
  useEffect(() => {
    if (open) {
      setImgNatural(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    }
  }, [open, imageDataUrl]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Measure viewport once after mount / on resize.
  useEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setViewport({ w: rect.width, h: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // ── Geometry helpers ─────────────────────────────────────────────────────
  // The image is sized to "cover" the viewport at zoom=1. Whichever axis is
  // tighter (image-aspect vs viewport-aspect) wins, and the other axis
  // overflows. zoom > 1 just multiplies the cover size.
  const baseScale = (() => {
    if (!imgNatural || viewport.w === 0) return 1;
    const sx = viewport.w / imgNatural.w;
    const sy = viewport.h / imgNatural.h;
    return Math.max(sx, sy);
  })();
  const displayW = imgNatural ? imgNatural.w * baseScale * zoom : 0;
  const displayH = imgNatural ? imgNatural.h * baseScale * zoom : 0;

  // Clamp pan so the image always covers the viewport.
  const clamp = useCallback(
    (next: { x: number; y: number }) => {
      const maxX = (displayW - viewport.w) / 2;
      const maxY = (displayH - viewport.h) / 2;
      return {
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y)),
      };
    },
    [displayW, displayH, viewport.w, viewport.h],
  );

  // Re-clamp when zoom changes (zooming out can leave the image off-center).
  /* eslint-disable react-hooks/set-state-in-effect -- derived clamp: pan must stay valid as zoom changes */
  useEffect(() => {
    setOffset((prev) => clamp(prev));
  }, [zoom, clamp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Pointer handlers ─────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setOffset(clamp({ x: dragRef.current.baseX + dx, y: dragRef.current.baseY + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // releasePointerCapture throws if the pointer was never captured;
      // safe to ignore.
    }
  };

  // ── Save: render the cropped region to a canvas at native resolution ─────
  const handleSave = useCallback(async () => {
    if (!imgNatural) return;
    // Convert on-screen crop window → source-image pixels.
    // The source-image pixel area visible in the viewport is:
    //   srcW = viewport.w / (baseScale * zoom)
    //   srcH = viewport.h / (baseScale * zoom)
    // The center of that area (in source pixels) is the image center plus
    // the inverse of our pan offset, also divided by the on-screen scale.
    const scale = baseScale * zoom;
    const srcW = viewport.w / scale;
    const srcH = viewport.h / scale;
    const srcCenterX = imgNatural.w / 2 - offset.x / scale;
    const srcCenterY = imgNatural.h / 2 - offset.y / scale;
    const srcX = srcCenterX - srcW / 2;
    const srcY = srcCenterY - srcH / 2;

    // Output dims: clamp longest side to OUTPUT_MAX_DIM, preserving aspect.
    const cropAspect = aspectRatio;
    let outW: number;
    let outH: number;
    if (cropAspect >= 1) {
      outW = Math.min(OUTPUT_MAX_DIM, Math.round(srcW));
      outH = Math.round(outW / cropAspect);
    } else {
      outH = Math.min(OUTPUT_MAX_DIM, Math.round(srcH));
      outW = Math.round(outH * cropAspect);
    }
    outW = Math.max(1, outW);
    outH = Math.max(1, outH);

    // Decode the source image once more — using a fresh Image instance lets
    // us draw at native resolution regardless of the on-screen <img> size.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Failed to decode image for crop"));
      i.src = imageDataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      // Extremely defensive — every browser supports 2D context. Fallback:
      // hand the source back unmodified rather than block the user.
      onConfirm(imageDataUrl);
      return;
    }
    // High-quality smoothing for downscale.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
    const dataUrl = canvas.toDataURL("image/jpeg", OUTPUT_QUALITY);
    onConfirm(dataUrl);
  }, [
    imgNatural,
    baseScale,
    zoom,
    viewport.w,
    viewport.h,
    offset.x,
    offset.y,
    aspectRatio,
    imageDataUrl,
    onConfirm,
  ]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="relative w-full max-w-lg rounded-xl bg-white border border-[#E2DDD8] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2DDD8] px-6 py-4">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Crop Photo</h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            aria-label="Cancel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-gray-500">
            Drag to pan, use the slider to zoom. The area inside the frame will be saved.
          </p>
          {/* Crop viewport — fixed aspect ratio, image positioned absolutely inside */}
          <div
            ref={viewportRef}
            className="relative w-full overflow-hidden rounded-lg bg-[#1F1D1B] select-none touch-none"
            style={{ aspectRatio: String(aspectRatio) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              src={imageDataUrl}
              alt="Crop preview"
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                setImgNatural({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: displayW > 0 ? `${displayW}px` : undefined,
                height: displayH > 0 ? `${displayH}px` : undefined,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                pointerEvents: "none",
                maxWidth: "none",
              }}
            />
            {/* Frame outline — purely decorative, helps the user see the crop bounds */}
            <div className="absolute inset-0 ring-2 ring-white/70 ring-inset pointer-events-none rounded-lg" />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 w-12">Zoom</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="flex-1 accent-[#6B5C32]"
              aria-label="Zoom"
            />
            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
              {zoom.toFixed(2)}x
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#E2DDD8] px-6 py-4">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!imgNatural}
          >
            Save Crop
          </Button>
        </div>
      </div>
    </div>
  );
}

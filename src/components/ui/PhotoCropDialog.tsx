// ---------------------------------------------------------------------------
// PhotoCropDialog — phone-app style photo crop / rotate / zoom dialog.
//
// Why a custom implementation instead of `react-easy-crop`?
//   The library handles pan + zoom + cropAreaSize, but does NOT ship the
//   resizable crop frame (corner + edge handles), the aspect-ratio toggle
//   row, or the rotation buttons that mirror the iPhone Photos / Google
//   Photos workflow we want here. Building it custom means one component
//   owns the whole interaction model and the bundle delta stays at zero.
//
// Coordinate model:
//   - The image is rendered at `baseScale * zoom` inside a fixed-size
//     viewport box. `baseScale` "contains" the rotated image inside the
//     viewport so the user can always see the whole photo before zooming.
//   - Pan is tracked in CSS pixels (offset.x / offset.y) relative to the
//     viewport center.
//   - The crop rectangle floats above the image in viewport-pixel space.
//     When the user drags a handle the rect resizes (and snaps to the
//     active aspect ratio if one is locked); the image underneath does
//     not move.
//   - On Save we render the cropped region at native source resolution by
//     mapping each crop-rect corner back into source-image space using
//     the inverse of (rotate, scale, translate), then drawing on a canvas
//     sized to the crop's natural pixel bounding box (capped at 1280 on
//     longest side).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, RotateCw, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const OUTPUT_MAX_DIM = 1280;
const OUTPUT_QUALITY = 0.85;

// Minimum side length of the crop rectangle in viewport CSS pixels —
// keeps tiny crops usable on touch.
const MIN_CROP_PX = 64;

// Visible drag handle hit area (CSS pixels). We render an 18px square
// for touch comfort but the actual visible dot is smaller.
const HANDLE_HIT = 22;

type AspectKey = "free" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";

const ASPECT_OPTIONS: { key: AspectKey; label: string; ratio: number | null }[] = [
  { key: "free", label: "Free", ratio: null },
  { key: "1:1", label: "1:1", ratio: 1 },
  { key: "4:3", label: "4:3", ratio: 4 / 3 },
  { key: "3:4", label: "3:4", ratio: 3 / 4 },
  { key: "16:9", label: "16:9", ratio: 16 / 9 },
  { key: "9:16", label: "9:16", ratio: 9 / 16 },
];

type Props = {
  open: boolean;
  imageDataUrl: string;
  /**
   * Width / height ratio used as the *initial* lock. The user can switch
   * to any other ratio (or "Free") inside the dialog. Defaults to 1.
   */
  aspectRatio?: number;
  onCancel: () => void;
  onConfirm: (croppedDataUrl: string) => void;
};

type Rect = { x: number; y: number; w: number; h: number };

type DragKind =
  | { kind: "pan" }
  | { kind: "move-rect" }
  | { kind: "resize"; corner: ResizeCorner };

type ResizeCorner =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w";

const HANDLE_CURSORS: Record<ResizeCorner, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

// Pick the closest preset to the incoming aspectRatio prop so the toggle
// row reflects what the caller asked for. Falls back to 1:1.
function aspectKeyForRatio(r: number | undefined): AspectKey {
  if (!r || !Number.isFinite(r) || r <= 0) return "1:1";
  let best: AspectKey = "1:1";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const opt of ASPECT_OPTIONS) {
    if (opt.ratio == null) continue;
    const diff = Math.abs(opt.ratio - r);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = opt.key;
    }
  }
  return best;
}

export function PhotoCropDialog({
  open,
  imageDataUrl,
  aspectRatio = 1,
  onCancel,
  onConfirm,
}: Props) {
  // Source image dimensions captured once after decode.
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);

  // Viewport sizing. We measure with a ResizeObserver so the box can
  // grow / shrink with the dialog.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Image transform.
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0); // multiple of 90, signed

  // Aspect ratio + crop rect. Crop rect is in viewport CSS pixels.
  const initialKey = useMemo(() => aspectKeyForRatio(aspectRatio), [aspectRatio]);
  const [aspectKey, setAspectKey] = useState<AspectKey>(initialKey);
  const aspectLock = useMemo(
    () => ASPECT_OPTIONS.find((o) => o.key === aspectKey)?.ratio ?? null,
    [aspectKey],
  );
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });

  // True while a pointer interaction is active — drives the rule-of-thirds
  // overlay so it only shows while the user is actually cropping.
  const [interacting, setInteracting] = useState(false);

  // Pointer tracking. We support 1-pointer drag (pan / move-rect / resize)
  // and 2-pointer pinch zoom. `activePointers` keeps the live set.
  const dragStateRef = useRef<{
    kind: DragKind;
    startX: number;
    startY: number;
    base: {
      offset: { x: number; y: number };
      crop: Rect;
    };
  } | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStateRef = useRef<{
    startDist: number;
    startZoom: number;
    centroid: { x: number; y: number };
    startOffset: { x: number; y: number };
  } | null>(null);

  // ── Lifecycle: reset on open / image change ────────────────────────────
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot reset when dialog opens or source image changes */
  useEffect(() => {
    if (open) {
      setImgNatural(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setRotation(0);
      setAspectKey(initialKey);
      setCrop({ x: 0, y: 0, w: 0, h: 0 });
    }
  }, [open, imageDataUrl, initialKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Measure viewport after layout / on resize.
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

  // ── Geometry helpers ──────────────────────────────────────────────────
  // After rotation by ±90 the displayed image bounding box swaps W/H.
  const rotatedNatural = useMemo(() => {
    if (!imgNatural) return null;
    const swap = ((rotation / 90) % 2 + 2) % 2 === 1;
    return swap
      ? { w: imgNatural.h, h: imgNatural.w }
      : { w: imgNatural.w, h: imgNatural.h };
  }, [imgNatural, rotation]);

  const baseScale = useMemo(() => {
    if (!rotatedNatural || viewport.w === 0 || viewport.h === 0) return 1;
    const sx = viewport.w / rotatedNatural.w;
    const sy = viewport.h / rotatedNatural.h;
    return Math.min(sx, sy);
  }, [rotatedNatural, viewport.w, viewport.h]);

  const displayW = rotatedNatural ? rotatedNatural.w * baseScale * zoom : 0;
  const displayH = rotatedNatural ? rotatedNatural.h * baseScale * zoom : 0;

  const clampOffset = useCallback(
    (next: { x: number; y: number }) => {
      const xRange = Math.max(0, (displayW - viewport.w) / 2);
      const yRange = Math.max(0, (displayH - viewport.h) / 2);
      return {
        x: xRange > 0 ? Math.max(-xRange, Math.min(xRange, next.x)) : 0,
        y: yRange > 0 ? Math.max(-yRange, Math.min(yRange, next.y)) : 0,
      };
    },
    [displayW, displayH, viewport.w, viewport.h],
  );

  // Re-clamp pan when zoom or rotation changes.
  /* eslint-disable react-hooks/set-state-in-effect -- derived clamp */
  useEffect(() => {
    setOffset((prev) => clampOffset(prev));
  }, [zoom, rotation, clampOffset]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Displayed image bounds in viewport coords (at zoom = 1, contain-fit).
  // We use these — not the full viewport — to size the initial crop rect so
  // the user opens the dialog with the whole photo "selected" instead of a
  // small square in the middle of letterboxed dead space.
  const displayedImageBounds = useMemo(() => {
    if (!rotatedNatural || viewport.w === 0 || viewport.h === 0) return null;
    const dw = rotatedNatural.w * baseScale;
    const dh = rotatedNatural.h * baseScale;
    const dx = (viewport.w - dw) / 2;
    const dy = (viewport.h - dh) / 2;
    return { x: dx, y: dy, w: dw, h: dh };
  }, [rotatedNatural, baseScale, viewport.w, viewport.h]);

  // Fit a crop rectangle of given aspect inside a target rect, centered.
  // When `lockRatio` is null the crop fills the entire target; otherwise we
  // fit the LARGEST `lockRatio` rect inside the target. The result never
  // shrinks below `minSide` on its smaller axis (used to keep the initial
  // crop generously sized when the image's aspect is wildly off the lock).
  const fitCropToBounds = useCallback(
    (lockRatio: number | null, target: Rect, minSide: number): Rect => {
      if (target.w <= 0 || target.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
      if (lockRatio == null) {
        return { x: target.x, y: target.y, w: target.w, h: target.h };
      }
      let w = target.w;
      let h = w / lockRatio;
      if (h > target.h) {
        h = target.h;
        w = h * lockRatio;
      }
      // Enforce the minimum size on the smaller axis. We only grow up to the
      // viewport bounds via the caller's clamp; here we just bump dimensions
      // and let the outer clamp pull us back if we overflow the viewport.
      const smallerNow = Math.min(w, h);
      if (smallerNow < minSide) {
        const scale = minSide / smallerNow;
        w *= scale;
        h *= scale;
      }
      return {
        x: target.x + (target.w - w) / 2,
        y: target.y + (target.h - h) / 2,
        w,
        h,
      };
    },
    [],
  );

  // Initialize / re-fit crop rect when viewport size lands or aspect changes.
  /* eslint-disable react-hooks/set-state-in-effect -- crop rect must follow viewport / aspect changes */
  useEffect(() => {
    if (viewport.w === 0 || viewport.h === 0) return;
    if (!displayedImageBounds) return;
    const minSide = Math.min(viewport.w, viewport.h) * 0.7;
    setCrop((prev) => {
      // First sizing — match the displayed image bounds. If aspect is locked
      // and the image's bounds are within 5% of that aspect, fit the rect to
      // the full image (so the whole photo is "selected"). Otherwise fit the
      // largest aspect-locked rect inside the displayed image.
      if (prev.w === 0 || prev.h === 0) {
        if (aspectLock == null) {
          return {
            x: displayedImageBounds.x,
            y: displayedImageBounds.y,
            w: displayedImageBounds.w,
            h: displayedImageBounds.h,
          };
        }
        const dispRatio = displayedImageBounds.w / displayedImageBounds.h;
        const closeEnough = Math.abs(dispRatio - aspectLock) / aspectLock <= 0.05;
        if (closeEnough) {
          return {
            x: displayedImageBounds.x,
            y: displayedImageBounds.y,
            w: displayedImageBounds.w,
            h: displayedImageBounds.h,
          };
        }
        return fitCropToBounds(aspectLock, displayedImageBounds, minSide);
      }
      // Aspect changed and we now have a lock — refit centered inside the
      // displayed image bounds.
      if (aspectLock != null) {
        const currentRatio = prev.w / prev.h;
        if (Math.abs(currentRatio - aspectLock) > 0.001) {
          return fitCropToBounds(aspectLock, displayedImageBounds, minSide);
        }
      }
      // Still inside viewport? keep it. Otherwise clamp to bounds.
      const x = Math.max(0, Math.min(viewport.w - prev.w, prev.x));
      const y = Math.max(0, Math.min(viewport.h - prev.h, prev.y));
      const w = Math.min(prev.w, viewport.w);
      const h = Math.min(prev.h, viewport.h);
      return { x, y, w, h };
    });
  }, [viewport.w, viewport.h, aspectLock, displayedImageBounds, fitCropToBounds]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Pointer handlers ──────────────────────────────────────────────────
  const startDrag = (kind: DragKind, e: React.PointerEvent) => {
    dragStateRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      base: { offset: { ...offset }, crop: { ...crop } },
    };
    setInteracting(true);
  };

  const onViewportPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two pointers => pinch zoom. Cancel any single-pointer drag.
    if (activePointersRef.current.size === 2) {
      const [p1, p2] = Array.from(activePointersRef.current.values());
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.hypot(dx, dy);
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      pinchStateRef.current = {
        startDist: Math.max(1, dist),
        startZoom: zoom,
        centroid: { x: cx, y: cy },
        startOffset: { ...offset },
      };
      dragStateRef.current = null;
      setInteracting(true);
      return;
    }

    // One pointer on an empty viewport area => pan the image.
    startDrag({ kind: "pan" }, e);
  };

  const onCropAreaPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointersRef.current.size === 2) {
      // Promote to pinch zoom — same logic as viewport.
      const [p1, p2] = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      pinchStateRef.current = {
        startDist: Math.max(1, dist),
        startZoom: zoom,
        centroid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        startOffset: { ...offset },
      };
      dragStateRef.current = null;
      setInteracting(true);
      return;
    }
    startDrag({ kind: "move-rect" }, e);
  };

  const onHandlePointerDown = (corner: ResizeCorner) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startDrag({ kind: "resize", corner }, e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    // Pinch zoom in flight — update zoom and pan around centroid.
    const pinch = pinchStateRef.current;
    if (pinch && activePointersRef.current.size >= 2) {
      const pts = Array.from(activePointersRef.current.values());
      const p1 = pts[0];
      const p2 = pts[1];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const ratio = dist / pinch.startDist;
      const nextZoom = clampZoom(pinch.startZoom * ratio);

      // Pan so the centroid stays anchored to the same source-pixel.
      const vp = viewportRef.current?.getBoundingClientRect();
      if (vp) {
        const cxLocal = pinch.centroid.x - (vp.left + vp.width / 2);
        const cyLocal = pinch.centroid.y - (vp.top + vp.height / 2);
        const scaleRatio = nextZoom / pinch.startZoom;
        const nextOffset = {
          x: pinch.startOffset.x + cxLocal * (1 - scaleRatio),
          y: pinch.startOffset.y + cyLocal * (1 - scaleRatio),
        };
        setZoom(nextZoom);
        setOffset(clampOffset(nextOffset));
      } else {
        setZoom(nextZoom);
      }
      return;
    }

    const drag = dragStateRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.kind.kind === "pan") {
      setOffset(clampOffset({ x: drag.base.offset.x + dx, y: drag.base.offset.y + dy }));
      return;
    }

    if (drag.kind.kind === "move-rect") {
      const next = {
        ...drag.base.crop,
        x: drag.base.crop.x + dx,
        y: drag.base.crop.y + dy,
      };
      next.x = Math.max(0, Math.min(viewport.w - next.w, next.x));
      next.y = Math.max(0, Math.min(viewport.h - next.h, next.y));
      setCrop(next);
      return;
    }

    if (drag.kind.kind === "resize") {
      setCrop(resizeCropRect(drag.base.crop, drag.kind.corner, dx, dy, aspectLock, viewport));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStateRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      dragStateRef.current = null;
      setInteracting(false);
    }
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      // releasePointerCapture throws if the pointer was never captured;
      // safe to ignore.
    }
  };

  // ── Wheel zoom ────────────────────────────────────────────────────────
  const onWheel = (e: React.WheelEvent) => {
    if (!viewportRef.current) return;
    e.preventDefault();
    const vp = viewportRef.current.getBoundingClientRect();
    const cxLocal = e.clientX - (vp.left + vp.width / 2);
    const cyLocal = e.clientY - (vp.top + vp.height / 2);
    // deltaY > 0 (wheel down) zooms out, deltaY < 0 zooms in.
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nextZoom = clampZoom(zoom * factor);
    const scaleRatio = nextZoom / zoom;
    const nextOffset = {
      x: offset.x + cxLocal * (1 - scaleRatio),
      y: offset.y + cyLocal * (1 - scaleRatio),
    };
    setZoom(nextZoom);
    setOffset(clampOffset(nextOffset));
  };

  // ── Reset / rotate ────────────────────────────────────────────────────
  // Reset now falls back to a viewport-only fit if the displayed image
  // bounds aren't ready yet (defensive — the dialog shouldn't render the
  // reset button before the image decodes, but we don't want to crash if
  // the user mashes Reset while the image is still loading).
  const fallbackBounds: Rect = { x: 0, y: 0, w: viewport.w, h: viewport.h };
  const minSideForReset = Math.min(viewport.w, viewport.h) * 0.7;

  const handleReset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
    setAspectKey(initialKey);
    const lock = ASPECT_OPTIONS.find((o) => o.key === initialKey)?.ratio ?? null;
    const bounds = displayedImageBounds ?? fallbackBounds;
    if (lock == null) {
      setCrop({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      return;
    }
    const dispRatio = bounds.w / bounds.h;
    const closeEnough = Math.abs(dispRatio - lock) / lock <= 0.05;
    if (closeEnough) {
      setCrop({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      return;
    }
    setCrop(fitCropToBounds(lock, bounds, minSideForReset));
  };

  const rotateBy = (delta: 90 | -90) => {
    setRotation((r) => {
      const next = ((r + delta) % 360 + 360) % 360;
      return next;
    });
    // After rotate the visible image bounds change; re-fit crop into the
    // (post-rotate) displayed image using current aspect lock. We can't read
    // the post-rotate bounds yet (state update is async), so fit against the
    // current bounds — the init effect re-runs after the rotation lands and
    // settles to the right size.
    const bounds = displayedImageBounds ?? fallbackBounds;
    setCrop(fitCropToBounds(aspectLock, bounds, minSideForReset));
    setOffset({ x: 0, y: 0 });
  };

  // Aspect button click — picks up the new key. "Free" gets special-cased
  // so it always snaps the crop rect back to the displayed image bounds
  // (full photo selected); other aspects fall through to the init effect
  // which refits the rect for the new lock.
  const handleAspectClick = (key: AspectKey) => {
    setAspectKey(key);
    if (key === "free") {
      const bounds = displayedImageBounds ?? fallbackBounds;
      setCrop({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
    }
  };

  // ── Save: bake rotation + zoom + pan + crop into a JPEG ───────────────
  const handleSave = useCallback(async () => {
    if (!imgNatural || crop.w === 0 || crop.h === 0) return;

    // Map crop rect (viewport CSS px) → source-image px.
    //
    // Forward transform from source-image px (sx, sy) to viewport CSS px
    // (vx, vy), with the image origin at its center:
    //   vx = (rotated_x - rotW/2) * baseScale * zoom + offset.x + viewport.w/2
    //   vy = (rotated_y - rotH/2) * baseScale * zoom + offset.y + viewport.h/2
    // where (rotated_x, rotated_y) is the source pixel after applying the
    // rotation around the source image center.
    //
    // We need the inverse: viewport px → un-rotated source px. Build the
    // crop rect's four corners in viewport space, invert to rotated-source
    // space, then un-rotate back to source pixels.

    const scale = baseScale * zoom;
    const rotW = rotatedNatural?.w ?? imgNatural.w;
    const rotH = rotatedNatural?.h ?? imgNatural.h;

    const viewToRotatedSrc = (vx: number, vy: number) => {
      const rx = (vx - viewport.w / 2 - offset.x) / scale + rotW / 2;
      const ry = (vy - viewport.h / 2 - offset.y) / scale + rotH / 2;
      return { x: rx, y: ry };
    };

    // For canvas: easier path is to draw the rotated image onto a temp
    // canvas, then crop. Build a "rotated source" canvas at native px and
    // map crop coordinates from rotated-source space directly to it.
    const corner = viewToRotatedSrc(crop.x, crop.y);
    const cropSrcW = crop.w / scale;
    const cropSrcH = crop.h / scale;
    const srcX = corner.x;
    const srcY = corner.y;

    // Output size: cap longest side at OUTPUT_MAX_DIM, preserving the
    // crop rect's aspect ratio.
    const cropAspect = crop.w / crop.h;
    let outW: number;
    let outH: number;
    if (cropAspect >= 1) {
      outW = Math.min(OUTPUT_MAX_DIM, Math.round(cropSrcW));
      outW = Math.max(1, outW);
      outH = Math.max(1, Math.round(outW / cropAspect));
    } else {
      outH = Math.min(OUTPUT_MAX_DIM, Math.round(cropSrcH));
      outH = Math.max(1, outH);
      outW = Math.max(1, Math.round(outH * cropAspect));
    }

    // Decode the source image at native size.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Failed to decode image for crop"));
      i.src = imageDataUrl;
    });

    // Canvas A: rotated source image, native rotated dimensions.
    const rotCanvas = document.createElement("canvas");
    rotCanvas.width = Math.max(1, Math.round(rotW));
    rotCanvas.height = Math.max(1, Math.round(rotH));
    const rotCtx = rotCanvas.getContext("2d");
    if (!rotCtx) {
      onConfirm(imageDataUrl);
      return;
    }
    rotCtx.fillStyle = "#FFFFFF";
    rotCtx.fillRect(0, 0, rotCanvas.width, rotCanvas.height);
    rotCtx.imageSmoothingEnabled = true;
    rotCtx.imageSmoothingQuality = "high";
    // Draw the un-rotated source onto the rotated canvas with the same
    // rotation that the user applied.
    rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
    rotCtx.rotate((rotation * Math.PI) / 180);
    rotCtx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    rotCtx.setTransform(1, 0, 0, 1, 0, 0);

    // Canvas B: final output. White-fill so any region of the crop that
    // extends beyond the rotated image bounds (when zoomed out) renders
    // as white letterbox in the JPEG instead of canvas-default black.
    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext("2d");
    if (!outCtx) {
      onConfirm(imageDataUrl);
      return;
    }
    outCtx.fillStyle = "#FFFFFF";
    outCtx.fillRect(0, 0, outW, outH);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(rotCanvas, srcX, srcY, cropSrcW, cropSrcH, 0, 0, outW, outH);

    const dataUrl = outCanvas.toDataURL("image/jpeg", OUTPUT_QUALITY);
    onConfirm(dataUrl);
  }, [
    imgNatural,
    rotatedNatural,
    rotation,
    baseScale,
    zoom,
    viewport.w,
    viewport.h,
    offset.x,
    offset.y,
    crop,
    imageDataUrl,
    onConfirm,
  ]);

  // ── Keyboard ──────────────────────────────────────────────────────────
  // Window-level Escape / Enter binding so the user does not have to focus
  // a specific element inside the dialog first. handleSave is captured via
  // the dependency list so the latest closure is always used.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel, handleSave]);

  if (!open) return null;

  const showGrid = interacting;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
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
            Drag to pan, pinch or scroll to zoom, drag the corners to resize the crop frame.
          </p>

          {/* Aspect ratio toggle row */}
          <div className="flex flex-wrap items-center gap-1.5">
            {ASPECT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => handleAspectClick(opt.key)}
                className={
                  "px-2.5 py-1 rounded-md text-xs font-medium transition-colors border " +
                  (aspectKey === opt.key
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "bg-white text-[#1F1D1B] border-[#E2DDD8] hover:bg-[#F0ECE9]")
                }
                aria-pressed={aspectKey === opt.key}
              >
                {opt.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => rotateBy(-90)}
                className="rounded-md border border-[#E2DDD8] bg-white p-1.5 text-[#1F1D1B] hover:bg-[#F0ECE9] transition-colors"
                aria-label="Rotate -90 degrees"
                title="Rotate -90 degrees"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => rotateBy(90)}
                className="rounded-md border border-[#E2DDD8] bg-white p-1.5 text-[#1F1D1B] hover:bg-[#F0ECE9] transition-colors"
                aria-label="Rotate +90 degrees"
                title="Rotate +90 degrees"
              >
                <RotateCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-md border border-[#E2DDD8] bg-white p-1.5 text-[#1F1D1B] hover:bg-[#F0ECE9] transition-colors"
                aria-label="Reset"
                title="Reset"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Viewport — fixed 4:3 stage so the crop rect has room on every aspect */}
          <div
            ref={viewportRef}
            className="relative w-full overflow-hidden rounded-lg bg-[#1F1D1B] select-none touch-none"
            style={{ aspectRatio: "4 / 3" }}
            onPointerDown={onViewportPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
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
                width: imgNatural ? `${imgNatural.w * baseScale * zoom}px` : undefined,
                height: imgNatural ? `${imgNatural.h * baseScale * zoom}px` : undefined,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) rotate(${rotation}deg)`,
                pointerEvents: "none",
                maxWidth: "none",
                transformOrigin: "center center",
              }}
            />

            {/* Dim the area outside the crop rect with a 4-segment overlay */}
            {crop.w > 0 && (
              <>
                <div
                  className="absolute bg-black/45 pointer-events-none"
                  style={{ left: 0, top: 0, width: "100%", height: `${crop.y}px` }}
                />
                <div
                  className="absolute bg-black/45 pointer-events-none"
                  style={{
                    left: 0,
                    top: `${crop.y + crop.h}px`,
                    width: "100%",
                    bottom: 0,
                  }}
                />
                <div
                  className="absolute bg-black/45 pointer-events-none"
                  style={{
                    left: 0,
                    top: `${crop.y}px`,
                    width: `${crop.x}px`,
                    height: `${crop.h}px`,
                  }}
                />
                <div
                  className="absolute bg-black/45 pointer-events-none"
                  style={{
                    left: `${crop.x + crop.w}px`,
                    top: `${crop.y}px`,
                    right: 0,
                    height: `${crop.h}px`,
                  }}
                />
              </>
            )}

            {/* Crop rectangle (interactive) */}
            {crop.w > 0 && (
              <div
                className="absolute ring-2 ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
                style={{
                  left: `${crop.x}px`,
                  top: `${crop.y}px`,
                  width: `${crop.w}px`,
                  height: `${crop.h}px`,
                  cursor: "move",
                }}
                onPointerDown={onCropAreaPointerDown}
              >
                {/* Rule of thirds — only while interacting */}
                {showGrid && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-0 bottom-0" style={{ left: "33.333%", width: 1, background: "rgba(255,255,255,0.5)" }} />
                    <div className="absolute top-0 bottom-0" style={{ left: "66.666%", width: 1, background: "rgba(255,255,255,0.5)" }} />
                    <div className="absolute left-0 right-0" style={{ top: "33.333%", height: 1, background: "rgba(255,255,255,0.5)" }} />
                    <div className="absolute left-0 right-0" style={{ top: "66.666%", height: 1, background: "rgba(255,255,255,0.5)" }} />
                  </div>
                )}

                {/* 8 handles */}
                {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as ResizeCorner[]).map((c) => (
                  <CropHandle
                    key={c}
                    corner={c}
                    onPointerDown={onHandlePointerDown(c)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Zoom slider — min is 0.3 so the user can shrink the photo
              below the contain-fit (zoom < 1 leaves white margins inside
              the viewport, which the save path bakes into the JPEG). */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 w-12">Zoom</span>
            <input
              type="range"
              min={0.3}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="flex-1 accent-[#6B5C32]"
              aria-label="Zoom"
            />
            <span className="text-xs text-gray-500 w-12 text-right tabular-nums">
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

// ── Subcomponents ─────────────────────────────────────────────────────────

function CropHandle({
  corner,
  onPointerDown,
}: {
  corner: ResizeCorner;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const pos = handlePosition(corner);
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: pos.left,
        top: pos.top,
        width: HANDLE_HIT,
        height: HANDLE_HIT,
        transform: "translate(-50%, -50%)",
        cursor: HANDLE_CURSORS[corner],
        touchAction: "none",
      }}
      aria-label={`Resize ${corner}`}
    >
      <div
        className="absolute bg-white border border-black/30 rounded-sm"
        style={{
          left: "50%",
          top: "50%",
          width: 10,
          height: 10,
          transform: "translate(-50%, -50%)",
        }}
      />
    </div>
  );
}

function handlePosition(corner: ResizeCorner): { left: string; top: string } {
  switch (corner) {
    case "nw": return { left: "0%", top: "0%" };
    case "n": return { left: "50%", top: "0%" };
    case "ne": return { left: "100%", top: "0%" };
    case "e": return { left: "100%", top: "50%" };
    case "se": return { left: "100%", top: "100%" };
    case "s": return { left: "50%", top: "100%" };
    case "sw": return { left: "0%", top: "100%" };
    case "w": return { left: "0%", top: "50%" };
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function clampZoom(z: number) {
  return Math.max(0.3, Math.min(4, z));
}

// Resize a crop rect by dragging one of 8 handles. Honors the aspect lock
// (corner drags only — edge drags are intrinsically single-axis and always
// "free"), keeps the rect inside the viewport, and enforces MIN_CROP_PX.
function resizeCropRect(
  base: Rect,
  corner: ResizeCorner,
  dx: number,
  dy: number,
  aspectLock: number | null,
  viewport: { w: number; h: number },
): Rect {
  // Determine which edges the corner moves.
  const movesLeft = corner === "nw" || corner === "w" || corner === "sw";
  const movesRight = corner === "ne" || corner === "e" || corner === "se";
  const movesTop = corner === "nw" || corner === "n" || corner === "ne";
  const movesBottom = corner === "sw" || corner === "s" || corner === "se";

  let x = base.x;
  let y = base.y;
  let w = base.w;
  let h = base.h;

  if (movesLeft) {
    const proposedX = base.x + dx;
    const clampedX = Math.max(0, Math.min(base.x + base.w - MIN_CROP_PX, proposedX));
    w = base.w + (base.x - clampedX);
    x = clampedX;
  } else if (movesRight) {
    const proposedRight = base.x + base.w + dx;
    const clampedRight = Math.max(base.x + MIN_CROP_PX, Math.min(viewport.w, proposedRight));
    w = clampedRight - base.x;
  }

  if (movesTop) {
    const proposedY = base.y + dy;
    const clampedY = Math.max(0, Math.min(base.y + base.h - MIN_CROP_PX, proposedY));
    h = base.h + (base.y - clampedY);
    y = clampedY;
  } else if (movesBottom) {
    const proposedBottom = base.y + base.h + dy;
    const clampedBottom = Math.max(base.y + MIN_CROP_PX, Math.min(viewport.h, proposedBottom));
    h = clampedBottom - base.y;
  }

  // Apply aspect lock for corner drags. Edges stay free even with lock so
  // the user can have a freeform rectangle while still being able to nudge
  // a side; the design doc treats edges as single-axis. To keep things
  // predictable we only lock corner drags.
  const isCorner = corner === "nw" || corner === "ne" || corner === "se" || corner === "sw";
  if (aspectLock != null && isCorner) {
    // Choose the axis that grew most relative to the base, scale the other.
    const dW = Math.abs(w - base.w);
    const dH = Math.abs(h - base.h);
    if (dW * (1 / Math.max(aspectLock, 1e-6)) > dH) {
      // Width drove the change → derive height.
      const desiredH = w / aspectLock;
      const newH = Math.max(MIN_CROP_PX, desiredH);
      // Anchor to the corner's fixed point.
      if (movesTop) {
        y = base.y + base.h - newH;
      }
      h = newH;
    } else {
      const desiredW = h * aspectLock;
      const newW = Math.max(MIN_CROP_PX, desiredW);
      if (movesLeft) {
        x = base.x + base.w - newW;
      }
      w = newW;
    }

    // Now re-clamp into viewport — if we'd overflow, scale both dims down
    // proportionally rather than break the lock.
    const overRight = x + w - viewport.w;
    const overBottom = y + h - viewport.h;
    const overLeft = -x;
    const overTop = -y;
    const overflow = Math.max(overRight, overBottom, overLeft, overTop, 0);
    if (overflow > 0) {
      // Walk back the change uniformly. We compute a max scale that keeps
      // the rect fully inside.
      const maxW = Math.min(
        viewport.w - (movesLeft ? base.x + base.w - viewport.w + 0 : x),
        viewport.w,
      );
      const maxH = Math.min(
        viewport.h - (movesTop ? base.y + base.h - viewport.h + 0 : y),
        viewport.h,
      );
      const fitW = Math.min(w, Math.max(MIN_CROP_PX, maxW));
      const fitH = Math.min(h, Math.max(MIN_CROP_PX, maxH));
      // Recompute respecting aspect.
      let newW = fitW;
      let newH = newW / aspectLock;
      if (newH > fitH) {
        newH = fitH;
        newW = newH * aspectLock;
      }
      if (movesLeft) x = base.x + base.w - newW;
      if (movesTop) y = base.y + base.h - newH;
      w = newW;
      h = newH;
    }
  }

  // Final viewport clamp + min-size guard.
  if (w < MIN_CROP_PX) w = MIN_CROP_PX;
  if (h < MIN_CROP_PX) h = MIN_CROP_PX;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > viewport.w) w = viewport.w - x;
  if (y + h > viewport.h) h = viewport.h - y;

  return { x, y, w, h };
}

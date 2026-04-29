"use client";

import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X, Eraser, Upload, Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { compressImage } from "@/lib/image-compress";
import type { ProofOfDelivery } from "@/types";

interface PODDialogProps {
  open: boolean;
  doNo: string;
  customerName: string;
  onClose: () => void;
  onSubmit: (pod: ProofOfDelivery) => Promise<void> | void;
}

const MAX_PHOTOS = 5;

// ---------------------------------------------------------------------------
// POD photo size guards.
//
// The whole POD blob (signature + up to 5 photos + receiver fields) is
// stringified and written to delivery_orders.proofOfDelivery, a TEXT column
// on D1 (Cloudflare D1 / SQLite). D1 enforces a 1 MB row size limit — and
// we share that row with every other DO column. Five raw 12 MP iPhone
// captures encoded as base64 weigh in around 50–80 MB, which would silently
// fail the UPDATE in production.
//
// To stay safely under the limit we:
//   1. Reject any individual file > MAX_INPUT_FILE_BYTES (10 MB) before it
//      ever hits the canvas.
//   2. Resize every accepted file to PHOTO_MAX_DIMENSION (longest side) and
//      JPEG-encode at PHOTO_JPEG_QUALITY. Empirically this lands ~150–200 KB
//      per photo for a typical phone capture (target = MAX_POD_PHOTO_BYTES).
//   3. Re-check the final stringified POD size against MAX_POD_JSON_BYTES
//      (700 KB ceiling, ~30 % headroom under the 1 MB row cap). If the user
//      somehow exceeds that — e.g. an unusually noisy photo that doesn't
//      compress well — we reject the submit and ask them to remove a photo.
// ---------------------------------------------------------------------------
const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap on raw upload
const PHOTO_MAX_DIMENSION = 1280; // longest side after resize
const PHOTO_JPEG_QUALITY = 0.7;
const MAX_POD_PHOTO_BYTES = 200 * 1024; // soft target per photo (post-compression)
const MAX_POD_JSON_BYTES = 700 * 1024; // total stringified POD ceiling (D1 row safe)

/**
 * Read a File, downscale to PHOTO_MAX_DIMENSION on the longest side, and
 * JPEG-encode at PHOTO_JPEG_QUALITY. Returns a base64 data URL ready to
 * embed in the POD JSON.
 *
 * Implementation lives in `@/lib/image-compress` — the shared helper uses
 * `createImageBitmap` + `OffscreenCanvas` to keep the work off the main
 * thread on modern browsers, and falls back to the FileReader/canvas
 * pipeline on Safari < 16.4 / old Android WebView.
 */
async function compressPhoto(file: File): Promise<string> {
  return compressImage(file, {
    maxDim: PHOTO_MAX_DIMENSION,
    quality: PHOTO_JPEG_QUALITY,
  });
}

export default function PODDialog({
  open,
  doNo,
  customerName,
  onClose,
  onSubmit,
}: PODDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const { toast } = useToast();
  const [hasSignature, setHasSignature] = useState(false);
  const [receiverName, setReceiverName] = useState("");
  const [receiverIC, setReceiverIC] = useState("");
  const [remarks, setRemarks] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Per-batch upload progress: { done, total } — drives the spinner overlay
  // on the photo grid. Cleared once compression finishes (success or error).
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  // Reset state whenever the dialog opens.
  //
  // Intentional form reset on the open->true transition. Each field is
  // user-editable while the dialog is open, so derive-from-prop is not an
  // option; we just need a one-shot clear on every re-open.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      setReceiverName("");
      setReceiverIC("");
      setRemarks("");
      setPhotos([]);
      setHasSignature(false);
      setSubmitting(false);
      // Clear canvas after it mounts
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.lineWidth = 2;
            ctx.lineCap = "round";
            ctx.strokeStyle = "#111827";
          }
        }
      });
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!open) return null;

  const getPoint = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX = 0;
    let clientY = 0;
    if ("touches" in e) {
      if (e.touches.length === 0) return { x: 0, y: 0 };
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    isDrawingRef.current = true;
    const { x, y } = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const moveDraw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y } = getPoint(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasSignature) setHasSignature(true);
  };

  const endDraw = () => {
    isDrawingRef.current = false;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    if (files.length === 0) return;
    const remaining = MAX_PHOTOS - photos.length;
    const toProcess = files.slice(0, remaining);

    // Reject oversize raw uploads up front. 10 MB on a phone capture is the
    // upper end of even RAW-ish JPEGs; anything beyond that is almost certainly
    // a video or HEIC the canvas pipeline can't usefully shrink.
    const oversize = toProcess.find((f) => f.size > MAX_INPUT_FILE_BYTES);
    if (oversize) {
      toast.error(
        `"${oversize.name}" is larger than 10 MB. Please choose a smaller photo.`,
      );
      input.value = "";
      return;
    }

    // Compress sequentially so the progress counter increments smoothly and
    // we don't stack multiple OffscreenCanvas decodes in flight on a low-end
    // phone (the worker pool is shared and concurrent decodes can OOM).
    setUploadProgress({ done: 0, total: toProcess.length });
    const compressed: string[] = [];
    try {
      for (let i = 0; i < toProcess.length; i++) {
        const f = toProcess[i];
        try {
          compressed.push(await compressPhoto(f));
        } catch (err) {
          toast.error(
            `Couldn't process "${f.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setUploadProgress({ done: i + 1, total: toProcess.length });
      }
      // Surface a soft warning if any single photo is still over the per-photo
      // budget after compression — usually means a noisy/textured image. We
      // still accept it; the total-size check below is the hard gate.
      const oversizeAfter = compressed.find(
        (url) => url.length > MAX_POD_PHOTO_BYTES * 1.5,
      );
      if (oversizeAfter) {
        toast.warning(
          "One photo is unusually large after compression — POD payload may be tight.",
        );
      }
      if (compressed.length > 0) {
        setPhotos((prev) => [...prev, ...compressed].slice(0, MAX_PHOTOS));
      }
    } finally {
      setUploadProgress(null);
      // Reset input so the same file can be re-selected
      input.value = "";
    }
  };

  const removePhoto = (idx: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit =
    receiverName.trim().length > 0 && (hasSignature || photos.length > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    let signatureDataUrl: string | undefined;
    if (hasSignature && canvasRef.current) {
      signatureDataUrl = canvasRef.current.toDataURL("image/png");
    }
    const pod: ProofOfDelivery = {
      receiverName: receiverName.trim(),
      receiverIC: receiverIC.trim(),
      signatureDataUrl: signatureDataUrl ?? "",
      photoDataUrls: photos,
      remarks: remarks.trim(),
      deliveredAt: new Date().toISOString(),
      capturedBy: "",
    };

    // Final guard: stringified blob must fit comfortably under the 1 MB D1
    // row limit (we share the row with every other DO column). 700 KB gives
    // ~30 % headroom — see the constant comment block at the top of the file.
    const podJsonSize = JSON.stringify(pod).length;
    if (podJsonSize > MAX_POD_JSON_BYTES) {
      const kb = Math.round(podJsonSize / 1024);
      const limitKb = Math.round(MAX_POD_JSON_BYTES / 1024);
      toast.error(
        `POD payload is ${kb} KB, over the ${limitKb} KB limit. Remove a photo and try again.`,
      );
      setSubmitting(false);
      return;
    }

    try {
      await onSubmit(pod);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">
              Proof of Delivery
            </h2>
            <p className="text-xs text-[#6B7280]">
              {doNo} &middot; {customerName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#F0ECE9] text-[#6B7280]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Receiver Name */}
          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">
              Receiver Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={receiverName}
              onChange={(e) => setReceiverName(e.target.value)}
              placeholder="Name of person signing"
              className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
            />
          </div>

          {/* Receiver IC */}
          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">
              Receiver IC / ID (optional)
            </label>
            <input
              type="text"
              value={receiverIC}
              onChange={(e) => setReceiverIC(e.target.value)}
              placeholder="IC / ID number"
              className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
            />
          </div>

          {/* Signature */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-[#374151]">
                Signature
              </label>
              <button
                type="button"
                onClick={clearSignature}
                className="text-xs text-[#6B7280] hover:text-[#111827] inline-flex items-center gap-1"
              >
                <Eraser className="h-3 w-3" /> Clear
              </button>
            </div>
            <div className="rounded-md border border-[#E2DDD8] bg-white">
              <canvas
                ref={canvasRef}
                width={600}
                height={180}
                className="w-full h-[180px] touch-none cursor-crosshair rounded-md"
                onMouseDown={startDraw}
                onMouseMove={moveDraw}
                onMouseUp={endDraw}
                onMouseLeave={endDraw}
                onTouchStart={startDraw}
                onTouchMove={moveDraw}
                onTouchEnd={endDraw}
              />
            </div>
            <p className="text-[11px] text-[#9CA3AF] mt-1">
              Sign above using mouse or finger
            </p>
          </div>

          {/* Photos */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-[#374151]">
                Photos ({photos.length}/{MAX_PHOTOS})
              </label>
              {photos.length < MAX_PHOTOS && (
                <label
                  className={
                    uploadProgress
                      ? "text-xs text-[#9CA3AF] inline-flex items-center gap-1 cursor-not-allowed"
                      : "text-xs text-[#6B5C32] hover:text-[#111827] inline-flex items-center gap-1 cursor-pointer"
                  }
                >
                  <Upload className="h-3 w-3" /> Add photo
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    disabled={!!uploadProgress}
                    onChange={handlePhotoUpload}
                  />
                </label>
              )}
            </div>
            {uploadProgress && (
              <div className="mb-2 inline-flex items-center gap-2 rounded-md bg-[#FAF9F7] border border-[#E2DDD8] px-3 py-1.5 text-xs text-[#6B7280]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Compressing photos {Math.min(uploadProgress.done + 1, uploadProgress.total)} / {uploadProgress.total}...
              </div>
            )}
            {photos.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E2DDD8] px-3 py-6 text-center text-xs text-[#9CA3AF]">
                No photos attached
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {photos.map((src, idx) => (
                  <div
                    key={idx}
                    className="relative w-20 h-20 rounded-md border border-[#E2DDD8] overflow-hidden bg-[#FAF9F7]"
                  >
                    <img
                      src={src}
                      alt={`Photo ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removePhoto(idx)}
                      className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 text-white hover:bg-black/80"
                      aria-label="Remove photo"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Remarks */}
          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">
              Remarks (optional)
            </label>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Any notes about the delivery"
              rows={3}
              className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm text-[#111827] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/30"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8] bg-[#FAF9F7]">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? "Submitting..." : "Submit POD"}
          </Button>
        </div>
      </div>
    </div>
  );
}

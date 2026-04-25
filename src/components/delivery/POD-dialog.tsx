"use client";

import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X, Eraser, Upload, Trash2 } from "lucide-react";
import type { ProofOfDelivery } from "@/lib/mock-data";

interface PODDialogProps {
  open: boolean;
  doNo: string;
  customerName: string;
  onClose: () => void;
  onSubmit: (pod: ProofOfDelivery) => Promise<void> | void;
}

const MAX_PHOTOS = 5;

export default function PODDialog({
  open,
  doNo,
  customerName,
  onClose,
  onSubmit,
}: PODDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [receiverName, setReceiverName] = useState("");
  const [receiverIC, setReceiverIC] = useState("");
  const [remarks, setRemarks] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

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

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const remaining = MAX_PHOTOS - photos.length;
    const toRead = files.slice(0, remaining);
    Promise.all(
      toRead.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    ).then((urls) => {
      setPhotos((prev) => [...prev, ...urls].slice(0, MAX_PHOTOS));
    });
    // Reset input so the same file can be re-selected
    e.target.value = "";
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
                <label className="text-xs text-[#6B5C32] hover:text-[#111827] inline-flex items-center gap-1 cursor-pointer">
                  <Upload className="h-3 w-3" /> Add photo
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handlePhotoUpload}
                  />
                </label>
              )}
            </div>
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

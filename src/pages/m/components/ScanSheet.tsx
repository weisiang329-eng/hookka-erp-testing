// ===========================================================================
// ScanSheet — full-screen QR scanner overlay for the /m mobile shell.
//
// Owner 2026-06-28 design v12 L1 list headers carry a scan-line icon next to
// the filter button. Tapping it opens this overlay: rear-camera live preview
// + reticle + jsQR decode loop. On a hit the parent's `onResult` callback
// fires with the decoded payload — typically a `${origin}/m/<slug>/<id>`
// URL the parent can route to.
//
// Real camera + real decode (jsQR + getUserMedia) — the same pieces the
// worker portal's /worker/scan uses, just packaged smaller for /m. The whole
// thing turns off + releases the stream when `open` flips false; no
// background camera holding.
//
// ADDITIVE: a new component under src/pages/m/components. Imported only by
// /m surfaces.
// ===========================================================================
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import jsQR from "jsqr";
import { M } from "../theme";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired ONCE on a successful decode (the parent decides what to do). */
  onResult: (value: string) => void;
  /** Optional header title; default "Scan QR code". */
  title?: string;
};

export function ScanSheet({ open, onClose, onResult, title = "Scan QR code" }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Keep onResult fresh without re-running the camera effect on each render
  // (the effect's only `open` dep keeps it from re-tearing-down the stream).
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      return;
    }

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        // Safari requires play() after assignment + needs muted+playsinline.
        v.play().catch(() => {});

        const tick = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && video.readyState >= 2) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w > 0 && h > 0) {
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext("2d", { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(video, 0, 0, w, h);
                try {
                  const img = ctx.getImageData(0, 0, w, h);
                  const code = jsQR(img.data, w, h, {
                    inversionAttempts: "dontInvert",
                  });
                  if (code && code.data) {
                    cancelled = true;
                    if (rafRef.current) cancelAnimationFrame(rafRef.current);
                    onResultRef.current(code.data);
                    return;
                  }
                } catch {
                  // ignore frame-decode glitches
                }
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch(() => {
        // Permission denied / no camera — overlay still shows so user can
        // close it (no auto-close to avoid surprise).
      });

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: M.raisin,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        animation: "hkScrim .2s ease both",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "50px 20px 14px",
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>
          {title}
        </span>
        <button
          onClick={onClose}
          aria-label="Close scanner"
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: "rgba(255,255,255,.12)",
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <X size={18} color="#fff" />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            background: "#000",
          }}
        />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {/* Reticle — design source uses a gold-tinted border with a
            scan-line animation; keep it static here (animation defined in
            global CSS in index.html could be reused, but a calm static
            reticle keeps the component self-contained). */}
        <div
          style={{
            position: "absolute",
            inset: 28,
            border: "2px solid rgba(201,169,97,.55)",
            borderRadius: 12,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 24,
            textAlign: "center",
            color: "rgba(255,255,255,.7)",
            fontSize: 12.5,
            fontWeight: 600,
            pointerEvents: "none",
          }}
        >
          Point at a QR code
        </div>
      </div>
    </div>,
    document.body,
  );
}

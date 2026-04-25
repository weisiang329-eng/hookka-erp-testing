// ---------------------------------------------------------------------------
// Client-side QR rendered into an <img>. Replaces `<img src={getQRCodeUrl(..)}>`
// so the QR PNG is generated in-browser via the `qrcode` package — the old
// path fetched every tile from api.qrserver.com and the page stalled on
// network round-trips (especially on the Production Overview / Detail pages
// that render dozens of tiles at once, or when the factory's internet is
// spotty).
//
// IntersectionObserver gate: the Production page can easily mount 300+ tiles
// at once, and `QRCode.toDataURL` is a synchronous CPU burn (~10ms each on a
// commodity laptop). Generating all of them on mount freezes the main thread
// for seconds. We only kick off generation when a tile approaches the viewport
// (rootMargin 400px so scroll feels instant) and unobserve after — identical
// inputs still reuse the memoised data URL from qrcode.toDataURL's own cache.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState, memo } from "react";
import { getQRCodeDataURL } from "@/lib/qr-utils";

type QRImgProps = {
  data: string;
  size?: number;
  className?: string;
  alt?: string;
};

function QRImgBase({ data, size = 200, className, alt = "QR" }: QRImgProps) {
  const [src, setSrc] = useState<string>("");
  const [shouldRender, setShouldRender] = useState<boolean>(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to viewport intersection — this is a textbook "external system
  // sync" effect (the observer is a browser-platform API), and `setShouldRender`
  // is the React-side projection of that subscription. Pure-derive is not an
  // option because there's no synchronous way to read the visibility state.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (shouldRender) return;
    const el = wrapperRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldRender(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldRender]);

  // Async data-URL generation. The promise resolves with a value the React
  // tree needs (the <img src>); the cancelled flag prevents a stale write
  // when `data`/`size` change mid-flight.
  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    if (!data) {
      setSrc("");
      return;
    }
    getQRCodeDataURL(data, size)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc("");
      });
    return () => {
      cancelled = true;
    };
  }, [data, size, shouldRender]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!src) {
    return (
      <div
        ref={wrapperRef}
        className={className}
        style={{ width: size, height: size, background: "#F5F2EE" }}
        aria-label={`${alt} (loading)`}
      />
    );
  }
  return <img src={src} width={size} height={size} className={className} alt={alt} />;
}

export const QRImg = memo(QRImgBase);

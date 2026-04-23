// ---------------------------------------------------------------------------
// Client-side QR rendered into an <img>. Replaces `<img src={getQRCodeUrl(..)}>`
// so the QR PNG is generated in-browser via the `qrcode` package — the old
// path fetched every tile from api.qrserver.com and the page stalled on
// network round-trips (especially on the Production Overview / Detail pages
// that render dozens of tiles at once, or when the factory's internet is
// spotty).
//
// Usage mirrors a normal img: `<QRImg data={trackUrl} size={300} />`. The
// data URL is memoised per (data, size) so switching a sticker's piece
// number / dept code regenerates, but identical inputs reuse the same base64.
// Falls back to a small placeholder box while the async generation resolves
// — that's one animation frame in practice, not a real loading state.
// ---------------------------------------------------------------------------
import { useEffect, useState, memo } from "react";
import { getQRCodeDataURL } from "@/lib/qr-utils";

type QRImgProps = {
  data: string;
  size?: number;
  className?: string;
  alt?: string;
};

function QRImgBase({ data, size = 200, className, alt = "QR" }: QRImgProps) {
  const [src, setSrc] = useState<string>("");

  useEffect(() => {
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
  }, [data, size]);

  if (!src) {
    // Same footprint as a rendered img so layout doesn't jump when the
    // async generation resolves.
    return (
      <div
        className={className}
        style={{ width: size, height: size, background: "#F5F2EE" }}
        aria-label={`${alt} (loading)`}
      />
    );
  }
  return <img src={src} width={size} height={size} className={className} alt={alt} />;
}

export const QRImg = memo(QRImgBase);

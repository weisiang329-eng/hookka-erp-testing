// ============================================================
// QR Code Utilities for Production Sticker Printing
// ============================================================
import QRCode from "qrcode";

/**
 * Generate a QR code image URL using the free qrserver.com API.
 * Kept as a fallback; prefer `getQRCodeDataURL` below for batch prints,
 * which generates locally and avoids hundreds of network round-trips.
 */
export function getQRCodeUrl(data: string, size: number = 150): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`;
}

/**
 * Generate a QR code as a base64 data URL entirely on the client.
 * Use this for batch sticker printing where dozens/hundreds of QRs are
 * rendered at once — hitting an external QR API for each one causes
 * rate-limits, timeouts, and blank print previews.
 *
 * Returns a Promise<string> of the form `data:image/png;base64,...`.
 */
export async function getQRCodeDataURL(data: string, size: number = 300): Promise<string> {
  return QRCode.toDataURL(data, {
    width: size,
    margin: 0,
    errorCorrectionLevel: "M",
  });
}

/**
 * Generate the scan URL that a QR code should encode.
 * When scanned, it takes the worker to the scan page with the operation pre-filled.
 *
 * basePath defaults to the scan page ("/production/scan"). Payload fields
 * (op/dept/po) are fixed — only the host page route is parameterised so the
 * worker portal can also build links back to /production/scan itself.
 *
 * When `pieceNo` / `totalPieces` are provided, the QR encodes them as `p` / `t`
 * so that each physical piece of a qty=N job card carries a DIFFERENT payload.
 * This is what lets the worker portal tell "Divan piece 1 of 2" apart from
 * "Divan piece 2 of 2" and block double-scans of the same sticker.
 */
export function generateStickerData(
  poNo: string,
  deptCode: string,
  opId: string,
  basePath: string = "/production/scan",
  pieceNo?: number,
  totalPieces?: number,
): string {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  let url = `${baseUrl}${basePath}?op=${encodeURIComponent(opId)}&dept=${encodeURIComponent(deptCode)}&po=${encodeURIComponent(poNo)}`;
  if (pieceNo && pieceNo > 0) url += `&p=${encodeURIComponent(String(pieceNo))}`;
  if (totalPieces && totalPieces > 0) url += `&t=${encodeURIComponent(String(totalPieces))}`;
  return url;
}

/**
 * Parse scanned QR data back into structured fields. `pieceNo` / `totalPieces`
 * are optional — older stickers printed before the per-piece encoding existed
 * return them as undefined and the scanner treats them as "single piece".
 */
export function parseStickerData(
  url: string,
): { opId: string; deptCode: string; poNo: string; pieceNo?: number; totalPieces?: number } | null {
  try {
    const u = new URL(url);
    const opId = u.searchParams.get("op");
    const deptCode = u.searchParams.get("dept");
    const poNo = u.searchParams.get("po");
    const pStr = u.searchParams.get("p");
    const tStr = u.searchParams.get("t");
    if (opId && deptCode && poNo) {
      const pieceNo = pStr ? Number(pStr) : undefined;
      const totalPieces = tStr ? Number(tStr) : undefined;
      return {
        opId,
        deptCode,
        poNo,
        pieceNo: pieceNo && Number.isFinite(pieceNo) && pieceNo > 0 ? pieceNo : undefined,
        totalPieces:
          totalPieces && Number.isFinite(totalPieces) && totalPieces > 0 ? totalPieces : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

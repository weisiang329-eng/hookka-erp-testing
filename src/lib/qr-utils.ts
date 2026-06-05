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
 * Shared per-compartment Sew/Uph sticker. ONE sticker per compartment that BOTH
 * the Fabric Sewing worker and the Upholstery worker scan — the completing
 * department is decided by WHO scans (their Employee-Master dept), NOT by the
 * sticker. So the payload carries the PO + the compartment key (`wk` = wipKey)
 * and deliberately omits `dept`/`op`. The same wipKey is shared by the
 * compartment's FAB_SEW and UPHOLSTERY job cards (they differ only in
 * departmentCode), so the backend resolves the right card from po+wk+scannerDept.
 */
export function generateSharedStickerData(
  poNo: string,
  wipKey: string,
  basePath: string = "/worker/scan",
): string {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  return `${baseUrl}${basePath}?po=${encodeURIComponent(poNo)}&wk=${encodeURIComponent(wipKey)}`;
}

/**
 * Parse scanned QR data back into structured fields. Two shapes share one
 * return type (opId/deptCode optional so existing callers compile unchanged):
 *   - Per-piece / dept sticker: `op` + `dept` + `po` (+ optional `p`/`t`).
 *   - Shared Sew/Uph sticker: `wk` (wipKey) + `po`, no `op`/`dept` — `wipKey`
 *     is set and the scanner routes to the shared resolver, supplying the
 *     department from the logged-in worker.
 * `pieceNo` / `totalPieces` are optional — older stickers printed before the
 * per-piece encoding existed return them as undefined ("single piece").
 */
export function parseStickerData(
  url: string,
): {
  opId?: string;
  deptCode?: string;
  poNo: string;
  pieceNo?: number;
  totalPieces?: number;
  wipKey?: string;
} | null {
  try {
    const u = new URL(url);
    const poNo = u.searchParams.get("po");
    if (!poNo) return null;
    // Shared Sew/Uph compartment sticker — wipKey + po, dept supplied by scanner.
    const wk = u.searchParams.get("wk");
    if (wk) {
      return { poNo, wipKey: wk };
    }
    const opId = u.searchParams.get("op");
    const deptCode = u.searchParams.get("dept");
    const pStr = u.searchParams.get("p");
    const tStr = u.searchParams.get("t");
    if (opId && deptCode) {
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

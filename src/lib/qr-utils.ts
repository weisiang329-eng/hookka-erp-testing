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
  pieceNo?: number,
  totalPieces?: number,
): string {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  let url = `${baseUrl}${basePath}?po=${encodeURIComponent(poNo)}&wk=${encodeURIComponent(wipKey)}`;
  if (pieceNo && pieceNo > 0) url += `&p=${encodeURIComponent(String(pieceNo))}`;
  if (totalPieces && totalPieces > 0) url += `&t=${encodeURIComponent(String(totalPieces))}`;
  return url;
}

/**
 * SHORT compartment sticker for Fab Sew / Upholstery. Encodes the PO + the
 * compartment subtype (`c` = DIVAN / HEADBOARD / SOFA_BASE — the wipKey's 3rd
 * `::`-segment) + optional piece markers. It deliberately omits the LONG full
 * wipKey (and the op id / dept) so the QR stays at version ~5 (37x37) — the same
 * low density as Fab Cut's sticker, which scans reliably. The long-wipKey form
 * pushed the QR to version 6+, where phone cameras struggled to lock on ("scan,
 * no reaction"). The scanner resolves `c` against the PO's cards to recover the
 * full wipKey and routes to scan-complete-shared (dept by the worker's section).
 */
export function generateCompartmentStickerData(
  poNo: string,
  compartmentCode: string,
  basePath: string = "/worker/scan",
  pieceNo?: number,
  totalPieces?: number,
): string {
  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  let url = `${baseUrl}${basePath}?po=${encodeURIComponent(poNo)}&c=${encodeURIComponent(compartmentCode)}`;
  if (pieceNo && pieceNo > 0) url += `&p=${encodeURIComponent(String(pieceNo))}`;
  if (totalPieces && totalPieces > 0) url += `&t=${encodeURIComponent(String(totalPieces))}`;
  return url;
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
  compartment?: string;
} | null {
  try {
    const u = new URL(url);
    const poNo = u.searchParams.get("po");
    if (!poNo) return null;
    // Piece markers are shared by both sticker shapes (per-piece dept sticker
    // AND per-piece shared Sew/Uph compartment sticker).
    const pStr = u.searchParams.get("p");
    const tStr = u.searchParams.get("t");
    const rawPiece = pStr ? Number(pStr) : undefined;
    const rawTotal = tStr ? Number(tStr) : undefined;
    const pieceNo =
      rawPiece && Number.isFinite(rawPiece) && rawPiece > 0 ? rawPiece : undefined;
    const totalPieces =
      rawTotal && Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : undefined;
    // SHORT compartment sticker — `c` = compartment subtype (DIVAN / HEADBOARD /
    // SOFA_BASE). The scanner resolves it to the full wipKey from the PO's cards.
    const c = u.searchParams.get("c");
    if (c) {
      return { poNo, compartment: c, pieceNo, totalPieces };
    }
    // Shared Sew/Uph compartment sticker — wipKey + po (+ p/t), dept supplied
    // by the scanner's section at completion time.
    const wk = u.searchParams.get("wk");
    if (wk) {
      return { poNo, wipKey: wk, pieceNo, totalPieces };
    }
    const opId = u.searchParams.get("op");
    const deptCode = u.searchParams.get("dept");
    if (opId && deptCode) {
      return { opId, deptCode, poNo, pieceNo, totalPieces };
    }
    return null;
  } catch {
    return null;
  }
}

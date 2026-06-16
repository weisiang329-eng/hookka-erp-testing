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
export async function getQRCodeDataURL(
  data: string,
  size: number = 300,
  margin: number = 2,
): Promise<string> {
  return QRCode.toDataURL(data, {
    width: size,
    // A quiet zone (white border) is REQUIRED by the QR spec for a scanner to
    // lock on, and it makes the code tolerant of slight edge-clipping when a
    // sticker prints near a printer's non-printable margin (Wei Siang 2026-06-15:
    // the Packing FG QR was getting shaved off the left edge — "挤出去了"). Was 0,
    // which printed an edge-to-edge QR with no quiet zone at all. 2 modules is the
    // practical minimum; callers can pass more if a layout needs extra breathing.
    margin,
    // Q = ~25% damage recovery (was M = ~15%). Shop-floor labels get wrinkled,
    // smudged, and printed near a printer's clip margin — Q lets the scanner
    // rebuild the code even when a corner is shaved off or dirty (Wei Siang
    // 2026-06-16). Q over H to keep the module count — and the print density —
    // sane on the small 50x75mm job-card stickers.
    errorCorrectionLevel: "Q",
  });
}

// ============================================================
// Code 128 barcodes — the linear-scan twin of the square QR.
//
// Some departments (Woodcutting / Framing / Webbing) can't keep a QR sticker
// WITH the WIP, so a Code 128 is printed on the Production Schedule listing
// instead. Scanning it marks the same WIP complete as the QR would. The
// barcode encodes the job_card id (compact — a full URL becomes too wide to
// scan reliably on a printed row), guarded by a short sentinel prefix so a
// stray courier / GTIN barcode in the camera view is never mistaken for ours.
// ============================================================

/** Sentinel prefix on every WIP Code 128 — `HKJC:` + job_card.id. */
export const JC_BARCODE_PREFIX = "HKJC:";

// Code 128 IMAGE generation lives at its single consumer — the Production
// Schedule print in src/pages/production/index.tsx — which statically imports
// `jsbarcode` and renders SYNCHRONOUSLY inside the print click gesture (an
// async generator would force an `await` before window.open and trip the
// browser pop-up blocker). Keeping jsbarcode out of qr-utils also keeps it out
// of the scanner / PDF chunks that import this module only to DECODE or for QR.

/** The string to ENCODE in a WIP's Code 128 (prefix + job card id). */
export function jobCardBarcodeValue(jobCardId: string): string {
  return `${JC_BARCODE_PREFIX}${jobCardId}`;
}

/**
 * Parse a scanned Code 128 back to a WIP barcode token, or null when it isn't
 * one of ours. The schedule barcode is now the SHORT `b<deptNN><7hash>` form
 * 2026-06-17: the token is now ALL-NUMERIC `<deptNN><8 digits>` = 10 digits so
 * Code 128 uses Set C (fat, scannable bars — see deriveBarcodeToken). The
 * leading 2 digits are the dept (01–08), which keeps a stray courier barcode
 * (EAN-8 = 8 digits, EAN-13 = 13) AND our own QR URLs from matching. The legacy
 * `HKJC:jc-…` form is still accepted.
 */
export function parseJobCardBarcode(value: string): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^0[1-8]\d{8}$/.test(v)) return v; // new 10-digit numeric token
  if (v.startsWith(JC_BARCODE_PREFIX)) {
    const id = v.slice(JC_BARCODE_PREFIX.length).trim();
    return /^jc-/.test(id) ? id : null; // legacy HKJC:jc-… token
  }
  return null;
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
  // FG-<DEPT> sentinels (FG-PACKING / FG-FAB_CUT / FG-FAB_SEW) already encode the
  // dept in the op id, so the &dept= param is redundant — omit it to keep the QR
  // small (version ~5, reliably scannable). Per-JC op ids (no FG- prefix) keep it.
  const deptParam = /^FG-/.test(opId)
    ? ""
    : `&dept=${encodeURIComponent(deptCode)}`;
  let url = `${baseUrl}${basePath}?op=${encodeURIComponent(opId)}${deptParam}&po=${encodeURIComponent(poNo)}`;
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
  pieceLabel?: string;
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
    // FG-<DEPT> sentinels encode the dept in the op id, so the &dept= param is
    // dropped to keep the QR small — derive it back when absent. Older stickers
    // that still carry &dept= parse unchanged.
    let deptCode = u.searchParams.get("dept");
    if (opId && !deptCode) {
      const fg = /^FG-([A-Z_]+)$/.exec(opId);
      if (fg) deptCode = fg[1];
    }
    if (opId && deptCode) {
      // FG dept sentinels (e.g. FG-PACKING) may carry pn=<box piece label> so a
      // multi-compartment PO (bedframe Divan + Headboard) resolves to the ONE
      // matching dept card on scan instead of prompting the worker to pick.
      // Optional + backward compatible — older stickers without pn still parse.
      const pieceLabel = u.searchParams.get("pn") || undefined;
      return { opId, deptCode, poNo, pieceNo, totalPieces, pieceLabel };
    }
    return null;
  } catch {
    return null;
  }
}

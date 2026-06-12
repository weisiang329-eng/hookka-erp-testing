// ---------------------------------------------------------------------------
// do-qr.ts — frontend helper for the DO/PL delivery-status QR.
//
// Fetches the document's public scan URL (the lazily-minted qrtoken from the
// authed /:id/qr-token endpoints) and renders it as a local QR data URL for
// embedding into the printed PDFs (DO form + Packing List manifest).
//
// Best-effort BY DESIGN: any failure returns undefined and the print
// proceeds without the QR — a QR hiccup must never block a document print.
//
// NOTE: the QR encodes the advance-capable token, so it is only embedded
// into PRINT flows. The customer-email PDF path (sendCustomerNotice →
// generateDoPdfBase64) deliberately never passes qrDataUrl — the token must
// not leave the company in an email attachment.
// ---------------------------------------------------------------------------
import { getQRCodeDataURL } from "@/lib/qr-utils";

export async function fetchDoQrDataUrl(
  kind: "DO" | "PL",
  recordId: string,
  size = 300,
): Promise<string | undefined> {
  try {
    const endpoint =
      kind === "DO"
        ? `/api/delivery-orders/${encodeURIComponent(recordId)}/qr-token`
        : `/api/packing-lists/${encodeURIComponent(recordId)}/qr-token`;
    const r = await fetch(endpoint);
    const j = (await r.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { url?: string };
    };
    if (!r.ok || !j.success || !j.data?.url) return undefined;
    return await getQRCodeDataURL(j.data.url, size);
  } catch {
    return undefined;
  }
}

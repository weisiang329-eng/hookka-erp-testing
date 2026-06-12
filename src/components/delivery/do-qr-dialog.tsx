// ---------------------------------------------------------------------------
// do-qr-dialog.tsx — "QR" modal for a Delivery Order or a Packing List.
//
// Fetches the document's lazily-minted qrtoken from the authed endpoint
// (GET /api/delivery-orders/:id/qr-token or /api/packing-lists/:id/qr-token),
// renders the public scan URL as a QR (shared <QRImg> — local generation, no
// external QR API) and offers a one-click print sheet (window.open + print,
// same pattern as print-report.ts / the Department QR poster).
//
// Scanning the printed QR with a normal phone camera opens /d/<token> —
// no login — where the crew/driver can Mark Dispatched / Mark Delivered.
// A PL QR transitions ALL its member DOs together; a DO QR just that DO.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, Printer, QrCode } from "lucide-react";
import { QRImg } from "@/components/qr-img";
import { getQRCodeDataURL } from "@/lib/qr-utils";

interface DoQrDialogProps {
  open: boolean;
  kind: "DO" | "PL";
  recordId: string;
  /** Display number — doNo for a DO, packingNo for a PL. */
  docNo: string;
  onClose: () => void;
}

export default function DoQrDialog({
  open,
  kind,
  recordId,
  docNo,
  onClose,
}: DoQrDialogProps) {
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch the scan URL when the dialog opens. All state writes happen in the
  // async continuation (post-await), so the effect body itself stays
  // setState-free. No synchronous reset needed: the delivery page mounts the
  // dialog per record ({qrDialog && …}), and the detail page reuses it for
  // one fixed DO — stale state across opens is the same document's state.
  useEffect(() => {
    if (!open || !recordId) return;
    let cancelled = false;
    void (async () => {
      try {
        const endpoint =
          kind === "DO"
            ? `/api/delivery-orders/${encodeURIComponent(recordId)}/qr-token`
            : `/api/packing-lists/${encodeURIComponent(recordId)}/qr-token`;
        const r = await fetch(endpoint);
        const j = (await r.json().catch(() => ({}))) as {
          success?: boolean;
          data?: { token: string; url: string };
          error?: string;
        };
        if (cancelled) return;
        if (!r.ok || !j.success || !j.data?.url) {
          setError(j.error || "Failed to load the QR code.");
          return;
        }
        setError(null);
        setScanUrl(j.data.url);
      } catch {
        if (!cancelled) setError("Network error. Please try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, kind, recordId]);

  if (!open) return null;

  const subtitle =
    kind === "PL"
      ? "Scan with any phone camera — one tap marks the whole truck run Dispatched / Delivered. No login."
      : "Scan with any phone camera — one tap marks this DO Dispatched / Delivered. No login.";

  const handlePrint = async () => {
    if (!scanUrl) return;
    // High-res data URL for the print sheet (the on-screen QRImg is 208px).
    const qrDataUrl = await getQRCodeDataURL(scanUrl, 600).catch(() => null);
    if (!qrDataUrl) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${kind === "PL" ? "Packing List" : "Delivery Order"} QR — ${docNo}</title>
<style>
  @page { margin: 14mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111; text-align: center; }
  .doc-no { font-size: 34px; font-weight: 800; letter-spacing: 1px; margin: 10mm 0 4mm; }
  .kind { font-size: 13px; text-transform: uppercase; letter-spacing: 3px; color: #555; }
  img { width: 90mm; height: 90mm; margin-top: 6mm; }
  .hint { font-size: 13px; color: #333; margin-top: 8mm; }
  .sub { font-size: 11px; color: #777; margin-top: 2mm; }
</style></head><body>
  <div class="kind">${kind === "PL" ? "Packing List" : "Delivery Order"}</div>
  <div class="doc-no">${docNo}</div>
  <img src="${qrDataUrl}" alt="QR code" />
  <div class="hint">Scan with any phone camera to mark Dispatched / Delivered</div>
  <div class="sub">HOOKKA INDUSTRIES — delivery status QR (no login needed)</div>
</body></html>`);
    w.document.close();
    w.focus();
    // Give the new window time to lay out before invoking print(). Click
    // handler, not React lifecycle — useTimeout doesn't apply.
    // eslint-disable-next-line no-restricted-syntax -- print-window settle delay from event handler
    setTimeout(() => w.print(), 500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm border border-[#E2DDD8]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-base font-bold text-[#111827] flex items-center gap-2">
              <QrCode className="h-4 w-4 text-[#6B5C32]" /> Delivery QR
            </h2>
            <p className="text-xs text-[#6B7280]">{docNo}</p>
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
        <div className="px-5 py-4 text-center space-y-3">
          {error && <p className="text-sm text-[#9A3A2D]">{error}</p>}
          {!error && !scanUrl && (
            <div className="py-10">
              <div className="h-8 w-8 mx-auto rounded-full border-4 border-[#6B5C32] border-t-transparent animate-spin" />
              <p className="mt-3 text-xs text-[#6B7280]">Generating QR...</p>
            </div>
          )}
          {scanUrl && (
            <>
              <div className="mx-auto w-fit border border-[#E2DDD8] rounded p-1">
                <QRImg
                  data={scanUrl}
                  size={208}
                  eager
                  alt={`QR code for ${docNo}`}
                />
              </div>
              <p className="text-xs text-[#6B7280]">{subtitle}</p>
              <p className="text-[10px] font-mono text-[#9CA3AF] break-all px-2">
                {scanUrl}
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#E2DDD8]">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!scanUrl}
            onClick={() => void handlePrint()}
          >
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// ScanPOSheet — capture a customer PO (photo or PDF) → /api/scan-po/extract →
// preview the extracted POs → tap one → onResult(extracted) fires.
//
// Owner 2026-06-28 dc12 design v12 includes a "scan customer PO" capture in
// the OCR overlay. The desktop has had /api/scan-po/extract for months
// (Claude-vision-powered, schema-aware against the customer/product catalog);
// this mobile sheet wires it up to native camera capture via a hidden
// `<input type="file" accept="image/*,application/pdf" capture="environment">`.
// On a phone that triggers the rear camera; on desktop it pops the file
// picker. No camera-stream/canvas plumbing on our side — the browser does it.
//
// Three states: idle (capture button) → scanning (busy) → preview (extracted
// POs as tappable cards). The parent receives the chosen ExtractedPO via
// onResult and decides what to do (typically open the SO create form with
// the data as prefill).
//
// ADDITIVE: a new component under src/pages/m/components.
// ===========================================================================
import { useRef, useState } from "react";
import { X, Camera, FileSearch, AlertCircle } from "lucide-react";
import { M, M_ACCENT } from "../theme";
import { Sheet } from "./Sheet";

/** A subset of the server's ExtractedPO shape — only what the FE needs. */
export type ScanPOExtracted = {
  customerName?: string;
  customerCode?: string | null;
  customerId?: string | null;
  customerPO?: string;
  customerSO?: string | null;
  yourRefNo?: string | null;
  customerState?: string | null;
  deliveryHub?: string | null;
  deliveryHubId?: string | null;
  deliveryDate?: string | null;
  isUrgent?: boolean;
  items?: Array<{
    productCode?: string;
    productName?: string;
    itemCategory?: string;
    sizeLabel?: string;
    fabricCode?: string;
    quantity?: number;
    basePriceSen?: number;
    unitPriceSen?: number;
  }>;
};

type Sample = {
  sampleId: string;
  extracted: ScanPOExtracted;
  warnings?: string[];
};

type Resp = {
  success: boolean;
  error?: string;
  data?: { samples: Sample[]; meta?: { totalPOs?: number } };
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fires when the operator picks one of the extracted POs. sampleId lets
   *  the caller report the FINAL imported values back to
   *  /api/scan-po/samples/:id/confirm (OCR accuracy dashboard). */
  onResult: (extracted: ScanPOExtracted, sampleId: string) => void;
};

export function ScanPOSheet({ open, onClose, onResult }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setBusy(false);
    setSamples(null);
    setError(null);
  }

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    setSamples(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch("/api/scan-po/extract", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const json = (await resp.json()) as Resp;
      if (!resp.ok || !json.success) {
        setError(json.error || `Scan failed (${resp.status})`);
        return;
      }
      setSamples(json.data?.samples ?? []);
    } catch (e) {
      setError((e as Error).message || "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Scan Customer PO"
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        // Tells mobile Safari/Chrome to open the rear camera by default
        // (PDFs still selectable via the "Files" tab in the picker).
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          // Allow re-picking the same file later.
          if (inputRef.current) inputRef.current.value = "";
        }}
      />

      {/* --- idle: capture entry --- */}
      {!busy && !samples && !error ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13.5, color: M.body, lineHeight: 1.5 }}>
            Snap the customer's PO with the camera or pick a PDF.
            We'll read the customer · PO number · items · delivery info
            and let you create a Sales Order from it.
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            style={{
              width: "100%",
              padding: "14px 0",
              borderRadius: 14,
              border: "none",
              background: M.taupe,
              color: "#fff",
              fontFamily: "inherit",
              fontSize: 15,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <Camera size={18} strokeWidth={2} />
            Capture or pick file
          </button>
        </div>
      ) : null}

      {/* --- scanning: spinner-ish --- */}
      {busy ? (
        <div
          style={{
            padding: "32px 14px",
            textAlign: "center",
            color: M.body,
            fontSize: 14,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <FileSearch
            size={36}
            strokeWidth={1.75}
            color={M.taupe}
            style={{ animation: "hkUp 0.6s ease-in-out infinite alternate" }}
          />
          <div>Reading document · extracting line items…</div>
          <div style={{ fontSize: 12, color: M.muted }}>
            Usually takes 10–25 seconds.
          </div>
        </div>
      ) : null}

      {/* --- error --- */}
      {error ? (
        <div
          style={{
            background: M_ACCENT.danger.bg,
            border: `1px solid #E8B2A1`,
            borderRadius: 12,
            padding: 14,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <AlertCircle size={18} color={M_ACCENT.danger.fg} />
          <div style={{ flex: 1, fontSize: 13, color: M_ACCENT.danger.fg }}>
            {error}
            <div style={{ marginTop: 10 }}>
              <button
                onClick={() => {
                  reset();
                  inputRef.current?.click();
                }}
                style={{
                  background: "#fff",
                  border: `1px solid ${M.hairline}`,
                  borderRadius: 10,
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: M.ink,
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* --- preview: extracted POs as tappable cards --- */}
      {samples ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {samples.length === 0 ? (
            <div
              style={{
                padding: "24px 14px",
                textAlign: "center",
                color: M.muted,
                fontSize: 13,
              }}
            >
              No POs detected in this file. Try again with a clearer photo.
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  color: M.muted,
                  textTransform: "uppercase",
                }}
              >
                {samples.length} PO{samples.length === 1 ? "" : "s"} detected ·
                tap one to create
              </div>
              {samples.map((s) => {
                const e = s.extracted;
                const itemCount = e.items?.length ?? 0;
                return (
                  <button
                    key={s.sampleId}
                    onClick={() => {
                      onResult(e, s.sampleId);
                      reset();
                    }}
                    style={{
                      textAlign: "left",
                      background: "#fff",
                      border: `1px solid ${M.border}`,
                      borderRadius: 14,
                      padding: "13px 15px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: M.taupe,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {e.customerPO || "—"}
                      </span>
                      {e.isUrgent ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: M_ACCENT.danger.fg,
                            background: M_ACCENT.danger.bg,
                            border: "1px solid #E8B2A1",
                            padding: "1px 7px",
                            borderRadius: 20,
                          }}
                        >
                          URGENT
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: M.raisin,
                        marginTop: 6,
                      }}
                    >
                      {e.customerName || "Unknown customer"}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: M.muted,
                        marginTop: 4,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <span>
                        {itemCount} item{itemCount === 1 ? "" : "s"}
                      </span>
                      {e.deliveryDate ? <span>· DD {e.deliveryDate}</span> : null}
                      {e.deliveryHub ? <span>· {e.deliveryHub}</span> : null}
                      {e.customerState ? <span>· {e.customerState}</span> : null}
                    </div>
                    {s.warnings && s.warnings.length > 0 ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: M_ACCENT.warning.fg,
                          marginTop: 7,
                          display: "flex",
                          gap: 5,
                          alignItems: "flex-start",
                        }}
                      >
                        <AlertCircle size={12} color={M_ACCENT.warning.fg} />
                        <span>{s.warnings.length} warning{s.warnings.length === 1 ? "" : "s"} — review on create form</span>
                      </div>
                    ) : null}
                  </button>
                );
              })}
              <button
                onClick={() => {
                  reset();
                  inputRef.current?.click();
                }}
                style={{
                  marginTop: 4,
                  background: "transparent",
                  border: `1px dashed ${M.hairline}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                  fontSize: 13,
                  color: M.taupe,
                  fontWeight: 600,
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                Scan another
              </button>
            </>
          )}
        </div>
      ) : null}

      {/* Unused X import; placeholder to keep tree-shaker happy if we later
          add a dedicated dismiss inside the sheet (Sheet provides one). */}
      <X size={0} style={{ display: "none" }} />
    </Sheet>
  );
}

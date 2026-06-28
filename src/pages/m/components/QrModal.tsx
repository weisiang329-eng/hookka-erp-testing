// ===========================================================================
// QrModal — centered QR popup for the Warehouse screen (Rack QR / Item QR).
//
// Mirrors the new design source (erp-redesign-new): a centered card (not a
// bottom sheet) with an optional chip row to switch the encoded value, a 200px
// QR, the selected code, the "Scan to look up in Hookka ERP" caption, and a
// taupe "Download QR" button.
//
// The encoded values reuse the SAME shared QR scheme the DESKTOP warehouse uses
// (src/lib/qr-utils.ts → rackScanUrl / itemQrValue), so a sticker generated on
// the phone scans identically to one printed from the desktop — additive, no
// new scheme (see MEMORY: "additive — never break existing"; shared QR URL
// scheme must keep every consumer working).
//
// ADDITIVE: imported only by files under src/pages/m/.
// ===========================================================================
import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";
import { getQRCodeDataURL } from "@/lib/qr-utils";
import { M, M_MAX_WIDTH } from "../theme";

/** One selectable QR target — a human label + the string to encode. */
export type QrChoice = { label: string; code: string; value: string };

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The QR targets. One = no chip row; many = a chip row to switch. */
  choices: QrChoice[];
  /** Download file-name stem (".png" appended). */
  downloadName?: string;
};

export function QrModal({ open, onClose, title, choices, downloadName }: Props) {
  const [selIdx, setSelIdx] = useState(0);
  // Map of encoded-value → generated data-url, so switching chips back to a
  // previously-rendered value is instant and we never setState synchronously in
  // an effect (the resolve callback below is the only writer).
  const [urls, setUrls] = useState<Record<string, string>>({});

  // Render-time reset of the selection when the choice set changes (the
  // codebase's endorsed alternative to setState-in-effect).
  const choiceKey = choices.map((c) => c.code).join("|");
  const [lastKey, setLastKey] = useState(choiceKey);
  if (choiceKey !== lastKey) {
    setLastKey(choiceKey);
    setSelIdx(0);
  }

  const sel = choices[Math.min(selIdx, choices.length - 1)];
  const dataUrl = sel ? urls[sel.value] ?? null : null;

  // Generate the QR data-url for the selected value (async, off the shared lib).
  // Only the async resolve writes state — no synchronous setState in the effect.
  useEffect(() => {
    if (!open || !sel || urls[sel.value]) return;
    let cancelled = false;
    getQRCodeDataURL(sel.value, 600)
      .then((url) => {
        if (!cancelled) setUrls((p) => ({ ...p, [sel.value]: url }));
      })
      .catch(() => {
        /* leave unset → caption shows "Generating…"; user can retry by reopening */
      });
    return () => {
      cancelled = true;
    };
  }, [open, sel, urls]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !sel) return null;

  const onDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${downloadName || sel.code || "qr"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        backgroundColor: "rgba(31, 29, 27, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 26,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: "100%",
          maxWidth: M_MAX_WIDTH - 52,
          backgroundColor: M.card,
          borderRadius: 24,
          padding: 22,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 800, color: M.raisin }}>
            {title}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: M.divider,
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <X size={17} strokeWidth={1.75} color={M.body} />
          </button>
        </div>

        {/* Chip row to switch the encoded target (Item QR has several). */}
        {choices.length > 1 ? (
          <div
            style={{
              display: "flex",
              gap: 7,
              overflowX: "auto",
              paddingBottom: 6,
              marginBottom: 16,
              scrollbarWidth: "none",
            }}
          >
            {choices.map((ch, i) => {
              const active = i === selIdx;
              return (
                <button
                  key={ch.code + i}
                  onClick={() => setSelIdx(i)}
                  style={{
                    flexShrink: 0,
                    padding: "7px 12px",
                    borderRadius: 9,
                    border: `1px solid ${active ? M.taupe : M.hairline}`,
                    background: active ? M.taupe : M.card,
                    color: active ? "#fff" : "#6B7280",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {ch.label}
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "center" }}
        >
          <div
            style={{
              width: 200,
              height: 200,
              background: M.card,
              border: `1px solid ${M.border}`,
              borderRadius: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              padding: 10,
            }}
          >
            {dataUrl ? (
              <img
                src={dataUrl}
                alt={`QR for ${sel.code}`}
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <span style={{ fontSize: 12, color: M.muted }}>Generating…</span>
            )}
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: M.raisin,
              marginTop: 14,
              letterSpacing: "0.3px",
            }}
          >
            {sel.code}
          </div>
          <div style={{ fontSize: 11.5, color: M.muted, marginTop: 3 }}>
            Scan to look up in Hookka ERP
          </div>
        </div>

        <button
          onClick={onDownload}
          disabled={!dataUrl}
          style={{
            width: "100%",
            height: 48,
            marginTop: 18,
            border: "none",
            borderRadius: 13,
            background: M.taupe,
            color: "#fff",
            fontSize: 14.5,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            cursor: dataUrl ? "pointer" : "default",
            opacity: dataUrl ? 1 : 0.6,
          }}
        >
          <Download size={18} strokeWidth={1.75} color="#fff" />
          Download QR
        </button>
      </div>
    </div>
  );
}

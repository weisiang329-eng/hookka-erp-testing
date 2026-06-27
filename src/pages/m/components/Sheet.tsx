// Sheet — bottom-sheet overlay used for filters, quick actions, and (later)
// create/edit forms. Slides up from the bottom, dimmed backdrop, drag handle,
// optional title. Closes on backdrop tap / Esc.
import { type ReactNode, useEffect } from "react";
import { X } from "lucide-react";
import { M, M_MAX_WIDTH } from "../theme";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

export function Sheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        backgroundColor: "rgba(31, 29, 27, 0.45)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: "100%",
          maxWidth: M_MAX_WIDTH,
          backgroundColor: M.paper,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: "85vh",
          overflowY: "auto",
          paddingBottom: "max(16px, env(safe-area-inset-bottom))",
          boxShadow: "0 -8px 30px rgba(31,29,27,0.18)",
        }}
      >
        {/* Drag handle */}
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 9999,
              backgroundColor: M.border,
            }}
          />
        </div>

        {title ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 16px 6px",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: M.raisin }}>
              {title}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                padding: 6,
                cursor: "pointer",
                display: "flex",
              }}
            >
              <X size={20} strokeWidth={1.75} color={M.muted} />
            </button>
          </div>
        ) : null}

        <div style={{ padding: "8px 16px 16px" }}>{children}</div>
      </div>
    </div>
  );
}

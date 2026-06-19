// ---------------------------------------------------------------------------
// useConfirm — in-app confirmation dialog (NOT window.confirm).
// ---------------------------------------------------------------------------
// Owner rule ([[feedback_no_naked_edits]]): destructive / posting actions
// (delete, void, deduct stock, close case, discard edits) must ask Confirm
// first, and the confirm must look like the rest of the ERP — never the
// browser's window.confirm.
//
// Architecture: ONE <ConfirmProvider> is mounted at the app root (main.tsx)
// and renders a SINGLE shared <ConfirmDialog>. Any page calls
// `const { confirm } = useConfirm()` and awaits
// `await confirm({ message, ... })`, which resolves true (confirmed) / false
// (cancelled, backdrop click, or Esc). No per-page modal, no provider wiring
// at each call site.
//
// Backward compatibility: useConfirm() still returns `confirmDialog` (now
// always null, since the provider renders the one real dialog). Older callers
// that render `{confirmDialog}` keep working as a harmless no-op. The options
// shape accepts both the legacy `{ title, message, tone }` and the new
// `{ message, danger, confirmLabel, cancelLabel, title? }`.
//
// Styling mirrors the existing modals (fixed inset-0 overlay, bg-black/40
// backdrop, white rounded card, bronze #6B5C32 primary button, red #9A3A2D
// button when danger). English only.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  // Optional heading. Defaults to "Please confirm" when omitted.
  title?: string;
  // Body — string or rich node (e.g. a highlighted item name + warning line).
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // Paint the confirm button red (delete / void / discard / cancel actions).
  // `tone: "danger"` is the legacy alias for `danger: true` — either works.
  danger?: boolean;
  tone?: "default" | "danger";
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Context — provides the single `confirm` function to the whole tree.
// ---------------------------------------------------------------------------
const ConfirmContext = createContext<ConfirmFn | null>(null);

// Module-level fallback so a `confirm()` call works even if (somehow) the
// provider isn't mounted yet — degrades gracefully to window.confirm rather
// than throwing and breaking a delete handler.
function fallbackConfirm(opts: ConfirmOptions): Promise<boolean> {
  const text =
    typeof opts.message === "string"
      ? opts.message
      : opts.title ?? "Are you sure?";
  return Promise.resolve(window.confirm(text));
}

// ---------------------------------------------------------------------------
// ConfirmProvider — mount ONCE near the app root.
// ---------------------------------------------------------------------------
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setOpts(null);
    const r = resolver.current;
    resolver.current = null;
    r?.(value);
  }, []);

  // Esc cancels the dialog (same as backdrop / Cancel button).
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, settle]);

  const isDanger = opts?.danger === true || opts?.tone === "danger";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          {/* Backdrop click = cancel (same as the Cancel button / Esc). */}
          <div
            className="fixed inset-0 bg-black/40"
            onClick={() => settle(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative mx-4 w-full max-w-sm rounded-xl border border-[#E2DDD8] bg-white shadow-2xl"
          >
            <div className="p-5">
              <h3 className="text-base font-semibold text-[#1F1D1B]">
                {opts.title ?? "Please confirm"}
              </h3>
              {opts.message != null && (
                <div className="mt-2 whitespace-pre-line text-sm leading-relaxed text-[#4B5563]">
                  {opts.message}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#E2DDD8] bg-[#FAF9F7] p-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => settle(false)}
              >
                {opts.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                size="sm"
                onClick={() => settle(true)}
                className={
                  isDanger
                    ? "bg-[#9A3A2D] text-white hover:bg-[#7A2E24]"
                    : "bg-[#6B5C32] text-white hover:bg-[#4D4224]"
                }
              >
                {opts.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// useConfirm — page-facing hook.
// ---------------------------------------------------------------------------
// Returns `confirm` (the shared, provider-backed function) plus `confirmDialog`
// (always null now — kept so legacy callers that render `{confirmDialog}` keep
// compiling and behave as a no-op).
export function useConfirm(): {
  confirm: ConfirmFn;
  confirmDialog: ReactNode;
} {
  const ctx = useContext(ConfirmContext);
  return { confirm: ctx ?? fallbackConfirm, confirmDialog: null };
}

// ---------------------------------------------------------------------------
// useConfirm — in-app confirmation dialog (NOT window.confirm).
// ---------------------------------------------------------------------------
// Owner rule ([[feedback_no_naked_edits]]): destructive / posting actions
// (delete, void, deduct stock, close case) must ask Confirm first, and the
// confirm must live INSIDE the page — never the browser's window.confirm.
//
// Self-contained per-component hook (no app-root provider to wire): a panel
// calls `const { confirm, confirmDialog } = useConfirm()`, renders
// `{confirmDialog}` once in its tree, and awaits `await confirm({ ... })`
// which resolves true (confirmed) / false (cancelled or backdrop-dismissed).
//
// Styling mirrors the existing modals on the page (fixed overlay + white
// rounded card) so it feels native to the ERP.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  // Body — string or rich node (e.g. a highlighted item name + warning line).
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // "danger" paints the confirm button red (delete / deduct / cancel-case);
  // "default" uses the brand button (benign confirmations).
  tone?: "default" | "danger";
};

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions): Promise<boolean> => {
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

  const confirmDialog = opts ? (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop click = cancel (same as the × / Cancel button). */}
      <div
        className="fixed inset-0 bg-black/40"
        onClick={() => settle(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative mx-4 w-full max-w-sm rounded-lg border border-[#E2DDD8] bg-white shadow-xl"
      >
        <div className="p-4">
          <h3 className="text-sm font-semibold text-[#1F1D1B]">{opts.title}</h3>
          {opts.message != null && (
            <div className="mt-2 text-xs leading-relaxed text-[#4B5563]">
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
            variant={opts.tone === "danger" ? "destructive" : "primary"}
            size="sm"
            onClick={() => settle(true)}
            className={
              opts.tone === "danger"
                ? undefined
                : "bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            }
          >
            {opts.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmDialog };
}

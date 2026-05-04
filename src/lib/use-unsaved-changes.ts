// ---------------------------------------------------------------------------
// useUnsavedChanges — beforeunload guard for forms with pending edits.
//
// Replaces the old in-app tab system's `useActiveTabDirty` (which gated
// LRU eviction in the 10-tab cap modal). With breadcrumb-based shell
// navigation we don't need per-tab dirty bookkeeping; we just want the
// browser to warn the user before they close the tab / refresh / navigate
// to a different domain while a form has unsaved edits.
//
// Matches Odoo / SAP Fiori convention: internal route changes do NOT
// trigger a prompt (there's no good UX for "are you sure" between every
// page click); only browser-level unload events do.
//
// Usage:
//   useUnsavedChanges(isDirty);
//
// When `isDirty` is true the user sees the browser's native "Leave site?"
// dialog if they try to close the tab, hit refresh, or navigate to a
// different origin. The listener is automatically removed on unmount.
// ---------------------------------------------------------------------------
import { useEffect } from "react";

export function useUnsavedChanges(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore custom messages and show their own
      // standard prompt, but the event must be cancelled (preventDefault
      // + returnValue assignment) for the dialog to appear at all.
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts for the multi-tab bar.
//
// Bindings (match VS Code / Chrome conventions)
//   Ctrl+W              Close current tab
//   Ctrl+Tab            Next tab (wraps)
//   Ctrl+Shift+Tab      Previous tab (wraps)
//   Ctrl+1..9           Jump to tab N (9 = last)
//   Ctrl+Shift+T        (reserved — browser "reopen last closed"; no-op here)
//
// Rendered as a sibling inside <TabsProvider>. Does not render any DOM.
// ---------------------------------------------------------------------------
import { useEffect } from "react";
import { useTabs } from "./tabs-context";

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function TabsKeyboardShortcuts() {
  const { tabs, activeId, switchTab, closeTab } = useTabs();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only listen to Ctrl (or Cmd on Mac). Never intercept typing inside
      // inputs / textareas — users editing a field expect their Ctrl+W or
      // Ctrl+1 to behave browser-natively (though Ctrl+W is usually caught
      // by the browser anyway).
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (isEditableTarget(e.target)) return;

      // --- Close current tab (Ctrl+W) ------------------------------------
      if (e.key === "w" || e.key === "W") {
        if (activeId) {
          // Browsers intercept Ctrl+W at the tab level — this may still
          // never fire, but we try so that if the browser release key-capture
          // (e.g. in Electron or kiosk mode) we behave correctly.
          e.preventDefault();
          closeTab(activeId);
        }
        return;
      }

      // --- Cycle tabs (Ctrl+Tab / Ctrl+Shift+Tab) ------------------------
      if (e.key === "Tab") {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeId);
        let next: number;
        if (e.shiftKey) {
          next = idx <= 0 ? tabs.length - 1 : idx - 1;
        } else {
          next = idx === -1 || idx === tabs.length - 1 ? 0 : idx + 1;
        }
        switchTab(tabs[next].id);
        return;
      }

      // --- Jump to tab N (Ctrl+1..9) -------------------------------------
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        e.preventDefault();
        const target =
          n === 9
            ? tabs[tabs.length - 1]
            : tabs[n - 1];
        if (target) switchTab(target.id);
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeId, switchTab, closeTab]);

  return null;
}

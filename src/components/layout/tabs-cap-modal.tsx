// ---------------------------------------------------------------------------
// TabsCapModal — surfaces when openTab() is blocked because all 10 tabs
// have unsaved changes. Lists those dirty tabs and lets the user pick one
// to save & close (page handles save) or discard & close. Cancel keeps
// the existing 10 and drops the deferred-open intent.
//
// We avoid the "save" half being a magic wand: we navigate the user to the
// dirty tab they chose, then close the modal. They commit / cancel save in
// the form itself; once it submits, react state goes clean and they can
// retry the original navigation. Discard close calls closeTab via the
// resolveCapModal action, which evicts and proceeds.
//
// Pattern reference: SAP Fiori "leave page" prompt, Salesforce Lightning
// console "Subtab limit reached" modal.
// ---------------------------------------------------------------------------
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTabs, titleForPath } from "@/contexts/tabs-context";
import { MAX_TABS } from "@/contexts/tabs-reducer";

export function TabsCapModal() {
  const {
    pendingOpenPath,
    tabs,
    dirtyIds,
    cancelPendingOpen,
    resolveCapModal,
    switchTab,
  } = useTabs();
  const navigate = useNavigate();

  // Keyboard escape cancels.
  useEffect(() => {
    if (!pendingOpenPath) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelPendingOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingOpenPath, cancelPendingOpen]);

  if (!pendingOpenPath) return null;

  const dirtyTabs = tabs.filter((t) => dirtyIds.has(t.id) && !t.pinned);

  const goToTabAndClose = (tabId: string) => {
    switchTab(tabId);
    cancelPendingOpen();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tabs-cap-modal-title"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancelPendingOpen();
      }}
    >
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl border border-[#E2DDD8]">
        <div className="px-5 py-4 border-b border-[#E2DDD8]">
          <h2
            id="tabs-cap-modal-title"
            className="text-base font-semibold text-[#1F1D1B]"
          >
            Tab limit reached ({MAX_TABS}/{MAX_TABS})
          </h2>
          <p className="mt-1 text-sm text-[#5A5550]">
            All open tabs have unsaved changes. Close one to open{" "}
            <code className="text-xs px-1 py-0.5 rounded bg-[#F5F2ED]">
              {titleForPath(pendingOpenPath)}
            </code>
            .
          </p>
        </div>

        <ul className="max-h-72 overflow-y-auto divide-y divide-[#F0ECE9]">
          {dirtyTabs.map((tab) => (
            <li key={tab.id} className="flex items-center gap-3 px-5 py-3">
              <span
                className="h-2 w-2 rounded-full bg-[#6B5C32] shrink-0"
                aria-hidden
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[#1F1D1B] truncate">
                  {tab.title}
                </div>
                <div className="text-xs text-[#9CA3AF] truncate">
                  {tab.path}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  // Route the user to the tab so they can save in-place,
                  // then drop the deferred-open intent. They re-trigger
                  // the original navigation manually after saving.
                  goToTabAndClose(tab.id);
                  navigate(tab.path);
                }}
                className="text-xs px-2 py-1 rounded border border-[#D1CBC5] text-[#6B5C32] hover:bg-[#F5F2ED]"
              >
                Save…
              </button>
              <button
                type="button"
                onClick={() => resolveCapModal(tab.id)}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50"
              >
                Discard &amp; close
              </button>
            </li>
          ))}
        </ul>

        <div className="px-5 py-3 border-t border-[#E2DDD8] flex justify-end">
          <button
            type="button"
            onClick={cancelPendingOpen}
            className="text-sm px-3 py-1.5 rounded border border-[#D1CBC5] text-[#5A5550] hover:bg-[#F5F2ED]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

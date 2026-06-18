// ---------------------------------------------------------------------------
// useNavGuard — unsaved-changes guard for BOTH halves of "leaving":
//
//   1. In-app navigation (breadcrumb / link / back button) — via React
//      Router's useBlocker (the app is on createBrowserRouter, so the data
//      router APIs are available). When `isDirty` is true and the path is
//      about to change, the user gets a confirm; proceed = navigate away,
//      cancel = stay on the form with edits intact.
//   2. Browser unload (tab close / refresh / cross-origin) — delegated to
//      the existing `useUnsavedChanges` (native beforeunload dialog).
//
// This is the in-app counterpart the codebase was missing: `useUnsavedChanges`
// alone only covered tab-close/refresh and intentionally left in-app route
// changes unguarded. Owner 2026-06-18 asked for a prompt on 切頁 (page switch)
// too, so a card's unsaved edits can't be silently dropped by clicking away.
//
// Usage (in any component rendered inside the RouterProvider tree):
//   useNavGuard(isDirty);
//   useNavGuard(isDirty, "You have unsaved Root Cause edits. Leave without saving?");
//
// Pair it with an explicit Save/Cancel: Save persists (isDirty → false),
// Cancel reverts local state to the server value (isDirty → false). The guard
// only fires while edits are genuinely pending.
// ---------------------------------------------------------------------------
import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { useUnsavedChanges } from "./use-unsaved-changes";

const DEFAULT_MESSAGE =
  "You have unsaved changes. Leave this page without saving?";

export function useNavGuard(
  isDirty: boolean,
  message: string = DEFAULT_MESSAGE,
): void {
  // Half 1 — browser-level (close tab / refresh / different origin).
  useUnsavedChanges(isDirty);

  // Half 2 — in-app route changes. Only block a genuine path change while
  // dirty (same-path search/hash tweaks don't count, so a filter change or a
  // query-param write on the same page never trips the prompt).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    // If the form became clean between the nav attempt and this effect
    // (e.g. a Save resolved), let the navigation through silently.
    if (!isDirty) {
      blocker.proceed();
      return;
    }
    const leave = window.confirm(message);
    if (leave) blocker.proceed();
    else blocker.reset();
  }, [blocker, isDirty, message]);
}

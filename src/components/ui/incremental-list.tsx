"use client";

// ---------------------------------------------------------------------------
// useIncrementalList — render the newest slice of a long list, extend it as
// the reader reaches the end.
//
// WHY THIS AND NOT useVirtualRows
// Row windowing needs a known, uniform row height. Some lists don't have one:
// Mail Center's threads are `<li>`s whose height depends on the subject, the
// label chips and the density preference, and they scroll with the PAGE rather
// than inside a sized box. Pinning them to a constant to satisfy a virtualizer
// would mean clipping real content.
//
// This is the other half of the answer, and it is the one that matches how
// people actually read these screens: show the newest N, and when the reader
// scrolls to the bottom, extend. Nobody scrolls to mail #300; the ones who do
// end up exactly where they are today, just later.
//
// Measured on production (erp.hookka.com, 2026-08-01): /mail-center rendered
// all 300 threads the API caps at — 11,543 DOM nodes, 1,566 buttons, 24,564px
// of page — and froze the main thread for 3,745ms in one task, the second
// worst freeze in the system. Its APIs answered in 350ms; the entire cost was
// building rows nobody had scrolled to.
//
// The count resets whenever the underlying list identity changes (a different
// folder, mailbox or filter), so switching folders never inherits a previous
// screen's scroll depth.
// ---------------------------------------------------------------------------

import * as React from "react";
import { nextIncrementalCount } from "@/lib/incremental-window";

export type UseIncrementalListOptions = {
  /** How many items exist in total. */
  total: number;
  /** How many to render before the reader asks for more. */
  initial?: number;
  /** How many more to add each time the end comes into view. */
  step?: number;
  /**
   * Changing this resets back to `initial` — pass whatever identifies the
   * current list (folder + filter + search term).
   */
  resetKey?: string;
};

export type UseIncrementalListResult = {
  /** Render `items.slice(0, count)`. */
  count: number;
  /** True when items remain beyond `count`. */
  hasMore: boolean;
  /**
   * Attach to an element placed AFTER the last rendered item. When it comes
   * into view, the next step is added.
   */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
};

export function useIncrementalList({
  total,
  initial = 50,
  step = 50,
  resetKey = "",
}: UseIncrementalListOptions): UseIncrementalListResult {
  const [rawCount, setCount] = React.useState(initial);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  // Switching folder/mailbox/search is a different list, so the slice rewinds
  // to the first screenful. Adjusted during render (React's documented
  // "reset state when a prop changes" pattern) rather than in an effect, which
  // would paint the old folder's depth for one frame first.
  const [seenKey, setSeenKey] = React.useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setCount(initial);
  }

  // No IntersectionObserver (old browser, jsdom) → show everything rather than
  // strand the reader with no way to reach the rest of the list. Derived, not
  // pushed into state, so there is no render where the list is truncated with
  // no way to extend it.
  const canObserve = typeof IntersectionObserver !== "undefined";
  const count = canObserve ? Math.min(rawCount, total) : total;
  const hasMore = count < total;

  React.useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setCount((c) => nextIncrementalCount(c, step, total));
        }
      },
      // Extend before the reader actually hits the end, so the list feels
      // continuous rather than paged.
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, step, total]);

  // Ctrl-P must not silently print a partial list.
  React.useEffect(() => {
    if (!hasMore) return;
    const showAll = () => setCount(total);
    window.addEventListener("beforeprint", showAll);
    return () => window.removeEventListener("beforeprint", showAll);
  }, [hasMore, total]);

  return { count, hasMore, sentinelRef };
}

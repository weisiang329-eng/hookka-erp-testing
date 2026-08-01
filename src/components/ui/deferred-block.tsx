"use client";

// ---------------------------------------------------------------------------
// DeferredBlock — don't build DOM for a section nobody is looking at.
//
// WHY THIS EXISTS
// Row windowing (useVirtualRows) only helps a table whose rows are siblings in
// one <tbody>. The accounting General Ledger is not that shape: its grouped
// view is one <Card> + its own <table> PER ACCOUNT, which is the owner's
// AutoCount-style layout and worth keeping. On production (2026-08-01) that
// meant 1,798 rows spread over dozens of per-account tables — 17,344 DOM nodes
// and 63,538px of page height to show eight rows, freezing the main thread for
// 844ms on tab entry while the API itself answered in 296ms.
//
// This component keeps the markup exactly as it is and simply refuses to mount
// a block until it is near the viewport, swapping in a same-height placeholder
// so the page height, scrollbar and anchor links stay correct. Scrolling
// mounts blocks as they approach and they stay mounted afterwards — a ledger
// is read by scrolling down, and re-rendering a block the user just scrolled
// past would cost more than it saves.
//
// `content-visibility: auto` was considered and is NOT enough here: it skips
// layout and paint for off-screen subtrees but the DOM nodes are still created,
// and node creation is what the 844ms freeze is made of.
//
// PRINT / EXPORT SAFETY
// CSV, Excel and PDF exports build from the data array, never from the DOM, so
// they are unaffected. Browser print IS DOM-driven, so pass `alwaysRender` (or
// let the built-in beforeprint listener do it) to guarantee every block exists
// on paper.
// ---------------------------------------------------------------------------

import * as React from "react";

export type DeferredBlockProps = {
  /**
   * Height to reserve while the block is unmounted. Getting this close to the
   * real height keeps the scrollbar steady; being wrong only causes a small
   * jump as the block mounts.
   */
  estimatedHeight: number;
  /** Mount when the block comes within this many pixels of the viewport. */
  rootMargin?: number;
  /** Force the real content to render — printing, or an expanded-all view. */
  alwaysRender?: boolean;
  children: React.ReactNode;
};

export function DeferredBlock({
  estimatedHeight,
  rootMargin = 900,
  alwaysRender = false,
  children,
}: DeferredBlockProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  // `mounted` latches once the block has been near the viewport; `alwaysRender`
  // is derived rather than pushed into state so a print/export toggle takes
  // effect in the same render instead of one cascade later.
  const [mounted, setMounted] = React.useState(false);
  const shown = alwaysRender || mounted;

  React.useEffect(() => {
    if (shown) return;
    const el = ref.current;
    // No IntersectionObserver (old browser, jsdom) → render everything rather
    // than render nothing. Degrading to the current behaviour is the only
    // acceptable failure mode for a financial report.
    if (!el || typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          io.disconnect();
        }
      },
      { rootMargin: `${rootMargin}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rootMargin]);

  // Ctrl-P must not print a page full of placeholders.
  React.useEffect(() => {
    if (shown) return;
    const onBeforePrint = () => setMounted(true);
    window.addEventListener("beforeprint", onBeforePrint);
    return () => window.removeEventListener("beforeprint", onBeforePrint);
  }, [shown]);

  return (
    <div ref={ref} style={shown ? undefined : { height: `${estimatedHeight}px` }}>
      {shown ? children : null}
    </div>
  );
}

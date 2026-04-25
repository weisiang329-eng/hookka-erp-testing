// ---------------------------------------------------------------------------
// scheduler — visibility-aware setInterval / setTimeout React hooks.
//
// Purpose: enforce one canonical timer pattern across the SPA. Every recurring
// timer should pause when the tab is hidden (saves CPU + bandwidth on idle
// background tabs, avoids hammering the API from pinned-but-forgotten tabs)
// and clear cleanly on unmount (prevents the "setState on unmounted component"
// warning + memory leaks when navigating quickly between pages).
//
// The pattern is lifted from `src/lib/use-presence.ts` (the reference impl
// for visibility-aware polling) and `src/lib/use-version-check.ts`. Those
// two hooks are the template; this module generalises them.
//
// Phase 4 (P4.1) of the enterprise upgrade — see docs/UPGRADE-CONTROL-BOARD.md.
// P4.2 wires up an ESLint rule that warns on raw `setInterval`/`setTimeout`.
// P4.3 migrates the existing 30+ raw call sites to use these wrappers.
// ---------------------------------------------------------------------------
import { useEffect, useRef } from "react";

export type IntervalOptions = {
  /**
   * Pause when `document.hidden` is true. Default: true (matches use-presence
   * pattern). Pass `false` for animations that must keep running while the
   * tab is backgrounded (e.g. CSS-driven progress that the user expects to
   * have advanced when they return).
   *
   * Trade-off: with `pauseOnHidden: true` the user gets stale data on tab
   * focus until the next interval fires. Combine with a `visibilitychange`
   * listener if you need an immediate refresh on focus (use-presence does
   * this — see lines 132-144 of use-presence.ts).
   */
  pauseOnHidden?: boolean;
  /**
   * Run `fn` immediately on mount, before waiting the first `ms` interval.
   * Default: false (matches setInterval semantics — first fire is at +ms).
   */
  runImmediately?: boolean;
};

/**
 * Visibility-aware setInterval wrapper.
 *
 * - Auto-clears on unmount.
 * - When `pauseOnHidden` (default true), pauses on `document.hidden = true`
 *   and resumes on `visibilitychange` back to visible.
 * - The latest `fn` is captured via ref, so the caller does not need to
 *   memoise it — the interval keeps the most recent closure without
 *   restarting (changing the function identity does NOT reset the timer).
 * - `ms = null` is a no-op (timer is not started). Useful for conditional
 *   polling: `useInterval(fn, enabled ? 30_000 : null)`.
 *
 * @example
 *   useInterval(() => refresh(), 30_000);
 *   useInterval(() => poll(), 10_000, { pauseOnHidden: true, runImmediately: true });
 */
export function useInterval(
  fn: () => void,
  ms: number | null,
  opts: IntervalOptions = {},
): void {
  const { pauseOnHidden = true, runImmediately = false } = opts;
  const fnRef = useRef(fn);

  // Keep the ref pointed at the latest closure. Read in the timer tick so
  // callers do not need useCallback.
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (ms === null) return;

    let timerId: number | undefined;

    function tick() {
      try {
        fnRef.current();
      } catch (err) {
        // Don't let a thrown callback kill the timer — log and continue so
        // a transient failure doesn't permanently stop polling.
        // eslint-disable-next-line no-console
        console.error("[useInterval] callback threw:", err);
      }
    }

    function startTimer() {
      if (timerId !== undefined) return;
      timerId = window.setInterval(tick, ms!);
    }

    function stopTimer() {
      if (timerId !== undefined) {
        window.clearInterval(timerId);
        timerId = undefined;
      }
    }

    // Initial fire path. `runImmediately` fires before the first delay; this
    // is the common case for "fetch on mount, then keep refreshing".
    if (typeof document !== "undefined" && pauseOnHidden && document.hidden) {
      // Tab is already backgrounded on mount — don't fire, don't start.
    } else {
      if (runImmediately) tick();
      startTimer();
    }

    let onVisibilityChange: (() => void) | undefined;
    if (pauseOnHidden && typeof document !== "undefined") {
      onVisibilityChange = () => {
        if (document.hidden) {
          stopTimer();
        } else {
          // Resuming: don't double-fire. Just restart the cadence — the next
          // tick will land at +ms from now. Callers who need an immediate
          // refresh on focus should add their own visibilitychange listener
          // (see use-version-check.ts for the pattern).
          startTimer();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      stopTimer();
      if (onVisibilityChange && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
    // `ms`, `pauseOnHidden`, `runImmediately` are the only inputs that change
    // the timer wiring. `fn` is intentionally excluded — see fnRef above.
  }, [ms, pauseOnHidden, runImmediately]);
}

export type TimeoutOptions = {
  /**
   * If true, `fn` runs once on unmount even if the timeout has not yet fired.
   * Useful for "save on unmount" delayed actions. Default: false.
   *
   * Note: this does NOT fire if the component is unmounted while
   * `document.hidden` is true and the timer was never armed — the contract
   * is "fire once at most".
   */
  runOnUnmount?: boolean;
};

/**
 * Visibility-aware setTimeout wrapper. One-shot.
 *
 * - Cleared on unmount.
 * - When `document.hidden` becomes true before fire, the timer is cancelled
 *   and the callback is NOT scheduled to fire on resume. (Differs from
 *   `useInterval`'s pause/resume semantics. Timeouts are typically used for
 *   "delayed save" / "delayed toast dismiss" — firing them stale on
 *   background-tab-resume is usually wrong.)
 * - Latest `fn` captured via ref so callers don't have to memo.
 * - `ms = null` is a no-op.
 *
 * @example
 *   useTimeout(() => save(formState), 800);    // delayed autosave
 *   useTimeout(() => setVisible(false), null); // disabled
 */
export function useTimeout(
  fn: () => void,
  ms: number | null,
  opts: TimeoutOptions = {},
): void {
  const { runOnUnmount = false } = opts;
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (ms === null) return;

    let timerId: number | undefined;
    let fired = false;

    function fire() {
      if (fired) return;
      fired = true;
      try {
        fnRef.current();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[useTimeout] callback threw:", err);
      }
    }

    function arm() {
      if (timerId !== undefined) return;
      timerId = window.setTimeout(() => {
        timerId = undefined;
        fire();
      }, ms!);
    }

    function disarm() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
        timerId = undefined;
      }
    }

    if (typeof document !== "undefined" && document.hidden) {
      // Don't arm while hidden — wait for visible.
    } else {
      arm();
    }

    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        disarm();
      }
      // Note: we deliberately do NOT re-arm on resume. A delayed save fired
      // 5 minutes after the user backgrounded the tab is almost always wrong.
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      disarm();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (runOnUnmount && !fired) {
        fire();
      }
    };
  }, [ms, runOnUnmount]);
}

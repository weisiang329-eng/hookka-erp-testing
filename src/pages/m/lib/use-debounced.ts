// ===========================================================================
// useDebounced — return a value delayed by `ms`.
//
// Why: every /m list filters the FULL fetched array (Sales ~930, Production
// ~457, Inventory ~1,800 rows) on each keystroke and re-renders. On a phone
// that's the difference between smooth and janky typing. Feeding the search box
// through this hook runs the filter only after the user pauses (~200ms); the
// <input> itself stays instant (it's still bound to the raw state).
//
// ADDITIVE: imported only by files under src/pages/m/.
// ===========================================================================
import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax -- debounce needs a per-value resettable timer; useTimeout doesn't fit
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

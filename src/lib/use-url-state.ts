// ---------------------------------------------------------------------------
// useUrlState — two-way sync between a piece of state and the URL query string.
//
// Why: list pages keep their filters / sort / search / pagination in plain
// `useState`, which is wiped on refresh, navigation away, or accidental tab
// close. Mirroring those values to the URL gives us:
//   • survives refresh (URL is the source of truth)
//   • survives back/forward (browser history naturally restores it)
//   • shareable links (paste a URL into chat → same view opens for everyone)
//
// All three helpers (string, number, bool) replace the URL entry by default
// (replace: true) so flipping filters doesn't pollute the back-stack — the
// user can still hit back to leave the page, not to undo a checkbox.
// ---------------------------------------------------------------------------

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

type UrlStateValue = string | string[];

function readScalar(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  return v === null ? null : v;
}

function readList(params: URLSearchParams, key: string): string[] | null {
  // We support both repeated-key form (?k=a&k=b) and comma-joined (?k=a,b).
  // Repeated form wins because URLSearchParams.getAll yields it natively.
  const all = params.getAll(key);
  if (all.length > 1) return all;
  if (all.length === 1) {
    const v = all[0];
    if (v === "") return [];
    return v.includes(",") ? v.split(",").filter(Boolean) : [v];
  }
  return null;
}

/**
 * Two-way sync between a piece of state and a URL query param.
 *
 * `defaultValue` controls both the initial fallback when the URL has no
 * entry for `key` AND the "is this the default" check used to clean the URL
 * (writing the default removes the param so we don't ship `?status=` for
 * empty filters).
 *
 * Arrays serialize as repeated keys (`?cat=A&cat=B`) which URLSearchParams
 * round-trips cleanly.
 */
export function useUrlState<T extends UrlStateValue>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const value = useMemo<T>(() => {
    if (Array.isArray(defaultValue)) {
      const list = readList(searchParams, key);
      return (list ?? defaultValue) as T;
    }
    const scalar = readScalar(searchParams, key);
    return (scalar ?? defaultValue) as T;
  }, [searchParams, key, defaultValue]);

  const setValue = useCallback(
    (next: T) => {
      setSearchParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (Array.isArray(next)) {
            out.delete(key);
            // If `next` matches the default, leave the param dropped so URLs
            // stay clean — typing a filter back to "All" should remove the
            // ugly empty query.
            const isDefault =
              Array.isArray(defaultValue) &&
              next.length === defaultValue.length &&
              next.every((v, i) => v === defaultValue[i]);
            if (!isDefault) {
              for (const v of next) out.append(key, String(v));
            }
          } else {
            if (next === defaultValue || next === "" || next == null) {
              out.delete(key);
            } else {
              out.set(key, String(next));
            }
          }
          return out;
        },
        { replace: true },
      );
    },
    [setSearchParams, key, defaultValue],
  );

  return [value, setValue];
}

/**
 * Same shape as useUrlState but the URL value is parsed/stringified as a
 * number. NaN-safe — falls back to the default when the URL holds garbage.
 */
export function useUrlStateNumber(
  key: string,
  def: number,
): [number, (n: number) => void] {
  const [raw, setRaw] = useUrlState<string>(key, "");
  const value = useMemo<number>(() => {
    if (raw === "") return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  }, [raw, def]);
  const setValue = useCallback(
    (n: number) => {
      if (n === def) {
        setRaw("");
      } else {
        setRaw(String(n));
      }
    },
    [setRaw, def],
  );
  return [value, setValue];
}

/**
 * Boolean variant — URL value is "1" / "0". Default value is encoded by
 * absence (no param = default), so a bool toggled back to its default
 * disappears from the URL.
 */
export function useUrlStateBool(
  key: string,
  def: boolean,
): [boolean, (b: boolean) => void] {
  const [raw, setRaw] = useUrlState<string>(key, "");
  const value = useMemo<boolean>(() => {
    if (raw === "1") return true;
    if (raw === "0") return false;
    return def;
  }, [raw, def]);
  const setValue = useCallback(
    (b: boolean) => {
      if (b === def) {
        setRaw("");
      } else {
        setRaw(b ? "1" : "0");
      }
    },
    [setRaw, def],
  );
  return [value, setValue];
}

import { useCallback, useMemo, useState } from "react";

// Ticked-row selection for a list, keyed by a stable id (doc number). toggleAll
// and allSelected are evaluated against the CURRENTLY PASSED rows, so they honour
// the active filter. selectedKeys may hold keys no longer visible (kept stable);
// selectedRows is always the intersection with the current rows.
export function useRowSelection<T>(rows: T[], keyOf: (r: T) => string) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const isSelected = useCallback((key: string) => selectedKeys.has(key), [selectedKeys]);

  const toggle = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const visibleKeys = useMemo(() => rows.map(keyOf), [rows, keyOf]);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selectedKeys.has(k));

  const toggleAll = useCallback(() => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      const allOn = visibleKeys.length > 0 && visibleKeys.every((k) => next.has(k));
      if (allOn) visibleKeys.forEach((k) => next.delete(k));
      else visibleKeys.forEach((k) => next.add(k));
      return next;
    });
  }, [visibleKeys]);

  const clear = useCallback(() => setSelectedKeys(new Set()), []);

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedKeys.has(keyOf(r))),
    [rows, keyOf, selectedKeys],
  );

  return { selectedKeys, selectedRows, isSelected, toggle, toggleAll, clear, allSelected, count: selectedRows.length };
}

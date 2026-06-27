// ===========================================================================
// Shared helpers for module configs + the generic list engine.
//
// - Status resolution through the SAME design-tokens maps the desktop uses,
//   with NEUTRAL fallback for any value not in the enum (mirrors
//   resolveUnknownStatus, no per-row dev warning spam).
// - Dual-key reads (r.camelCase ?? r.snake_case) — the repo's canonical
//   defence against folded-lowercase / snake_case column drift.
// - Filtering + sorting applied generically from ColumnDef value types.
// ===========================================================================
import {
  NEUTRAL,
  type SemanticStyle,
  SO_STATUS_COLOR,
  PRODUCTION_STATUS_COLOR,
  DELIVERY_STATUS_COLOR,
  ATTENDANCE_STATUS_COLOR,
  FG_UNIT_STATUS_COLOR,
  SUCCESS,
  WARNING,
  DANGER,
  INFO,
} from "@/lib/design-tokens";
import { formatCurrency } from "@/lib/utils";
import {
  type RawRow,
  type ColumnDef,
  type ActiveFilter,
  type DataSource,
} from "./types";

// ---------------------------------------------------------------------------
// Dual-key read — tolerate camelCase / snake_case / folded-lowercase columns.
// ---------------------------------------------------------------------------
export function read(row: RawRow, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function str(row: RawRow, ...keys: string[]): string {
  const v = read(row, ...keys);
  return v == null ? "" : String(v);
}

export function num(row: RawRow, ...keys: string[]): number {
  const v = read(row, ...keys);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Slice any ISO / datetime string to "YYYY-MM-DD"; "" if absent. */
export function dateOnly(row: RawRow, ...keys: string[]): string {
  const v = str(row, ...keys);
  return v ? v.slice(0, 10) : "";
}

export function money(sen: number): string {
  return formatCurrency(sen || 0);
}

// ---------------------------------------------------------------------------
// Status resolution.
// ---------------------------------------------------------------------------
type StyleMap = Record<string, SemanticStyle>;

/** Resolve a raw status against a specific design-tokens map; NEUTRAL fallback. */
export function resolveStatus(
  raw: string | undefined | null,
  map: StyleMap,
): { style: SemanticStyle; label: string } {
  const key = (raw ?? "").toString().toUpperCase();
  return { style: map[key] ?? NEUTRAL, label: key || "—" };
}

export const STATUS_MAPS = {
  so: SO_STATUS_COLOR as StyleMap,
  production: PRODUCTION_STATUS_COLOR as StyleMap,
  delivery: DELIVERY_STATUS_COLOR as StyleMap,
  attendance: ATTENDANCE_STATUS_COLOR as StyleMap,
  fgUnit: FG_UNIT_STATUS_COLOR as StyleMap,
};

/**
 * Invoice / purchasing payment-state colours. These statuses aren't a single
 * canonical enum in design-tokens (they're derived display states), so we map
 * the spec's documented values to the shared semantic styles by meaning.
 */
export const PAYMENT_STATUS_MAP: StyleMap = {
  PAID: SUCCESS,
  PARTIAL: WARNING,
  UNPAID: NEUTRAL,
  OVERDUE: DANGER,
  // e-Invoice lifecycle (spec): Validated / Submitted / Pending.
  VALIDATED: SUCCESS,
  SUBMITTED: INFO,
  PENDING: NEUTRAL,
  // Procurement / GRN / 3-way (spec): Draft/Awaiting/Partial/Received/Matched/Mismatch.
  DRAFT: NEUTRAL,
  AWAITING: NEUTRAL,
  RECEIVED: SUCCESS,
  MATCHED: SUCCESS,
  MISMATCH: DANGER,
  // Generic active/closed.
  CONFIRMED: INFO,
  ISSUED: INFO,
  SENT: INFO,
  APPROVED: SUCCESS,
  COMPLETED: SUCCESS,
  CLOSED: NEUTRAL,
  CANCELLED: DANGER,
  VOID: DANGER,
  ACTIVE: SUCCESS,
  INACTIVE: NEUTRAL,
};

// ---------------------------------------------------------------------------
// Envelope selectors — most endpoints return { success, data: [...] }.
// ---------------------------------------------------------------------------
export function selectData(resp: unknown): RawRow[] {
  if (!resp || typeof resp !== "object") return [];
  const o = resp as { data?: unknown };
  if (Array.isArray(o.data)) return o.data as RawRow[];
  // Some endpoints return a bare array.
  if (Array.isArray(resp)) return resp as RawRow[];
  return [];
}

/** Selector for nested arrays, e.g. { data: { rawMaterials: [...] } }. */
export function selectNested(...path: string[]) {
  return (resp: unknown): RawRow[] => {
    let cur: unknown = resp;
    for (const k of path) {
      if (!cur || typeof cur !== "object") return [];
      cur = (cur as Record<string, unknown>)[k];
    }
    return Array.isArray(cur) ? (cur as RawRow[]) : [];
  };
}

// ---------------------------------------------------------------------------
// Generic filtering + sorting from ColumnDefs.
// ---------------------------------------------------------------------------
export function applyFilters(
  rows: RawRow[],
  columns: ColumnDef[],
  filters: Record<string, ActiveFilter>,
  search: string,
): RawRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter((row) => {
    // Free-text search across every text/enum column + the code/title fields.
    if (q) {
      const hay = columns
        .map((c) => {
          const v = c.value(row);
          return v == null ? "" : String(v);
        })
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    for (const col of columns) {
      const f = filters[col.key];
      if (!f) continue;
      const raw = col.value(row);
      if (f.type === "text") {
        if (!f.contains) continue;
        const v = raw == null ? "" : String(raw).toLowerCase();
        if (!v.includes(f.contains.toLowerCase())) return false;
      } else if (f.type === "number") {
        const v = Number(raw);
        if (!Number.isFinite(v)) return false;
        const { op, a, b } = f;
        if (a == null) continue;
        if (op === "eq" && v !== a) return false;
        if (op === "gt" && !(v > a)) return false;
        if (op === "lt" && !(v < a)) return false;
        if (op === "gte" && !(v >= a)) return false;
        if (op === "lte" && !(v <= a)) return false;
        if (op === "between") {
          if (b == null) continue;
          if (v < Math.min(a, b) || v > Math.max(a, b)) return false;
        }
      } else if (f.type === "date") {
        const v = raw == null ? "" : String(raw).slice(0, 10);
        if (!v) return false;
        if (f.from && v < f.from) return false;
        if (f.to && v > f.to) return false;
      } else if (f.type === "enum") {
        if (f.selected.length === 0) continue;
        const v = raw == null ? "" : String(raw).toUpperCase();
        if (!f.selected.map((s) => s.toUpperCase()).includes(v)) return false;
      }
    }
    return true;
  });
}

export function applySort(
  rows: RawRow[],
  columns: ColumnDef[],
  sort: { key: string; dir: "asc" | "desc" } | null,
): RawRow[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  const isNumeric = col.type === "number";
  return [...rows].sort((ra, rb) => {
    const va = col.value(ra);
    const vb = col.value(rb);
    if (isNumeric) {
      return (Number(va || 0) - Number(vb || 0)) * sign;
    }
    const sa = (va == null ? "" : String(va)).toLowerCase();
    const sb = (vb == null ? "" : String(vb)).toLowerCase();
    return sa.localeCompare(sb) * sign;
  });
}

/** Count of active (non-empty) filters for the badge on the Filter button. */
export function activeFilterCount(
  filters: Record<string, ActiveFilter>,
): number {
  let n = 0;
  for (const f of Object.values(filters)) {
    if (f.type === "text" && f.contains.trim()) n++;
    else if (f.type === "number" && f.a != null) n++;
    else if (f.type === "date" && (f.from || f.to)) n++;
    else if (f.type === "enum" && f.selected.length) n++;
  }
  return n;
}

/** Resolve the active source for the current sub-tab key across all sources. */
export function findSourceForTab(
  sources: DataSource[],
  tabKey: string,
): { source: DataSource; tab: DataSource["subTabs"][number] } | null {
  for (const source of sources) {
    const tab = source.subTabs.find((t) => t.key === tabKey);
    if (tab) return { source, tab };
  }
  return null;
}

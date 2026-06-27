// ===========================================================================
// Config-driven L1 module list system — shared types (Phase 2).
//
// Every L1 module list in the mobile app (Sales Orders, Delivery, Invoices,
// Procurement, Production, Planning, Warehouse, Inventory, Employees,
// Announcements, Mail Center) is structurally identical:
//
//   • a horizontal sub-tab row,
//   • a list of ListRow cards built from a fetched array,
//   • a type-aware filter / sort bottom-sheet.
//
// Instead of hand-writing 11 near-identical screens, each module supplies a
// ModuleConfig that declares: which endpoint to fetch, how to map one raw row
// → a view-model, the sub-tabs (+ their per-tab filter), the filterable
// columns (+ their value types so FilterSheet renders the right controls),
// and the L2 detail route. <ModuleListScreen> consumes the config.
//
// ADDITIVE: imported only by files under src/pages/m/. No backend, no desktop.
// ===========================================================================
import { type ReactNode } from "react";
import { type SemanticStyle } from "@/lib/design-tokens";

/** A raw row as returned by the API — shape varies per module. */
export type RawRow = Record<string, unknown>;

/** The view-model a config maps each raw row into, consumed by ListRow. */
export type RowVM = {
  /** Stable key for React + the L2 route param. */
  id: string;
  /** Document code, taupe monospace (e.g. "SO-2606-0142"). */
  code: string;
  /** Primary title (e.g. customer name). */
  title: string;
  /** Optional secondary line. */
  subLine?: string;
  /** Up to two right-aligned meta columns. */
  meta1?: { label: string; value: ReactNode };
  meta2?: { label: string; value: ReactNode };
  /** Resolved status pill (style + raw label), or undefined for no pill. */
  status?: { style: SemanticStyle; label: string };
};

/** Column value types drive the FilterSheet control + the sort comparator. */
export type ColumnType = "text" | "number" | "date" | "enum";

/** A filterable / sortable column declared by a module config. */
export type ColumnDef = {
  /** Stable key (used as the active-filter map key). */
  key: string;
  /** Human label shown in the FilterSheet + Sort list (spec terminology). */
  label: string;
  type: ColumnType;
  /**
   * Extract the comparable value from a raw row. Return:
   *   text   → string (lower-cased compare done by FilterSheet)
   *   number → number (sen for money columns)
   *   date   → ISO "YYYY-MM-DD" string (or full ISO; sliced to 10)
   *   enum   → the raw enum value string (compared against `options`)
   */
  value: (row: RawRow) => string | number | null | undefined;
  /** For enum columns: the selectable raw values (rendered Title Case). */
  options?: string[];
};

/** A sub-tab: a label + a predicate that narrows the fetched rows. */
export type SubTabDef = {
  key: string;
  label: string;
  /** Return true to KEEP the row under this tab. "All" tabs return true. */
  match: (row: RawRow) => boolean;
};

/**
 * One data source. Most modules have a single source feeding every sub-tab
 * (the sub-tab is just a client-side predicate). A few modules whose sub-tabs
 * are genuinely different entities (e.g. Delivery → Delivery Orders vs 3PL
 * Providers, Invoices → Invoices vs Payments) supply MULTIPLE sources, one per
 * sub-tab group, selected by `sourceKey` on the sub-tab.
 */
export type DataSource = {
  /** Endpoint to fetch (reuses an existing desktop API; no new backend). */
  url: string;
  /** Pull the row array out of the response envelope. */
  select: (resp: unknown) => RawRow[];
  /** Map a raw row → view-model. */
  toVM: (row: RawRow) => RowVM;
  /** Filterable / sortable columns for rows from this source. */
  columns: ColumnDef[];
  /** Sub-tabs that read from this source. */
  subTabs: SubTabDef[];
  /** Default sort: column key + direction. */
  defaultSort?: { key: string; dir: "asc" | "desc" };
};

export type ModuleConfig = {
  /** Route slug under /m (e.g. "sales" → /m/sales). */
  slug: string;
  /** Screen title. */
  title: string;
  /**
   * L2 detail route builder. Phase 3 supplies the real detail screen; for now
   * these resolve to a ComingSoon detail. Return null to make rows non-tappable.
   */
  detailPath?: (vm: RowVM, row: RawRow) => string | null;
  /** One or more data sources (see DataSource). */
  sources: DataSource[];
};

/** Active filter state for one column. */
export type ActiveFilter =
  | { type: "text"; contains: string }
  | { type: "number"; op: NumberOp; a: number | null; b: number | null }
  | { type: "date"; from: string | null; to: string | null }
  | { type: "enum"; selected: string[] };

export type NumberOp = "eq" | "gt" | "lt" | "gte" | "lte" | "between";

export const NUMBER_OP_LABEL: Record<NumberOp, string> = {
  eq: "=",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  between: "range",
};

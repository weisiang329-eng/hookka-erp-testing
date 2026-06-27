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

// ===========================================================================
// L2 DOCUMENT DETAIL (Phase 3)
//
// Every document detail screen is structurally identical (per the spec):
//   • header card: code + status pill + title + a 5-step status-flow indicator,
//   • a field grid (the doc's real columns),
//   • a line-items list (tappable → L3 in a later phase),
//   • a "Related documents" list (cross-links the payload exposes),
//   • a bottom action bar (Print · Edit · primary CTA — placeholder Sheets).
//
// A module supplies a `detail: DetailConfig` to make its rows open a real L2
// screen. The generic <DocumentDetailScreen> consumes it. Modules whose
// rows have no per-id endpoint omit `detail` (rows fall back to ComingSoon).
// ===========================================================================

/** One label/value cell in the detail field grid. */
export type FieldDef = {
  label: string;
  /** Extract the display value from the fetched doc. */
  value: (doc: RawRow) => ReactNode;
  /** Span the full row instead of half (e.g. notes / long references). */
  full?: boolean;
};

/** One row in the line-items list. */
export type LineItemVM = {
  id: string;
  /** Left primary (e.g. product name). */
  title: string;
  /** Left secondary (e.g. product code). */
  subLine?: string;
  /** Right meta columns (e.g. Qty / Amount). */
  meta1?: { label: string; value: ReactNode };
  meta2?: { label: string; value: ReactNode };
};

/** One cross-linked related document (SO↔DO↔Invoice↔Customer). */
export type RelatedDocVM = {
  id: string;
  /** Group heading (e.g. "Delivery Orders", "Invoices"). */
  group: string;
  code: string;
  subLine?: string;
  status?: { style: SemanticStyle; label: string };
  /** Destination route, or undefined if not linkable (data not in payload). */
  href?: string;
};

/** A single step in the document lifecycle flow indicator. */
export type FlowStep = { key: string; label: string };

export type DetailConfig = {
  /** Build the single-doc fetch URL from the route :id param. */
  url: (id: string) => string;
  /**
   * Pull the doc object out of the response envelope. For per-id endpoints
   * the body is `{ data: {...} }` and `id` is ignored; for list-backed detail
   * (e.g. Announcements have no GET /:id) the doc is found in the array by id.
   */
  selectDoc: (resp: unknown, id: string) => RawRow | null;
  /**
   * Optional: when one slug hosts MULTIPLE doc types (e.g. Procurement = PO /
   * GRN / PI, dispatched by id prefix), return the effective DetailConfig once
   * the doc is fetched. Only `url` + `selectDoc` run before fetch; everything
   * else (code/title/status/flow/fields/lineItems/relatedDocs/primaryCta) is
   * read from the resolved config. Return undefined to use `this` config.
   */
  resolve?: (doc: RawRow, id: string) => DetailConfig;
  /** Doc code for the header + breadcrumb (e.g. "SO-2606-0142"). */
  code: (doc: RawRow) => string;
  /** Header title (e.g. customer name). */
  title: (doc: RawRow) => string;
  /** Resolve the header status pill (style + raw label), or undefined. */
  status?: (doc: RawRow) => { style: SemanticStyle; label: string } | undefined;
  /**
   * The full ordered lifecycle (the doc-type's status enum order). The flow
   * indicator highlights up to the doc's current status. The current step is
   * derived by matching the doc's status against these keys.
   */
  flow?: {
    steps: FlowStep[];
    /** The doc's current status key (UPPER_SNAKE), matched against steps. */
    current: (doc: RawRow) => string;
  };
  /** Field grid cells (spec terminology). */
  fields: FieldDef[];
  /** Map the doc → its line-items list (empty array = no items section). */
  lineItems?: (doc: RawRow) => LineItemVM[];
  /** Map the response (doc + envelope extras) → related documents. */
  relatedDocs?: (doc: RawRow, resp: unknown) => RelatedDocVM[];
  /** Label for the bottom-bar primary CTA (e.g. "Confirm"). Defaults none. */
  primaryCta?: (doc: RawRow) => string | undefined;
};

export type ModuleConfig = {
  /** Route slug under /m (e.g. "sales" → /m/sales). */
  slug: string;
  /** Screen title. */
  title: string;
  /**
   * L2 detail route builder. Returns the route a list row navigates to, or
   * null to make rows non-tappable. When `detail` is also supplied, this route
   * resolves to <DocumentDetailScreen>; otherwise to a ComingSoon placeholder.
   */
  detailPath?: (vm: RowVM, row: RawRow) => string | null;
  /**
   * L2 detail spec. When present, /m/<slug>/:id renders the generic
   * <DocumentDetailScreen> driven by this config. When absent, /m/<slug>/:id
   * falls back to a ComingSoon detail (list types with no per-id endpoint).
   */
  detail?: DetailConfig;
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

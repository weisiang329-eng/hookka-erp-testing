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
  /** Document code, taupe + tabular-nums sans-serif (e.g. "SO-2606-0142"). */
  code: string;
  /** Primary title (e.g. customer name). */
  title: string;
  /** dc13 "items line" — what the doc is FOR (e.g. "Aspen 3-Seater ×12,
   * Hudson HB ×8" on a sales order, "Pine 2×2 ×400, MDF ×120" on a PO).
   * Takes the slot below the title; hides subLine when both are set. */
  items?: string;
  /** Optional secondary line (back-compat — modules with no items concept). */
  subLine?: string;
  /** dc13 footer metas — 2 to 4, wrap in a 3-col grid. Prefer this over
   * meta1/meta2 (which remain for back-compat with existing modules). */
  metas?: { label: string; value: ReactNode }[];
  /** @deprecated — use `metas` (a 2- to 4-array). Kept for back-compat. */
  meta1?: { label: string; value: ReactNode };
  /** @deprecated — use `metas` (a 2- to 4-array). Kept for back-compat. */
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
  /**
   * Include this source in the module's cross-source search merge (see
   * ModuleConfig.crossSourceSearch). Set on the sources that hold the SAME
   * business object across its lifecycle (delivery: the Sales-Order source +
   * the Delivery-Order source) so one query finds it in any status. Sources
   * that are unrelated entities (packing lists, 3PL providers) leave it off and
   * are searched only when their own tab is active.
   */
  crossSearch?: boolean;
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

/** A small inline chip on a line item (e.g. a customization like Leg 6"). */
export type LineItemChip = {
  text: string;
  /** Semantic tint key. Defaults to the neutral parchment tint. */
  tone?: "neutral" | "gold" | "info" | "moss" | "danger" | "warning" | "plum";
};

/** A small label/value spec row under a line item (e.g. Size / Fabric). */
export type LineItemSpec = { label: string; value: string };

/** One row in the line-items list. */
export type LineItemVM = {
  id: string;
  /** Left primary (e.g. product name). */
  title: string;
  /** Left secondary (e.g. product code). */
  subLine?: string;
  /**
   * Optional spec rows (Category / Size / Fabric) stacked under the title —
   * the variant data the desktop SO/DO/PI tables show in their own columns.
   */
  specs?: LineItemSpec[];
  /**
   * Optional customization chips (the desktop "Customization" column: Leg 6",
   * Divan 5", Gap 2", special order, free-text customs).
   */
  chips?: LineItemChip[];
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

/** One label/value row in a key-value section (e.g. Earnings / Deductions). */
export type KvRow = { label: string; value: ReactNode };

/**
 * A titled key-value section rendered below the field grid (the design source's
 * Earnings / Deductions cards on a payslip). `negative` tints the values red
 * (deductions). Empty `rows` → the section is skipped.
 */
export type KvSection = {
  title: string;
  rows: KvRow[];
  /** Render values in the danger colour (deductions). */
  negative?: boolean;
};

/**
 * A titled sub-document list rendered as a tappable card (the design source's
 * "Payslips" list under an employee, or "In this rack now" / "Recent movements"
 * under a rack). Each row optionally links to another /m route.
 */
export type SubDocRow = {
  id: string;
  /** Left primary (e.g. period, product description). */
  title: string;
  /** Left secondary (e.g. amount, SO · customer). */
  subLine?: string;
  /** Right-aligned meta (e.g. date). */
  trailing?: string;
  /** Status pill on the right. */
  status?: { style: SemanticStyle; label: string };
  /** lucide icon name for the leading tile (default "file-text"). */
  icon?: "file-text" | "package" | "arrow-down" | "arrow-up";
  /** Destination route, or undefined if not linkable. */
  href?: string;
  /** Custom click handler — overrides href. Use for inline edit/delete
   * actions (Customer Hub Edit, etc). Receives the parent doc + the row's
   * id so the handler can build the right PUT payload. */
  onClick?: () => void;
};

export type SubDocList = {
  title: string;
  rows: SubDocRow[];
  /** Shown when `rows` is empty (omit the section if undefined). */
  emptyText?: string;
};

/** A dark "stat" hero card (the design source's rack hero on warehouse detail). */
export type DarkStat = {
  /** Small uppercase eyebrow (e.g. "Rack"). */
  eyebrow: string;
  /** Large value (e.g. the rack label). */
  value: string;
  /** Optional caption line under the value. */
  caption?: ReactNode;
};

/**
 * One "Convert document" action button. `to` is a route the app navigates to
 * (absolute, e.g. "/procurement/grn/create?poId=..."). `primary` tints the
 * button taupe (the design's filled button); others render outlined.
 */
export type DetailAction = {
  label: string;
  /** Router-internal navigation target. Set ONE of `to` / `onClick` / `formSpec`. */
  to?: string;
  /** Custom onClick — overrides `to`. Use for actions that need to write
   * localStorage / fetch / await before navigating. */
  onClick?: (navigate: (to: string) => void) => void | Promise<void>;
  /** Opens a FormSheet with the returned spec when clicked. Used for
   * mobile-side mutations that don't fit a status PUT (e.g. Log Hours,
   * Set Affected Products). The form's submit handler runs the API call. */
  formSpec?: () => import("./form-types").FormSpec;
  /** lucide icon name for the leading glyph. */
  icon?: "package-check" | "receipt" | "file-text" | "copy";
  primary?: boolean;
};

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
  /**
   * Optional dark hero "stat" card rendered between the header card and the
   * field grid (the design source's rack hero on warehouse detail).
   */
  darkStat?: (doc: RawRow) => DarkStat | undefined;
  /**
   * Optional body paragraphs rendered in their own card below the field grid
   * (the design source's announcement / mail message body). Empty array → no
   * card. Newlines inside a paragraph render as line breaks (white-space:
   * pre-line).
   */
  body?: (doc: RawRow) => string[];
  /**
   * Optional titled key-value sections below the field grid (the design
   * source's Earnings / Deductions cards on a payslip).
   */
  kvSections?: (doc: RawRow) => KvSection[];
  /**
   * Optional dark "Net pay" summary card rendered after the kv sections (the
   * design source's payslip net-pay band). Returns { label, value }.
   */
  netPay?: (doc: RawRow) => { label: string; value: string } | undefined;
  /**
   * Optional titled sub-document lists (the design source's payslips list under
   * an employee, or rack contents + movements under a rack). Third arg is the
   * map of `extraFetches` results when the config declared them (e.g. an
   * employee detail joining attendance + payslips into the same screen).
   */
  subDocLists?: (
    doc: RawRow,
    resp: unknown,
    extras?: Record<string, unknown>,
    /** Open a FormSheet with the given spec — used by row.onClick for
     * inline edit flows (e.g. Customer Hub row → Edit Hub form). */
    openForm?: (spec: import("./form-types").FormSpec) => void,
  ) => SubDocList[];
  /**
   * Optional extra single-shot fetches the screen fires alongside the main
   * `url`. Two named slots maximum (so the screen's hook count stays fixed —
   * rules-of-hooks). Each is a `(id) => url | null` — return null to skip.
   * Results land in subDocLists' `extras` arg keyed by slot name.
   * Example (employee detail, dc12): `{ attendance: id => '/api/attendance?employeeId=' + id + '&from=...&to=...', payslips: id => '/api/payslips?employeeId=' + id }`.
   */
  extraFetches?: {
    a?: { key: string; url: (id: string) => string | null };
    b?: { key: string; url: (id: string) => string | null };
    c?: { key: string; url: (id: string) => string | null };
  };
  /** Optional audit-history resource. When set, DocumentDetailScreen fetches
   * /api/audit-events?resource=<resource>&resourceId=<id> + renders a
   * "History · N" sub-doc list. dc13 CHANGELOG B.7 "History audit" gap. */
  auditResource?: (id: string) => string;
  /**
   * Optional file-attachments resource for this doc. When set, the detail
   * screen fires GET /api/files?resourceType=<type>&resourceId=<id> + renders
   * a "Files" section with an upload button (POST /api/files multipart). Same
   * scheme the desktop products catalog + procurement attachments use.
   * Backend gates the actual upload behind Supabase storage config; the
   * mobile UI gracefully shows an empty state if /api/files returns 503.
   */
  attachmentsResource?: (id: string) => { type: string; id: string };
  /** Per-line attachments (dc13 v13 sync, owner 2026-06-29) — when set, the
   * LineItemDetailScreen renders a Files section keyed by (parentId, lineId).
   * Reuses the same /api/files mechanism (no schema change — line attachments
   * are stored as resourceType="SO_LINE" / "DO_LINE" / etc., resourceId=lineId).
   * Each line then carries its own paperclip. */
  lineAttachmentsResource?: (
    parentId: string,
    lineId: string,
  ) => { type: string; id: string };
  /**
   * Optional "Convert document" action row (owner 2026-06-28 design v10) —
   * rendered as a titled pair of buttons below the field grid. Each action
   * navigates to a route (typically a desktop convert flow deep-linked with the
   * doc id, e.g. PO → GRN / PO → Purchase Invoice). Empty array → no section.
   */
  extraActions?: (doc: RawRow, id: string) => DetailAction[];
  /** Map the doc → its line-items list (empty array = no items section). */
  lineItems?: (doc: RawRow) => LineItemVM[];
  /** Map the response (doc + envelope extras) → related documents. */
  relatedDocs?: (doc: RawRow, resp: unknown) => RelatedDocVM[];
  /** Label for the bottom-bar primary CTA (e.g. "Confirm"). Defaults none. */
  primaryCta?: (doc: RawRow) => string | undefined;
  /**
   * Optional override for the bottom action bar. By default the bar shows
   * Print · Edit · CTA. Set `hideActionBar` for read-only detail screens
   * (payslip / rack) that the design shows with no action bar.
   */
  hideActionBar?: boolean;
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
  /**
   * Optional panel rendered ABOVE the list on specific sub-tabs (design source:
   * the Employees "Pending requests" approve/reject card on the Attendance
   * tab). Receives the active tab key; return null to render nothing. Keeps the
   * generic list engine while letting one module inject a bespoke section.
   */
  topPanel?: (activeTab: string) => ReactNode;
  /**
   * When true, a search query scans EVERY source of the module (not just the
   * active tab's source) and merges the matches into one result list, each card
   * rendered through its own source's view-model. Delivery uses this so one
   * search finds an order whether it's still a Sales Order (Planning / Pending
   * Delivery) or already a Delivery Order (Pending Dispatch / Dispatched /
   * Delivered) — owner 2026-07-11. Off by default: single-source modules and
   * modules whose sources are unrelated entities keep the active-source search.
   */
  crossSourceSearch?: boolean;
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

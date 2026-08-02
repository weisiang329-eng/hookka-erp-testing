// ---------------------------------------------------------------------------
// search-sources — the catalogue behind GET /api/search.
//
// The Ctrl+K palette used to fan out SIX separate HTTP calls from the browser
// (sales orders, customers, products, delivery orders, invoices, consignment
// notes) on every keystroke, and covered only those six things. Everything
// else in the ERP — purchase orders, GRNs, purchase invoices, suppliers,
// production orders, job cards, service orders, service cases, employees,
// leads, journal entries — was simply not findable from search.
//
// This file is the single list of what is searchable and how. Keeping it as
// DATA rather than code means adding a module to global search is one entry,
// and the endpoint, the permission gate and the tests all pick it up.
//
// Pure and dependency-free so the SQL it produces can be unit-tested without a
// database — the parts that go wrong here (an identifier reaching SQL from
// user input, a missing org filter leaking another company's rows) are exactly
// the parts worth pinning.
// ---------------------------------------------------------------------------

export type SearchSource = {
  /** Stable discriminator returned to the client. */
  kind: string;
  /** Human label for the result group. */
  groupLabel: string;
  table: string;
  /** Column holding the row id used to build the link. */
  idCol: string;
  /** Column shown as the result's title. */
  labelCol: string;
  /** Columns shown under the title, in order. Missing ones render blank. */
  subCols: string[];
  /** Columns matched against the search term. */
  searchCols: string[];
  /** Column used to scope to the caller's org, when the table has one. */
  orgCol: string | null;
  /** RBAC resource this source belongs to; the caller must have `read`. */
  resource: string;
  /** Path prefix; the row id is appended. */
  hrefPrefix: string;
};

// Ordered by how often people look for the thing. The endpoint returns groups
// in this order, so the list itself is the ranking.
export const SEARCH_SOURCES: SearchSource[] = [
  {
    kind: "sales_order", groupLabel: "Sales Orders", table: "sales_orders",
    idCol: "id", labelCol: "company_so_id",
    subCols: ["customer_name", "customer_po_id", "status"],
    searchCols: ["company_so_id", "customer_so_id", "customer_po_id", "customer_name", "reference"],
    orgCol: "org_id", resource: "sales_orders", hrefPrefix: "/sales/",
  },
  {
    kind: "customer", groupLabel: "Customers", table: "customers",
    idCol: "id", labelCol: "name",
    subCols: ["code", "phone", "email"],
    searchCols: ["name", "code", "phone", "email"],
    orgCol: "org_id", resource: "customers", hrefPrefix: "/customers?id=",
  },
  {
    kind: "product", groupLabel: "Products", table: "products",
    idCol: "id", labelCol: "code",
    subCols: ["name", "category"],
    searchCols: ["code", "name"],
    orgCol: "org_id", resource: "products", hrefPrefix: "/products?id=",
  },
  {
    kind: "delivery_order", groupLabel: "Delivery Orders", table: "delivery_orders",
    idCol: "id", labelCol: "do_no",
    subCols: ["customer_name", "status"],
    searchCols: ["do_no", "customer_name"],
    orgCol: "org_id", resource: "delivery_orders", hrefPrefix: "/delivery/",
  },
  {
    kind: "invoice", groupLabel: "Invoices", table: "invoices",
    idCol: "id", labelCol: "invoice_no",
    subCols: ["customer_name", "status"],
    searchCols: ["invoice_no", "customer_name"],
    orgCol: "org_id", resource: "invoices", hrefPrefix: "/invoices/",
  },
  // ── everything below was NOT searchable before ──
  {
    kind: "purchase_order", groupLabel: "Purchase Orders", table: "purchase_orders",
    idCol: "id", labelCol: "po_no",
    subCols: ["supplier_name", "status"],
    searchCols: ["po_no", "supplier_name"],
    orgCol: "org_id", resource: "procurement", hrefPrefix: "/procurement/",
  },
  {
    kind: "purchase_invoice", groupLabel: "Purchase Invoices", table: "purchase_invoices",
    idCol: "id", labelCol: "pi_no",
    subCols: ["supplier_name", "supplier_invoice_no", "status"],
    searchCols: ["pi_no", "supplier_name", "supplier_invoice_no"],
    orgCol: "org_id", resource: "procurement", hrefPrefix: "/procurement/pi/",
  },
  {
    // The column is grn_number (folds from grnNumber), NOT grn_no — confirmed
    // against grn.ts and reported by /api/search's sourcesSkipped.
    kind: "grn", groupLabel: "Goods Receipts", table: "grns",
    idCol: "id", labelCol: "grn_number",
    subCols: ["supplier_name", "status"],
    searchCols: ["grn_number", "supplier_name"],
    orgCol: "org_id", resource: "procurement", hrefPrefix: "/procurement/grn/",
  },
  {
    kind: "supplier", groupLabel: "Suppliers", table: "suppliers",
    idCol: "id", labelCol: "name",
    subCols: ["code", "phone"],
    searchCols: ["name", "code", "phone"],
    orgCol: "org_id", resource: "procurement", hrefPrefix: "/suppliers/",
  },
  {
    kind: "production_order", groupLabel: "Production Orders", table: "production_orders",
    idCol: "id", labelCol: "po_no",
    subCols: ["product_code", "current_department", "status"],
    searchCols: ["po_no", "product_code"],
    orgCol: "org_id", resource: "production", hrefPrefix: "/production/",
  },
  {
    kind: "service_order", groupLabel: "Service Orders", table: "sales_orders",
    idCol: "id", labelCol: "company_so_id",
    subCols: ["customer_name", "status"],
    searchCols: ["company_so_id", "customer_name"],
    orgCol: "org_id", resource: "service_orders", hrefPrefix: "/service-order/",
  },
  {
    kind: "service_case", groupLabel: "Service Cases", table: "service_cases",
    idCol: "id", labelCol: "case_no",
    subCols: ["customer_name", "status"],
    searchCols: ["case_no", "customer_name"],
    orgCol: "org_id", resource: "service_cases", hrefPrefix: "/service-cases/",
  },
  {
    // The table is `workers`, not `employees` (the UI label is Employees but
    // the storage kept the original name — see workers.ts). emp_no folds from
    // empNo. orgCol is declared but degrades to no filter if the column is
    // absent (buildSourceSql guards on availableCols).
    kind: "employee", groupLabel: "Employees", table: "workers",
    idCol: "id", labelCol: "name",
    subCols: ["emp_no", "department_code", "position"],
    searchCols: ["name", "emp_no"],
    orgCol: "org_id", resource: "employees", hrefPrefix: "/employees?id=",
  },
  {
    // The table is `sales_leads` (sales-leads.ts), and its RBAC resource is
    // `customers` — the same gate the leads route itself uses.
    kind: "lead", groupLabel: "Sales Pipeline", table: "sales_leads",
    idCol: "id", labelCol: "name",
    subCols: ["company", "stage"],
    searchCols: ["name", "company", "phone", "email"],
    orgCol: "org_id", resource: "customers", hrefPrefix: "/leads?id=",
  },
  {
    kind: "journal_entry", groupLabel: "Journal Entries", table: "journal_entries",
    idCol: "id", labelCol: "entry_no",
    subCols: ["description", "status"],
    searchCols: ["entry_no", "description"],
    orgCol: "org_id", resource: "accounting", hrefPrefix: "/accounting?tab=journals&id=",
  },
];

/** A source is usable only when its table and every column it names exist. */
export function isSourceUsable(
  source: SearchSource,
  columnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const cols = columnsByTable.get(source.table);
  if (!cols) return false;
  const needed = [source.idCol, source.labelCol, ...source.searchCols];
  return needed.every((c) => cols.has(c));
}

/**
 * The SELECT for one source.
 *
 * Every identifier comes from SEARCH_SOURCES — a hard-coded module constant —
 * and is additionally filtered against the live column list before it gets
 * here, so no caller-supplied string is ever interpolated. Only the search
 * term and the org id are bound, and they are bound as PARAMETERS.
 *
 * Columns listed in `subCols` that the table does not actually have are
 * dropped rather than failing the query, so a source stays searchable when a
 * cosmetic column is missing.
 */
export function buildSourceSql(
  source: SearchSource,
  availableCols: ReadonlySet<string>,
  limit: number,
): { sql: string; bindCount: number } {
  const subs = source.subCols.filter((c) => availableCols.has(c));
  const subSelect = [0, 1, 2]
    .map((i) => (subs[i] ? `${subs[i]}` : `NULL`) + ` AS sub${i + 1}`)
    .join(", ");
  const where = source.searchCols.map((c) => `COALESCE(${c}::text,'') ILIKE ?`).join(" OR ");
  const orgClause = source.orgCol && availableCols.has(source.orgCol)
    ? ` AND (${source.orgCol} = ? OR ${source.orgCol} IS NULL)`
    : "";
  const sql =
    `SELECT ${source.idCol} AS rid, ${source.labelCol}::text AS label, ${subSelect}` +
    ` FROM ${source.table}` +
    ` WHERE (${where})${orgClause}` +
    ` LIMIT ${Math.max(1, Math.min(50, Math.floor(limit)))}`;
  return { sql, bindCount: source.searchCols.length + (orgClause ? 1 : 0) };
}

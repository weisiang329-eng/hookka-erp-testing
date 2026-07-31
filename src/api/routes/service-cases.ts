// ---------------------------------------------------------------------------
// Service Cases — parent of Service Orders.
//
// Per design 2026-04-28: every customer-facing service interaction lives
// in service_cases. A case may spawn 0..N service_orders (one per
// resolution attempt — REPRODUCE / STOCK_SWAP / REPAIR). Cases that don't
// need rework (missing parts shipout, on-site fix, refund record) are
// case-only with no orders.
//
// Endpoints (mounted under /api/service-cases):
//   GET    /                       — list
//   GET    /:id                    — case detail with nested orders
//   POST   /                       — create a case
//   PUT    /:id                    — edit metadata (issue, photos, RCA)
//   PUT    /:id/status             — advance status (OPEN/IN_PROGRESS/CLOSED/CANCELLED)
//   DELETE /:id                    — cancel a case (only when status='OPEN')
//
// The existing /api/service-orders endpoints continue to handle resolution
// flows (mode picking, lines, returns). Service Order POST now requires a
// caseId in the body.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type SourceType = "SO" | "CO" | "EXTERNAL";
type CaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
type RootCauseCategory =
  | "PRODUCTION" | "DESIGN" | "MATERIAL" | "PROCESS"
  | "CUSTOMER" | "TRANSPORT" | "SALES" | "PICKING" | "OTHER";
type PreventionStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "NOT_NEEDED";

const VALID_SOURCE_TYPES: SourceType[] = ["SO", "CO", "EXTERNAL"];
const VALID_STATUSES: CaseStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED", "CANCELLED"];
const VALID_ROOT_CAUSE: RootCauseCategory[] = [
  "PRODUCTION", "DESIGN", "MATERIAL", "PROCESS",
  "CUSTOMER", "TRANSPORT", "SALES", "PICKING", "OTHER",
];
const VALID_PREVENTION_STATUS: PreventionStatus[] = [
  "PENDING", "IN_PROGRESS", "DONE", "NOT_NEEDED",
];

// Responsible Unit — which business unit caused the issue (owner-level
// attribution, set from the case detail's Root Cause & Prevention card).
// Stored on the runtime-added lowercase column service_cases.responsibleunit
// (migration 0166). PUT accepts exactly these values or empty/null → NULL;
// anything else is a 400. The frontend select mirrors the same 5 values.
type ResponsibleUnit = "PRODUCTION" | "QC" | "R_AND_D" | "OFFICE" | "TRANSPORT";
const VALID_RESPONSIBLE_UNITS: ResponsibleUnit[] = [
  "PRODUCTION", "QC", "R_AND_D", "OFFICE", "TRANSPORT",
];

// Adjacency for case status. Cases close on a separate timeline from any
// attached service_orders — operator can close a case while orders are
// still in flight (rare but allowed; reports treat that as the operator's
// signal that the customer is satisfied).
const STATUS_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  OPEN: ["IN_PROGRESS", "CLOSED", "CANCELLED"],
  IN_PROGRESS: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

type ServiceCaseRow = {
  id: string;
  caseNo: string;
  sourceType: SourceType;
  sourceId: string | null;
  sourceNo: string | null;
  customerId: string | null;
  customerName: string;
  customerState: string | null;
  issueDescription: string | null;
  issuePhotos: string | null;
  actionLog: string | null;
  rootCauseCategory: RootCauseCategory | null;
  rootCauseNotes: string | null;
  rootCauseDetails: string | null;
  // responsibleunit is a runtime-added lowercase column (migration 0166) —
  // read dual-key like sales_orders.caseid below.
  responsibleUnit?: ResponsibleUnit | null;
  responsibleunit?: ResponsibleUnit | null;
  // investigatingat is a runtime-added lowercase column (migration 0168) —
  // read dual-key. ISO timestamp the case first hit IN_PROGRESS.
  investigatingAt?: string | null;
  investigatingat?: string | null;
  // rootcauses is a runtime-added lowercase column (migration 0169) — read
  // dual-key. JSON array [{category, details}, ...] of the case's root causes.
  rootCauses?: string | null;
  rootcauses?: string | null;
  affectedProductIds: string | null;
  preventionAction: string | null;
  preventionStatus: PreventionStatus | null;
  preventionOwner: string | null;
  status: CaseStatus;
  externalRef: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  closedAt: string | null;
  notes: string | null;
};

type ServiceOrderRow = {
  id: string;
  serviceOrderNo: string;
  caseId: string;
  sourceType: SourceType;
  sourceId: string | null;
  sourceNo: string | null;
  customerId: string;
  customerName: string;
  mode: "REPRODUCE" | "STOCK_SWAP" | "REPAIR" | null;
  status: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  closedAt: string | null;
  notes: string | null;
};

function genCaseId(): string {
  return `svccase-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// affectedProducts sanitizer (POST + PUT). Entries pass through verbatim
// ({productId, code, name, qty?} — unchanged behaviour), but the optional
// `components` layer (damaged-part picks from GET /api/sales-orders/
// repair-components, 2026-06-12) is sanitized: keep only well-formed
// {key, label, qty>=1} picks, cap label length + list size so a bad client
// can't bloat the JSON column. A malformed / empty components field is
// dropped entirely (absent = all parts, same as before the feature).
// ---------------------------------------------------------------------------
function sanitizeAffectedProductsJson(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    if (!("components" in entry)) return entry;
    const { components, ...rest } = entry as Record<string, unknown>;
    if (!Array.isArray(components)) return rest;
    const cleaned = components
      .map((p) => {
        if (!p || typeof p !== "object" || Array.isArray(p)) return null;
        const key = (p as { key?: unknown }).key;
        const label = (p as { label?: unknown }).label;
        const qty = Math.floor(Number((p as { qty?: unknown }).qty));
        if (typeof key !== "string" || !key.trim()) return null;
        if (typeof label !== "string") return null;
        if (!Number.isFinite(qty) || qty < 1) return null;
        return { key: key.trim(), label: label.trim().slice(0, 120), qty };
      })
      .filter((p): p is { key: string; label: string; qty: number } => p !== null)
      .slice(0, 40);
    return cleaned.length > 0 ? { ...rest, components: cleaned } : rest;
  });
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// rootCauses sanitizer (PUT). A case can have several root causes (owner
// 2026-06-12) — the body sends an array of {category, details}. We keep only
// entries whose category is a real VALID_ROOT_CAUSE, coerce details to a plain
// object (anything else → {}), and cap the array length so a bad client can't
// bloat the JSON column. Returns a normalised array (NOT a string) so callers
// can both mirror entries[0] to the legacy columns and serialise once.
//
// Exported for tests (tests/service-cases-rootcauses.test.mjs) — same as the
// pure helpers in src/lib/repair-scope.ts.
// ---------------------------------------------------------------------------
const ROOT_CAUSES_MAX = 12;
export function sanitizeRootCauses(
  raw: unknown,
): Array<{ category: RootCauseCategory; details: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ category: RootCauseCategory; details: Record<string, unknown> }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const category = (entry as { category?: unknown }).category;
    if (typeof category !== "string") continue;
    if (!VALID_ROOT_CAUSE.includes(category as RootCauseCategory)) continue;
    const rawDetails = (entry as { details?: unknown }).details;
    const details =
      rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)
        ? (rawDetails as Record<string, unknown>)
        : {};
    out.push({ category: category as RootCauseCategory, details });
    if (out.length >= ROOT_CAUSES_MAX) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// rootCauses GET reader. Parses the stored JSON array; if it's empty/missing
// but the legacy single root_cause_category is set, synthesizes a one-element
// array [{category, details}] so old single-category cases render as one block
// on the redesigned (multi) detail panel. Each entry is re-sanitized so a
// hand-edited / legacy-malformed column can't surface a junk category.
//
// Exported for tests.
// ---------------------------------------------------------------------------
export function synthesizeRootCauses(
  rawRootCauses: string | null | undefined,
  legacyCategory: RootCauseCategory | null | undefined,
  legacyDetails: Record<string, unknown>,
): Array<{ category: RootCauseCategory; details: Record<string, unknown> }> {
  if (rawRootCauses) {
    try {
      const parsed = JSON.parse(rawRootCauses);
      const cleaned = sanitizeRootCauses(parsed);
      if (cleaned.length > 0) return cleaned;
    } catch {
      // tolerate malformed JSON — fall through to legacy synthesis
    }
  }
  if (legacyCategory && VALID_ROOT_CAUSE.includes(legacyCategory)) {
    return [{ category: legacyCategory, details: legacyDetails }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// SV Service Orders (sales_orders rows with is_service_order=TRUE) created
// from /service-order/create?fromCase=… carry the parent case id in the
// runtime-added lowercase column sales_orders.caseid (migration 0165). The
// case's "Service Orders" panel merges them with the legacy service_orders
// rows so production-backed SV orders show up on the case either way.
//
// service_cases.responsibleunit (migration 0166) piggybacks on the same
// ensure — which business unit caused the issue, written by PUT /:id.
// ---------------------------------------------------------------------------
let caseLinkColumns: Promise<void> | null = null;
function ensureCaseLinkColumns(db: D1Database): Promise<void> {
  if (caseLinkColumns) return caseLinkColumns;
  caseLinkColumns = (async () => {
    try {
      await db
        .prepare("ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS caseid TEXT")
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
    try {
      await db
        .prepare("ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS responsibleunit TEXT")
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
    try {
      // investigatingat (migration 0168) — set the first time the case is
      // marked IN_PROGRESS, so the Case Pipeline can date the Investigating
      // stage (the only stage without another native timestamp).
      await db
        .prepare("ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS investigatingat TEXT")
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
    try {
      // rootcauses (migration 0169) — JSON array of the case's root causes; a
      // case can have several (owner 2026-06-12). The FIRST entry is mirrored
      // into the legacy root_cause_category / root_cause_details columns so
      // the list "Category" column + any legacy reader keep working.
      await db
        .prepare("ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS rootcauses TEXT")
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
  })();
  return caseLinkColumns;
}

type SvOrderRow = {
  id: string;
  companySOId: string | null;
  status: string;
  // caseid is a runtime-added lowercase column — read dual-key.
  caseId?: string | null;
  caseid?: string | null;
  createdAt: string | null;
};

async function loadSvOrdersForCases(
  db: D1Database,
  caseId?: string,
): Promise<SvOrderRow[]> {
  await ensureCaseLinkColumns(db);
  try {
    const sql = `SELECT id, companySOId AS "companySOId", status, caseid, created_at AS "createdAt" FROM sales_orders WHERE ${
      caseId ? "caseid = ?" : "caseid IS NOT NULL"
    }`;
    const stmt = db.prepare(sql);
    const res = caseId
      ? await stmt.bind(caseId).all<SvOrderRow>()
      : await stmt.all<SvOrderRow>();
    return res.results ?? [];
  } catch {
    // Column missing (ALTER rejected) — degrade to "no SV orders" rather
    // than failing the whole case read.
    return [];
  }
}

// Product ids already covered by a NON-cancelled service order on this case, so
// re-spawning a 2nd service order can pre-fill ONLY the newly-affected products
// (#10). Reuses the already-loaded SV order rows; best-effort (empty on error).
async function loadCoveredProductIdsForCase(
  db: D1Database,
  svOrders: SvOrderRow[],
): Promise<string[]> {
  const activeIds = svOrders
    .filter((o) => (o.status || "").toUpperCase() !== "CANCELLED")
    .map((o) => o.id)
    .filter(Boolean);
  if (activeIds.length === 0) return [];
  try {
    const ph = activeIds.map(() => "?").join(",");
    const res = await db
      .prepare(`SELECT * FROM sales_order_items WHERE salesOrderId IN (${ph})`)
      .bind(...activeIds)
      .all<{ productId?: string | null }>();
    const out: string[] = [];
    for (const r of res.results ?? []) {
      const p = (r.productId || "").trim();
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

async function nextCaseNo(db: D1Database, now: Date): Promise<string> {
  // 2026-04-29 operator request: rename Case # prefix from "CASE-YYMM-NNN" to
  // the more compact "SC-YYMM-NNN" so it's the same length as Sales Order #s
  // (SO-YYMM-NNN). Existing CASE-YYMM-NNN rows stay as-is; we count BOTH
  // prefixes for the current month so the sequence keeps incrementing
  // monotonically across the rename without colliding visually.
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `SC-${yy}${mm}`;
  const legacyPrefix = `CASE-${yy}${mm}`;
  const res = await db
    .prepare(
      "SELECT COUNT(*) as n FROM service_cases WHERE caseNo LIKE ? OR caseNo LIKE ?",
    )
    .bind(`${prefix}-%`, `${legacyPrefix}-%`)
    .first<{ n: number }>();
  const seq = (res?.n ?? 0) + 1;
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

function rowToApi(
  row: ServiceCaseRow,
  orders: ServiceOrderRow[] = [],
  svOrders: SvOrderRow[] = [],
  // issue_photos is a JSON array of base64 data URIs — 500 cases of these is
  // ~13 MB on the LIST endpoint (perf audit 2026-07-31), and the list never
  // renders full photos (only the detail page does). omitPhotos drops them from
  // the list payload (a photoCount is still surfaced so the UI can show "N
  // photos" if it wants). The detail endpoint calls rowToApi WITHOUT this, so
  // the full photos still load when a case is opened.
  opts: { omitPhotos?: boolean } = {},
) {
  let photos: string[] = [];
  if (!opts.omitPhotos && row.issuePhotos) {
    try {
      const parsed = JSON.parse(row.issuePhotos);
      if (Array.isArray(parsed)) photos = parsed.map(String);
    } catch {
      // tolerate malformed JSON; surface the case anyway
    }
  }
  // action log: array of { id, date, description, createdAt, createdByName? }
  let actionLog: Array<Record<string, unknown>> = [];
  if (row.actionLog) {
    try {
      const parsed = JSON.parse(row.actionLog);
      if (Array.isArray(parsed)) actionLog = parsed as Array<Record<string, unknown>>;
    } catch {
      /* tolerate */
    }
  }
  // root cause details: category-specific structured fields. See migration
  // 0076 header for the per-category shape.
  let rootCauseDetails: Record<string, unknown> = {};
  if (row.rootCauseDetails) {
    try {
      const parsed = JSON.parse(row.rootCauseDetails);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rootCauseDetails = parsed as Record<string, unknown>;
      }
    } catch {
      /* tolerate */
    }
  }
  // affected products: array of {productId, code, name, qty?}. Optional —
  // case can have 0..N products. Migration 0077.
  let affectedProducts: Array<Record<string, unknown>> = [];
  if (row.affectedProductIds) {
    try {
      const parsed = JSON.parse(row.affectedProductIds);
      if (Array.isArray(parsed)) affectedProducts = parsed as Array<Record<string, unknown>>;
    } catch {
      /* tolerate */
    }
  }
  // root causes (migration 0169): array [{category, details}, ...]. Dual-key
  // read of the runtime-added lowercase column. Falls back to a one-element
  // array synthesized from the legacy single category/details so old
  // single-category cases render as one block on the multi detail panel.
  const rootCauses = synthesizeRootCauses(
    row.rootCauses ?? row.rootcauses,
    row.rootCauseCategory,
    rootCauseDetails,
  );
  return {
    id: row.id,
    caseNo: row.caseNo,
    sourceType: row.sourceType,
    sourceId: row.sourceId ?? "",
    sourceNo: row.sourceNo ?? "",
    customerId: row.customerId ?? "",
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    issueDescription: row.issueDescription ?? "",
    issuePhotos: photos,
    actionLog,
    rootCauseDetails,
    // Multi root causes (migration 0169). Always present (synthesized from the
    // legacy single column for old cases) so the detail panel can render
    // uniformly. The legacy rootCauseCategory / rootCauseDetails fields below
    // stay for the list "Category" column + any legacy reader.
    rootCauses,
    affectedProducts,
    rootCauseCategory: row.rootCauseCategory,
    // Dual-key read — the column is runtime-added lowercase (migration 0166).
    responsibleUnit: row.responsibleUnit ?? row.responsibleunit ?? null,
    rootCauseNotes: row.rootCauseNotes ?? "",
    preventionAction: row.preventionAction ?? "",
    preventionStatus: row.preventionStatus ?? "PENDING",
    preventionOwner: row.preventionOwner ?? "",
    status: row.status,
    externalRef: row.externalRef ?? "",
    createdBy: row.createdBy ?? "",
    createdByName: row.createdByName ?? "",
    createdAt: row.createdAt ?? "",
    closedAt: row.closedAt ?? "",
    // Dual-key read — runtime-added lowercase column (migration 0168). Drives
    // the Case Pipeline's Investigating-stage date + per-stage durations.
    investigatingAt: row.investigatingAt ?? row.investigatingat ?? null,
    notes: row.notes ?? "",
    orders: [
      ...orders
        .filter((o) => o.caseId === row.id)
        .map((o) => ({
          id: o.id,
          serviceOrderNo: o.serviceOrderNo,
          mode: o.mode as string | null,
          status: o.status,
          createdAt: o.createdAt ?? "",
          isSv: false,
        })),
      // SV Service Orders (sales_orders rows) linked via caseid. isSv steers
      // the case page's link to /service-order/:id instead of /service-orders.
      ...svOrders
        .filter((o) => (o.caseId ?? o.caseid) === row.id)
        .map((o) => ({
          id: o.id,
          serviceOrderNo: o.companySOId ?? o.id,
          mode: null as string | null,
          status: o.status,
          createdAt: o.createdAt ?? "",
          isSv: true,
        })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
  };
}

// ---------------------------------------------------------------------------
// GET /api/service-cases
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const status = c.req.query("status");
  const customerId = c.req.query("customerId");
  const sourceType = c.req.query("sourceType");

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (customerId) {
    clauses.push("customerId = ?");
    params.push(customerId);
  }
  if (sourceType) {
    clauses.push("sourceType = ?");
    params.push(sourceType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const [caseRes, orderRes, svOrders] = await Promise.all([
    c.var.DB.prepare(`SELECT * FROM service_cases ${where} ORDER BY created_at DESC LIMIT 500`)
      .bind(...params)
      .all<ServiceCaseRow>(),
    c.var.DB.prepare("SELECT id, serviceOrderNo, caseId, sourceType, sourceId, sourceNo, customerId, customerName, mode, status, createdBy, createdByName, created_at as createdAt, closedAt, notes FROM service_orders").all<ServiceOrderRow>(),
    loadSvOrdersForCases(c.var.DB),
  ]);
  const data = (caseRes.results ?? []).map((r) =>
    // omitPhotos: the list never renders full photos (only the detail page
    // does), and 500 cases of base64 issue_photos was ~13 MB (perf 2026-07-31).
    rowToApi(r, orderRes.results ?? [], svOrders, { omitPhotos: true }),
  );
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/service-cases/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [caseRow, orders, svOrders] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM service_cases WHERE id = ?")
      .bind(id)
      .first<ServiceCaseRow>(),
    c.var.DB
      .prepare(
        "SELECT id, serviceOrderNo, caseId, sourceType, sourceId, sourceNo, customerId, customerName, mode, status, createdBy, createdByName, created_at as createdAt, closedAt, notes FROM service_orders WHERE caseId = ? ORDER BY created_at",
      )
      .bind(id)
      .all<ServiceOrderRow>(),
    loadSvOrdersForCases(c.var.DB, id),
  ]);
  if (!caseRow) {
    return c.json({ success: false, error: "Service case not found" }, 404);
  }
  const coveredProductIds = await loadCoveredProductIdsForCase(c.var.DB, svOrders);
  return c.json({
    success: true,
    data: {
      ...rowToApi(caseRow, orders.results ?? [], svOrders),
      // product ids already on a non-cancelled service order (#10) — the
      // re-spawn flow pre-fills only the affected products NOT in this list.
      coveredProductIds,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/service-cases
//
// Body: {
//   sourceType: 'SO' | 'CO' | 'EXTERNAL',
//   sourceId?: string,                    // required for SO/CO
//   customerName?: string,                // required for EXTERNAL
//   customerId?: string,
//   externalRef?: string,
//   issueDescription?: string,
//   issuePhotos?: string[],               // base64 data URIs
//   rootCauseCategory?: RootCauseCategory,
//   rootCauseNotes?: string,
//   preventionAction?: string,
//   preventionOwner?: string,
//   notes?: string,
// }
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "service-orders", "create");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const sourceType = body.sourceType as SourceType;
    if (!VALID_SOURCE_TYPES.includes(sourceType)) {
      return c.json(
        { success: false, error: "sourceType must be SO, CO, or EXTERNAL" },
        400,
      );
    }

    let sourceId: string | null = (body.sourceId as string) || null;
    let sourceNo: string | null = null;
    let customerId: string | null = (body.customerId as string) || null;
    let customerName = String(body.customerName ?? "").trim();
    let customerState: string | null = null;

    if (sourceType === "EXTERNAL") {
      if (!customerName) {
        return c.json(
          { success: false, error: "customerName is required for EXTERNAL source" },
          400,
        );
      }
      sourceId = null;
    } else {
      if (!sourceId) {
        return c.json({ success: false, error: "sourceId is required for SO/CO" }, 400);
      }
      // Validate the source order exists. We DON'T require shipped status
      // here — a Case can be opened against an in-flight order (e.g., the
      // customer changed their mind mid-production). Service ORDER POST
      // still validates shipped because rework only makes sense after ship.
      type SrcRow = { customerId: string | null; customerName: string | null; customerState: string | null; companyOrderId: string | null };
      const tableId = sourceType === "SO" ? "sales_orders" : "consignment_orders";
      const noCol = sourceType === "SO" ? "companySOId" : "companyCOId";
      // Quote the camelCase alias — unquoted identifiers fold to lowercase
      // on Postgres, which made row.companyOrderId resolve to undefined and
      // triggered UNDEFINED_VALUE on the INSERT bind below.
      const row = await c.var.DB
        .prepare(
          `SELECT customerId, customerName, customerState, ${noCol} AS "companyOrderId" FROM ${tableId} WHERE id = ?`,
        )
        .bind(sourceId)
        .first<SrcRow>();
      if (!row) {
        return c.json(
          { success: false, error: `${sourceType} ${sourceId} not found` },
          404,
        );
      }
      customerId = row.customerId ?? customerId;
      customerName = row.customerName ?? customerName;
      customerState = row.customerState ?? null;
      // Defensive ?? null so any future case where the column-rename layer
      // returns undefined doesn't re-trip the same UNDEFINED_VALUE bug.
      sourceNo = row.companyOrderId ?? null;
    }

    if (!customerName) {
      return c.json({ success: false, error: "customerName is required" }, 400);
    }

    const rcCategory = body.rootCauseCategory as RootCauseCategory | null | undefined;
    if (rcCategory && !VALID_ROOT_CAUSE.includes(rcCategory)) {
      return c.json({ success: false, error: "rootCauseCategory invalid" }, 400);
    }
    const pStatus =
      (body.preventionStatus as PreventionStatus | undefined) ?? "PENDING";
    if (!VALID_PREVENTION_STATUS.includes(pStatus)) {
      return c.json({ success: false, error: "preventionStatus invalid" }, 400);
    }

    const id = genCaseId();
    const now = new Date();
    const nowIso = now.toISOString();
    const caseNo = await nextCaseNo(c.var.DB, now);

    const photosJson = Array.isArray(body.issuePhotos)
      ? JSON.stringify((body.issuePhotos as unknown[]).map(String))
      : null;

    // Affected products on the case (migration 0077). Stored as JSON array
    // of {productId, code, name, qty?, components?} — optional, can be 0..N.
    // components (damaged-part picks) are sanitized; the rest passes through.
    const affectedProductsJson = sanitizeAffectedProductsJson(body.affectedProducts);

    await c.var.DB
      .prepare(
        `INSERT INTO service_cases (
           id, caseNo, sourceType, sourceId, sourceNo,
           customerId, customerName, customerState,
           issueDescription, issuePhotos, affectedProductIds,
           rootCauseCategory, rootCauseNotes,
           preventionAction, preventionStatus, preventionOwner,
           status, externalRef, createdBy, createdByName, created_at, closedAt, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        id,
        caseNo,
        sourceType,
        sourceId,
        sourceNo,
        customerId,
        customerName,
        customerState,
        (body.issueDescription as string) ?? null,
        photosJson,
        affectedProductsJson,
        rcCategory ?? null,
        (body.rootCauseNotes as string) ?? null,
        (body.preventionAction as string) ?? null,
        pStatus,
        (body.preventionOwner as string) ?? null,
        (body.externalRef as string) ?? null,
        (body.createdBy as string) ?? null,
        (body.createdByName as string) ?? null,
        nowIso,
        (body.notes as string) ?? null,
      )
      .run();

    const created = await c.var.DB
      .prepare("SELECT * FROM service_cases WHERE id = ?")
      .bind(id)
      .first<ServiceCaseRow>();
    if (!created) {
      return c.json({ success: false, error: "Failed to reload after insert" }, 500);
    }
    return c.json({ success: true, data: rowToApi(created, []) }, 201);
  } catch (err) {
    console.error("[POST /api/service-cases] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/service-cases/:id — edit metadata (issue, photos, RCA, notes)
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "service-orders", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    // responsibleunit is runtime-added (migration 0166) — make sure the
    // column exists before the UPDATE below references it.
    await ensureCaseLinkColumns(c.var.DB);
    const existing = await c.var.DB
      .prepare("SELECT * FROM service_cases WHERE id = ?")
      .bind(id)
      .first<ServiceCaseRow>();
    if (!existing) {
      return c.json({ success: false, error: "Service case not found" }, 404);
    }
    const body = (await c.req.json()) as Record<string, unknown>;

    const photosJson =
      body.issuePhotos === undefined
        ? existing.issuePhotos
        : Array.isArray(body.issuePhotos)
          ? JSON.stringify((body.issuePhotos as unknown[]).map(String))
          : null;

    let rcNext =
      body.rootCauseCategory === undefined
        ? existing.rootCauseCategory
        : ((body.rootCauseCategory as RootCauseCategory | null) ?? null);
    if (rcNext != null && !VALID_ROOT_CAUSE.includes(rcNext)) {
      return c.json({ success: false, error: "rootCauseCategory invalid" }, 400);
    }
    const pStatusNext =
      body.preventionStatus === undefined
        ? (existing.preventionStatus ?? "PENDING")
        : (body.preventionStatus as PreventionStatus);
    if (!VALID_PREVENTION_STATUS.includes(pStatusNext)) {
      return c.json({ success: false, error: "preventionStatus invalid" }, 400);
    }

    // responsibleUnit — one of the 5 units, empty string / null clears to
    // NULL, anything else is rejected. Undefined = keep existing (dual-key
    // read since the stored column is lowercase).
    const ruNext =
      body.responsibleUnit === undefined
        ? (existing.responsibleUnit ?? existing.responsibleunit ?? null)
        : body.responsibleUnit === null || body.responsibleUnit === ""
          ? null
          : (body.responsibleUnit as ResponsibleUnit);
    if (ruNext != null && !VALID_RESPONSIBLE_UNITS.includes(ruNext)) {
      return c.json({ success: false, error: "responsibleUnit invalid" }, 400);
    }

    // actionLog is JSON array on the row. Body sends it as an array; we
    // serialise here. Undefined = keep existing.
    const actionLogJson =
      body.actionLog === undefined
        ? existing.actionLog
        : Array.isArray(body.actionLog)
          ? JSON.stringify(body.actionLog)
          : null;

    // rootCauseDetails — JSON object with category-specific fields. (May be
    // overwritten just below by the rootCauses[0] mirror when the multi-cause
    // array is sent.)
    let rcDetailsJson =
      body.rootCauseDetails === undefined
        ? existing.rootCauseDetails
        : body.rootCauseDetails === null
          ? null
          : JSON.stringify(body.rootCauseDetails);

    // rootCauses (migration 0169) — the multi-cause array. Undefined = keep the
    // stored column AND the legacy mirror untouched. When sent, it WINS: we
    // sanitize, store the array as JSON, and mirror entries[0] into the legacy
    // root_cause_category / root_cause_details columns so the list "Category"
    // column + any legacy reader keep working. Empty array → both legacy
    // fields NULL + rootcauses '[]'.
    let rootCausesJson: string | null = existing.rootCauses ?? existing.rootcauses ?? null;
    if (body.rootCauses !== undefined) {
      const cleaned = sanitizeRootCauses(body.rootCauses);
      rootCausesJson = JSON.stringify(cleaned);
      const first = cleaned[0];
      rcNext = first ? first.category : null;
      rcDetailsJson = first ? JSON.stringify(first.details) : null;
    }

    // affectedProducts — JSON array of {productId, code, name, qty?,
    // components?}. Migration 0077. Optional, undefined = keep existing;
    // components (damaged-part picks) go through the shared sanitizer.
    const affectedProductsJson =
      body.affectedProducts === undefined
        ? existing.affectedProductIds
        : sanitizeAffectedProductsJson(body.affectedProducts);

    // investigatingat (migration 0168) — stamp the FIRST time a PUT moves the
    // case to IN_PROGRESS, only when not already set (COALESCE keeps the
    // earliest entry). PUT /:id doesn't write status itself, but this records
    // the Investigating timestamp on any path that signals IN_PROGRESS.
    const investigatingAt =
      body.status === "IN_PROGRESS" &&
      !(existing.investigatingAt ?? existing.investigatingat)
        ? new Date().toISOString()
        : null;

    await c.var.DB
      .prepare(
        `UPDATE service_cases SET
           issueDescription = ?, issuePhotos = ?, notes = ?,
           rootCauseCategory = ?, responsibleunit = ?, rootCauseNotes = ?, rootCauseDetails = ?,
           rootcauses = ?,
           affectedProductIds = ?,
           preventionAction = ?, preventionStatus = ?, preventionOwner = ?,
           externalRef = ?, actionLog = ?,
           investigatingat = COALESCE(?, investigatingat)
         WHERE id = ?`,
      )
      .bind(
        body.issueDescription !== undefined
          ? ((body.issueDescription as string) ?? null)
          : existing.issueDescription,
        photosJson,
        body.notes !== undefined
          ? ((body.notes as string) ?? null)
          : existing.notes,
        rcNext,
        ruNext,
        body.rootCauseNotes !== undefined
          ? ((body.rootCauseNotes as string) ?? null)
          : existing.rootCauseNotes,
        rcDetailsJson,
        rootCausesJson,
        affectedProductsJson,
        body.preventionAction !== undefined
          ? ((body.preventionAction as string) ?? null)
          : existing.preventionAction,
        pStatusNext,
        body.preventionOwner !== undefined
          ? ((body.preventionOwner as string) ?? null)
          : existing.preventionOwner,
        body.externalRef !== undefined
          ? ((body.externalRef as string) ?? null)
          : existing.externalRef,
        actionLogJson,
        investigatingAt,
        id,
      )
      .run();

    const [updated, orders, svOrders] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM service_cases WHERE id = ?")
        .bind(id)
        .first<ServiceCaseRow>(),
      c.var.DB
        .prepare(
          "SELECT id, serviceOrderNo, caseId, sourceType, sourceId, sourceNo, customerId, customerName, mode, status, createdBy, createdByName, created_at as createdAt, closedAt, notes FROM service_orders WHERE caseId = ?",
        )
        .bind(id)
        .all<ServiceOrderRow>(),
      loadSvOrdersForCases(c.var.DB, id),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "Failed to reload after update" }, 500);
    }
    return c.json({ success: true, data: rowToApi(updated, orders.results ?? [], svOrders) });
  } catch (err) {
    console.error("[PUT /api/service-cases/:id] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/service-cases/:id/status
// ---------------------------------------------------------------------------
app.put("/:id/status", async (c) => {
  const denied = await requirePermission(c, "service-orders", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    // investigatingat (migration 0168) is referenced in the UPDATE below.
    await ensureCaseLinkColumns(c.var.DB);
    const body = (await c.req.json()) as { status?: string };
    const next = body.status as CaseStatus;
    if (!VALID_STATUSES.includes(next)) {
      return c.json({ success: false, error: "status invalid" }, 400);
    }
    const existing = await c.var.DB
      .prepare("SELECT status, investigatingat FROM service_cases WHERE id = ?")
      .bind(id)
      .first<{ status: CaseStatus; investigatingat: string | null }>();
    if (!existing) {
      return c.json({ success: false, error: "Service case not found" }, 404);
    }
    const allowed = STATUS_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(next)) {
      return c.json(
        {
          success: false,
          error: `Cannot transition from ${existing.status} to ${next}. Allowed: ${allowed.join(", ") || "(none)"}`,
        },
        409,
      );
    }
    const nowIso = new Date().toISOString();
    const closedAt = next === "CLOSED" || next === "CANCELLED" ? nowIso : null;
    // Stamp the Investigating timestamp the FIRST time the case is marked
    // IN_PROGRESS (COALESCE keeps any earlier value, so it records the first
    // entry only). NULL for every other transition → COALESCE keeps existing.
    const investigatingAt =
      next === "IN_PROGRESS" && !existing.investigatingat ? nowIso : null;
    await c.var.DB
      .prepare(
        "UPDATE service_cases SET status = ?, closedAt = COALESCE(?, closedAt), investigatingat = COALESCE(?, investigatingat) WHERE id = ?",
      )
      .bind(next, closedAt, investigatingAt, id)
      .run();
    return c.json({ success: true, data: { id, status: next } });
  } catch (err) {
    console.error("[PUT /api/service-cases/:id/status] failed:", err);
    return c.json({ success: false, error: err instanceof Error ? err.message : "Invalid body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/service-cases/:id — only allowed if status='OPEN'.
// (Use PUT /:id/status with CANCELLED to soft-cancel anything past OPEN.)
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "service-orders", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB
    .prepare("SELECT status FROM service_cases WHERE id = ?")
    .bind(id)
    .first<{ status: CaseStatus }>();
  if (!existing) {
    return c.json({ success: false, error: "Service case not found" }, 404);
  }
  if (existing.status !== "OPEN") {
    return c.json(
      {
        success: false,
        error: `Only OPEN cases can be deleted. Use PUT /:id/status with CANCELLED instead.`,
      },
      400,
    );
  }
  // FK CASCADE on service_orders.case_id → service_orders go away with the case.
  await c.var.DB.prepare("DELETE FROM service_cases WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default app;

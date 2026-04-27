// ---------------------------------------------------------------------------
// D1-backed production-orders route.
//
// Mirrors the old src/api/routes/production-orders.ts response shape so the
// SPA frontend does not need any changes. `jobCards` is returned as a nested
// array joined from job_cards; each job card's `piecePics` is joined from
// piece_pics.
//
// Phase-4A scope: base CRUD (list/get/update/patch), /stock PO creation,
// /historical-wips + /historical-fgs aggregates, and the /scan-complete FIFO
// routing + piece-pic binding. Multi-table writes are batched.
//
// Deferred to later phases:
//   - TODO(phase-5): FIFO raw-material consumption on PO completion
//     (fg_batches/rm_batches/cost_ledger are present in schema but the
//     lookup helpers in src/lib/material-lookup + src/lib/costing haven't
//     been ported to D1 yet).
//   - TODO(phase-5): jobCard/PO override persistence (job-card-persistence.ts)
//     — D1 writes are already durable so overrides become redundant, but the
//     module is still called by the in-memory route. Not needed here.
//
// JSON columns: none on production_orders/job_cards themselves. piece_pics is
// its own table in the schema.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { postProductionOrderCompletion } from "../lib/fg-completion";
import { postJobCardLabor } from "../lib/po-cost-cascade";
import { resolveWorkerToken } from "./worker-auth";
// Phase 6 — parallel event sourcing for JC mutations. appendJobCardEvent
// writes go after the UPDATE lands so the source-of-truth row is committed
// before we narrate what changed; a write failure here does NOT roll the
// UPDATE back (events are audit-only, not the transactional source).
import {
  buildJobCardEventStatement,
  diffJobCardEvents,
} from "../lib/job-card-events";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Row types (mirror migrations/0001_init.sql exactly)
// ---------------------------------------------------------------------------
type ProductionOrderRow = {
  id: string;
  poNo: string;
  salesOrderId: string | null;
  salesOrderNo: string | null;
  lineNo: number;
  customerPOId: string | null;
  customerReference: string | null;
  customerName: string | null;
  customerState: string | null;
  companySOId: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string | null;
  notes: string | null;
  status: string;
  currentDepartment: string | null;
  progress: number;
  startDate: string | null;
  targetEndDate: string | null;
  completedDate: string | null;
  rackingNumber: string | null;
  stockedIn: number;
  createdAt: string | null;
  updatedAt: string | null;
};

type JobCardRow = {
  id: string;
  productionOrderId: string;
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  sequence: number;
  status: string;
  dueDate: string | null;
  wipKey: string | null;
  wipCode: string | null;
  wipType: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  // BOM-branch identifier (added 2026-04-27, migration 0058). See
  // src/lib/mock-data.ts JobCard.branchKey for full rationale. Within
  // one wipKey, JCs in different branchKeys are NOT each other's
  // upstream/downstream — used by lock + consume + WIP-display logic.
  branchKey: string | null;
  prerequisiteMet: number;
  pic1Id: string | null;
  pic1Name: string | null;
  pic2Id: string | null;
  pic2Name: string | null;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string | null;
  productionTimeMinutes: number;
  overdue: string | null;
  rackingNumber: string | null;
};

type PiecePicRow = {
  id: number;
  jobCardId: string;
  pieceNo: number;
  pic1Id: string | null;
  pic1Name: string | null;
  pic2Id: string | null;
  pic2Name: string | null;
  completedAt: string | null;
  lastScanAt: string | null;
  boundStickerKey: string | null;
};

// Shape mirrored to the frontend — matches the in-memory PiecePic type.
type PiecePicOut = {
  pieceNo: number;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  completedAt: string | null;
  lastScanAt: string | null;
  boundStickerKey: string | null;
};

type ProductionOrderOut = ReturnType<typeof rowToPO>;

function rowToPiecePic(r: PiecePicRow): PiecePicOut {
  return {
    pieceNo: r.pieceNo,
    pic1Id: r.pic1Id,
    pic1Name: r.pic1Name ?? "",
    pic2Id: r.pic2Id,
    pic2Name: r.pic2Name ?? "",
    completedAt: r.completedAt,
    lastScanAt: r.lastScanAt,
    boundStickerKey: r.boundStickerKey,
  };
}

function rowToJobCard(r: JobCardRow, pics: PiecePicRow[] = []) {
  const myPics = pics
    .filter((p) => p.jobCardId === r.id)
    .sort((a, b) => a.pieceNo - b.pieceNo)
    .map(rowToPiecePic);
  return {
    id: r.id,
    departmentId: r.departmentId ?? "",
    departmentCode: r.departmentCode ?? "",
    departmentName: r.departmentName ?? "",
    sequence: r.sequence,
    status: r.status,
    dueDate: r.dueDate ?? "",
    wipKey: r.wipKey ?? undefined,
    wipCode: r.wipCode ?? undefined,
    wipType: r.wipType ?? undefined,
    wipLabel: r.wipLabel ?? undefined,
    wipQty: r.wipQty ?? undefined,
    branchKey: r.branchKey ?? undefined,
    prerequisiteMet: r.prerequisiteMet === 1,
    pic1Id: r.pic1Id,
    pic1Name: r.pic1Name ?? "",
    pic2Id: r.pic2Id,
    pic2Name: r.pic2Name ?? "",
    completedDate: r.completedDate,
    estMinutes: r.estMinutes,
    actualMinutes: r.actualMinutes,
    category: r.category ?? "",
    productionTimeMinutes: r.productionTimeMinutes,
    overdue: r.overdue ?? "",
    rackingNumber: r.rackingNumber ?? undefined,
    piecePics: myPics.length > 0 ? myPics : undefined,
  };
}

// Slim output shape for ?fields=minimal — only the fields the Production
// page actually reads off the wire. Dropping the ~20 unused PO fields
// (progress, startDate, targetEndDate, notes, etc.) and the full piece_pics
// tree typically halves the payload on a ~530-PO / ~9k-JC response.
type MinimalJobCardOut = {
  id: string;
  departmentCode: string;
  wipKey?: string;
  wipCode?: string;
  wipType?: string;
  wipLabel?: string;
  wipQty?: number;
  branchKey?: string;
  sequence: number;
  status: string;
  dueDate: string;
  completedDate: string | null;
  pic1Id: string | null;
  pic1Name: string;
  pic2Id: string | null;
  pic2Name: string;
  prerequisiteMet: boolean;
  productionTimeMinutes: number;
  estMinutes: number;
  rackingNumber?: string;
  category: string;
};
type MinimalPOOut = {
  id: string;
  poNo: string;
  salesOrderId: string;
  salesOrderNo: string;
  companySOId: string;
  customerPOId: string;
  customerReference: string;
  customerName: string;
  customerState: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  status: string;
  currentDepartment: string;
  lineNo: number;
  targetEndDate: string;
  jobCards: MinimalJobCardOut[];
};

function rowToMinimalJobCard(r: JobCardRow): MinimalJobCardOut {
  return {
    id: r.id,
    departmentCode: r.departmentCode ?? "",
    sequence: r.sequence,
    status: r.status,
    dueDate: r.dueDate ?? "",
    wipKey: r.wipKey ?? undefined,
    wipCode: r.wipCode ?? undefined,
    wipType: r.wipType ?? undefined,
    wipLabel: r.wipLabel ?? undefined,
    wipQty: r.wipQty ?? undefined,
    branchKey: r.branchKey ?? undefined,
    prerequisiteMet: r.prerequisiteMet === 1,
    pic1Id: r.pic1Id,
    pic1Name: r.pic1Name ?? "",
    pic2Id: r.pic2Id,
    pic2Name: r.pic2Name ?? "",
    completedDate: r.completedDate,
    productionTimeMinutes: r.productionTimeMinutes,
    estMinutes: r.estMinutes,
    category: r.category ?? "",
    rackingNumber: r.rackingNumber ?? undefined,
  };
}

function rowToMinimalPO(
  row: ProductionOrderRow,
  jobCards: JobCardRow[] = [],
): MinimalPOOut {
  const myJCs = jobCards
    .filter((j) => j.productionOrderId === row.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map(rowToMinimalJobCard);
  return {
    id: row.id,
    poNo: row.poNo,
    salesOrderId: row.salesOrderId ?? "",
    salesOrderNo: row.salesOrderNo ?? "",
    companySOId: row.companySOId ?? "",
    customerPOId: row.customerPOId ?? "",
    customerReference: row.customerReference ?? "",
    customerName: row.customerName ?? "",
    customerState: row.customerState ?? "",
    productId: row.productId ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    itemCategory: row.itemCategory ?? "BEDFRAME",
    sizeCode: row.sizeCode ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    gapInches: row.gapInches,
    divanHeightInches: row.divanHeightInches,
    legHeightInches: row.legHeightInches,
    specialOrder: row.specialOrder ?? "",
    status: row.status,
    currentDepartment: row.currentDepartment ?? "",
    lineNo: row.lineNo,
    targetEndDate: row.targetEndDate ?? "",
    jobCards: myJCs,
  };
}

function rowToPO(
  row: ProductionOrderRow,
  jobCards: JobCardRow[] = [],
  pics: PiecePicRow[] = [],
) {
  const myJCs = jobCards
    .filter((j) => j.productionOrderId === row.id)
    .sort((a, b) => a.sequence - b.sequence)
    .map((j) => rowToJobCard(j, pics));
  return {
    id: row.id,
    poNo: row.poNo,
    salesOrderId: row.salesOrderId ?? "",
    salesOrderNo: row.salesOrderNo ?? "",
    lineNo: row.lineNo,
    customerPOId: row.customerPOId ?? "",
    customerReference: row.customerReference ?? "",
    customerName: row.customerName ?? "",
    customerState: row.customerState ?? "",
    companySOId: row.companySOId ?? "",
    productId: row.productId ?? "",
    productCode: row.productCode ?? "",
    productName: row.productName ?? "",
    itemCategory: row.itemCategory ?? "BEDFRAME",
    sizeCode: row.sizeCode ?? "",
    sizeLabel: row.sizeLabel ?? "",
    fabricCode: row.fabricCode ?? "",
    quantity: row.quantity,
    gapInches: row.gapInches,
    divanHeightInches: row.divanHeightInches,
    legHeightInches: row.legHeightInches,
    specialOrder: row.specialOrder ?? "",
    notes: row.notes ?? "",
    status: row.status,
    currentDepartment: row.currentDepartment ?? "",
    progress: row.progress,
    jobCards: myJCs,
    startDate: row.startDate ?? "",
    targetEndDate: row.targetEndDate ?? "",
    completedDate: row.completedDate,
    rackingNumber: row.rackingNumber ?? "",
    stockedIn: row.stockedIn === 1,
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------
function genPoId(): string {
  return `pord-${crypto.randomUUID().slice(0, 8)}`;
}
function genJcId(): string {
  return `jc-${crypto.randomUUID().slice(0, 8)}`;
}
function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `soi-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// D1 caps prepared-statement bind parameters at 100 per call. The Production
// page's status-filter result regularly exceeds that (~530 POs in active
// status), so any `WHERE productionOrderId IN (?,?,...)` query against
// job_cards / piece_pics has to chunk its bind list. This helper runs the
// chunks in parallel and concatenates results, preserving order within each
// chunk (overall order is undefined — callers must sort if they need it).
async function fetchInChunks<R>(
  db: D1Database,
  buildSql: (placeholders: string) => string,
  ids: string[],
  extraBindsBefore: unknown[] = [],
  extraBindsAfter: unknown[] = [],
  chunkSize = 100,
): Promise<R[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  const results = await Promise.all(
    chunks.map((chunk) => {
      const placeholders = chunk.map(() => "?").join(",");
      const sql = buildSql(placeholders);
      return db
        .prepare(sql)
        .bind(...extraBindsBefore, ...chunk, ...extraBindsAfter)
        .all<R>();
    }),
  );
  const out: R[] = [];
  for (const r of results) {
    if (r.results) out.push(...r.results);
  }
  return out;
}

async function fetchAllPOs(db: D1Database): Promise<ProductionOrderOut[]> {
  const [pos, jcs, pics] = await Promise.all([
    db
      .prepare("SELECT * FROM production_orders ORDER BY created_at DESC, id DESC")
      .all<ProductionOrderRow>(),
    db.prepare("SELECT * FROM job_cards").all<JobCardRow>(),
    db.prepare("SELECT * FROM piece_pics").all<PiecePicRow>(),
  ]);
  return (pos.results ?? []).map((p) =>
    rowToPO(p, jcs.results ?? [], pics.results ?? []),
  );
}

// Variant of fetchAllPOs that supports server-side status filtering and
// optional omission of inlined jobCards. Used by the list endpoint so the
// Production page can avoid shipping every PO + every JC on mount.
//
// - statuses: if provided (non-empty), applies `WHERE status IN (...)` at the
//   SQL layer.
// - includeJobCards: when false, skip the job_cards + piece_pics fetches and
//   return POs with `jobCards: []`. Defaults to true for backward compat.
async function fetchFilteredPOs(
  db: D1Database,
  statuses: string[] | null,
  includeJobCards: boolean,
  includeArchive = false,
  minimal = false,
  deptFilter: string | null = null,
): Promise<ProductionOrderOut[] | MinimalPOOut[]> {
  const hasFilter = Array.isArray(statuses) && statuses.length > 0;
  const placeholders = hasFilter
    ? statuses.map(() => "?").join(",")
    : "";
  // Phase-5: when includeArchive is set, UNION hot + archive. Hot rows get
  // a projected '' archivedAt so the column lists align with the archive
  // table. rowToPO ignores columns it doesn't know about.
  const poSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM production_orders
        UNION ALL
        SELECT * FROM production_orders_archive)`
    : "production_orders";
  const jcSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM job_cards
        UNION ALL
        SELECT * FROM job_cards_archive)`
    : "job_cards";
  const poSql = hasFilter
    ? `SELECT * FROM ${poSource} WHERE status IN (${placeholders}) ORDER BY created_at DESC, id DESC`
    : `SELECT * FROM ${poSource} ORDER BY created_at DESC, id DESC`;
  const poStmt = hasFilter
    ? db.prepare(poSql).bind(...(statuses as string[]))
    : db.prepare(poSql);

  // Dept-narrowing: when caller passes ?dept=FOAM (etc.), return JCs
  // whose wipKey appears in any wipKey that contains a matching-dept JC,
  // PLUS legacy JCs (wipKey NULL) whose PO has a matching-dept JC,
  // PLUS *every* JC on a PO whose matching-dept JC is FG-keyed (sofa
  // PACKING merge-row case — the only matching wipKey is "FG", which
  // would otherwise strip every upstream component-branch JC and leave
  // the Packing tab's upstream date columns rendering "—" for sofas).
  // The production page's prev-dept-CD pills need upstream sibling JCs
  // in the same wipKey -- the original `WHERE departmentCode = ?` filter
  // stripped them, leaving every upstream column rendering "—".  This
  // wipKey-grouped variant keeps the JC-row payload down (only loads
  // wipKeys that the active dept actually touches) while letting the
  // frontend picker find the full chain.
  const jcWhereDept = deptFilter
    ? ` WHERE wipKey IN (SELECT DISTINCT wipKey FROM ${jcSource} WHERE departmentCode = ? AND wipKey IS NOT NULL)
          OR (wipKey IS NULL AND productionOrderId IN (SELECT productionOrderId FROM ${jcSource} WHERE departmentCode = ? AND wipKey IS NULL))
          OR productionOrderId IN (SELECT DISTINCT productionOrderId FROM ${jcSource} WHERE departmentCode = ? AND wipKey = 'FG')`
    : "";

  if (!includeJobCards) {
    const pos = await poStmt.all<ProductionOrderRow>();
    if (minimal) {
      return (pos.results ?? []).map((p) => rowToMinimalPO(p, []));
    }
    return (pos.results ?? []).map((p) => rowToPO(p, [], []));
  }

  // Minimal path: skip piece_pics entirely (the Production page never reads
  // them) and return the narrow projection. This is the hot path for the
  // Production page — the dropped fields + table save several MB on the
  // ~530 PO / ~9k JC response.
  if (minimal) {
    if (deptFilter) {
      // Dept-narrowed path: the wipKey-grouped subquery already keeps the JC
      // payload bounded. Leave it untouched.
      const jcStmt = db
        .prepare(`SELECT * FROM ${jcSource}${jcWhereDept}`)
        .bind(deptFilter, deptFilter, deptFilter);
      const [pos, jcs] = await Promise.all([
        poStmt.all<ProductionOrderRow>(),
        jcStmt.all<JobCardRow>(),
      ]);
      return (pos.results ?? []).map((p) =>
        rowToMinimalPO(p, jcs.results ?? []),
      );
    }
    if (hasFilter) {
      // Status-filter path: run POs first, then narrow JCs to only the
      // matching POs' productionOrderId set. Avoids a full ~9k-row scan
      // when the filter shrinks the PO set to a few hundred. Bind list
      // is chunked at 100 (D1 cap) — see fetchInChunks.
      const pos = await poStmt.all<ProductionOrderRow>();
      const poRows = pos.results ?? [];
      if (poRows.length === 0) {
        return [];
      }
      const poIds = poRows.map((p) => p.id);
      const jcs = await fetchInChunks<JobCardRow>(
        db,
        (placeholders) =>
          `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${placeholders})`,
        poIds,
      );
      return poRows.map((p) => rowToMinimalPO(p, jcs));
    }
    // No status filter, no dept filter: legacy full-fetch backward-compat path.
    const jcStmt = db.prepare(`SELECT * FROM ${jcSource}`);
    const [pos, jcs] = await Promise.all([
      poStmt.all<ProductionOrderRow>(),
      jcStmt.all<JobCardRow>(),
    ]);
    return (pos.results ?? []).map((p) =>
      rowToMinimalPO(p, jcs.results ?? []),
    );
  }

  if (deptFilter) {
    const jcStmt = db
      .prepare(`SELECT * FROM ${jcSource}${jcWhereDept}`)
      .bind(deptFilter, deptFilter, deptFilter);
    const [pos, jcs, pics] = await Promise.all([
      poStmt.all<ProductionOrderRow>(),
      jcStmt.all<JobCardRow>(),
      db.prepare("SELECT * FROM piece_pics").all<PiecePicRow>(),
    ]);
    return (pos.results ?? []).map((p) =>
      rowToPO(p, jcs.results ?? [], pics.results ?? []),
    );
  }
  if (hasFilter) {
    // Status-filter path (full payload): same narrow-by-PO-id trick as the
    // minimal branch. piece_pics stays a full fetch for now (separate task).
    // Bind list chunked at 100 — see fetchInChunks.
    const pos = await poStmt.all<ProductionOrderRow>();
    const poRows = pos.results ?? [];
    if (poRows.length === 0) {
      return [];
    }
    const poIds = poRows.map((p) => p.id);
    const [jcs, pics] = await Promise.all([
      fetchInChunks<JobCardRow>(
        db,
        (placeholders) =>
          `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${placeholders})`,
        poIds,
      ),
      // piece_pics scoped via a sub-select bound to the page's PO IDs, not a
      // full table scan. Chunked at 100 PO ids — same D1 bind cap as the JC
      // chunking above. Avoids the ~all-piece_pics scan that the previous
      // `SELECT * FROM piece_pics` did when the operator only asked for a
      // status-filtered slice.
      fetchInChunks<PiecePicRow>(
        db,
        (placeholders) =>
          `SELECT * FROM piece_pics WHERE jobCardId IN (SELECT id FROM ${jcSource} WHERE productionOrderId IN (${placeholders}))`,
        poIds,
      ),
    ]);
    return poRows.map((p) => rowToPO(p, jcs, pics));
  }
  // No status filter, no dept filter: legacy full-fetch backward-compat path.
  const jcStmt = db.prepare(`SELECT * FROM ${jcSource}`);
  const [pos, jcs, pics] = await Promise.all([
    poStmt.all<ProductionOrderRow>(),
    jcStmt.all<JobCardRow>(),
    db.prepare("SELECT * FROM piece_pics").all<PiecePicRow>(),
  ]);
  return (pos.results ?? []).map((p) =>
    rowToPO(p, jcs.results ?? [], pics.results ?? []),
  );
}

// Paginated variant of fetchFilteredPOs. Returns the page's POs + the total
// filtered count in one round-trip group. Uses SQL LIMIT/OFFSET on the PO
// table and then fetches job_cards/piece_pics for ONLY the page's PO IDs
// (not the whole table), which is the big win when the list is paginated.
async function fetchPaginatedPOs(
  db: D1Database,
  statuses: string[] | null,
  includeJobCards: boolean,
  page: number,
  limit: number,
  includeArchive = false,
  minimal = false,
  deptFilter: string | null = null,
): Promise<{ data: ProductionOrderOut[] | MinimalPOOut[]; total: number }> {
  const hasFilter = Array.isArray(statuses) && statuses.length > 0;
  const statusPlaceholders = hasFilter
    ? statuses.map(() => "?").join(",")
    : "";
  const offset = (page - 1) * limit;

  const poSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM production_orders
        UNION ALL
        SELECT * FROM production_orders_archive)`
    : "production_orders";
  const jcSource = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM job_cards
        UNION ALL
        SELECT * FROM job_cards_archive)`
    : "job_cards";

  const countSql = hasFilter
    ? `SELECT COUNT(*) AS n FROM ${poSource} WHERE status IN (${statusPlaceholders})`
    : `SELECT COUNT(*) AS n FROM ${poSource}`;
  const pageSql = hasFilter
    ? `SELECT * FROM ${poSource} WHERE status IN (${statusPlaceholders}) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    : `SELECT * FROM ${poSource} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;

  const countStmt = hasFilter
    ? db.prepare(countSql).bind(...(statuses as string[]))
    : db.prepare(countSql);
  const pageStmt = hasFilter
    ? db.prepare(pageSql).bind(...(statuses as string[]), limit, offset)
    : db.prepare(pageSql).bind(limit, offset);

  const [countRes, pageRes] = await Promise.all([
    countStmt.first<{ n: number }>(),
    pageStmt.all<ProductionOrderRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const posRows = pageRes.results ?? [];

  if (!includeJobCards || posRows.length === 0) {
    if (minimal) {
      return { data: posRows.map((p) => rowToMinimalPO(p, [])), total };
    }
    return { data: posRows.map((p) => rowToPO(p, [], [])), total };
  }

  // Scope JC + piece_pics queries to only this page's PO IDs. Bind lists
  // chunked at 100 (D1 cap) — same latent overflow that 745801a fixed for
  // fetchFilteredPOs. With page size up to 500 + 3 IN clauses for the
  // deptFilter case, we'd otherwise blow past D1's 100-parameter cap.
  const poIds = posRows.map((p) => p.id);
  let jcs: JobCardRow[] = [];
  if (deptFilter) {
    // Dept narrowing — same wipKey-grouped logic as fetchFilteredPOs. Drops
    // unrelated wipKeys but keeps every sibling JC inside a touched wipKey
    // so the production page's prev-dept-CD pills (FAB_SEW shown on FOAM
    // tab, etc.) have the data they need.  Plain departmentCode filter
    // would orphan upstream pills.
    //
    // The query references `poIds` 3 times (outer + both subqueries), so we
    // chunk inline rather than threading a triple-IN shape through
    // fetchInChunks. Each chunk substitutes the same chunk slice into all 3
    // IN clauses.
    if (poIds.length > 0) {
      const CHUNK = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < poIds.length; i += CHUNK) {
        chunks.push(poIds.slice(i, i + CHUNK));
      }
      const chunkResults = await Promise.all(
        chunks.map((chunk) => {
          const ph = chunk.map(() => "?").join(",");
          // The 3rd OR clause covers the sofa PACKING merge-row case: when
          // the matching-dept JC's wipKey is "FG" (sofa Packing), include
          // *every* JC on that PO so the frontend has the upstream
          // component-branch JCs (Base / Cushion / Armrest) it needs to
          // aggregate completedDate across the merged set. Without this,
          // the wipKey IN (...FG only...) clause would strip the upstream
          // chain and the Packing tab's date columns render "—".
          const sql = `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${ph}) AND (wipKey IN (SELECT DISTINCT wipKey FROM ${jcSource} WHERE departmentCode = ? AND wipKey IS NOT NULL AND productionOrderId IN (${ph}))
            OR (wipKey IS NULL AND productionOrderId IN (SELECT productionOrderId FROM ${jcSource} WHERE departmentCode = ? AND wipKey IS NULL AND productionOrderId IN (${ph})))
            OR productionOrderId IN (SELECT DISTINCT productionOrderId FROM ${jcSource} WHERE departmentCode = ? AND wipKey = 'FG' AND productionOrderId IN (${ph})))`;
          return db
            .prepare(sql)
            .bind(...chunk, deptFilter, ...chunk, deptFilter, ...chunk, deptFilter, ...chunk)
            .all<JobCardRow>();
        }),
      );
      for (const r of chunkResults) {
        if (r.results) jcs.push(...r.results);
      }
    }
  } else {
    jcs = await fetchInChunks<JobCardRow>(
      db,
      (placeholders) =>
        `SELECT * FROM ${jcSource} WHERE productionOrderId IN (${placeholders})`,
      poIds,
    );
  }

  // Minimal path: skip piece_pics entirely.
  if (minimal) {
    return { data: posRows.map((p) => rowToMinimalPO(p, jcs)), total };
  }

  // piece_pics: bind chunks of 100 PO ids and use a sub-select on job_cards
  // so each round-trip can sweep all piece_pics for ~hundreds of JCs instead
  // of one prepared statement per 100 JC ids. The previous JC-id-bound shape
  // expanded to ~35 chunks for a 200-PO / ~3500-JC page (the bulk of the
  // 16s/44-query overview path); this collapses that to ceil(POs/100) chunks
  // — typically 2 for an active-status slice — without changing the result
  // set the JC-id-bound query produced.
  let pics: PiecePicRow[] = [];
  if (jcs.length > 0 && poIds.length > 0) {
    pics = await fetchInChunks<PiecePicRow>(
      db,
      (placeholders) =>
        `SELECT * FROM piece_pics WHERE jobCardId IN (SELECT id FROM ${jcSource} WHERE productionOrderId IN (${placeholders}))`,
      poIds,
    );
  }

  return { data: posRows.map((p) => rowToPO(p, jcs, pics)), total };
}

async function fetchPO(
  db: D1Database,
  id: string,
): Promise<ProductionOrderOut | null> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(id)
    .first<ProductionOrderRow>();
  if (!po) return null;
  const jcs = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(id)
    .all<JobCardRow>();
  const jcIds = (jcs.results ?? []).map((j) => j.id);
  let pics: PiecePicRow[] = [];
  if (jcIds.length > 0) {
    const placeholders = jcIds.map(() => "?").join(",");
    const picsRes = await db
      .prepare(`SELECT * FROM piece_pics WHERE jobCardId IN (${placeholders})`)
      .bind(...jcIds)
      .all<PiecePicRow>();
    pics = picsRes.results ?? [];
  }
  return rowToPO(po, jcs.results ?? [], pics);
}

// Ensure piece_pics rows exist for a job card. Creates wipQty (or 1) slots on
// demand and returns the ordered array. Mirrors the in-memory ensurePiecePics
// semantics, but persists to D1 so subsequent scans find the same slots.
async function ensurePiecePicsForJc(
  db: D1Database,
  jc: JobCardRow,
): Promise<PiecePicRow[]> {
  const existing = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ? ORDER BY pieceNo")
    .bind(jc.id)
    .all<PiecePicRow>();
  const rows = existing.results ?? [];
  if (rows.length > 0) return rows;
  const slots = Math.max(1, Math.floor(jc.wipQty || 1));
  const inserts: D1PreparedStatement[] = [];
  for (let i = 1; i <= slots; i++) {
    inserts.push(
      db
        .prepare(
          `INSERT INTO piece_pics
             (jobCardId, pieceNo, pic1Id, pic1Name, pic2Id, pic2Name,
              completedAt, lastScanAt, boundStickerKey)
           VALUES (?, ?, NULL, '', NULL, '', NULL, NULL, NULL)`,
        )
        .bind(jc.id, i),
    );
  }
  if (inserts.length > 0) {
    await db.batch(inserts);
  }
  const refreshed = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ? ORDER BY pieceNo")
    .bind(jc.id)
    .all<PiecePicRow>();
  return refreshed.results ?? [];
}

// Derive spec key used to scope FIFO candidates.
function specKeyFor(jc: JobCardRow, po: ProductionOrderRow): string {
  const wipLabel = jc.wipLabel;
  if (wipLabel) return `${jc.departmentCode}::${wipLabel}`;
  return `${jc.departmentCode}::${po.productCode}`;
}

// Month-based SOH counter.
async function nextSOHNumber(db: D1Database): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `SOH-${yy}${mm}-`;
  const res = await db
    .prepare(
      "SELECT companySOId FROM sales_orders WHERE companySOId LIKE ? ORDER BY companySOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companySOId: string }>();
  const seq = res?.companySOId
    ? Number(res.companySOId.split("-").pop()) + 1
    : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// WIP inventory — mirror of the in-memory applyWipInventoryChange().
// Writes directly to wip_items (code-keyed).
//
// UPHOLSTERY special case: UPHOLSTERY is the terminal WIP dept — once it
// completes, the WIP chain is finished and the piece becomes FG. We therefore
// DO NOT create / bump a new wip_items row for UPH (there's no physical
// "upholstered WIP" sitting on a shelf — it's a finished product). Instead we
// consume (zero out) every earlier-dept wip_items row in the same wipKey
// chain so the WIP board stops showing the intermediate Divan / HB / Cushion
// stock that was upstream of this UPH.
//
// FG stock is NOT written from here — it's derived at render time by
// deriveFGStock() in src/pages/inventory/index.tsx, which counts POs where
// every UPH job_card is completed. So the cascade is:
//   earlier depts COMPLETED → wip_items row added (stock accumulates)
//   UPH COMPLETED → wip_items rows for THIS wipKey zeroed out
//                   → deriveFGStock() now sees PO.jobCards[UPH].allCompleted
//                     and surfaces an FG row
// ---------------------------------------------------------------------------
async function applyWipInventoryChange(
  db: D1Database,
  poRow: ProductionOrderRow,
  jcRow: JobCardRow,
  newStatus: string,
  allJcRows: JobCardRow[],
  prevStatus: string | null = null,
): Promise<void> {
  // Producer wipLabel — falls back to a synthesized label when the JC was
  // created without BOM (legacy seed via createJobCards()) so the inventory
  // upsert still lands a row. Without this fallback, completing WOOD_CUT (or
  // any producer dept) on a non-BOM PO silently skipped the wip_items
  // upsert, leaving nothing in the warehouse WIP view — reported by user
  // 2026-04-26.
  const deptCodeRaw = (jcRow.departmentCode || "").toUpperCase();
  const wipType = jcRow.wipType;
  const wipKey = jcRow.wipKey;
  const wipQty = jcRow.wipQty || poRow.quantity || 1;
  const wipLabel =
    jcRow.wipLabel ||
    // Synthesize: "<productCode> <wipCode> (<DEPT>)" — keeps each dept's
    // output uniquely keyed so the upsert-by-code accumulates correctly
    // and the JC-derived /api/inventory/wip view groups by dept stage.
    [
      poRow.productCode || "",
      jcRow.wipCode || wipKey || "",
      deptCodeRaw ? `(${deptCodeRaw})` : "",
    ]
      .filter((s) => s && String(s).trim().length > 0)
      .join(" ")
      .trim();
  if (!wipLabel) return;

  const isUpholstery = deptCodeRaw === "UPHOLSTERY";

  const shortType = (() => {
    const t = (wipType || "").toUpperCase();
    if (t === "HEADBOARD") return "HB";
    if (t === "SOFA_BASE") return "BASE";
    if (t === "SOFA_CUSHION") return "CUSHION";
    if (t === "SOFA_ARMREST") return "ARMREST";
    return t || "WIP";
  })();

  // Generic upstream-consume gate — fires on IN_PROGRESS OR COMPLETED for
  // every non-UPH, non-FAB_CUT dept. Date-cell clicks skip IN_PROGRESS
  // (WAITING → COMPLETED directly), which used to orphan upstream stock.
  // BUG-2026-04-27-013: consume is unclamped (no MAX(0)) so a skipped /
  // out-of-order upstream dept surfaces as negative stock_qty rather
  // than being silently swallowed.
  const deptUpper = deptCodeRaw;
  const isFabCut = deptUpper === "FAB_CUT";
  // WOOD_CUT is parallel to FAB_CUT — both are raw-material entry points
  // (wood cut starts the wooden-frame chain, fabric cut starts the fabric
  // chain). Neither has an upstream wip_items to consume.
  const isWoodCut = deptUpper === "WOOD_CUT";
  const becomingActive =
    newStatus === "IN_PROGRESS" ||
    newStatus === "COMPLETED" ||
    newStatus === "TRANSFERRED";

  // ---------------------------------------------------------------------
  // BUG-2026-04-27-002 — rollback branch.
  // When a JC transitions OUT of a DONE state (COMPLETED/TRANSFERRED →
  // anything else) we have to undo what the original COMPLETED transition
  // did, otherwise stock drifts on every toggle. Symmetric inverse of the
  // forward paths below:
  //   Non-UPH:   subtract wipQty from this JC's own wip_items row,
  //              refund the same qty to the upstream sibling that the
  //              forward path consumed from.
  //   UPH:       subtract wipQty from UPH's own row, refund each upstream
  //              wipKey sibling that the forward path zeroed.
  // ---------------------------------------------------------------------
  const wasDone =
    prevStatus === "COMPLETED" || prevStatus === "TRANSFERRED";
  const isDone =
    newStatus === "COMPLETED" || newStatus === "TRANSFERRED";
  if (wasDone && !isDone) {
    const refundQty = wipQty;
    if (isUpholstery) {
      // Subtract UPH's own row.
      // BUG-2026-04-27-013: no MAX(0) clamp — symmetric with the forward
      // consume; a rollback before any completion can go negative as a
      // visibility signal.
      await db
        .prepare(
          "UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?",
        )
        .bind(refundQty, wipLabel)
        .run();
      // Refund every upstream sibling the forward UPH-COMPLETED path
      // consumed from.
      if (wipKey) {
        const upstreamLabels = new Set<string>();
        for (const j of allJcRows) {
          if (
            j.wipKey === wipKey &&
            j.sequence < jcRow.sequence &&
            j.wipLabel
          ) {
            upstreamLabels.add(j.wipLabel);
          }
        }
        for (const label of upstreamLabels) {
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?",
            )
            .bind(refundQty, label)
            .run();
        }
      }
      return;
    }

    // Non-UPH dept rollback: subtract this JC's own row first.
    // BUG-2026-04-27-013: no MAX(0) clamp — symmetric with the forward
    // consume so a "rollback before any completion" goes negative as a
    // visibility signal that something is out of order.
    await db
      .prepare(
        "UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?",
      )
      .bind(refundQty, wipLabel)
      .run();
    // Refund the upstream sibling that the becomingActive branch consumed.
    // FAB_CUT and WOOD_CUT have no upstream so they skip the refund —
    // matches the forward path's `!isFabCut && !isWoodCut && !isUpholstery`
    // gate. Sibling lookup matches by (wipKey, branchKey) — within one
    // wipKey there can be multiple parallel BOM branches that share the
    // wipKey but never each other's upstream/downstream (BUG-2026-04-27:
    // Wood Cut completion was wrongly consuming Fab Sew stock because the
    // old wipKey-only filter pulled siblings from both branches).
    if (!isFabCut && !isWoodCut && wipKey) {
      const myBranch = jcRow.branchKey ?? "";
      const children = allJcRows
        .filter(
          (j) =>
            j.wipKey === wipKey &&
            (j.branchKey ?? "") === myBranch &&
            j.sequence < jcRow.sequence,
        )
        .sort((a, b) => b.sequence - a.sequence);
      const child = children[0];
      if (child?.wipLabel) {
        await db
          .prepare(
            "UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?",
          )
          .bind(refundQty, child.wipLabel)
          .run();
      }
    }
    return;
  }

  // FAB_CUT and WOOD_CUT are producer-only stages — nothing upstream to
  // consume. UPH has its own consume-all-upstream logic in the COMPLETED
  // branch below.
  if (!isFabCut && !isWoodCut && !isUpholstery && becomingActive) {
    // Per-component upstream consume — sibling lookup is now BOM-branch
    // aware (BUG-2026-04-27 fix, migration 0058). Within one wipKey
    // ("DIVAN" / "HEADBOARD" / "SOFA_*") the BOM has parallel branches
    // (e.g. BF Divan: Foam-branch wood chain || Fabric-branch fab chain)
    // that converge only at UPHOLSTERY. The previous wipKey + sequence
    // heuristic flattened them into one chain and a Wood Cut completion
    // wrongly consumed Fab Sew stock (Wei Siang report 2026-04-27).
    // Filter siblings by (wipKey, branchKey) so each branch's consume
    // only reaches its own true upstream.
    if (wipKey) {
      const myBranch = jcRow.branchKey ?? "";
      const children = allJcRows
        .filter(
          (j) =>
            j.wipKey === wipKey &&
            (j.branchKey ?? "") === myBranch &&
            j.sequence < jcRow.sequence,
        )
        .sort((a, b) => b.sequence - a.sequence);
      const child = children[0];
      if (child?.wipLabel) {
        const consumeQty = jcRow.wipQty || poRow.quantity || 1;
        // BUG-2026-04-27-013: cascade consume always decrements (no MAX
        // clamp). If the upstream wip_items row doesn't exist (because
        // the upstream JC was skipped / never completed), INSERT one
        // with stock_qty = -consumeQty so the negative number surfaces
        // the missed dept on the WIP board.
        const upstream = await db
          .prepare("SELECT id, stockQty FROM wip_items WHERE code = ?")
          .bind(child.wipLabel)
          .first<{ id: string; stockQty: number }>();
        if (upstream) {
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = stockQty - ? WHERE id = ?",
            )
            .bind(consumeQty, upstream.id)
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
               VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
            )
            .bind(
              `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
              child.wipLabel,
              shortType,
              poRow.productCode ?? "",
              "PENDING",
              -consumeQty,
            )
            .run();
        }
      }
    }
    // For IN_PROGRESS-only we stop here — COMPLETED falls through to
    // upsert its own wip_items row via the COMPLETED branch below.
    if (newStatus === "IN_PROGRESS") return;
  }

  if (newStatus === "COMPLETED" || newStatus === "TRANSFERRED") {
    if (isUpholstery) {
      // UPH completion semantics (per user's accounting model):
      //   1. SUBTRACT wipQty from each upstream wipKey sibling's stockQty
      //      (was "zero out the lot" — wrong when the wip_items row covers
      //      a higher cumulative qty than this UPH wave: e.g., Fab Sew has
      //      13 in stock, this UPH consumed 7, the remaining 6 should
      //      stay visible, not zero).
      //   2. Upsert UPH's OWN wip_items row so the inventory board shows
      //      "completed-by-Upholstery" stock until Packing picks it up.
      const consumeQty = jcRow.wipQty || poRow.quantity || 1;
      if (wipKey) {
        // BUG-2026-04-27-014: UPH only consumes the BRANCH TERMINAL of each
        // BOM branch — i.e., within each branchKey, the JC at the highest
        // sequence below UPH's. Earlier upstreams in the chain are NOT
        // UPH's direct upstream; their stock is consumed by their own
        // direct downstream dept (FRAMING consumes WOOD_CUT, WEBBING
        // consumes FRAMING, etc.). Per the user: "Webbing missing should
        // not also make Framing/WoodCut negative — those would only go
        // negative if Webbing itself were marked complete with
        // Framing/WoodCut missing." The previous code flattened every
        // upstream wipKey sibling into a Set and decremented all of them,
        // which for a sofa Base BOM (6 upstream JCs) wrote 6 separate
        // -consumeQty entries instead of 2 (one per branch terminal).
        const byBranch = new Map<string, JobCardRow>();
        for (const j of allJcRows) {
          if (j.wipKey !== wipKey) continue;
          if (j.sequence >= jcRow.sequence) continue;
          if (!j.wipLabel) continue;
          const bk = j.branchKey ?? "";
          const cur = byBranch.get(bk);
          if (!cur || j.sequence > cur.sequence) {
            byBranch.set(bk, j);
          }
        }
        for (const [, terminal] of byBranch) {
          const label = terminal.wipLabel!;
          // BUG-2026-04-27-013: cascade consume always decrements (no
          // MAX clamp). If the upstream wip_items row doesn't exist
          // (upstream dept was skipped), INSERT one with negative qty
          // so the WIP board surfaces the missed dept.
          const upstream = await db
            .prepare("SELECT id, stockQty FROM wip_items WHERE code = ?")
            .bind(label)
            .first<{ id: string; stockQty: number }>();
          if (upstream) {
            await db
              .prepare(
                "UPDATE wip_items SET stockQty = stockQty - ? WHERE id = ?",
              )
              .bind(consumeQty, upstream.id)
              .run();
          } else {
            await db
              .prepare(
                `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
              )
              .bind(
                `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
                label,
                shortType,
                poRow.productCode ?? "",
                "PENDING",
                -consumeQty,
              )
              .run();
          }
        }
      }
      // Add UPH's own wip_items row (treat UPH like every other producer
      // dept).  Prior code skipped this and left FG derivation to the
      // frontend — but the user wants visible per-dept WIP rows, and the
      // upsert is idempotent so multiple UPH JCs in the same wipKey
      // accumulate correctly.
      if (wipLabel) {
        const existingUph = await db
          .prepare("SELECT id, stockQty FROM wip_items WHERE code = ?")
          .bind(wipLabel)
          .first<{ id: string; stockQty: number }>();
        if (existingUph) {
          await db
            .prepare(
              "UPDATE wip_items SET stockQty = ?, deptStatus = ?, status = 'COMPLETED' WHERE id = ?",
            )
            .bind(
              (existingUph.stockQty || 0) + consumeQty,
              "UPHOLSTERY",
              existingUph.id,
            )
            .run();
        } else {
          await db
            .prepare(
              `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
               VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED')`,
            )
            .bind(
              `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
              wipLabel,
              shortType,
              poRow.productCode ?? "",
              "UPHOLSTERY",
              consumeQty,
            )
            .run();
        }
      }
      return;
    }

    // Non-UPH dept: upsert-by-code, accumulate stock on each completion.
    const existing = await db
      .prepare("SELECT id, stockQty FROM wip_items WHERE code = ?")
      .bind(wipLabel)
      .first<{ id: string; stockQty: number }>();
    if (existing) {
      await db
        .prepare(
          "UPDATE wip_items SET stockQty = ?, deptStatus = ?, status = 'COMPLETED' WHERE id = ?",
        )
        .bind(
          (existing.stockQty || 0) + wipQty,
          jcRow.departmentCode ?? "",
          existing.id,
        )
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
           VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED')`,
        )
        .bind(
          `wip-dyn-${crypto.randomUUID().slice(0, 8)}`,
          wipLabel,
          shortType,
          poRow.productCode ?? "",
          jcRow.departmentCode ?? "",
          wipQty,
        )
        .run();
    }
    return;
  }

  if (newStatus === "IN_PROGRESS") {
    const isFabSew =
      (jcRow.departmentCode || "").toUpperCase() === "FAB_SEW";
    const isSofa = (poRow.itemCategory || "").toUpperCase() === "SOFA";

    // Sofa Fab Sew special case: the Fab Cut merge groups a full sofa
    // set (1A(LHF) + 1NA + 1A(RHF) sharing the same bolt) into one
    // sticker. The moment Fab Sew picks up the stack to start sewing
    // ANY piece of the set, the whole batch has left Fab Cut's shelf
    // — it's physically impossible to only grab one. So the first
    // FAB_SEW IN_PROGRESS in a (SO, fabric) group zeroes every
    // upstream FAB_CUT wip_items row in that group. Subsequent sibling
    // FAB_SEW scans are no-ops because the stock is already 0.
    if (isFabSew && isSofa && poRow.salesOrderId && poRow.fabricCode) {
      const siblingLabels = await db
        .prepare(
          `SELECT DISTINCT jc.wipLabel AS "wipLabel"
             FROM production_orders po
             JOIN job_cards jc ON jc.productionOrderId = po.id
            WHERE po.salesOrderId = ?
              AND po.fabricCode = ?
              AND po.itemCategory = 'SOFA'
              AND jc.departmentCode = 'FAB_CUT'
              AND jc.wipLabel IS NOT NULL`,
        )
        .bind(poRow.salesOrderId, poRow.fabricCode)
        .all<{ wipLabel: string | null }>();
      const labels = (siblingLabels.results ?? [])
        .map((r) => r.wipLabel)
        .filter((l): l is string => !!l);
      for (const label of labels) {
        await db
          .prepare(
            "UPDATE wip_items SET stockQty = 0, status = 'IN_PRODUCTION' WHERE code = ?",
          )
          .bind(label)
          .run();
      }
      return;
    }

    // Default path (BF / accessory / non-sofa Fab Sew chains): consume
    // the immediate upstream wip_items row within the same (wipKey,
    // branchKey) by this JC's own qty. Per-JC consumption — each child
    // scan decrements exactly its own share. (wipKey, branchKey) match
    // is BOM-branch aware (see migration 0058).
    const myBranch = jcRow.branchKey ?? "";
    const children = allJcRows
      .filter(
        (j) =>
          j.wipKey === wipKey &&
          (j.branchKey ?? "") === myBranch &&
          j.sequence < jcRow.sequence,
      )
      .sort((a, b) => b.sequence - a.sequence);
    const child = children[0];
    if (!child || !child.wipLabel) return;

    const entry = await db
      .prepare("SELECT id, stockQty FROM wip_items WHERE code = ?")
      .bind(child.wipLabel)
      .first<{ id: string; stockQty: number }>();
    if (entry && entry.stockQty > 0) {
      const remaining = Math.max(0, entry.stockQty - wipQty);
      await db
        .prepare(
          `UPDATE wip_items SET stockQty = ?, status = ? WHERE id = ?`,
        )
        .bind(
          remaining,
          remaining === 0 ? "IN_PRODUCTION" : "COMPLETED",
          entry.id,
        )
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// Cascade Upholstery completion → SO READY_TO_SHIP + stockedIn flags.
// Mirrors the in-memory cascadeUpholsteryToSO().
// ---------------------------------------------------------------------------
async function cascadeUpholsteryToSO(
  db: D1Database,
  poId: string,
): Promise<void> {
  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po || !po.salesOrderId) return;
  const so = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(po.salesOrderId)
    .first<{ id: string; status: string }>();
  if (!so) return;

  const siblings = await db
    .prepare("SELECT * FROM production_orders WHERE salesOrderId = ?")
    .bind(so.id)
    .all<ProductionOrderRow>();
  const siblingPOs = siblings.results ?? [];
  if (siblingPOs.length === 0) return;

  // Load all upholstery job cards for siblings in one go.
  const sibIds = siblingPOs.map((p) => p.id);
  const placeholders = sibIds.map(() => "?").join(",");
  const uphRes = await db
    .prepare(
      `SELECT * FROM job_cards WHERE departmentCode = 'UPHOLSTERY' AND productionOrderId IN (${placeholders})`,
    )
    .bind(...sibIds)
    .all<JobCardRow>();
  const uphJcs = uphRes.results ?? [];
  if (uphJcs.length === 0) return;

  const everyUphDone = siblingPOs.every((p) => {
    const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
    if (mine.length === 0) return true;
    return mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED");
  });

  const now = new Date().toISOString();
  if (everyUphDone) {
    for (const p of siblingPOs) {
      const mine = uphJcs.filter((j) => j.productionOrderId === p.id);
      if (
        mine.length > 0 &&
        mine.every((j) => j.status === "COMPLETED" || j.status === "TRANSFERRED")
      ) {
        await db
          .prepare("UPDATE production_orders SET stockedIn = 1 WHERE id = ?")
          .bind(p.id)
          .run();
      }
    }
    if (so.status !== "READY_TO_SHIP") {
      await db
        .prepare(
          "UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
        )
        .bind(now, so.id)
        .run();
    }
  } else if (so.status === "READY_TO_SHIP") {
    await db
      .prepare(
        "UPDATE sales_orders SET status = 'CONFIRMED', updated_at = ? WHERE id = ?",
      )
      .bind(now, so.id)
      .run();
  }
}

// Cascade when a PO itself reaches COMPLETED (not just Upholstery). Bumps SO
// to READY_TO_SHIP once every sibling is fully done.
async function cascadePoCompletionToSO(
  db: D1Database,
  salesOrderId: string | null,
): Promise<void> {
  if (!salesOrderId) return;
  const so = await db
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(salesOrderId)
    .first<{ id: string; status: string }>();
  if (!so) return;
  const siblings = await db
    .prepare("SELECT status FROM production_orders WHERE salesOrderId = ?")
    .bind(salesOrderId)
    .all<{ status: string }>();
  const sibList = siblings.results ?? [];
  const allDone = sibList.length > 0 && sibList.every((p) => p.status === "COMPLETED");
  if (allDone && so.status !== "READY_TO_SHIP") {
    await db
      .prepare(
        "UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ? WHERE id = ?",
      )
      .bind(new Date().toISOString(), salesOrderId)
      .run();
  }
}

// Track F cost cascade lives in ../lib/po-cost-cascade.ts and is wired
// through postProductionOrderCompletion() + postJobCardLabor() below.

// ---------------------------------------------------------------------------
// Core PO-update logic shared between PUT and PATCH.
// ---------------------------------------------------------------------------
async function applyPoUpdate(
  c: Context<Env>,
  id: string,
): Promise<Response> {
  const db = c.var.DB;
  const existing = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(id)
    .first<ProductionOrderRow>();
  if (!existing) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  const body = await c.req.json();
  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];

  // Load all job cards for this PO — used for wip-cascade and progress calc.
  const jcRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(id)
    .all<JobCardRow>();
  const allJcRows = jcRes.results ?? [];

  let updatedPoStatus = existing.status;
  let updatedProgress = existing.progress;
  let updatedCurrentDept = existing.currentDepartment ?? "";
  let updatedCompletedDate = existing.completedDate;

  if (body.jobCardId) {
    const jcRow = allJcRows.find((j) => j.id === body.jobCardId);
    if (!jcRow) {
      return c.json({ success: false, error: "Job card not found" }, 404);
    }

    // ---- PO lock guard -----------------------------------------------------
    // If the parent PO is ON_HOLD or CANCELLED, reject any job-card mutation
    // from this endpoint. Mirrors the scan-complete guard so the shop floor
    // and admin PATCH path agree: paused/cancelled work cannot advance until
    // the SO supervisor resumes or reopens the order.
    if (existing.status === "ON_HOLD" || existing.status === "CANCELLED") {
      return c.json(
        {
          success: false,
          code: "PO_LOCKED",
          error: `Cannot modify job card — parent PO is ${existing.status}.`,
        },
        409,
      );
    }

    // Upstream-lock disabled (2026-04-26, user request).
    //
    // The wipKey + sequence predicate doesn't model the BOM tree's parallel
    // branches: within one wipKey ("DIVAN" / "HEADBOARD" / "SOFA_*") the
    // FAB chain (FAB_CUT→FAB_SEW…) and WOOD chain (WOOD_CUT→FRAMING→
    // WEBBING…) run independently and only converge at UPHOLSTERY. The
    // previous predicate treated WOOD_CUT (sequence 3) as downstream of
    // FAB_CUT/FAB_SEW (sequences 1/2), so completing Wood Cut wrongly 409'd
    // pure-date edits on the fabric branch. Frontend lock UI is also a
    // no-op (see src/pages/production/index.tsx buildSched). Will be
    // restored once the lock chain is derived from the actual BOM template
    // at runtime.

    // Mutate a shallow copy — final UPDATE statement below writes it.
    const updated: JobCardRow = { ...jcRow };

    if (body.status) {
      updated.status = body.status;
      const isDone = body.status === "COMPLETED" || body.status === "TRANSFERRED";
      const wasDone =
        jcRow.status === "COMPLETED" || jcRow.status === "TRANSFERRED";
      if (isDone) {
        if (!updated.completedDate) updated.completedDate = today;
        updated.overdue = "COMPLETED";
      } else if (wasDone && body.completedDate === undefined) {
        // BUG-2026-04-27-001: previously cleared completedDate on ANY
        // non-DONE status change (including WAITING → IN_PROGRESS, which
        // shouldn't touch the date). Now only clear when the JC is
        // genuinely transitioning OUT of a DONE state — i.e. the user is
        // un-completing it. Other status touches (PIC re-assign that
        // re-sends status, due-date edit that includes status) leave the
        // date alone.
        updated.completedDate = null;
      }
    }

    if (body.completedDate !== undefined) {
      updated.completedDate = body.completedDate || null;
    }

    if (body.pic1Id !== undefined) {
      updated.pic1Id = body.pic1Id;
      if (body.pic1Id) {
        const w = await db
          .prepare("SELECT name FROM workers WHERE id = ?")
          .bind(body.pic1Id)
          .first<{ name: string }>();
        updated.pic1Name = w?.name ?? "";
      } else {
        updated.pic1Name = "";
      }
    }
    if (body.pic2Id !== undefined) {
      updated.pic2Id = body.pic2Id;
      if (body.pic2Id) {
        const w = await db
          .prepare("SELECT name FROM workers WHERE id = ?")
          .bind(body.pic2Id)
          .first<{ name: string }>();
        updated.pic2Name = w?.name ?? "";
      } else {
        updated.pic2Name = "";
      }
    }

    if (body.actualMinutes !== undefined) {
      updated.actualMinutes = body.actualMinutes;
    }
    if (body.dueDate !== undefined) updated.dueDate = body.dueDate;
    if (body.rackingNumber !== undefined) {
      updated.rackingNumber = body.rackingNumber;
    }

    await db
      .prepare(
        `UPDATE job_cards SET
           status = ?, completedDate = ?, pic1Id = ?, pic1Name = ?,
           pic2Id = ?, pic2Name = ?, actualMinutes = ?, dueDate = ?,
           rackingNumber = ?, overdue = ?
         WHERE id = ?`,
      )
      .bind(
        updated.status,
        updated.completedDate,
        updated.pic1Id,
        updated.pic1Name,
        updated.pic2Id,
        updated.pic2Name,
        updated.actualMinutes,
        updated.dueDate,
        updated.rackingNumber,
        updated.overdue,
        updated.id,
      )
      .run();

    // Phase 6 — parallel event log. Diff the JC snapshot before/after and
    // append one row per field that actually changed. `actorUserId` is
    // stashed on the Hono ctx by authMiddleware; for worker-portal calls
    // it's absent (the PIN flow mounts under /api/worker/* which bypasses
    // the dashboard auth gate), so actorUserId may legitimately be null.
    // Source is 'ui' here — the shop-floor scan path lives in its own
    // handler (scan-complete) and will wire its own 'scan' source later.
    const actorUserId = (c.get as unknown as (k: string) => string | undefined)(
      "userId",
    ) ?? null;
    const events = diffJobCardEvents(jcRow, updated, {
      actorUserId,
      actorName: null,
      source: "ui",
    });
    if (events.length > 0) {
      // Batch the event INSERTs so we pay one round-trip regardless of
      // how many fields changed. Event-write failures do NOT roll back the
      // JC UPDATE (already run()), so a batch reject here just means we
      // lose audit rows for this one mutation — acceptable for a v1
      // parallel write path. Any failure will surface in wrangler tail.
      const stmts = events.map((e) => buildJobCardEventStatement(db, e));
      try {
        await db.batch(stmts);
      } catch (err) {
        console.error("[jc-events] append failed", err);
      }
    }

    // Update WIP inventory if status changed.
    //
    // Defensive try/catch (Bug 3, 2026-04-26): a runtime exception inside the
    // WIP cascade — a missing wip_items row, a transient D1 hiccup, a
    // synthesized-label collision — used to bubble up to Hono's default 500
    // handler and surface as "Update applied to 0/1 components" in the UI,
    // even though the job_card UPDATE at line 1383 already committed. The
    // cascade is supplementary inventory bookkeeping; failing it must NOT
    // void the operator's primary write. Log + continue so the PATCH still
    // returns 200 + the updated payload.
    if (body.status) {
      const refreshed = allJcRows.map((j) => (j.id === updated.id ? updated : j));
      try {
        // Pass prevStatus (jcRow.status, the pre-update value) so the
        // cascade can detect a DONE → non-DONE rollback and reverse the
        // forward consume + producer-add. See BUG-2026-04-27-002.
        await applyWipInventoryChange(
          db,
          existing,
          updated,
          body.status,
          refreshed,
          jcRow.status,
        );
      } catch (err) {
        console.error("[applyWipInventoryChange] cascade failed", {
          poId: id,
          jobCardId: updated.id,
          dept: updated.departmentCode,
          status: body.status,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // F2 — labor cost posting on job_card COMPLETED/TRANSFERRED transition.
    // Idempotent: postJobCardLabor checks cost_ledger for existing LABOR_POSTED
    // entries keyed by refType='JOB_CARD', refId=jc.id.
    //
    // Same defensive wrap as above — a labor-ledger insert failure must not
    // void the JC status flip. The ledger write is recoverable separately
    // (idempotent re-run via PATCH), so swallowing once is safe.
    if (
      body.status &&
      (body.status === "COMPLETED" || body.status === "TRANSFERRED")
    ) {
      try {
        await postJobCardLabor(db, updated.id, existing.id);
      } catch (err) {
        console.error("[postJobCardLabor] cascade failed", {
          poId: id,
          jobCardId: updated.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Recalculate progress / PO status.
    const refreshedJcs = allJcRows.map((j) => (j.id === updated.id ? updated : j));
    const completedCount = refreshedJcs.filter(
      (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
    ).length;
    updatedProgress = Math.round((completedCount / refreshedJcs.length) * 100);

    if (completedCount === refreshedJcs.length) {
      updatedPoStatus = "COMPLETED";
      updatedCompletedDate = today;
      // postProductionOrderCompletion (FG + Track F cost cascade) runs
      // after the production_orders UPDATE below.
    } else {
      updatedPoStatus = "IN_PROGRESS";
      updatedCompletedDate = null;
    }

    const activeDept = refreshedJcs.find(
      (j) => j.status === "IN_PROGRESS" || j.status === "WAITING",
    );
    updatedCurrentDept = activeDept?.departmentCode ?? "PACKING";
  }

  // PO-level scalar fields.
  const newTargetEnd =
    body.targetEndDate !== undefined ? body.targetEndDate : existing.targetEndDate;
  const newRackingNumber =
    body.rackingNumber !== undefined
      ? body.rackingNumber
      : existing.rackingNumber;
  const newStockedIn =
    body.stockedIn !== undefined
      ? body.stockedIn
        ? 1
        : 0
      : existing.stockedIn;

  await db
    .prepare(
      `UPDATE production_orders SET
         status = ?, progress = ?, currentDepartment = ?, completedDate = ?,
         targetEndDate = ?, rackingNumber = ?, stockedIn = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      updatedPoStatus,
      updatedProgress,
      updatedCurrentDept,
      updatedCompletedDate,
      newTargetEnd,
      newRackingNumber,
      newStockedIn,
      nowIso,
      id,
    )
    .run();

  // SO cascades.  Wrapped in try/catch for the same reason as the WIP +
  // labor cascades above (Bug 3, 2026-04-26): a downstream cascade failure
  // must not void the JC + PO scalar UPDATEs that already committed.
  if (body.jobCardId && updatedPoStatus === "COMPLETED") {
    // Auto-generate FG units + fg_batches row on PO completion. Idempotent:
    // postProductionOrderCompletion short-circuits if fg_units already exist
    // for this PO, and the fg_batches insert is guarded by productionOrderId.
    try {
      await postProductionOrderCompletion(db, id);
    } catch (err) {
      console.error("[postProductionOrderCompletion] cascade failed", {
        poId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await cascadePoCompletionToSO(db, existing.salesOrderId);
    } catch (err) {
      console.error("[cascadePoCompletionToSO] cascade failed", {
        poId: id,
        soId: existing.salesOrderId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    await cascadeUpholsteryToSO(db, id);
  } catch (err) {
    console.error("[cascadeUpholsteryToSO] cascade failed", {
      poId: id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const fresh = await fetchPO(db, id);
  return c.json({ success: true, data: fresh });
}

// ---------------------------------------------------------------------------
// ROUTES
// Order matters: specific routes BEFORE /:id.
// ---------------------------------------------------------------------------

// GET /api/production-orders
//
// Query params (all optional; omitting them preserves backward-compatible
// "return everything with JCs inlined" behavior for any legacy consumer):
//
//   ?status=PENDING,IN_PROGRESS,ON_HOLD
//     Comma-separated list. Applied as SQL `WHERE status IN (...)` so we
//     don't ship COMPLETED/CANCELLED POs to the Production page.
//
//   ?include=jobCards
//     Whether to inline job_cards (and piece_pics) on each PO. Defaults to
//     `jobCards` (included) to stay backward-compatible. Callers that only
//     need PO headers can pass `?include=` to skip the JC joins.
//
//   ?page=N&limit=M
//     Opt-in pagination. When either is supplied, response includes
//     { page, limit } and `data` is sliced. When both omitted, the full
//     result set is returned (backward compatible). Default page=1,
//     default limit=50, hard cap limit=500. Slicing happens AFTER status
//     filter and AFTER rowToPO shaping, so `total` is always the filtered
//     total (not the page length).
//
//   ?includeArchive=true
//     Phase-5 historical-report hook. When set, UNIONs
//     production_orders + production_orders_archive (and same for
//     job_cards) before filtering/ordering. Default off — hot only.
app.get("/", async (c) => {
  const statusParam = c.req.query("status");
  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;

  const includeParam = c.req.query("include");
  // Backward compat: if `include` is not passed at all, inline jobCards.
  // If it IS passed, only include jobCards when the list contains "jobCards".
  const includeJobCards =
    includeParam === undefined
      ? true
      : includeParam
          .split(",")
          .map((s) => s.trim())
          .includes("jobCards");

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const includeArchive = c.req.query("includeArchive") === "true";
  // Opt-in slim payload for the Production page: drops ~20 unused PO fields
  // and the whole piece_pics tree. Default stays full-response for backward
  // compat (the PO detail page + other consumers need the full shape).
  const minimal = c.req.query("fields") === "minimal";
  // Opt-in dept-narrowing: when present, each PO's jobCards array is
  // filtered at SQL level to only the given dept code. Used by the
  // per-department pages (/production/fab-cut etc.) so they never ship
  // the other 7 depts' JC rows.
  const deptParamRaw = c.req.query("dept");
  const deptFilter =
    deptParamRaw && deptParamRaw.trim().length > 0
      ? deptParamRaw.trim().toUpperCase()
      : null;

  if (!paginate) {
    const data = await fetchFilteredPOs(
      c.var.DB,
      statuses,
      includeJobCards,
      includeArchive,
      minimal,
      deptFilter,
    );
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const { data, total } = await fetchPaginatedPOs(
    c.var.DB,
    statuses,
    includeJobCards,
    page,
    limit,
    includeArchive,
    minimal,
    deptFilter,
  );
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-wips
// Distinct WIPs that have appeared in any JobCard to date.
// ---------------------------------------------------------------------------
app.get("/historical-wips", async (c) => {
  const all = await fetchAllPOs(c.var.DB);
  type H = {
    wipLabel: string;
    wipKey?: string;
    wipCode?: string;
    wipType?: string;
    sourcePoId: string;
    sourceJcId: string;
    sourcePoNo: string;
    itemCategory: string;
    productCode: string;
    productName: string;
    sizeCode: string;
    sizeLabel: string;
    fabricCode: string;
    lastSeen: string;
  };
  const seen = new Map<string, H>();
  for (const po of all) {
    for (const jc of po.jobCards) {
      if (!jc.wipLabel) continue;
      const key = `${jc.wipLabel}::${jc.wipKey ?? ""}::${po.sizeCode}::${po.fabricCode}`;
      const prev = seen.get(key);
      if (!prev || (po.createdAt || "") > (prev.lastSeen || "")) {
        seen.set(key, {
          wipLabel: jc.wipLabel,
          wipKey: jc.wipKey,
          wipCode: jc.wipCode,
          wipType: jc.wipType,
          sourcePoId: po.id,
          sourceJcId: jc.id,
          sourcePoNo: po.poNo,
          itemCategory: po.itemCategory,
          productCode: po.productCode,
          productName: po.productName,
          sizeCode: po.sizeCode,
          sizeLabel: po.sizeLabel,
          fabricCode: po.fabricCode,
          lastSeen: po.createdAt || "",
        });
      }
    }
  }
  const list = Array.from(seen.values()).sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
    return a.wipLabel.localeCompare(b.wipLabel);
  });
  return c.json({ success: true, data: list });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-fgs
// ---------------------------------------------------------------------------
app.get("/historical-fgs", async (c) => {
  const all = await fetchAllPOs(c.var.DB);
  type H = {
    sourcePoId: string;
    sourcePoNo: string;
    itemCategory: string;
    productCode: string;
    productName: string;
    sizeCode: string;
    sizeLabel: string;
    fabricCode: string;
    lastSeen: string;
  };
  const seen = new Map<string, H>();
  for (const po of all) {
    const key = `${po.productCode}::${po.sizeCode}::${po.fabricCode}`;
    const prev = seen.get(key);
    if (!prev || (po.createdAt || "") > (prev.lastSeen || "")) {
      seen.set(key, {
        sourcePoId: po.id,
        sourcePoNo: po.poNo,
        itemCategory: po.itemCategory,
        productCode: po.productCode,
        productName: po.productName,
        sizeCode: po.sizeCode,
        sizeLabel: po.sizeLabel,
        fabricCode: po.fabricCode,
        lastSeen: po.createdAt || "",
      });
    }
  }
  const list = Array.from(seen.values()).sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
    return a.productName.localeCompare(b.productName);
  });
  return c.json({ success: true, data: list });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/stock — create a WIP-only or full-FG stock PO.
//
// Clones the source PO's jobCards (filtered by wipKey for WIP mode, or all
// for FG mode), resets worker-side state, generates a placeholder SOH SO,
// and creates a new PO linked to it.
// ---------------------------------------------------------------------------
app.post("/stock", async (c) => {
  const db = c.var.DB;
  const body = await c.req.json().catch(() => ({}));
  const type = body?.type as "WIP" | "FG" | undefined;
  const sourcePoId = body?.sourcePoId as string | undefined;
  const sourceJcId = body?.sourceJcId as string | undefined;
  const quantity = Math.max(1, Math.floor(Number(body?.quantity) || 0));
  const targetEndDate = body?.targetEndDate as string | undefined;

  if (type !== "WIP" && type !== "FG") {
    return c.json({ success: false, error: "type must be WIP or FG" }, 400);
  }
  if (!sourcePoId) {
    return c.json({ success: false, error: "sourcePoId is required" }, 400);
  }
  if (type === "WIP" && !sourceJcId) {
    return c.json(
      { success: false, error: "sourceJcId is required for WIP stock PO" },
      400,
    );
  }
  if (!quantity) {
    return c.json({ success: false, error: "quantity must be >= 1" }, 400);
  }
  if (!targetEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetEndDate)) {
    return c.json(
      { success: false, error: "targetEndDate must be YYYY-MM-DD" },
      400,
    );
  }

  const sourcePO = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(sourcePoId)
    .first<ProductionOrderRow>();
  if (!sourcePO) {
    return c.json({ success: false, error: "Source PO not found" }, 404);
  }
  const sourceJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(sourcePoId)
    .all<JobCardRow>();
  const sourceJcs = sourceJcsRes.results ?? [];

  let jcsToCopy: JobCardRow[];
  let selectedWipLabel = "";
  if (type === "WIP") {
    const sourceJc = sourceJcs.find((j) => j.id === sourceJcId);
    if (!sourceJc) {
      return c.json(
        { success: false, error: "Source JC not found on source PO" },
        404,
      );
    }
    selectedWipLabel = sourceJc.wipLabel || "";
    if (sourceJc.wipKey) {
      jcsToCopy = sourceJcs.filter((j) => j.wipKey === sourceJc.wipKey);
    } else {
      jcsToCopy = [sourceJc];
    }
  } else {
    jcsToCopy = [...sourceJcs];
  }
  if (jcsToCopy.length === 0) {
    return c.json(
      { success: false, error: "No jobCards to clone from source PO" },
      422,
    );
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];

  // Generate SOH + new SO row.
  const sohNo = await nextSOHNumber(db);
  const soId = genSoId();

  const newItem = {
    id: genItemId(),
    lineNo: 1,
    lineSuffix: "-01",
    productId: sourcePO.productId,
    productCode: sourcePO.productCode,
    productName: sourcePO.productName,
    itemCategory: sourcePO.itemCategory,
    sizeCode: sourcePO.sizeCode,
    sizeLabel: sourcePO.sizeLabel,
    fabricId: "",
    fabricCode: sourcePO.fabricCode,
    quantity,
    gapInches: sourcePO.gapInches,
    divanHeightInches: sourcePO.divanHeightInches,
    divanPriceSen: 0,
    legHeightInches: sourcePO.legHeightInches,
    legPriceSen: 0,
    specialOrder: sourcePO.specialOrder || "",
    specialOrderPriceSen: 0,
    basePriceSen: 0,
    unitPriceSen: 0,
    lineTotalSen: 0,
    notes: type === "WIP" ? `Stock WIP: ${selectedWipLabel}` : "Stock FG",
  };

  // Clone job cards — reset worker state; adjust wipQty proportional to new qty.
  const sourceQty = Math.max(1, sourcePO.quantity || 1);
  const minSeq = jcsToCopy.reduce(
    (m, j) => (j.sequence < m ? j.sequence : m),
    jcsToCopy[0].sequence,
  );

  const newJcIds = jcsToCopy.map(() => genJcId());
  const newPoId = genPoId();
  const newPoNo = `${sohNo}-01`;

  const statements: D1PreparedStatement[] = [];

  // Insert stock SO.
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
            customerSO, customerSOId, reference, customerId, customerName,
            customerState, hubId, hubName, companySO, companySOId, companySODate,
            customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
            subtotalSen, totalSen, status, overdue, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        soId,
        "",
        "",
        "",
        "",
        "",
        type === "WIP" ? `Stock WIP (${selectedWipLabel})` : "Stock FG",
        "", // customerId — stock SO has no customer; NOT NULL but empty string OK
        "— Stock —",
        "",
        null,
        null,
        sohNo,
        sohNo,
        today,
        targetEndDate,
        targetEndDate,
        "",
        0,
        0,
        "DRAFT",
        "PENDING",
        "Stock placeholder — will be renamed to the customer SO when a real order lands.",
        nowIso,
        nowIso,
      ),
  );

  // Insert minimal SO item so downstream readers don't crash.
  statements.push(
    db
      .prepare(
        `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
           productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
           fabricId, fabricCode, quantity, gapInches, divanHeightInches,
           divanPriceSen, legHeightInches, legPriceSen, specialOrder,
           specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newItem.id,
        soId,
        newItem.lineNo,
        newItem.lineSuffix,
        newItem.productId,
        newItem.productCode,
        newItem.productName,
        newItem.itemCategory,
        newItem.sizeCode,
        newItem.sizeLabel,
        newItem.fabricId,
        newItem.fabricCode,
        newItem.quantity,
        newItem.gapInches,
        newItem.divanHeightInches,
        newItem.divanPriceSen,
        newItem.legHeightInches,
        newItem.legPriceSen,
        newItem.specialOrder,
        newItem.specialOrderPriceSen,
        newItem.basePriceSen,
        newItem.unitPriceSen,
        newItem.lineTotalSen,
        newItem.notes,
      ),
  );

  // Find first dept — for PO.currentDepartment.
  const firstDept = [...jcsToCopy].sort((a, b) => a.sequence - b.sequence)[0]
    ?.departmentCode || "WOOD_CUT";

  // Insert PO.
  statements.push(
    db
      .prepare(
        `INSERT INTO production_orders (id, poNo, salesOrderId, salesOrderNo, lineNo,
           customerPOId, customerReference, customerName, customerState, companySOId,
           productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
           fabricCode, quantity, gapInches, divanHeightInches, legHeightInches,
           specialOrder, notes, status, currentDepartment, progress, startDate,
           targetEndDate, completedDate, rackingNumber, stockedIn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newPoId,
        newPoNo,
        soId,
        sohNo,
        1,
        "",
        type === "WIP" ? `Stock WIP (${selectedWipLabel})` : "Stock FG",
        "— Stock —",
        "",
        sohNo,
        sourcePO.productId,
        sourcePO.productCode,
        sourcePO.productName,
        sourcePO.itemCategory,
        sourcePO.sizeCode,
        sourcePO.sizeLabel,
        sourcePO.fabricCode,
        quantity,
        sourcePO.gapInches,
        sourcePO.divanHeightInches,
        sourcePO.legHeightInches,
        sourcePO.specialOrder || "",
        type === "WIP"
          ? `Stock PO — WIP only (${selectedWipLabel}). Cloned from ${sourcePO.poNo}.`
          : `Stock PO — FG. Cloned from ${sourcePO.poNo}.`,
        "PENDING",
        firstDept,
        0,
        today,
        targetEndDate,
        null,
        "",
        0,
        nowIso,
        nowIso,
      ),
  );

  // Insert job cards.
  for (let i = 0; i < jcsToCopy.length; i++) {
    const jc = jcsToCopy[i];
    const newId = newJcIds[i];
    const perUnit = (jc.wipQty ?? sourceQty) / sourceQty;
    const newWipQty = Math.max(1, Math.round(perUnit * quantity));
    statements.push(
      db
        .prepare(
          `INSERT INTO job_cards (id, productionOrderId, departmentId, departmentCode,
             departmentName, sequence, status, dueDate, wipKey, wipCode, wipType,
             wipLabel, wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name,
             completedDate, estMinutes, actualMinutes, category,
             productionTimeMinutes, overdue, rackingNumber, branchKey)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId,
          newPoId,
          jc.departmentId,
          jc.departmentCode,
          jc.departmentName,
          jc.sequence,
          "WAITING",
          targetEndDate,
          jc.wipKey,
          jc.wipCode,
          jc.wipType,
          jc.wipLabel,
          newWipQty,
          jc.sequence === minSeq ? 1 : 0,
          null,
          "",
          null,
          "",
          null,
          jc.estMinutes,
          null,
          jc.category,
          jc.productionTimeMinutes,
          "PENDING",
          null,
          // Inherit the source JC's branchKey (clone path — same BOM
          // branch as the row we're copying from).
          jc.branchKey ?? "",
        ),
    );
  }

  await db.batch(statements);

  const fresh = await fetchPO(db, newPoId);
  return c.json({ success: true, data: fresh });
});

// ---------------------------------------------------------------------------
// POST /api/production-orders/:id/scan-complete
// B-flow piece-pic FIFO routing + sticker binding.
// ---------------------------------------------------------------------------
app.post("/:id/scan-complete", async (c) => {
  const db = c.var.DB;
  const scannedId = c.req.param("id");
  const scannedPo = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(scannedId)
    .first<ProductionOrderRow>();
  if (!scannedPo) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  // ---- ON_HOLD / CANCELLED scan block ---------------------------------------
  // Paused or cancelled production orders must not accept new scans. The
  // supervisor has to resume (ON_HOLD → PENDING) before the shop floor can
  // record any more completions. COMPLETED POs are intentionally left alone —
  // FIFO sticker binding already handles that path.
  if (scannedPo.status === "ON_HOLD") {
    return c.json(
      {
        success: false,
        code: "PO_ON_HOLD",
        error: "此 Production Order 处于 ON_HOLD。主管恢复后才能扫描。",
      },
      409,
    );
  }
  if (scannedPo.status === "CANCELLED") {
    return c.json(
      {
        success: false,
        code: "PO_CANCELLED",
        error: "此 Production Order 已被取消,无法扫描。",
      },
      409,
    );
  }

  const body = await c.req.json();
  const { jobCardId, workerId } = body || {};
  const rawPiece = Number(body?.pieceNo);
  const pieceNo =
    Number.isFinite(rawPiece) && rawPiece >= 1 ? Math.floor(rawPiece) : 1;
  // `force: true` means the worker has already acknowledged a soft warning
  // (PREREQUISITE_NOT_MET / UPSTREAM_LOCKED) on the previous scan-complete
  // round-trip and is re-posting to bypass it. Each forced scan gets an
  // audit row in `scan_override_audit`.
  const forced = body?.force === true;
  if (!jobCardId || !workerId) {
    return c.json(
      { success: false, error: "jobCardId and workerId are required" },
      400,
    );
  }

  // ---- Worker-auth verification --------------------------------------------
  // The scan-complete endpoint is mounted under /api/production-orders, which
  // means the dashboard auth-middleware gate already passed OR the caller is
  // a worker using the shop-floor portal. For worker callers we bind the
  // body.workerId to the `x-worker-token` header so a malicious worker can't
  // post scans "as someone else" by spoofing the workerId field.
  //
  // Two accepted auth paths:
  //   1. A dashboard user (userId already set on ctx by auth-middleware) —
  //      trust body.workerId as-is (admin scanner in src/pages/production/scan).
  //   2. A worker token (x-worker-token header) — body.workerId must match
  //      the worker_tokens row; otherwise 403.
  const ctxUserId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  );
  const workerToken = c.req.header("x-worker-token");
  if (!ctxUserId) {
    // No dashboard auth → must be a worker call; verify the token binds to
    // the claimed workerId.
    const resolvedWorkerId = await resolveWorkerToken(db, workerToken);
    if (!resolvedWorkerId || resolvedWorkerId !== workerId) {
      return c.json(
        {
          success: false,
          error:
            "Worker auth mismatch — workerId does not match the session token.",
          code: "AUTH_MISMATCH",
        },
        403,
      );
    }
  }

  const scannedJc = await db
    .prepare("SELECT * FROM job_cards WHERE id = ? AND productionOrderId = ?")
    .bind(jobCardId, scannedId)
    .first<JobCardRow>();
  if (!scannedJc) {
    return c.json({ success: false, error: "Job card not found" }, 404);
  }
  const worker = await db
    .prepare("SELECT id, name FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ id: string; name: string }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 400);
  }

  // Upstream-lock disabled (2026-04-26, user request) — same reasoning as
  // the PATCH guard above: the flat DEPT_ORDER + wipKey predicate doesn't
  // model the BOM tree's parallel branches (FAB chain vs WOOD chain inside
  // one wipKey only converge at UPHOLSTERY). The previous predicate flagged
  // any FAB_CUT/FAB_SEW scan as UPSTREAM_LOCKED the moment WOOD_CUT
  // completed, which is wrong. Re-enable once the lock chain is derived
  // from the BOM template at runtime.

  // ---- prerequisiteMet check -----------------------------------------------
  // The sales-orders planner stamps prerequisiteMet=1 on the first dept of
  // each wip chain and 0 on every downstream dept. As each earlier dept
  // completes, the rollup flips downstream prerequisiteMet=1. If it's still
  // 0 here, the operator is trying to scan a piece whose upstream dept
  // hasn't finished yet.
  if (scannedJc.prerequisiteMet !== 1) {
    if (!forced) {
      return c.json(
        {
          success: false,
          requiresConfirmation: true,
          warning: {
            code: "PREREQUISITE_NOT_MET",
            message: "前面 dept 还没完工,确定继续?",
          },
          data: {
            jobCardId: scannedJc.id,
            blockedBy: "UPSTREAM_NOT_COMPLETED",
          },
        },
        202,
      );
    }
    // Forced — record the override.
    await db
      .prepare(
        `INSERT INTO scan_override_audit
           (id, workerId, workerName, jobCardId, productionOrderId,
            overrideCode, reason, created_at)
         VALUES (?, ?, ?, ?, ?, 'PREREQUISITE_NOT_MET', 'force scan', ?)`,
      )
      .bind(
        `soa-${crypto.randomUUID().slice(0, 8)}`,
        workerId,
        worker.name,
        scannedJc.id,
        scannedJc.productionOrderId,
        new Date().toISOString(),
      )
      .run();
  }

  // Ensure scanned JC has piecePics rows.
  await ensurePiecePicsForJc(db, scannedJc);

  const targetKey = specKeyFor(scannedJc, scannedPo);
  const stickerKey = `${scannedPo.id}::${scannedJc.id}::${pieceNo}`;

  // Gather all same-spec candidate JCs across all POs.
  const allPoRes = await db
    .prepare("SELECT * FROM production_orders").all<ProductionOrderRow>();
  const allPos = allPoRes.results ?? [];
  const allJcRes = await db.prepare("SELECT * FROM job_cards").all<JobCardRow>();
  const allJcs = allJcRes.results ?? [];

  type Hit = {
    po: ProductionOrderRow;
    jc: JobCardRow;
    slot: PiecePicRow;
  };

  // Find sticker binding first.
  let bound: Hit | null = null;
  const specJcs = allJcs.filter((j) => {
    const p = allPos.find((pp) => pp.id === j.productionOrderId);
    return p && specKeyFor(j, p) === targetKey;
  });
  if (specJcs.length > 0) {
    const jcIds = specJcs.map((j) => j.id);
    const placeholders = jcIds.map(() => "?").join(",");
    const picsRes = await db
      .prepare(
        `SELECT * FROM piece_pics WHERE jobCardId IN (${placeholders}) AND boundStickerKey = ?`,
      )
      .bind(...jcIds, stickerKey)
      .all<PiecePicRow>();
    const hit = picsRes.results?.[0];
    if (hit) {
      const jc = allJcs.find((j) => j.id === hit.jobCardId);
      const po = jc ? allPos.find((p) => p.id === jc.productionOrderId) : undefined;
      if (jc && po) {
        bound = { po, jc, slot: hit };
      }
    }
  }

  // FIFO: if no binding, pick oldest-due unclaimed piece.
  let selected: Hit | null = bound;
  if (!selected) {
    // Build candidate list — for each eligible JC, ensure piece_pics, then
    // collect pic1-empty slots.
    const candidates: Hit[] = [];
    for (const jc of specJcs) {
      if (jc.status === "COMPLETED" || jc.status === "TRANSFERRED") continue;
      const po = allPos.find((p) => p.id === jc.productionOrderId);
      if (!po) continue;
      const slots = await ensurePiecePicsForJc(db, jc);

      // Legacy pic1 mirror: if JC has pic1Id but slot[0] doesn't, sync it.
      const s0 = slots[0];
      let syncedS0 = s0;
      if (jc.pic1Id && s0 && !s0.pic1Id) {
        await db
          .prepare(
            "UPDATE piece_pics SET pic1Id = ?, pic1Name = ? WHERE id = ?",
          )
          .bind(jc.pic1Id, jc.pic1Name ?? "", s0.id)
          .run();
        syncedS0 = { ...s0, pic1Id: jc.pic1Id, pic1Name: jc.pic1Name ?? "" };
        slots[0] = syncedS0;
      }
      if (jc.pic2Id && slots[0] && !slots[0].pic2Id) {
        await db
          .prepare(
            "UPDATE piece_pics SET pic2Id = ?, pic2Name = ? WHERE id = ?",
          )
          .bind(jc.pic2Id, jc.pic2Name ?? "", slots[0].id)
          .run();
        slots[0] = { ...slots[0], pic2Id: jc.pic2Id, pic2Name: jc.pic2Name ?? "" };
      }

      for (const s of slots) {
        if (s.pic1Id) continue;
        candidates.push({ po, jc, slot: s });
      }
    }

    if (candidates.length === 0) {
      return c.json(
        {
          success: false,
          error: `No pending work for ${targetKey}. All pieces in this spec are already in progress or complete.`,
          code: "PIC_FULL",
        },
        400,
      );
    }

    // FIFO sort: jc.dueDate asc, po.targetEndDate asc, po.createdAt asc, pieceNo asc.
    candidates.sort((a, b) => {
      const aJD = a.jc.dueDate || "9999-12-31";
      const bJD = b.jc.dueDate || "9999-12-31";
      if (aJD !== bJD) return aJD.localeCompare(bJD);
      const aTD = a.po.targetEndDate || "9999-12-31";
      const bTD = b.po.targetEndDate || "9999-12-31";
      if (aTD !== bTD) return aTD.localeCompare(bTD);
      const aC = a.po.createdAt || "";
      const bC = b.po.createdAt || "";
      if (aC !== bC) return aC.localeCompare(bC);
      return a.slot.pieceNo - b.slot.pieceNo;
    });
    selected = candidates[0];

    // Bind sticker.
    await db
      .prepare("UPDATE piece_pics SET boundStickerKey = ? WHERE id = ?")
      .bind(stickerKey, selected.slot.id)
      .run();
    selected.slot = { ...selected.slot, boundStickerKey: stickerKey };
  }

  const target = selected;

  // Same-worker guard.
  if (target.slot.pic1Id === worker.id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `You are already PIC1 on this piece (${worker.name}). A second PIC must be a different worker.`,
        code: "ALREADY_PIC1",
        data: {
          jobCard: jcOut,
          assignedSlot: 1,
          workerName: worker.name,
          pieceNo: target.slot.pieceNo,
        },
      },
      409,
    );
  }
  if (target.slot.pic2Id === worker.id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `You are already PIC2 on this piece (${worker.name}).`,
        code: "ALREADY_PIC2",
        data: {
          jobCard: jcOut,
          assignedSlot: 2,
          workerName: worker.name,
          pieceNo: target.slot.pieceNo,
        },
      },
      409,
    );
  }

  // 3-second piece-level debounce.
  if (target.slot.lastScanAt) {
    const elapsedMs = Date.now() - new Date(target.slot.lastScanAt).getTime();
    if (elapsedMs < 3000) {
      return c.json(
        {
          success: false,
          error:
            "This piece was just scanned. Please wait a moment before scanning again.",
          code: "DEBOUNCE",
        },
        429,
      );
    }
  }

  if (target.slot.pic1Id && target.slot.pic2Id) {
    const freshJc = await fetchPO(db, target.po.id);
    const jcOut = freshJc?.jobCards.find((j) => j.id === target.jc.id);
    return c.json(
      {
        success: false,
        error: `This piece already has 2 PICs (${target.slot.pic1Name} / ${target.slot.pic2Name}). A third person cannot scan the same piece.`,
        code: "PIC_FULL",
        data: { jobCard: jcOut, pieceNo: target.slot.pieceNo },
      },
      400,
    );
  }

  // Fill the slot.
  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  let assignedSlot: 1 | 2;
  let newPic1Id = target.slot.pic1Id;
  let newPic1Name = target.slot.pic1Name ?? "";
  let newPic2Id = target.slot.pic2Id;
  let newPic2Name = target.slot.pic2Name ?? "";
  let newCompletedAt = target.slot.completedAt;

  if (!target.slot.pic1Id) {
    newPic1Id = worker.id;
    newPic1Name = worker.name;
    newCompletedAt = nowIso;
    assignedSlot = 1;
  } else {
    newPic2Id = worker.id;
    newPic2Name = worker.name;
    assignedSlot = 2;
  }

  await db
    .prepare(
      `UPDATE piece_pics SET pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ?,
         completedAt = ?, lastScanAt = ? WHERE id = ?`,
    )
    .bind(
      newPic1Id,
      newPic1Name,
      newPic2Id,
      newPic2Name,
      newCompletedAt,
      nowIso,
      target.slot.id,
    )
    .run();

  // Rollup: all slots for this JC have pic1 → mark JC COMPLETED.
  const allSlots = await db
    .prepare("SELECT * FROM piece_pics WHERE jobCardId = ?")
    .bind(target.jc.id)
    .all<PiecePicRow>();
  const slotList = allSlots.results ?? [];
  const allPiecesDone = slotList.length > 0 && slotList.every((s) => !!s.pic1Id);

  let jcJustCompleted = false;
  const mergedJc: JobCardRow = { ...target.jc };
  if (
    allPiecesDone &&
    target.jc.status !== "COMPLETED" &&
    target.jc.status !== "TRANSFERRED"
  ) {
    mergedJc.status = "COMPLETED";
    mergedJc.completedDate = today;
    mergedJc.overdue = "COMPLETED";
    jcJustCompleted = true;
  } else if (
    // WAITING → IN_PROGRESS on the FIRST pic1 assignment. The first scan is
    // the operator "starting" the job card; if the rollup above didn't move
    // it straight to COMPLETED (e.g. multi-piece JCs only complete after
    // every piece's pic1 is filled), flip it to IN_PROGRESS now.
    // Never overwrite COMPLETED / TRANSFERRED — those are terminal and the
    // caller is expected to 409 long before we get here.
    target.jc.status === "WAITING" &&
    assignedSlot === 1
  ) {
    mergedJc.status = "IN_PROGRESS";
  }

  // Mirror legacy pic1/pic2 from first piece with a value.
  const firstWithPic1 = slotList.find((s) => s.pic1Id);
  const firstWithPic2 = slotList.find((s) => s.pic2Id);
  if (!mergedJc.pic1Id && firstWithPic1) {
    mergedJc.pic1Id = firstWithPic1.pic1Id;
    mergedJc.pic1Name = firstWithPic1.pic1Name ?? "";
  }
  if (!mergedJc.pic2Id && firstWithPic2) {
    mergedJc.pic2Id = firstWithPic2.pic2Id;
    mergedJc.pic2Name = firstWithPic2.pic2Name ?? "";
  }

  await db
    .prepare(
      `UPDATE job_cards SET status = ?, completedDate = ?, overdue = ?,
         pic1Id = ?, pic1Name = ?, pic2Id = ?, pic2Name = ? WHERE id = ?`,
    )
    .bind(
      mergedJc.status,
      mergedJc.completedDate,
      mergedJc.overdue,
      mergedJc.pic1Id,
      mergedJc.pic1Name ?? "",
      mergedJc.pic2Id,
      mergedJc.pic2Name ?? "",
      mergedJc.id,
    )
    .run();

  // If JC just completed, emit WIP inventory update.
  if (jcJustCompleted) {
    const siblings = await db
      .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
      .bind(target.po.id)
      .all<JobCardRow>();
    // Scan path is forward-only (jcJustCompleted is computed from a
    // prevStatus that wasn't COMPLETED/TRANSFERRED). Pass target.jc.status
    // for completeness so the cascade's wasDone gate evaluates correctly.
    await applyWipInventoryChange(
      db,
      target.po,
      mergedJc,
      "COMPLETED",
      siblings.results ?? [],
      target.jc.status,
    );

    // F2 — labor cost posting (idempotent per jobCardId).
    await postJobCardLabor(db, mergedJc.id, target.po.id);
  }

  // PO progress rollup.
  const poJcsRes = await db
    .prepare("SELECT * FROM job_cards WHERE productionOrderId = ?")
    .bind(target.po.id)
    .all<JobCardRow>();
  const poJcs = poJcsRes.results ?? [];
  const completedCount = poJcs.filter(
    (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
  ).length;
  const newProgress = Math.round((completedCount / poJcs.length) * 100);
  const allDone = completedCount === poJcs.length;

  let newPoStatus = target.po.status;
  let newCompleted: string | null = target.po.completedDate;
  if (allDone) {
    newPoStatus = "COMPLETED";
    newCompleted = today;
    // FG generation + fg_batches row is handled below, after the PO UPDATE
    // writes the COMPLETED status (so generateFGUnitsForPO sees the flipped
    // completedDate when stamping mfdDate on new units).
  } else if (completedCount > 0) {
    newPoStatus = "IN_PROGRESS";
  }
  const activeDept = poJcs.find(
    (j) => j.status === "IN_PROGRESS" || j.status === "WAITING",
  );
  const newCurrentDept = activeDept?.departmentCode || "PACKING";

  await db
    .prepare(
      `UPDATE production_orders SET status = ?, progress = ?,
         completedDate = ?, currentDepartment = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      newPoStatus,
      newProgress,
      newCompleted,
      newCurrentDept,
      nowIso,
      target.po.id,
    )
    .run();

  if (allDone) {
    // Auto-generate FG units + fg_batches row on PO completion. Runs BEFORE
    // the SO cascade so SO progression sees the freshly created inventory.
    // Idempotent — safe on re-entry.
    await postProductionOrderCompletion(db, target.po.id);
    await cascadePoCompletionToSO(db, target.po.salesOrderId);
  }
  await cascadeUpholsteryToSO(db, target.po.id);

  const freshPo = await fetchPO(db, target.po.id);
  const jcOut = freshPo?.jobCards.find((j) => j.id === target.jc.id);
  const redirected =
    target.po.id !== scannedPo.id || target.jc.id !== scannedJc.id;

  return c.json({
    success: true,
    data: {
      jobCard: jcOut,
      assignedSlot,
      workerName: worker.name,
      pieceNo: target.slot.pieceNo,
      pieceCompletedAt: newCompletedAt,
      jcJustCompleted,
      fifoRedirected: redirected,
      scannedPoId: scannedPo.id,
      scannedPoNo: scannedPo.poNo,
      assignedPoId: target.po.id,
      assignedPoNo: target.po.poNo,
      specKey: targetKey,
      fifoDueDate: target.jc.dueDate || target.po.targetEndDate || "",
      stickerKey,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const po = await fetchPO(c.var.DB, c.req.param("id"));
  if (!po) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }
  return c.json({ success: true, data: po });
});

// ---------------------------------------------------------------------------
// PUT /api/production-orders/:id
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => applyPoUpdate(c, c.req.param("id")));

// ---------------------------------------------------------------------------
// PATCH /api/production-orders/:id — alias for PUT
// ---------------------------------------------------------------------------
app.patch("/:id", async (c) => applyPoUpdate(c, c.req.param("id")));

export default app;

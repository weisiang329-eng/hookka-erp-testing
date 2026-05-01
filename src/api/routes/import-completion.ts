// ---------------------------------------------------------------------------
// import-completion.ts — one-shot historical job_card completion importer.
//
// Wei Siang is migrating ~3000 historical orders from Google Sheets into the
// ERP. The source data has, per (custPONo, deptCode), a completion date and
// up to two short-name PIC tags. This endpoint marks the matching job_cards
// COMPLETED with the right PIC, completion date, and `actualMinutes`, AND
// fires the same downstream cascades a normal scan-driven completion would:
//
//   1. applyWipInventoryChange  — wip_items rows for upstream consume +
//      this dept's producer-add (UPHOLSTERY also zeros upstream branch
//      terminals; PACKING is skipped from this cascade by design).
//   2. postJobCardLabor         — LABOR_POSTED cost_ledger entry per JC.
//   3. postProductionOrderCompletion — fires once per PO when ALL its JCs
//      reach COMPLETED. Generates fg_units, writes fg_batches, runs the
//      Track F cost cascade (RM FIFO consume → FG cost backfill → WIP
//      marker). All steps inside this helper are idempotent.
//
// Dry-run mode (?dryRun=true on body) returns the same response shape with
// counts only and zero side effects so the caller can validate match rate
// before committing.
//
// Worker name resolution
//   The Google Sheets log uses short names ("AUNG", "PHOO", "MIN") that
//   don't always match workers.name 1:1. WORKER_NAME_MAP below is the
//   canonical short-name → full-name table (keyed by GS short, value =
//   workers.name to look up). Two short names ("AUNG KO", "KYAW") have
//   real ambiguity in the worker roster — we pick the documented first
//   match and surface a picWarnings entry so the caller can spot-check.
//
// Chunking
//   Default: 100 rows per call. Caller passes ?cursor=<n> to resume from
//   the next chunk. When `cursor` is omitted, processing starts at row 0
//   of the rows[] array supplied in the body. Mirrors the cursor pattern
//   from /api/bom/resync-job-card-times — caller loops until
//   `cursor.hasMore === false`.
//
// Permission
//   production-orders:update — same gate as the PATCH handler that the
//   shop-floor app uses to flip JC status. This is intentional: the
//   importer is a privileged backfill tool, not an end-user surface.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import {
  applyWipInventoryChange,
  type JobCardRow,
  type ProductionOrderRow,
} from "./production-orders";
import { postJobCardLabor } from "../lib/po-cost-cascade";
import { postProductionOrderCompletion } from "../lib/fg-completion";
import { loadLeadTimes, type LeadTimeMap } from "../lib/lead-times";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Worker name map — Google Sheets short name → workers.name lookup value.
// Embedded in code (not DB) since this is a one-shot import.
//
// Ambiguous entries: the GS short matches multiple workers in the roster.
// We pick the documented first match per Wei Siang's note. The importer
// surfaces a picWarnings entry for each one so the caller knows which
// JCs were resolved on the ambiguous branch.
// ---------------------------------------------------------------------------
const WORKER_NAME_MAP: Record<string, { name: string; ambiguous?: boolean }> = {
  PHOO: { name: "EI PHOO WEI" },
  ZIN: { name: "ZIN MIN NWE" },
  ANN: { name: "ANN" },
  YEE: { name: "OO SAN YEE" },
  PHYU: { name: "PHYU SIN MOE" },
  KHIN: { name: "KHIN AYE MU" },
  SHEIN: { name: "OHN MAR SHEIN" },
  LIN: { name: "KHIN MAUNG LIN" },
  "KYAW OO": { name: "KYAW OO" },
  // AUNG KO — disambiguated per dept at extraction time; the data file
  // sends explicit "AUNG KO OO" for framing rows and "AUNG KO MYINT" for
  // upholstery rows. The bare "AUNG KO" key still defaults to MYINT in
  // case any source row leaks through unprocessed.
  "AUNG KO": { name: "AUNG KO MYINT" },
  "AUNG KO OO": { name: "AUNG KO OO" },
  "AUNG KO MYINT": { name: "AUNG KO MYINT" },
  AZAW: { name: "MYINT TUN" },
  THAR: { name: "NYEIN CHAN AUNG" },
  "ZAW LIN": { name: "ZAW LIN" },
  ZAWLIN: { name: "ZAW LIN" }, // alias for missing-space typo
  MIN: { name: "HLAING MIN AUNG" },
  "ZAW MOE": { name: "ZAW MOE TUN" },
  "YE LI SOE": { name: "YE LI SOE" },
  "YE LIN SOE": { name: "YE LI SOE" }, // alias for typo
  "YEE LIN SOE": { name: "YE LI SOE" }, // alias for typo
  KYAW: { name: "AUNG KYAW SOE" }, // user disambiguation 2026-04-30: KYAW = AUNG KYAW SOE; KYAW OO is its own short name above
  AUNG: { name: "AUNG THEIN WIN" },
  AMANG: { name: "A MANG" },
  // 2026-04-30 prod-CSV import: full-name passthroughs for workers the user
  // typed verbatim into the per-dept Production Sheet. Self-referencing so
  // the script can ship full names directly without a reverse map.
  "KYAR TUN HLA": { name: "KYAR TUN HLA" },
  "CHAE KO KO": { name: "CHAE KO KO" },
  "KYAW ZIN OO": { name: "KYAW ZIN OO" },
};

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------
type InputRow = {
  // Multi-factor SO lookup. The handler tries customerPO first, then
  // customerRef (the most common path on this dataset), then falls back to
  // soNo. The first hit wins. All three columns accept "+"-separated
  // multi-values (e.g. "CR0450+CR1056") which are split + OR'd.
  custPONo?: string | null;
  customerRef?: string | null;
  companySO?: string | null;
  // Optional narrowing: when set, only production_orders whose productCode
  // equals this value are considered. Helps when one SO has multiple line
  // items (different products) and the source row identifies which.
  productCode?: string | null;
  deptCode: string;
  // Optional narrowing within the dept: only job_cards whose wipType is in
  // this array (case-insensitive) get the update. Used by the UPHOLSTERY +
  // FRAMING migrations where the Google Sheets has separate Divan / HB
  // columns that target different WIPs in the same dept.
  // Examples: ["DIVAN","SOFA_BASE","SOFA_CUSHION","SOFA_ARMREST"] for Divan
  // upholstery (everything except headboard); ["HEADBOARD"] for HB.
  wipTypes?: string[];
  completedDate?: string;
  pic1Name?: string;
  pic2Name?: string;
};

type RequestBody = {
  dryRun?: boolean;
  rows: InputRow[];
};

type PicWarning = {
  row: number;
  name: string;
  reason: string;
};

type ErrorEntry = {
  row: number;
  custPONo: string;
  message: string;
};

// In-memory worker name → row cache for one request, so the same short
// name doesn't re-hit the DB on every input row.
type WorkerLookupRow = { id: string; name: string };
type WorkerCache = Map<string, WorkerLookupRow | null>;

async function lookupWorkerByName(
  db: D1Database,
  fullName: string,
  cache: WorkerCache,
): Promise<WorkerLookupRow | null> {
  if (cache.has(fullName)) return cache.get(fullName) ?? null;
  const row = await db
    .prepare("SELECT id, name FROM workers WHERE name = ? LIMIT 1")
    .bind(fullName)
    .first<WorkerLookupRow>();
  cache.set(fullName, row ?? null);
  return row ?? null;
}

// Resolve a Google-Sheets short name → workers row. Returns:
//   { worker: row|null, warning: optional message }
// The `warning` is non-null whenever:
//   - short name is not in WORKER_NAME_MAP (skip-and-warn)
//   - short name maps to a full name that doesn't exist in workers (skip-and-warn)
//   - short name is documented as ambiguous (resolve to first match, warn)
async function resolvePic(
  db: D1Database,
  shortName: string,
  cache: WorkerCache,
): Promise<{ worker: WorkerLookupRow | null; warning: string | null }> {
  const trimmed = shortName.trim();
  if (!trimmed) return { worker: null, warning: null };
  const upper = trimmed.toUpperCase();
  const entry = WORKER_NAME_MAP[upper];
  if (!entry) {
    return {
      worker: null,
      warning: `short name "${trimmed}" not in WORKER_NAME_MAP`,
    };
  }
  const worker = await lookupWorkerByName(db, entry.name, cache);
  if (!worker) {
    return {
      worker: null,
      warning: `mapped name "${entry.name}" not found in workers table`,
    };
  }
  if (entry.ambiguous) {
    return {
      worker,
      warning: `short name "${trimmed}" is ambiguous — resolved to "${entry.name}" by first-match rule`,
    };
  }
  return { worker, warning: null };
}

// ---------------------------------------------------------------------------
// Helpers — load PO + JC rows by salesOrderId / dept, in batches of 1.
// We don't try to bulk-load across the full input batch because input
// rows can collide (same custPO appears in multiple rows for different
// depts), and the per-row processing already fans out across multiple
// matched SOs/POs/JCs. Within one row we run the queries serially —
// that's fine since the chunk cap (default 100) keeps the total bounded.
// ---------------------------------------------------------------------------
type SalesOrderIdRow = { id: string };

function splitMultiRef(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .split(/[+,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

async function findSalesOrderIdsByLookup(
  db: D1Database,
  lookup: {
    custPONo?: string | null;
    customerRef?: string | null;
    companySO?: string | null;
  },
): Promise<{ ids: string[]; matchedVia: string | null }> {
  // Strategy: try each field in order. First non-empty hit wins.
  //   1. customerPO  — if user populates `customers PO` column on the SO
  //   2. reference   — most common (HC#, CR#, AKHC#, ZNT# etc). Supports
  //                    combined values like "CR0450+CR1056" by splitting on
  //                    + or , and OR-ing the lookups.
  //   3. soNo        — fallback to our internal SO number (SO-2509-238).
  const customerPOTokens = splitMultiRef(lookup.custPONo);
  if (customerPOTokens.length > 0) {
    const all = new Set<string>();
    for (const tok of customerPOTokens) {
      const res = await db
        .prepare("SELECT id FROM sales_orders WHERE customerPO = ?")
        .bind(tok)
        .all<SalesOrderIdRow>();
      for (const r of res.results ?? []) all.add(r.id);
    }
    if (all.size > 0) return { ids: Array.from(all), matchedVia: "customerPO" };
  }

  const refTokens = splitMultiRef(lookup.customerRef);
  if (refTokens.length > 0) {
    const all = new Set<string>();
    for (const tok of refTokens) {
      const res = await db
        .prepare("SELECT id FROM sales_orders WHERE reference = ?")
        .bind(tok)
        .all<SalesOrderIdRow>();
      for (const r of res.results ?? []) all.add(r.id);
    }
    if (all.size > 0) return { ids: Array.from(all), matchedVia: "customerRef" };
  }

  const soTokens = splitMultiRef(lookup.companySO);
  if (soTokens.length > 0) {
    const all = new Set<string>();
    for (const tok of soTokens) {
      const res = await db
        .prepare("SELECT id FROM sales_orders WHERE soNo = ?")
        .bind(tok)
        .all<SalesOrderIdRow>();
      for (const r of res.results ?? []) all.add(r.id);
    }
    if (all.size > 0) return { ids: Array.from(all), matchedVia: "soNo" };
  }

  return { ids: [], matchedVia: null };
}


async function findProductionOrdersBySO(
  db: D1Database,
  salesOrderId: string,
): Promise<ProductionOrderRow[]> {
  const res = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, salesOrderNo, lineNo, customerPOId,
              customerReference, customerName, customerState, companySOId,
              consignmentOrderId, companyCOId, productId, productCode,
              productName, itemCategory, sizeCode, sizeLabel, fabricCode,
              quantity, gapInches, divanHeightInches, legHeightInches,
              specialOrder, notes, status, currentDepartment, progress,
              startDate, targetEndDate, completedDate, rackingNumber,
              stockedIn, created_at AS createdAt, updated_at AS updatedAt
         FROM production_orders WHERE salesOrderId = ?`,
    )
    .bind(salesOrderId)
    .all<ProductionOrderRow>();
  return res.results ?? [];
}

async function findJobCardsByPO(
  db: D1Database,
  productionOrderId: string,
): Promise<JobCardRow[]> {
  const res = await db
    .prepare(
      `SELECT id, productionOrderId, departmentId, departmentCode,
              departmentName, sequence, status, dueDate, wipKey, wipCode,
              wipType, wipLabel, wipQty, branchKey, prerequisiteMet,
              pic1Id, pic1Name, pic2Id, pic2Name, completedDate, estMinutes,
              actualMinutes, category, productionTimeMinutes, overdue,
              rackingNumber
         FROM job_cards WHERE productionOrderId = ?`,
    )
    .bind(productionOrderId)
    .all<JobCardRow>();
  return res.results ?? [];
}

// Load a single production_orders row by id. Used by cascade-upstream-
// completion to reconstruct (po, allJcs) per cascade target so the WIP
// producer-add can fire — applyWipInventoryChange needs both.
async function loadProductionOrderById(
  db: D1Database,
  productionOrderId: string,
): Promise<ProductionOrderRow | null> {
  const res = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, salesOrderNo, lineNo, customerPOId,
              customerReference, customerName, customerState, companySOId,
              consignmentOrderId, companyCOId, productId, productCode,
              productName, itemCategory, sizeCode, sizeLabel, fabricCode,
              quantity, gapInches, divanHeightInches, legHeightInches,
              specialOrder, notes, status, currentDepartment, progress,
              startDate, targetEndDate, completedDate, rackingNumber,
              stockedIn, created_at AS createdAt, updated_at AS updatedAt
         FROM production_orders WHERE id = ?`,
    )
    .bind(productionOrderId)
    .first<ProductionOrderRow>();
  return res ?? null;
}

// ---------------------------------------------------------------------------
// Per-row processing
// ---------------------------------------------------------------------------
type RowResult = {
  matched: boolean;
  matchedVia?: string | null;
  noSoMatch: boolean;
  noJcMatch: boolean;
  jcUpdated: number;
  posCompleted: number;
  warnings: PicWarning[];
  errors: ErrorEntry[];
};

async function processRow(
  db: D1Database,
  rowIndex: number,
  input: InputRow,
  workerCache: WorkerCache,
  dryRun: boolean,
): Promise<RowResult> {
  const result: RowResult = {
    matched: false,
    noSoMatch: false,
    noJcMatch: false,
    jcUpdated: 0,
    posCompleted: 0,
    warnings: [],
    errors: [],
  };

  // STRICT MODE — per user spec, every row MUST supply both customerRef
  // AND productCode. Either alone is rejected. soNo / customerPO fallback
  // is intentionally disabled to minimise false positives during this
  // historical migration.
  if (!input.deptCode) {
    result.errors.push({
      row: rowIndex,
      custPONo: input.custPONo ?? input.customerRef ?? input.companySO ?? "",
      message: "missing deptCode",
    });
    return result;
  }
  if (!input.customerRef || !input.customerRef.trim()) {
    result.errors.push({
      row: rowIndex,
      custPONo: input.custPONo ?? "",
      message: "strict mode requires customerRef",
    });
    return result;
  }
  if (!input.productCode || !input.productCode.trim()) {
    result.errors.push({
      row: rowIndex,
      custPONo: input.customerRef ?? "",
      message: "strict mode requires productCode",
    });
    return result;
  }

  const deptCode = input.deptCode.toUpperCase().trim();

  let pic1: WorkerLookupRow | null = null;
  let pic2: WorkerLookupRow | null = null;
  if (input.pic1Name) {
    const r = await resolvePic(db, input.pic1Name, workerCache);
    pic1 = r.worker;
    if (r.warning) {
      result.warnings.push({
        row: rowIndex,
        name: input.pic1Name,
        reason: r.warning,
      });
    }
  }
  if (input.pic2Name) {
    const r = await resolvePic(db, input.pic2Name, workerCache);
    pic2 = r.worker;
    if (r.warning) {
      result.warnings.push({
        row: rowIndex,
        name: input.pic2Name,
        reason: r.warning,
      });
    }
  }

  // STRICT: lookup by customerRef ONLY (customerPO + soNo not consulted).
  const lookup = await findSalesOrderIdsByLookup(db, {
    customerRef: input.customerRef,
  });
  const soIds = lookup.ids;
  if (soIds.length === 0) {
    result.noSoMatch = true;
    return result;
  }
  result.matched = true;
  result.matchedVia = lookup.matchedVia;

  // Validate completedDate format. Empty string treated as "skip date".
  const completedDate =
    input.completedDate && input.completedDate.trim().length > 0
      ? input.completedDate.trim()
      : null;
  if (completedDate && !/^\d{4}-\d{2}-\d{2}$/.test(completedDate)) {
    result.errors.push({
      row: rowIndex,
      custPONo: input.custPONo ?? input.customerRef ?? input.companySO ?? "",
      message: `completedDate "${completedDate}" not ISO YYYY-MM-DD`,
    });
    return result;
  }

  const setStatus = completedDate !== null;

  // Walk every PO under every matched SO, every matching JC.
  // If productCode is supplied, narrow the PO set to those matching it —
  // this disambiguates rows when one SO contains multiple line items.
  const productCodeFilter = (input.productCode || "").trim();
  let jcMatchedAny = false;
  for (const soId of soIds) {
    let pos = await findProductionOrdersBySO(db, soId);
    if (productCodeFilter) {
      pos = pos.filter((p) => (p.productCode || "") === productCodeFilter);
    }
    const wipTypeFilter = (input.wipTypes || [])
      .map((s) => (s || "").toUpperCase())
      .filter((s) => s.length > 0);
    for (const po of pos) {
      const allJcs = await findJobCardsByPO(db, po.id);
      const matchingJcs = allJcs.filter((j) => {
        if ((j.departmentCode || "").toUpperCase() !== deptCode) return false;
        if (wipTypeFilter.length === 0) return true;
        return wipTypeFilter.includes((j.wipType || "").toUpperCase());
      });
      if (matchingJcs.length === 0) continue;
      jcMatchedAny = true;

      for (const jc of matchingJcs) {
        // Build the patched JC snapshot.
        const updated: JobCardRow = { ...jc };
        if (pic1) {
          updated.pic1Id = pic1.id;
          updated.pic1Name = pic1.name;
        }
        if (pic2) {
          updated.pic2Id = pic2.id;
          updated.pic2Name = pic2.name;
        }

        const wasDone =
          jc.status === "COMPLETED" || jc.status === "TRANSFERRED";

        if (setStatus) {
          updated.status = "COMPLETED";
          updated.completedDate = completedDate;
          updated.overdue = "COMPLETED";
          // Use planned minutes as actual since we don't have real timing.
          // The labor cascade reads jc.actualMinutes when > 0, otherwise
          // falls back to productionTimeMinutes / estMinutes — setting
          // it explicitly here keeps the cost ledger deterministic.
          updated.actualMinutes = jc.productionTimeMinutes || jc.estMinutes;
        }

        if (dryRun) {
          // Counts only — no UPDATE, no cascades.
          result.jcUpdated++;
          continue;
        }

        try {
          await db
            .prepare(
              `UPDATE job_cards SET
                 status = ?, completedDate = ?, pic1Id = ?, pic1Name = ?,
                 pic2Id = ?, pic2Name = ?, actualMinutes = ?, overdue = ?
               WHERE id = ?`,
            )
            .bind(
              updated.status,
              updated.completedDate,
              updated.pic1Id,
              updated.pic1Name ?? "",
              updated.pic2Id,
              updated.pic2Name ?? "",
              updated.actualMinutes,
              updated.overdue,
              updated.id,
            )
            .run();
        } catch (err) {
          result.errors.push({
            row: rowIndex,
            custPONo: input.custPONo ?? input.customerRef ?? input.companySO ?? "",
            message: `UPDATE job_cards failed for jcId=${jc.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          continue;
        }

        result.jcUpdated++;

        // Cascades only fire when the JC actually transitioned INTO a DONE
        // state on this call. PIC-only updates (no completedDate) don't
        // need them. Defensive try/catch on every cascade — a downstream
        // failure must not void the JC UPDATE that already committed.
        if (setStatus && !wasDone) {
          // Refresh allJcs view so applyWipInventoryChange sees this JC's
          // new status (sibling/branch lookup looks at allJcs).
          const refreshed = allJcs.map((j) =>
            j.id === updated.id ? updated : j,
          );

          try {
            await applyWipInventoryChange(
              db,
              po,
              updated,
              "COMPLETED",
              refreshed,
              jc.status,
            );
          } catch (err) {
            console.error("[import-completion] WIP cascade failed", {
              jcId: jc.id,
              poId: po.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }

          try {
            await postJobCardLabor(db, updated.id, po.id);
          } catch (err) {
            console.error("[import-completion] postJobCardLabor failed", {
              jcId: jc.id,
              poId: po.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // After processing this PO's matching JCs, check if ALL its JCs are
      // now COMPLETED (or TRANSFERRED). If yes, flip the PO row and fire
      // postProductionOrderCompletion. Idempotent — the helper short-
      // circuits if fg_units / fg_batches / FG_COMPLETED ledger entry
      // already exist.
      if (setStatus) {
        // Re-query rather than trust the local refreshed map: the PO may
        // have other dept JCs we didn't touch in this row, and another
        // import row in the same batch may have moved them.
        const freshJcs = await findJobCardsByPO(db, po.id);
        const allDone =
          freshJcs.length > 0 &&
          freshJcs.every(
            (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
          );
        if (allDone && po.status !== "COMPLETED") {
          const nowIso = new Date().toISOString();
          const today = nowIso.split("T")[0];
          if (!dryRun) {
            try {
              await db
                .prepare(
                  `UPDATE production_orders SET
                     status = 'COMPLETED', progress = 100,
                     currentDepartment = 'PACKING',
                     completedDate = ?, updated_at = ?
                   WHERE id = ?`,
                )
                .bind(today, nowIso, po.id)
                .run();
            } catch (err) {
              result.errors.push({
                row: rowIndex,
                custPONo: input.custPONo ?? input.customerRef ?? input.companySO ?? "",
                message: `UPDATE production_orders failed for poId=${po.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
              continue;
            }

            try {
              await postProductionOrderCompletion(db, po.id);
            } catch (err) {
              console.error(
                "[import-completion] postProductionOrderCompletion failed",
                {
                  poId: po.id,
                  err: err instanceof Error ? err.message : String(err),
                },
              );
            }
          }
          result.posCompleted++;
        }
      }
    }
  }

  if (!jcMatchedAny) {
    result.noJcMatch = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// POST /api/import/job-card-completion
// ---------------------------------------------------------------------------
app.post("/job-card-completion", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: RequestBody;
  try {
    body = (await c.req.json()) as RequestBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  if (!body || !Array.isArray(body.rows)) {
    return c.json(
      { success: false, error: "body.rows must be an array" },
      400,
    );
  }

  const dryRun = body.dryRun === true;

  // Cursor + limit: rows are processed sequentially from the supplied
  // body.rows array. ?cursor=<n> skips the first N rows; default 0.
  // ?limit=<m> caps the chunk; default 100, hard cap 500. Caller loops
  // until cursor.hasMore === false.
  const cursorParam = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const startIdx = cursorParam ? Math.max(0, parseInt(cursorParam, 10) || 0) : 0;
  const rawLimit = limitParam ? parseInt(limitParam, 10) || 100 : 100;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const endIdx = Math.min(body.rows.length, startIdx + limit);
  const slice = body.rows.slice(startIdx, endIdx);

  const db = c.var.DB;
  const workerCache: WorkerCache = new Map();

  let matched = 0;
  let noSoMatch = 0;
  let noJcMatch = 0;
  let jcUpdated = 0;
  let posCompleted = 0;
  const picWarnings: PicWarning[] = [];
  const errors: ErrorEntry[] = [];

  for (let i = 0; i < slice.length; i++) {
    const absoluteIdx = startIdx + i;
    const r = slice[i];
    try {
      const res = await processRow(db, absoluteIdx, r, workerCache, dryRun);
      if (res.matched) matched++;
      if (res.noSoMatch) noSoMatch++;
      if (res.noJcMatch) noJcMatch++;
      jcUpdated += res.jcUpdated;
      posCompleted += res.posCompleted;
      picWarnings.push(...res.warnings);
      errors.push(...res.errors);
    } catch (err) {
      errors.push({
        row: absoluteIdx,
        custPONo: r?.custPONo ?? "",
        message: `unhandled error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  const hasMore = endIdx < body.rows.length;
  const nextCursor = hasMore ? String(endIdx) : null;

  return c.json({
    success: true,
    dryRun,
    totalRows: body.rows.length,
    matched,
    noSoMatch,
    noJcMatch,
    jcUpdated,
    picWarnings,
    posCompleted,
    errors,
    cursor: { hasMore, nextCursor },
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/clear-future-completions
//
// One-shot cleanup: any job_card whose completedDate is strictly > today gets
// reset (status → WAITING, completedDate → null, actualMinutes → null,
// pic1/pic2 → null, overdue → null). The historical migration ingested some
// source rows whose completion date column had been used as a "scheduled"
// future date by mistake; this endpoint reverses those imports without
// touching legitimately recent completions.
//
// Returns the count of rows reset and a sample.
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
app.post("/clear-future-completions", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);

  // Find all jcs with completedDate strictly > today.
  const sel = await db
    .prepare(
      `SELECT id, departmentCode, completedDate, dueDate, status, pic1Name
         FROM job_cards
        WHERE completedDate IS NOT NULL AND completedDate > ?`,
    )
    .bind(today)
    .all<{
      id: string;
      departmentCode: string | null;
      completedDate: string | null;
      dueDate: string | null;
      status: string;
      pic1Name: string | null;
    }>();
  const rows = sel.results ?? [];

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      today,
      wouldReset: rows.length,
      sample: rows.slice(0, 8),
    });
  }

  let reset = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const jc of rows) {
    try {
      await db
        .prepare(
          `UPDATE job_cards
              SET status = 'WAITING', completedDate = NULL,
                  actualMinutes = NULL,
                  pic1Id = NULL, pic1Name = '',
                  pic2Id = NULL, pic2Name = '',
                  overdue = NULL
            WHERE id = ?`,
        )
        .bind(jc.id)
        .run();
      reset++;
    } catch (err) {
      errors.push({
        jcId: jc.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    today,
    reset,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/cascade-upstream-completion
//
// Anchor-relative cascade-fill, RESTRICTED to an explicit rule set. Within
// each (productionOrderId, wipKey) group, find the most-downstream completed
// JC (the "anchor" — MAX(sequence) among rows where status IN ('COMPLETED',
// 'TRANSFERRED') AND completedDate IS NOT NULL). If the anchor's dept is in
// the rule set, plan completions for the listed target depts in that group.
// Any other anchor dept → entire group is skipped.
//
// Default rules (apply regardless of wipType):
//   UPHOLSTERY → FAB_CUT, FAB_SEW, FOAM, WOOD_CUT, FRAMING, WEBBING
//   WEBBING    → FRAMING, WOOD_CUT
//   FRAMING    → WOOD_CUT
//   FAB_SEW    → FAB_CUT
//
// wipType-specific overrides:
//   HEADBOARD: FOAM → FAB_SEW, FAB_CUT
//     (HB foam consumes sewn fabric, which consumes cut fabric. So when an
//      HB PO has FOAM as the most-downstream completed JC, backfill the
//      sewing + cutting upstream of it.)
//
// FOAM / WOOD_CUT / FAB_CUT / PACKING anchors → no cascade (unless an override
// above kicks in for the active wipType).
//
// Date math (unchanged):
//   leadtimes[cat][dept] = days BEFORE customer DD that dept finishes.
//     offsetDays = ltAnchor - ltTarget
//     newDate    = anchor_date + offsetDays days
//   if (offsetDays > 0) offsetDays = 0   (anchor-date clamp)
//   if (newDate > 2026-04-30) newDate = 2026-04-30   (today clamp)
// Falls back to 1-day-per-sequence-step when leadtime data missing
// (counted as `fallbackToSequence`). Skips candidates already
// COMPLETED/TRANSFERRED with a completedDate.
//
// Side-effect policy: each WAITING → COMPLETED transition fires the same
// producer-side cascades a normal completion would — applyWipInventoryChange
// (for the producer-add into wip_items) and postJobCardLabor (cost ledger
// LABOR_POSTED entry). UPHOLSTERY is skipped here because its consumer-side
// already fired earlier (when downstream finished), and PACKING is skipped
// because it has no WIP terminal of its own. The earlier "metadata only"
// stance was wrong: UPH-side consumes ran when downstream completed but
// upstream producer-adds never ran (those JCs were still WAITING), leaving
// ~1300 negative wip_items rows. postProductionOrderCompletion is still
// NOT fired here — PO-flip is governed by /job-card-completion's pass.
//
// Query params:
//   ?dryRun=true|false   default false
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
const CASCADE_DATE_CLAMP = "2026-04-30";

// Default rules — fire regardless of wipType.
const CASCADE_ALLOWED_DEFAULT: Record<string, readonly string[]> = {
  UPHOLSTERY: ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING"],
  WEBBING: ["FRAMING", "WOOD_CUT"],
  FRAMING: ["WOOD_CUT"],
  FAB_SEW: ["FAB_CUT"],
};

// wipType-specific overrides. Only DIFFERENT entries from default.
const CASCADE_ALLOWED_BY_WIPTYPE: Record<
  string,
  Record<string, readonly string[]>
> = {
  HEADBOARD: { FOAM: ["FAB_CUT", "FAB_SEW"] }, // HB foam consumes sewn fabric
};

function cascadeAllowed(
  wipType: string | null | undefined,
  anchorDept: string,
): readonly string[] {
  const wt = (wipType ?? "").toUpperCase();
  return (
    CASCADE_ALLOWED_BY_WIPTYPE[wt]?.[anchorDept] ??
    CASCADE_ALLOWED_DEFAULT[anchorDept] ??
    []
  );
}

type CandidateRow = {
  id: string;
  productionOrderId: string;
  wipKey: string | null;
  departmentCode: string | null;
  wipType: string | null;
  sequence: number;
  estMinutes: number | null;
  productionTimeMinutes: number | null;
  status: string;
  completedDate: string | null;
  itemCategory: string | null;
};

type AnchorRow = {
  productionOrderId: string;
  wk: string;
  anchor_seq: number;
  anchor_date: string;
  anchor_dept: string | null;
  anchorWt: string | null;
};

type CandidatePlan = {
  cand: CandidateRow & {
    anchor_seq: number;
    anchor_date: string;
    anchor_dept: string | null;
    anchor_wipType: string | null;
  };
  newDate: string;
  actualMinutes: number;
  offsetDays: number;
  rawOffsetDays: number;
  fallback: boolean;
  clampedToAnchor: boolean;
};

function addDaysISO(iso: string, days: number): string {
  // iso assumed YYYY-MM-DD. Use UTC math to avoid TZ drift.
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

app.post("/cascade-upstream-completion", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Load production_lead_times into the (cat, dept) → days map BEFORE we
  // start computing offsets. Falls back to in-file defaults for any
  // missing pair. ACCESSORY POs reuse BEDFRAME values via leadDaysFor.
  const leadTimes: LeadTimeMap = await loadLeadTimes(db);
  const ltLookup = (cat: string | null, dept: string | null): number | null => {
    if (!dept) return null;
    const normCat = (cat || "").toUpperCase() === "SOFA" ? "SOFA" : "BEDFRAME";
    const v = leadTimes[normCat]?.[dept];
    return typeof v === "number" && v >= 0 ? v : null;
  };

  // Two-pass approach (NOT a single CTE join). The single-CTE version
  // tripped a D1 column-aliasing quirk: SELECT j.completedDate AND
  // a.anchor_date from the same underlying column returned anchor_date
  // as undefined for every row. So instead:
  //   1. Build the anchor map (productionOrderId, wipKey) → {seq, date, dept}
  //      from a query that selects ONLY anchor-side columns (no name
  //      collision with job_cards' own completedDate).
  //   2. Fetch all candidate JCs (every non-done row) and join in JS.
  // Alias note: anchorWt has NO underscore on purpose — empirically the
  // underscore-aliased `anchor_wipType` came back as undefined regardless of
  // camel/snake casing checks (likely a D1 quirk specific to mixed-case
  // identifiers after an underscore). A no-underscore alias passes through
  // cleanly.
  const anchorRes = await db
    .prepare(
      `SELECT j.productionOrderId AS productionOrderId,
              COALESCE(j.wipKey,'') AS wk,
              j.sequence AS anchor_seq,
              j.completedDate AS anchor_date,
              j.departmentCode AS anchor_dept,
              j.wipType AS anchorWt
         FROM job_cards j
         JOIN (
           SELECT productionOrderId,
                  COALESCE(wipKey,'') AS wk2,
                  MAX(sequence) AS max_seq
             FROM job_cards
            WHERE status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL
            GROUP BY productionOrderId, COALESCE(wipKey,'')
         ) m
           ON m.productionOrderId = j.productionOrderId
          AND m.wk2 = COALESCE(j.wipKey,'')
          AND m.max_seq = j.sequence
        WHERE j.status IN ('COMPLETED','TRANSFERRED') AND j.completedDate IS NOT NULL`,
    )
    .all<AnchorRow>();

  // Build a map: "<poId>||<wk>" → {anchor_seq, anchor_date, anchor_dept}
  // D1 quirk: snake_case aliases get camelCased on the way out, so
  // `anchor_date` becomes `anchorDate` in the result row. Try both forms.
  const anchorMap = new Map<
    string,
    {
      anchor_seq: number;
      anchor_date: string;
      anchor_dept: string | null;
      anchor_wipType: string | null;
    }
  >();
  for (const a of anchorRes.results ?? []) {
    const raw = a as unknown as Record<string, unknown>;
    const seq =
      typeof raw.anchorSeq === "number"
        ? (raw.anchorSeq as number)
        : typeof raw.anchor_seq === "number"
          ? (raw.anchor_seq as number)
          : null;
    const date =
      typeof raw.anchorDate === "string"
        ? (raw.anchorDate as string)
        : typeof raw.anchor_date === "string"
          ? (raw.anchor_date as string)
          : null;
    const dept =
      typeof raw.anchorDept === "string"
        ? (raw.anchorDept as string)
        : typeof raw.anchor_dept === "string"
          ? (raw.anchor_dept as string)
          : null;
    // anchorWt: no-underscore alias used to dodge the same D1 quirk that hit
    // anchor_date. Keep both forms as a belt-and-braces fallback.
    const wt =
      typeof raw.anchorWt === "string"
        ? (raw.anchorWt as string)
        : typeof raw.anchorwt === "string"
          ? (raw.anchorwt as string)
          : null;
    if (seq == null || !date) continue;
    const poId =
      typeof raw.productionOrderId === "string"
        ? (raw.productionOrderId as string)
        : "";
    const wk = typeof raw.wk === "string" ? (raw.wk as string) : "";
    const key = `${poId}||${wk}`;
    anchorMap.set(key, {
      anchor_seq: seq,
      anchor_date: date,
      anchor_dept: dept,
      anchor_wipType: wt,
    });
  }

  // Fetch every non-done JC that lives in a group with an anchor.
  // We pull the full set of non-done rows; any row whose group has no
  // anchor (i.e. nothing completed in that wipKey at all) is filtered
  // out in JS — those are legitimately untouched orders.
  // JOIN to production_orders to surface itemCategory for the leadtime
  // category lookup.
  const candRes = await db
    .prepare(
      `SELECT j.id AS id, j.productionOrderId AS productionOrderId,
              j.wipKey AS wipKey, j.departmentCode AS departmentCode,
              j.wipType AS wipType, j.sequence AS sequence,
              j.estMinutes AS estMinutes,
              j.productionTimeMinutes AS productionTimeMinutes,
              j.status AS status, j.completedDate AS completedDate,
              po.itemCategory AS itemCategory
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE (j.status NOT IN ('COMPLETED','TRANSFERRED') OR j.completedDate IS NULL)`,
    )
    .all<CandidateRow>();

  const allNonDone = candRes.results ?? [];

  // Compute per-row newDate + actualMinutes, build histogram alongside.
  // Defensive: skip rows whose anchor lookup returns nothing OR whose
  // anchor_date doesn't match ISO YYYY-MM-DD.
  const plans: CandidatePlan[] = [];
  const dateHistogram: Record<string, number> = {};
  const skipped: Array<{ jcId: string; reason: string }> = [];
  let groupHadAnchor = 0;
  let fallbackToSequence = 0;
  let parallelChainSkipped = 0;
  let clampedToAnchor = 0;
  for (const cand of allNonDone) {
    const key = `${cand.productionOrderId}||${cand.wipKey ?? ""}`;
    const anchor = anchorMap.get(key);
    if (!anchor) continue; // group has no completed sibling — leave alone
    groupHadAnchor++;
    if (cand.sequence === anchor.anchor_seq) continue; // shouldn't happen (anchor row is by definition done) but guard

    // Restricted cascade: only 4 anchor depts trigger fills, and each
    // anchor only cascades to a fixed allow-list of target depts. Any
    // other anchor dept (FOAM, WOOD_CUT, FAB_CUT, PACKING, ...)
    // → group skipped, nothing planned.
    const anchorDept = (anchor.anchor_dept || "").toUpperCase();
    const targetDept = (cand.departmentCode || "").toUpperCase();
    const allowedTargets = cascadeAllowed(anchor.anchor_wipType, anchorDept);
    if (!allowedTargets.length || !allowedTargets.includes(targetDept)) {
      parallelChainSkipped++;
      continue;
    }

    const anchorDate = anchor.anchor_date;
    if (
      typeof anchorDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)
    ) {
      skipped.push({
        jcId: cand.id,
        reason: `anchor_date not ISO YYYY-MM-DD: ${JSON.stringify(anchorDate)}`,
      });
      continue;
    }

    // Leadtime-driven offset. ltAnchor < ltTarget → upstream target →
    // negative offset → earlier date. ltAnchor > ltTarget → downstream
    // target → positive offset → later date.
    const ltAnchor = ltLookup(cand.itemCategory, anchor.anchor_dept);
    const ltTarget = ltLookup(cand.itemCategory, cand.departmentCode);
    let rawOffset: number;
    let fallback = false;
    if (ltAnchor == null || ltTarget == null) {
      // Missing leadtime data — fall back to 1-day-per-sequence-step so
      // we never silently skip a candidate.
      rawOffset = cand.sequence - anchor.anchor_seq;
      fallback = true;
      fallbackToSequence++;
    } else {
      rawOffset = ltAnchor - ltTarget;
    }

    // Clamp: backfilled completion can never exceed the anchor's date.
    // Upstream depts have larger leadtimes so their offset is naturally <= 0
    // and this clamp is a no-op. The case that triggers is downstream
    // backfill from an UPHOLSTERY anchor — e.g. PACKING in SOFA where
    // lt_UPH=4 and lt_PACKING=3 gives +1 (one day past UPH), which the user
    // says must not happen. Squashed to 0 = same date as anchor.
    let offset = rawOffset;
    let clamped = false;
    if (offset > 0) {
      offset = 0;
      clamped = true;
      clampedToAnchor++;
    }

    let newDate = addDaysISO(anchorDate, offset);
    if (newDate > CASCADE_DATE_CLAMP) newDate = CASCADE_DATE_CLAMP;
    const actualMinutes =
      cand.productionTimeMinutes != null
        ? cand.productionTimeMinutes
        : cand.estMinutes != null
          ? cand.estMinutes
          : 0;
    plans.push({
      cand: {
        ...cand,
        anchor_seq: anchor.anchor_seq,
        anchor_date: anchorDate,
        anchor_dept: anchor.anchor_dept,
        anchor_wipType: anchor.anchor_wipType,
      },
      newDate,
      actualMinutes,
      offsetDays: offset,
      rawOffsetDays: rawOffset,
      fallback,
      clampedToAnchor: clamped,
    });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
  }
  const candidatesCount = groupHadAnchor;

  // Offset summary: min/max/median across plans for a quick sanity check
  // on the spread of the new dates.
  let byOffsetSummary: { min: number; max: number; median: number } | null =
    null;
  if (plans.length > 0) {
    const offsets = plans.map((p) => p.offsetDays).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    const median =
      offsets.length % 2 === 0
        ? Math.round((offsets[mid - 1] + offsets[mid]) / 2)
        : offsets[mid];
    byOffsetSummary = {
      min: offsets[0],
      max: offsets[offsets.length - 1],
      median,
    };
  }

  // Stable, easy-to-read 5-row sample with the load-bearing fields.
  const sample = plans.slice(0, 5).map((p) => ({
    id: p.cand.id,
    productionOrderId: p.cand.productionOrderId,
    wipKey: p.cand.wipKey,
    departmentCode: p.cand.departmentCode,
    wipType: p.cand.wipType,
    itemCategory: p.cand.itemCategory,
    sequence: p.cand.sequence,
    anchor_seq: p.cand.anchor_seq,
    anchor_date: p.cand.anchor_date,
    anchor_dept: p.cand.anchor_dept,
    anchor_wipType: p.cand.anchor_wipType,
    offsetDays: p.offsetDays,
    rawOffsetDays: p.rawOffsetDays,
    clampedToAnchor: p.clampedToAnchor,
    fallback: p.fallback,
    newDate: p.newDate,
  }));

  // Targeted sample: rows where rawOffsetDays was positive and got clamped
  // back to 0 (typically PACKING target on a SOFA UPHOLSTERY anchor).
  const clampedToAnchorSample = plans
    .filter((p) => p.clampedToAnchor)
    .slice(0, 3)
    .map((p) => ({
      id: p.cand.id,
      productionOrderId: p.cand.productionOrderId,
      wipKey: p.cand.wipKey,
      anchor_dept: p.cand.anchor_dept,
      anchor_wipType: p.cand.anchor_wipType,
      anchor_date: p.cand.anchor_date,
      departmentCode: p.cand.departmentCode,
      wipType: p.cand.wipType,
      itemCategory: p.cand.itemCategory,
      rawOffsetDays: p.rawOffsetDays,
      offsetDays: p.offsetDays,
      newDate: p.newDate,
    }));

  // Stratified sample: one row per (anchor_dept, target_dept) combination
  // to verify the DAG filter is keeping each anchor on its own sub-chain.
  // Caller wants to see e.g. WOOD-anchor → wood-chain only, FAB-anchor →
  // fabric-chain only, UPHOLSTERY-anchor → all upstream depts.
  const stratifiedMap = new Map<string, CandidatePlan>();
  for (const p of plans) {
    const k = `${p.cand.anchor_dept}__${p.cand.departmentCode}`;
    if (!stratifiedMap.has(k)) stratifiedMap.set(k, p);
  }
  const stratifiedSample = Array.from(stratifiedMap.values()).map((p) => ({
    productionOrderId: p.cand.productionOrderId,
    wipKey: p.cand.wipKey,
    anchor_dept: p.cand.anchor_dept,
    departmentCode: p.cand.departmentCode,
    offsetDays: p.offsetDays,
    newDate: p.newDate,
  }));

  // Anchor-dept breakdown: { [anchor_dept]: { [target_dept]: count } } so
  // the caller can confirm zero cross-chain leakage.
  const anchorBreakdown: Record<string, Record<string, number>> = {};
  for (const p of plans) {
    const aDept = p.cand.anchor_dept || "UNKNOWN";
    const tDept = p.cand.departmentCode || "UNKNOWN";
    if (!anchorBreakdown[aDept]) anchorBreakdown[aDept] = {};
    anchorBreakdown[aDept][tDept] = (anchorBreakdown[aDept][tDept] ?? 0) + 1;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      count: candidatesCount,
      planned: plans.length,
      parallelChainSkipped,
      fallbackToSequence,
      clampedToAnchor,
      skipped,
      dateHistogram,
      byOffsetSummary,
      anchorBreakdown,
      stratifiedSample,
      clampedToAnchorSample,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  // Per-PO cache so we only fetch (po, allJcs) once even when multiple
  // candidates in the same PO get cascaded in this run. allJcs is mutated
  // in place as each candidate's status flips so subsequent siblings see
  // the updated view (mirrors the refresh-then-apply pattern in
  // /job-card-completion).
  const poCache = new Map<
    string,
    { po: ProductionOrderRow; allJcs: JobCardRow[] }
  >();

  for (const plan of plans) {
    try {
      await db
        .prepare(
          `UPDATE job_cards
              SET status = 'COMPLETED',
                  completedDate = ?,
                  actualMinutes = ?,
                  overdue = 'COMPLETED'
            WHERE id = ?`,
        )
        .bind(plan.newDate, plan.actualMinutes, plan.cand.id)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: plan.cand.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // BUG-2026-04-30 fix: this endpoint used to be metadata-only, leaving
    // ~1300 phantom UPH consumes without compensating producer-adds because
    // upstream JCs were WAITING when downstream completed. Now mirror the
    // /job-card-completion flow: after the JC UPDATE commits, fire the
    // producer-add (applyWipInventoryChange) and labor ledger
    // (postJobCardLabor) for each WAITING → COMPLETED transition.
    // Skip UPHOLSTERY (its consume already fired earlier) and PACKING
    // (no WIP terminal). Best-effort with defensive try/catch — a cascade
    // failure must NOT roll back the JC UPDATE that already committed.
    const targetDept = (plan.cand.departmentCode || "").toUpperCase();
    if (targetDept === "UPHOLSTERY" || targetDept === "PACKING") continue;

    const poId = plan.cand.productionOrderId;
    let cached = poCache.get(poId);
    if (!cached) {
      try {
        const po = await loadProductionOrderById(db, poId);
        if (!po) {
          console.error(
            "[cascade-upstream-completion] PO not found for cascade",
            { jcId: plan.cand.id, poId },
          );
          continue;
        }
        const allJcs = await findJobCardsByPO(db, poId);
        cached = { po, allJcs };
        poCache.set(poId, cached);
      } catch (err) {
        console.error(
          "[cascade-upstream-completion] PO/JC load failed",
          {
            jcId: plan.cand.id,
            poId,
            err: err instanceof Error ? err.message : String(err),
          },
        );
        continue;
      }
    }

    // Build the post-UPDATE JC snapshot. Re-use the canonical row from
    // findJobCardsByPO so applyWipInventoryChange gets the full JobCardRow
    // shape (branchKey, dueDate, etc.) — CandidateRow drops several fields.
    const idx = cached.allJcs.findIndex((j) => j.id === plan.cand.id);
    if (idx === -1) continue;
    const prevStatus = cached.allJcs[idx].status;
    const updatedJc: JobCardRow = {
      ...cached.allJcs[idx],
      status: "COMPLETED",
      completedDate: plan.newDate,
      actualMinutes: plan.actualMinutes,
      overdue: "COMPLETED",
    };
    cached.allJcs[idx] = updatedJc;

    try {
      await applyWipInventoryChange(
        db,
        cached.po,
        updatedJc,
        "COMPLETED",
        cached.allJcs,
        prevStatus,
      );
    } catch (err) {
      console.error("[cascade-upstream-completion] WIP cascade failed", {
        jcId: plan.cand.id,
        poId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await postJobCardLabor(db, plan.cand.id, poId);
    } catch (err) {
      console.error(
        "[cascade-upstream-completion] postJobCardLabor failed",
        {
          jcId: plan.cand.id,
          poId,
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    count: candidatesCount,
    planned: plans.length,
    parallelChainSkipped,
    fallbackToSequence,
    clampedToAnchor,
    skipped,
    updated,
    errors,
    dateHistogram,
    byOffsetSummary,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/fix-misparsed-jan-dates
//
// One-shot fix for the 2026-04-30 CSV import. The earlier importer parsed
// dates with a "try dd/mm, fall back to mm/dd if future" heuristic. Edge
// case: a date like `4/1/2026` is past in BOTH interpretations (4 Jan AND
// 1 Apr) so the heuristic kept `4 Jan` even though the surrounding dataset
// was clearly March/April. The user spotted rows in the live tracker where
// Foam/Wood/Framing/Webbing show 3 Jan / 4 Jan / 31 Mar mixed with
// April-due dates — clearly misparsed as Jan instead of Apr.
//
// Conservative fix:
//   1. Find job_cards where completedDate is 2026-01-xx OR 2026-02-xx, AND
//      both day and month components are <= 12 (so swap is valid).
//   2. For each, look at sibling JCs on the same productionOrderId with
//      completedDate >= '2026-03-15'. If sibling cluster exists, propose
//      the swap (YYYY-MM-DD → YYYY-DD-MM).
//   3. Validate swapped date is <= today (2026-04-30) and not in the future.
//   4. dryRun=true → return count + sample of 10 (current → proposed).
//   5. dryRun=false → UPDATE job_cards SET completedDate = proposed.
//
// Side-effect policy: metadata only — we do NOT re-run cascades. The JCs
// already fired their cascades when they completed; we're just correcting
// the date on the existing row.
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
const FIX_DATE_TODAY_CLAMP = "2026-04-30";

type SuspiciousDateRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  completedDate: string;
};

type SwapPlan = {
  jcId: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  current: string;
  proposed: string;
  siblingMaxDate: string;
  siblingsInMarchAprWindow: number;
};

app.post("/fix-misparsed-jan-dates", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Find all JCs whose completedDate is in 2026-01-xx or 2026-02-xx where the
  // day component is also <= 12 (i.e. the date is swappable).
  const sus = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, wipKey, completedDate
         FROM job_cards
        WHERE completedDate IS NOT NULL
          AND completedDate >= '2026-01-01'
          AND completedDate <  '2026-03-01'
          AND CAST(substr(completedDate, 9, 2) AS INTEGER) BETWEEN 1 AND 12
          AND CAST(substr(completedDate, 6, 2) AS INTEGER) BETWEEN 1 AND 12`,
    )
    .all<SuspiciousDateRow>();
  const suspects = sus.results ?? [];

  // For each suspect, look up siblings on same productionOrderId with
  // completedDate >= '2026-03-15'. Group by PO id to amortize the round-trip.
  const poIds = Array.from(new Set(suspects.map((s) => s.productionOrderId)));
  const siblingsByPO = new Map<string, { count: number; maxDate: string }>();

  // D1's bind doesn't support array-spread well, so chunk + IN-list.
  const CHUNK = 50;
  for (let i = 0; i < poIds.length; i += CHUNK) {
    const chunk = poIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sib = await db
      .prepare(
        `SELECT productionOrderId,
                COUNT(*) AS cnt,
                MAX(completedDate) AS maxDate
           FROM job_cards
          WHERE productionOrderId IN (${placeholders})
            AND completedDate IS NOT NULL
            AND completedDate >= '2026-03-15'
          GROUP BY productionOrderId`,
      )
      .bind(...chunk)
      .all<{ productionOrderId: string; cnt: number; maxDate: string }>();
    for (const r of sib.results ?? []) {
      siblingsByPO.set(r.productionOrderId, {
        count: r.cnt,
        maxDate: r.maxDate,
      });
    }
  }

  const plans: SwapPlan[] = [];
  const skipped: Array<{ jcId: string; reason: string }> = [];
  for (const s of suspects) {
    const sib = siblingsByPO.get(s.productionOrderId);
    if (!sib || sib.count === 0) {
      skipped.push({
        jcId: s.id,
        reason: "no sibling JC with completedDate >= 2026-03-15 on same PO",
      });
      continue;
    }

    // Swap month <-> day.
    // Format is YYYY-MM-DD, swap → YYYY-DD-MM (substr 6,2 ↔ substr 9,2).
    const yyyy = s.completedDate.slice(0, 4);
    const mm = s.completedDate.slice(5, 7);
    const dd = s.completedDate.slice(8, 10);
    const proposed = `${yyyy}-${dd}-${mm}`;

    // Sanity check: swapped date must be a valid date.
    const ddNum = parseInt(dd, 10);
    const mmNum = parseInt(mm, 10);
    if (
      !Number.isFinite(ddNum) ||
      !Number.isFinite(mmNum) ||
      ddNum < 1 ||
      ddNum > 12 ||
      mmNum < 1 ||
      mmNum > 12
    ) {
      skipped.push({
        jcId: s.id,
        reason: `non-swappable components dd=${dd} mm=${mm}`,
      });
      continue;
    }

    // Swapped date must be <= today and not the same as current.
    if (proposed > FIX_DATE_TODAY_CLAMP) {
      skipped.push({
        jcId: s.id,
        reason: `swapped date ${proposed} > today clamp ${FIX_DATE_TODAY_CLAMP}`,
      });
      continue;
    }
    if (proposed === s.completedDate) {
      skipped.push({
        jcId: s.id,
        reason: `swap is identity (palindromic date) for ${s.completedDate}`,
      });
      continue;
    }

    plans.push({
      jcId: s.id,
      productionOrderId: s.productionOrderId,
      departmentCode: s.departmentCode,
      wipKey: s.wipKey,
      current: s.completedDate,
      proposed,
      siblingMaxDate: sib.maxDate,
      siblingsInMarchAprWindow: sib.count,
    });
  }

  // By-dept and by-(current → proposed) breakdowns for sanity-checking.
  const byDept: Record<string, number> = {};
  const byMonthSwap: Record<string, number> = {};
  for (const p of plans) {
    const d = p.departmentCode || "UNKNOWN";
    byDept[d] = (byDept[d] ?? 0) + 1;
    const swapKey = `${p.current.slice(0, 7)} -> ${p.proposed.slice(0, 7)}`;
    byMonthSwap[swapKey] = (byMonthSwap[swapKey] ?? 0) + 1;
  }

  const sample = plans.slice(0, 10).map((p) => ({
    jcId: p.jcId,
    productionOrderId: p.productionOrderId,
    departmentCode: p.departmentCode,
    wipKey: p.wipKey,
    current: p.current,
    proposed: p.proposed,
    siblingMaxDate: p.siblingMaxDate,
    siblingsInMarchAprWindow: p.siblingsInMarchAprWindow,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      suspectsFound: suspects.length,
      planned: plans.length,
      skipped: skipped.length,
      skippedSample: skipped.slice(0, 5),
      byDept,
      byMonthSwap,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const p of plans) {
    try {
      await db
        .prepare(`UPDATE job_cards SET completedDate = ? WHERE id = ?`)
        .bind(p.proposed, p.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: p.jcId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    suspectsFound: suspects.length,
    planned: plans.length,
    skipped: skipped.length,
    updated,
    byDept,
    byMonthSwap,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/cascade-leak-pass
//
// Companion pass to /cascade-upstream-completion that catches "leaks" — JCs
// where the cascade missed an upstream because the wipKey grouping was too
// strict. Live tracker shows rows where UPHOLSTERY is DONE but upstream
// depts (FAB_CUT, FOAM, WOOD_CUT, FRAMING, WEBBING) are still WAITING.
//
// Root cause: the original cascade groups by (productionOrderId,
// COALESCE(wipKey,'')). Any wipKey mismatch within a PO breaks the group —
// e.g. UPHOLSTERY JC has wipKey='SOFA_BASE' but the upstream FOAM JC has
// wipKey='SOFA_CUSHION' (or NULL → ''), so they never join.
//
// Relaxed match: treat the entire production_order as ONE group. Pick the
// most-downstream COMPLETED JC in the PO (regardless of wipKey) as the
// anchor, and apply the same CASCADE_ALLOWED + leadtime offset rules to
// every non-done JC in the same PO whose departmentCode is in the anchor's
// allow-list.
//
// Side-effect policy: metadata only (status, completedDate, actualMinutes,
// overdue) — same as /cascade-upstream-completion. Cascades already fired
// when each anchor JC originally completed.
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
type LeakAnchorRow = {
  productionOrderId: string;
  anchor_seq: number;
  anchor_date: string;
  anchor_dept: string | null;
};

type LeakCandidatePlan = {
  jcId: string;
  productionOrderId: string;
  wipKey: string | null;
  departmentCode: string | null;
  wipType: string | null;
  itemCategory: string | null;
  sequence: number;
  status: string;
  currentCompletedDate: string | null;
  anchor_seq: number;
  anchor_date: string;
  anchor_dept: string;
  newDate: string;
  actualMinutes: number;
  offsetDays: number;
  rawOffsetDays: number;
  fallback: boolean;
  clampedToAnchor: boolean;
};

app.post("/cascade-leak-pass", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  const leadTimes: LeadTimeMap = await loadLeadTimes(db);
  const ltLookup = (cat: string | null, dept: string | null): number | null => {
    if (!dept) return null;
    const normCat = (cat || "").toUpperCase() === "SOFA" ? "SOFA" : "BEDFRAME";
    const v = leadTimes[normCat]?.[dept];
    return typeof v === "number" && v >= 0 ? v : null;
  };

  // Anchor query: most-downstream COMPLETED JC per productionOrderId
  // (no wipKey grouping). Same MAX(sequence) trick as the strict cascade.
  const anchorRes = await db
    .prepare(
      `SELECT j.productionOrderId AS productionOrderId,
              j.sequence AS anchor_seq,
              j.completedDate AS anchor_date,
              j.departmentCode AS anchor_dept
         FROM job_cards j
         JOIN (
           SELECT productionOrderId,
                  MAX(sequence) AS max_seq
             FROM job_cards
            WHERE status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL
            GROUP BY productionOrderId
         ) m
           ON m.productionOrderId = j.productionOrderId
          AND m.max_seq = j.sequence
        WHERE j.status IN ('COMPLETED','TRANSFERRED') AND j.completedDate IS NOT NULL`,
    )
    .all<LeakAnchorRow>();

  const anchorByPo = new Map<
    string,
    { anchor_seq: number; anchor_date: string; anchor_dept: string }
  >();
  for (const a of anchorRes.results ?? []) {
    const raw = a as unknown as Record<string, unknown>;
    const seq =
      typeof raw.anchorSeq === "number"
        ? (raw.anchorSeq as number)
        : typeof raw.anchor_seq === "number"
          ? (raw.anchor_seq as number)
          : null;
    const date =
      typeof raw.anchorDate === "string"
        ? (raw.anchorDate as string)
        : typeof raw.anchor_date === "string"
          ? (raw.anchor_date as string)
          : null;
    const dept =
      typeof raw.anchorDept === "string"
        ? (raw.anchorDept as string)
        : typeof raw.anchor_dept === "string"
          ? (raw.anchor_dept as string)
          : null;
    const poId =
      typeof raw.productionOrderId === "string"
        ? (raw.productionOrderId as string)
        : "";
    if (!poId || seq == null || !date || !dept) continue;
    // If two JCs share max_seq (shouldn't happen, but defensive), keep first.
    if (anchorByPo.has(poId)) continue;
    anchorByPo.set(poId, {
      anchor_seq: seq,
      anchor_date: date,
      anchor_dept: dept.toUpperCase(),
    });
  }

  // Fetch every non-done JC.
  const candRes = await db
    .prepare(
      `SELECT j.id AS id, j.productionOrderId AS productionOrderId,
              j.wipKey AS wipKey, j.departmentCode AS departmentCode,
              j.wipType AS wipType, j.sequence AS sequence,
              j.estMinutes AS estMinutes,
              j.productionTimeMinutes AS productionTimeMinutes,
              j.status AS status, j.completedDate AS completedDate,
              po.itemCategory AS itemCategory
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE (j.status NOT IN ('COMPLETED','TRANSFERRED') OR j.completedDate IS NULL)`,
    )
    .all<CandidateRow>();

  const allNonDone = candRes.results ?? [];

  const plans: LeakCandidatePlan[] = [];
  const skipped: Array<{ jcId: string; reason: string }> = [];
  let groupHadAnchor = 0;
  let parallelChainSkipped = 0;
  let fallbackToSequence = 0;
  let clampedToAnchor = 0;
  for (const cand of allNonDone) {
    const anchor = anchorByPo.get(cand.productionOrderId);
    if (!anchor) continue; // PO has no completed JC — leave alone
    groupHadAnchor++;

    if (cand.sequence >= anchor.anchor_seq) {
      // Candidate is at or downstream of the anchor — skip; the cascade only
      // fills upstream gaps (the rule set is strictly upstream by design).
      // We allow equality just to be safe; the strict cascade also treated
      // anchor's own sequence as a guard.
      parallelChainSkipped++;
      continue;
    }

    const anchorDept = anchor.anchor_dept;
    const targetDept = (cand.departmentCode || "").toUpperCase();
    const allowedTargets = cascadeAllowed(cand.wipType, anchorDept);
    if (!allowedTargets.length || !allowedTargets.includes(targetDept)) {
      parallelChainSkipped++;
      continue;
    }

    const anchorDate = anchor.anchor_date;
    if (
      typeof anchorDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)
    ) {
      skipped.push({
        jcId: cand.id,
        reason: `anchor_date not ISO YYYY-MM-DD: ${JSON.stringify(anchorDate)}`,
      });
      continue;
    }

    const ltAnchor = ltLookup(cand.itemCategory, anchorDept);
    const ltTarget = ltLookup(cand.itemCategory, cand.departmentCode);
    let rawOffset: number;
    let fallback = false;
    if (ltAnchor == null || ltTarget == null) {
      rawOffset = cand.sequence - anchor.anchor_seq;
      fallback = true;
      fallbackToSequence++;
    } else {
      rawOffset = ltAnchor - ltTarget;
    }

    let offset = rawOffset;
    let clamped = false;
    if (offset > 0) {
      offset = 0;
      clamped = true;
      clampedToAnchor++;
    }

    let newDate = addDaysISO(anchorDate, offset);
    if (newDate > CASCADE_DATE_CLAMP) newDate = CASCADE_DATE_CLAMP;
    const actualMinutes =
      cand.productionTimeMinutes != null
        ? cand.productionTimeMinutes
        : cand.estMinutes != null
          ? cand.estMinutes
          : 0;

    plans.push({
      jcId: cand.id,
      productionOrderId: cand.productionOrderId,
      wipKey: cand.wipKey,
      departmentCode: cand.departmentCode,
      wipType: cand.wipType,
      itemCategory: cand.itemCategory,
      sequence: cand.sequence,
      status: cand.status,
      currentCompletedDate: cand.completedDate,
      anchor_seq: anchor.anchor_seq,
      anchor_date: anchorDate,
      anchor_dept: anchorDept,
      newDate,
      actualMinutes,
      offsetDays: offset,
      rawOffsetDays: rawOffset,
      fallback,
      clampedToAnchor: clamped,
    });
  }

  // Anchor x target breakdown.
  const anchorBreakdown: Record<string, Record<string, number>> = {};
  for (const p of plans) {
    const a = p.anchor_dept;
    const t = (p.departmentCode || "UNKNOWN").toUpperCase();
    if (!anchorBreakdown[a]) anchorBreakdown[a] = {};
    anchorBreakdown[a][t] = (anchorBreakdown[a][t] ?? 0) + 1;
  }

  // wipKey-mismatch surface: among the leak candidates, how many have a
  // wipKey different from the anchor's wipKey on the same PO? We don't have
  // anchor's wipKey in this query, but we can compare candidate's wipKey to
  // the most common wipKey of completed siblings on the same PO. Simpler:
  // just count distinct (PO, wipKey) pairs in the leak set so the user can
  // see how many wipKey buckets are involved.
  const distinctPoWipPairs = new Set<string>();
  for (const p of plans) {
    distinctPoWipPairs.add(`${p.productionOrderId}||${p.wipKey ?? ""}`);
  }

  const sample = plans.slice(0, 5).map((p) => ({
    jcId: p.jcId,
    productionOrderId: p.productionOrderId,
    wipKey: p.wipKey,
    departmentCode: p.departmentCode,
    wipType: p.wipType,
    itemCategory: p.itemCategory,
    sequence: p.sequence,
    status: p.status,
    currentCompletedDate: p.currentCompletedDate,
    anchor_seq: p.anchor_seq,
    anchor_date: p.anchor_date,
    anchor_dept: p.anchor_dept,
    offsetDays: p.offsetDays,
    rawOffsetDays: p.rawOffsetDays,
    fallback: p.fallback,
    clampedToAnchor: p.clampedToAnchor,
    newDate: p.newDate,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatesWithAnchor: groupHadAnchor,
      planned: plans.length,
      parallelChainSkipped,
      fallbackToSequence,
      clampedToAnchor,
      distinctLeakPoWipPairs: distinctPoWipPairs.size,
      skipped,
      anchorBreakdown,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const p of plans) {
    try {
      await db
        .prepare(
          `UPDATE job_cards
              SET status = 'COMPLETED',
                  completedDate = ?,
                  actualMinutes = ?,
                  overdue = 'COMPLETED'
            WHERE id = ?`,
        )
        .bind(p.newDate, p.actualMinutes, p.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: p.jcId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    candidatesWithAnchor: groupHadAnchor,
    planned: plans.length,
    parallelChainSkipped,
    fallbackToSequence,
    clampedToAnchor,
    updated,
    errors,
    anchorBreakdown,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/fix-misparsed-dates
//
// One-shot fix for misparsed completedDate values from the 2026-04-30 CSV
// import (`import-prod-completions-2026-04-30.mjs`). The importer parsed CSV
// dates like `4/1/2026` ambiguously: it tried dd/mm first and kept that if
// the result was <= today. Edge case — when BOTH interpretations are past
// (e.g. `4/1/2026` is 4 Jan AND 1 Apr 2026), dd/mm wins by default. Result:
// many JCs that should be 2026-04-01 landed as 2026-01-04.
//
// User has eyeballed the live tracker and confirmed dates in 2026-01-xx and
// 2026-02-xx clusters are anomalous against same-PO siblings landing in
// 2026-03/04. This endpoint proposes (and optionally applies) a month/day
// swap on every JC where the heuristic confirms the early date is an
// outlier vs the dominant March/April cluster on the same PO.
//
// Heuristic:
//   1. Candidates: completedDate IS NOT NULL, in [2026-01-01, 2026-03-01),
//      with both day AND month components <= 12 (so the swap is valid).
//   2. Propose: YYYY-MM-DD -> YYYY-DD-MM. Skip if proposed > today (clamp).
//   3. Confirm via siblings: count JCs on the same productionOrderId
//      (excluding the candidate) whose completedDate >= '2026-03-15'. If
//      siblingsInLateCluster >= 1, the early date is an outlier — swap is
//      justified. Otherwise skip — early dates may be legitimate for that
//      PO.
//
// CAVEAT: This is a one-shot endpoint for the 2026-04-30 CSV import only.
// It deliberately mirrors the existing /fix-misparsed-jan-dates handler
// but uses the spec-defined response shape (totalCandidates / wouldSwap /
// skippedNoSiblings / sample of 20) so the user can do a final spot-check
// across the whole window before flipping dryRun=false.
//
// Side-effect policy: metadata only — we update completedDate + updated_at
// and do NOT re-run cascades. The JCs already fired their cascades when
// they completed; we're just correcting the stored date.
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
type FixDatesCandidateRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  completedDate: string;
};

type FixDatesPlan = {
  jcId: string;
  poId: string;
  departmentCode: string | null;
  current: string;
  proposed: string;
  siblingsInLateCluster: number;
};

app.post("/fix-misparsed-dates", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") !== "false";

  // 1. Pull every JC in the 2026-01/2026-02 window where day & month are
  //    both <= 12 (i.e. the swap produces a valid date).
  const candRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, completedDate
         FROM job_cards
        WHERE completedDate IS NOT NULL
          AND completedDate >= '2026-01-01'
          AND completedDate <  '2026-03-01'
          AND CAST(substr(completedDate, 9, 2) AS INTEGER) BETWEEN 1 AND 12
          AND CAST(substr(completedDate, 6, 2) AS INTEGER) BETWEEN 1 AND 12`,
    )
    .all<FixDatesCandidateRow>();
  const candidates = candRes.results ?? [];

  // 2. Lookup sibling counts on the same PO with completedDate >= 2026-03-15.
  //    Exclude the candidate itself from the count via id != ?.
  const poIds = Array.from(new Set(candidates.map((c) => c.productionOrderId)));
  const siblingsByPO = new Map<string, number>();

  const CHUNK = 50;
  for (let i = 0; i < poIds.length; i += CHUNK) {
    const chunk = poIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const sib = await db
      .prepare(
        `SELECT productionOrderId, COUNT(*) AS cnt
           FROM job_cards
          WHERE productionOrderId IN (${placeholders})
            AND completedDate IS NOT NULL
            AND completedDate >= '2026-03-15'
          GROUP BY productionOrderId`,
      )
      .bind(...chunk)
      .all<{ productionOrderId: string; cnt: number }>();
    for (const r of sib.results ?? []) {
      siblingsByPO.set(r.productionOrderId, r.cnt);
    }
  }

  // 3. Build per-candidate plan. Subtract 1 if the candidate itself happens
  //    to fall in the late cluster (it shouldn't, since it's in 2026-01/02,
  //    but guard anyway).
  const plans: FixDatesPlan[] = [];
  let skippedNoSiblings = 0;
  let skippedOther = 0;
  for (const cand of candidates) {
    const yyyy = cand.completedDate.slice(0, 4);
    const mm = cand.completedDate.slice(5, 7);
    const dd = cand.completedDate.slice(8, 10);
    const proposed = `${yyyy}-${dd}-${mm}`;

    const ddNum = parseInt(dd, 10);
    const mmNum = parseInt(mm, 10);
    if (
      !Number.isFinite(ddNum) ||
      !Number.isFinite(mmNum) ||
      ddNum < 1 ||
      ddNum > 12 ||
      mmNum < 1 ||
      mmNum > 12
    ) {
      skippedOther++;
      continue;
    }
    if (proposed > FIX_DATE_TODAY_CLAMP) {
      skippedOther++;
      continue;
    }
    if (proposed === cand.completedDate) {
      // palindromic (e.g. 2026-02-02) — nothing to swap
      skippedOther++;
      continue;
    }

    const siblingsInLateCluster = siblingsByPO.get(cand.productionOrderId) ?? 0;
    if (siblingsInLateCluster < 1) {
      skippedNoSiblings++;
      continue;
    }

    plans.push({
      jcId: cand.id,
      poId: cand.productionOrderId,
      departmentCode: cand.departmentCode,
      current: cand.completedDate,
      proposed,
      siblingsInLateCluster,
    });
  }

  const sample = plans.slice(0, 20).map((p) => ({
    jcId: p.jcId,
    poId: p.poId,
    departmentCode: p.departmentCode,
    current: p.current,
    proposed: p.proposed,
    siblingsInLateCluster: p.siblingsInLateCluster,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalCandidates: candidates.length,
      wouldSwap: plans.length,
      skippedNoSiblings,
      skippedOther,
      sample,
    });
  }

  // 4. Live: update each row's completedDate + updated_at.
  const nowIso = new Date().toISOString();
  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];
  for (const p of plans) {
    try {
      await db
        .prepare(
          `UPDATE job_cards SET completedDate = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(p.proposed, nowIso, p.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: p.jcId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    totalCandidates: candidates.length,
    wouldSwap: plans.length,
    skippedNoSiblings,
    skippedOther,
    updated,
    errors,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-cascade-wip-producers
//
// Layer-1 fix for the WIP-leak introduced by /cascade-upstream-completion.
//
// Investigation summary (mental model — confirmed before coding):
//   1. applyWipInventoryChange(db, po, jc, "COMPLETED", refreshed, "WAITING")
//      is the producer-add: for non-UPH non-PACKING depts it does
//      "UPDATE wip_items SET stockQty = stockQty + wipQty WHERE code =
//      jc.wipLabel" (insert if missing). UPH instead consumes branch-
//      terminal wip_items + adds its own row.
//   2. /cascade-upstream-completion was metadata-only — see its big header:
//      "Side-effect policy: metadata cleanup only — no
//      applyWipInventoryChange". Status, completedDate, actualMinutes,
//      overdue='COMPLETED' got UPDATEd but the producer-add never fired.
//   3. Meanwhile UPH (the cascade anchor) DID consume the branch-terminal
//      wip_items when it originally completed via the scan-complete path,
//      but its upstream branch-terminal JC was still WAITING at that
//      moment, so the upstream JC's eventual cascade-COMPLETED never
//      produced its row. Result: -212 phantom on labels like
//      "8\" Divan-5FT Foam".
//   4. We fix by re-firing applyWipInventoryChange for every cascade-
//      completed JC with prevStatus='WAITING' newStatus='COMPLETED'. UPH
//      is excluded (its original consume was correct). PACKING is
//      excluded (no WIP terminal). FAB_CUT and WOOD_CUT are PRODUCER-ONLY
//      raw-material entry depts — they ALSO need the producer-add.
//   5. Cascade signature: status IN COMPLETED/TRANSFERRED + completedDate
//      NOT NULL + overdue='COMPLETED' + actualMinutes = COALESCE(
//      productionTimeMinutes, estMinutes, 0). The cascade endpoint set
//      actualMinutes from exactly that COALESCE, so the equality identifies
//      cascade-set rows. (Real scan-completed JCs almost always have
//      actualMinutes != that value because the operator's elapsed time
//      diverged from the plan.)
//
// Side-effect policy: ONLY applyWipInventoryChange. We do NOT post labor
// (postJobCardLabor was already fired by other paths or is irrelevant for
// this WIP fix), and we do NOT touch the PO completion state. The point
// is to credit the missing producer-add so wip_items reflects reality.
//
// Query params:
//   ?dryRun=true|false   default false
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
type CascadeBackfillRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  completedDate: string | null;
  status: string;
  sequence: number;
  estMinutes: number | null;
  productionTimeMinutes: number | null;
  actualMinutes: number | null;
  overdue: string | null;
};

app.post("/backfill-cascade-wip-producers", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Cascade signature query.
  // - status COMPLETED or TRANSFERRED
  // - completedDate NOT NULL
  // - overdue = 'COMPLETED'  (cascade always set this literal)
  // - actualMinutes = COALESCE(productionTimeMinutes, estMinutes, 0)
  //   The cascade endpoint computed actualMinutes from exactly that
  //   COALESCE; equality is a strong cascade fingerprint. BUT the CSV
  //   importer (/job-card-completion line 504) ALSO computes
  //   actualMinutes from the same COALESCE, so this clause alone matches
  //   ~3,182 rows including ~1,800 CSV-completed JCs that already had
  //   their producer-add fired correctly. Backfilling those would
  //   double-credit wip_items.
  // - departmentCode != 'UPHOLSTERY'  (UPH consumed correctly)
  // - departmentCode != 'PACKING'     (no WIP terminal)
  // - pic1Id IS NULL AND COALESCE(pic1Name,'') = ''
  //   The cascade UPDATE never touched PIC fields (see
  //   /cascade-upstream-completion's UPDATE clause — only sets status,
  //   completedDate, actualMinutes, overdue). The CSV importer
  //   unconditionally writes pic1Id/pic1Name in its UPDATE (line 517).
  //   So a JC with empty PIC fields was either never CSV-touched (pure
  //   cascade-completed) or CSV-touched with a row that had no PIC
  //   supplied. The latter case is rare (CSV rows generally include
  //   a PIC) and even if hit, that path also fires applyWipInventoryChange
  //   correctly — so the residual false-positive rate is small.
  // - completedDate window 2026-01-01 to 2026-04-30
  //   The full cascade run footprint by user's account.
  //
  // We do NOT exclude FAB_CUT or WOOD_CUT here — they are producer-only
  // raw-material entry depts; their producer-add is exactly what
  // populates the early WIP rows that downstream FRAMING/FAB_SEW then
  // consume from.
  const candRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, wipKey, wipLabel,
              wipQty, completedDate, status, sequence, estMinutes,
              productionTimeMinutes, actualMinutes, overdue
         FROM job_cards
        WHERE status IN ('COMPLETED','TRANSFERRED')
          AND completedDate IS NOT NULL
          AND overdue = 'COMPLETED'
          AND UPPER(COALESCE(departmentCode,'')) != 'UPHOLSTERY'
          AND UPPER(COALESCE(departmentCode,'')) != 'PACKING'
          AND actualMinutes = COALESCE(productionTimeMinutes, estMinutes, 0)
          AND pic1Id IS NULL
          AND COALESCE(pic1Name,'') = ''
          AND completedDate >= '2026-01-01'
          AND completedDate <= '2026-04-30'`,
    )
    .all<CascadeBackfillRow>();
  const candidates = candRes.results ?? [];

  // Department distribution + wipQty totals + sample (computed regardless
  // of dryRun). wipQty totals let us cross-validate against the audit's
  // 517 negative wip_items rows totalling -1,506: deptWipQtyTotals['<dept>']
  // should be >= the audit's negative magnitude per dept for a complete fix.
  const deptCounts: Record<string, number> = {};
  const deptWipQtyTotals: Record<string, number> = {};
  let totalWipQty = 0;
  for (const r of candidates) {
    const d = (r.departmentCode || "UNKNOWN").toUpperCase();
    deptCounts[d] = (deptCounts[d] ?? 0) + 1;
    const q = typeof r.wipQty === "number" ? r.wipQty : 0;
    deptWipQtyTotals[d] = (deptWipQtyTotals[d] ?? 0) + q;
    totalWipQty += q;
  }
  const sample = candidates.slice(0, 10).map((r) => ({
    jcId: r.id,
    productionOrderId: r.productionOrderId,
    departmentCode: r.departmentCode,
    wipKey: r.wipKey,
    wipLabel: r.wipLabel,
    wipQty: r.wipQty,
    completedDate: r.completedDate,
    sequence: r.sequence,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidateCount: candidates.length,
      totalWipQty,
      deptCounts,
      deptWipQtyTotals,
      sample,
    });
  }

  // Live mode: per candidate, load po + sibling JCs, fire
  // applyWipInventoryChange with prevStatus=WAITING newStatus=COMPLETED.
  // Cache (po, sibling JCs) per productionOrderId — multiple candidates
  // share the PO, and applyWipInventoryChange only writes to wip_items
  // (not job_cards) so the cached sibling list stays valid for every
  // candidate within the same PO.
  const poCache = new Map<string, ProductionOrderRow>();
  const jcCache = new Map<string, JobCardRow[]>();
  let posted = 0;
  let skippedNoPo = 0;
  let skippedNoJc = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  for (const cand of candidates) {
    try {
      let po = poCache.get(cand.productionOrderId);
      if (!po) {
        const poRow = await db
          .prepare(
            `SELECT id, poNo, salesOrderId, salesOrderNo, lineNo, customerPOId,
                    customerReference, customerName, customerState, companySOId,
                    consignmentOrderId, companyCOId, productId, productCode,
                    productName, itemCategory, sizeCode, sizeLabel, fabricCode,
                    quantity, gapInches, divanHeightInches, legHeightInches,
                    specialOrder, notes, status, currentDepartment, progress,
                    startDate, targetEndDate, completedDate, rackingNumber,
                    stockedIn, created_at AS createdAt, updated_at AS updatedAt
               FROM production_orders WHERE id = ?`,
          )
          .bind(cand.productionOrderId)
          .first<ProductionOrderRow>();
        if (!poRow) {
          skippedNoPo++;
          continue;
        }
        po = poRow;
        poCache.set(po.id, po);
      }

      let allJcs = jcCache.get(po.id);
      if (!allJcs) {
        allJcs = await findJobCardsByPO(db, po.id);
        jcCache.set(po.id, allJcs);
      }

      const updated = allJcs.find((j) => j.id === cand.id);
      if (!updated) {
        skippedNoJc++;
        continue;
      }

      // Mirror import-completion's cascade-firing pattern:
      //   applyWipInventoryChange(db, po, updated, "COMPLETED",
      //                           refreshed, prevStatus="WAITING")
      // prevStatus="WAITING" → forward (becomingActive + producer-upsert)
      // path. updated.status is already "COMPLETED" in the row so
      // newStatus="COMPLETED" matches reality.
      await applyWipInventoryChange(
        db,
        po,
        updated,
        "COMPLETED",
        allJcs,
        "WAITING",
      );
      posted++;
    } catch (err) {
      errors.push({
        jcId: cand.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    candidateCount: candidates.length,
    totalWipQty,
    posted,
    skippedNoPo,
    skippedNoJc,
    errors,
    deptCounts,
    deptWipQtyTotals,
    sample,
  });
});

export default app;

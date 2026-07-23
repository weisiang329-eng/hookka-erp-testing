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
import { invalidateProductionListCaches } from "../lib/po-list-cache";
import { autofillWorkingHoursFromPunch } from "../lib/punch-autofill";
import {
  applyWipInventoryChange,
  recomputePoStatusAndProgress,
  type JobCardRow,
  type ProductionOrderRow,
} from "./production-orders";
import {
  consumeRawMaterialsForPO,
  postJobCardLabor,
} from "../lib/po-cost-cascade";
import { postProductionOrderCompletion } from "../lib/fg-completion";
import { generateFGUnitsForPO } from "./fg-units";
import {
  loadLeadTimes,
  loadHookkaDDBuffer,
  hookkaDDBufferFor,
  addDays,
  type LeadTimeMap,
} from "../lib/lead-times";
import { createProductionOrdersForOrder } from "./_shared/production-builder";
import {
  createProductionOrdersForSO,
  type SalesOrderRow,
  type SalesOrderItemRow,
} from "./sales-orders";
import { loadAndValidatePOAlignment } from "../lib/po-alignment-validator";
import { getOrgId } from "../lib/tenant";
import { validateFabricCodes } from "../lib/fabric-validation";
import {
  breakBomIntoWips,
  type BomVariantContext,
} from "../lib/bom-wip-breakdown";

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
  //   1. customerPOId — primary. Real customer PO numbers live here
  //                     (e.g. "PO-008657"). The shorter `customerPO`
  //                     column exists in the schema but is empty in prod —
  //                     OR'd in below as a defensive fallback in case any
  //                     legacy row ended up populating it instead.
  //   2. reference    — most common (HC#, CR#, AKHC#, ZNT# etc). Supports
  //                     combined values like "CR0450+CR1056" by splitting
  //                     on + or , and OR-ing the lookups.
  //   3. companySOId  — fallback to our internal SO number (SO-2509-238).
  const customerPOTokens = splitMultiRef(lookup.custPONo);
  if (customerPOTokens.length > 0) {
    const all = new Set<string>();
    for (const tok of customerPOTokens) {
      const res = await db
        .prepare(
          "SELECT id FROM sales_orders WHERE customerPOId = ? OR customerPO = ?",
        )
        .bind(tok, tok)
        .all<SalesOrderIdRow>();
      for (const r of res.results ?? []) all.add(r.id);
    }
    if (all.size > 0) return { ids: Array.from(all), matchedVia: "customerPOId" };
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
      // sales_orders has no so_no column — the customer-facing SO number
      // lives in companySOId ("SO-2509-238"). Earlier code searched
      // soNo and silently failed at the Postgres layer because that
      // column doesn't exist on this table.
      const res = await db
        .prepare("SELECT id FROM sales_orders WHERE companySOId = ?")
        .bind(tok)
        .all<SalesOrderIdRow>();
      for (const r of res.results ?? []) all.add(r.id);
    }
    if (all.size > 0) return { ids: Array.from(all), matchedVia: "companySOId" };
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
  // Threaded from the handler so the WIP cascade's wip_cascade_log
  // idempotency guard engages (2026-07-03 audit: backfill re-runs /
  // cursor-resumes could double-apply inventory changes without it).
  orgId: string,
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
              { orgId, source: "BACKFILL" },
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
      const res = await processRow(db, absoluteIdx, r, workerCache, dryRun, getOrgId(c));
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

  // A completion import moves job_cards AND flips production_orders to
  // COMPLETED in bulk — the dept sheets would keep listing finished work.
  // Skipped on a dry run, which writes nothing. See
  // tests/production-write-invalidation-class.test.mjs.
  if (!dryRun) {
    try {
      await invalidateProductionListCaches(c, getOrgId(c));
    } catch (err) {
      console.warn(
        "[import-completion] cache invalidation failed:",
        err instanceof Error ? err.message : String(err),
      );
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
// each (productionOrderId, wipKey, branchKey) group, find the most-downstream
// completed JC (the "anchor" — MAX(sequence) among rows where status IN
// ('COMPLETED', 'TRANSFERRED') AND completedDate IS NOT NULL). If the anchor's
// dept is in the rule set, plan completions for the listed target depts in
// that group. Any other anchor dept → entire group is skipped.
//
// Why per-branchKey, not just per-wipKey: each (PO, wipKey) typically has
// TWO BOM sub-branches that must cascade independently. E.g. SOFA_BASE has
// a fabric branch (FAB_CUT → FAB_SEW) and a wood branch (WOOD_CUT → FRAMING
// → WEBBING → FOAM). If we group by (PO, wipKey) only, MAX(sequence) picks
// the higher of the two branch heads — e.g. WOOD_CUT (seq=2) outranks
// FAB_SEW (seq=1) — and since WOOD_CUT has no upstream cascade rule, the
// fabric-branch FAB_CUT is left WAITING even though FAB_SEW (its anchor)
// is complete. Grouping by branchKey too gives each branch its own anchor
// and lets each cascade fire on its own rule. applyWipInventoryChange's
// sibling lookup is already (wipKey, branchKey)-scoped (production-orders.ts
// L1121, L1157, L1373), so per-branch is the natural granularity here too.
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
// Today-cap: newDate can never land beyond this date. Update before each
// re-run; the previous value (2026-05-04) was correct at the time of the
// first pass but stale for the 2026-05-11 re-run, which would have
// pinned every May 5–11 anchor's backfill date to 2026-05-04.
const CASCADE_DATE_CLAMP = "2026-05-11";

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
  branchKey: string | null;
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
  bk: string;
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
              COALESCE(j.branchKey,'') AS bk,
              j.sequence AS anchor_seq,
              j.completedDate AS anchor_date,
              j.departmentCode AS anchor_dept,
              j.wipType AS "anchorWt"
         FROM job_cards j
         JOIN (
           SELECT productionOrderId,
                  COALESCE(wipKey,'') AS wk2,
                  COALESCE(branchKey,'') AS bk2,
                  MAX(sequence) AS max_seq
             FROM job_cards
            WHERE status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL
            GROUP BY productionOrderId, COALESCE(wipKey,''), COALESCE(branchKey,'')
         ) m
           ON m.productionOrderId = j.productionOrderId
          AND m.wk2 = COALESCE(j.wipKey,'')
          AND m.bk2 = COALESCE(j.branchKey,'')
          AND m.max_seq = j.sequence
        WHERE j.status IN ('COMPLETED','TRANSFERRED') AND j.completedDate IS NOT NULL`,
    )
    .all<AnchorRow>();

  // Build a map: "<poId>||<wk>||<bk>" → {anchor_seq, anchor_date, anchor_dept}
  // Per-branchKey scoping so each BOM sub-branch (e.g. fabric vs wood under
  // SOFA_BASE) gets its own anchor and cascades independently.
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
    const bk = typeof raw.bk === "string" ? (raw.bk as string) : "";
    const key = `${poId}||${wk}||${bk}`;
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
              j.wipKey AS wipKey, j.branchKey AS branchKey,
              j.departmentCode AS departmentCode,
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
    const key = `${cand.productionOrderId}||${cand.wipKey ?? ""}||${cand.branchKey ?? ""}`;
    const anchor = anchorMap.get(key);
    if (!anchor) continue; // branch has no completed sibling — leave alone
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
    branchKey: p.cand.branchKey,
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
        { orgId: getOrgId(c), source: "BACKFILL" },
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
// POST /api/import/uph-pofold-backfill?dryRun=true|false
//
// Per-WIP backfill that complements /cascade-upstream-completion. The
// existing cascade walks per (PO, wipKey, branchKey) groups, which leaves
// a hole for the migration-period scenario where a worker scans only the
// terminal UPHOLSTERY JC and never scans any earlier-dept JC at all.
// In that case the wood/fabric sub-branches sit alone in their groups
// (no UPH sibling, since UPH lives at branchKey="" on the wipKey root),
// the per-branch anchor falls back to FAB_SEW / WOOD_CUT / FRAMING, and
// none of those anchors cascade upstream by the rule set — so 0 rows
// move (observed live: 1189 candidates → 0 planned).
//
// This endpoint takes the simpler PER-WIP view:
//
//   1. For each (PO, wipKey), find the UPH JC (there is exactly one per
//      top-level WIP — see bom-wip-breakdown.ts:319-369). If that UPH
//      is COMPLETED/TRANSFERRED with a completedDate, the entire WIP
//      is eligible for backfill.
//   2. Backfill EVERY non-done JC in the eligible (PO, wipKey) whose
//      deptCode ∈ {FAB_CUT, FAB_SEW, WOOD_CUT, FRAMING, WEBBING, FOAM},
//      regardless of branchKey. PACKING is skipped (it lives in the
//      separate wipKey="FG" group and is governed by the PO-completion
//      handler). UPH itself is the eligibility signal so it's by
//      definition already done.
//   3. Process the flips in DEPT_ORDER (FAB_CUT → FAB_SEW → WOOD_CUT →
//      FOAM → FRAMING → WEBBING) so each dept's applyWipInventoryChange
//      finds its upstream sibling already producer-added.
//   4. completedDate uses the canonical leadtime formula
//      (anchor_date + (ltAnchor - ltTarget) days, clamped to 0 if
//      positive, clamped to CASCADE_DATE_CLAMP if past today). Anchor
//      is the UPH completedDate of the SAME wipKey. For SOFA all
//      upstream lead times ≤ UPH's so offsets collapse to 0 → all
//      backfilled dates equal the per-WIP UPH completedDate, which is
//      the physical reality (workers scanned UPH as a one-shot at the
//      end of the cycle).
//   5. Each WAITING → COMPLETED flip fires applyWipInventoryChange and
//      postJobCardLabor (best-effort: a cascade failure does NOT roll
//      back the JC UPDATE). PIC fields are left untouched (NULL on the
//      WAITING row, NULL after the UPDATE).
//
// Half-completed UPH POs (e.g. BEDFRAME with DIVAN UPH done +
// HEADBOARD UPH still WAITING): the per-WIP gating naturally handles
// them — DIVAN's earlier depts get backfilled, HEADBOARD's untouched.
//
// Migration cleanup: this endpoint, /cascade-upstream-completion, and
// /backfill-cascade-wip-producers are all one-shot tools and will be
// removed wholesale post-migration. Don't refactor or generalize.
//
// Query params:
//   ?dryRun=true|false   default false
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
const UPH_POFOLD_TARGET_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
]);
const UPH_POFOLD_DEPT_ORDER = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
] as const;

type UphPofoldCandidate = {
  id: string;
  productionOrderId: string;
  wipKey: string;
  branchKey: string | null;
  departmentCode: string;
  wipType: string | null;
  itemCategory: string | null;
  sequence: number;
  estMinutes: number | null;
  productionTimeMinutes: number | null;
  anchorDate: string;
  newDate: string;
  actualMinutes: number;
  offsetDays: number;
  clampedToAnchor: boolean;
};

app.post("/uph-pofold-backfill", async (c) => {
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

  // Per-WIP UPH anchor map: (productionOrderId, wipKey) → completedDate.
  // Only includes (PO, wipKey) where the UPH JC is COMPLETED/TRANSFERRED
  // with a non-null completedDate. wipKey is COALESCEd to '' so empty-key
  // rows still group cleanly.
  const uphAnchorRes = await db
    .prepare(
      `SELECT productionOrderId,
              COALESCE(wipKey,'') AS wk,
              completedDate AS "uphDate"
         FROM job_cards
        WHERE departmentCode = 'UPHOLSTERY'
          AND status IN ('COMPLETED','TRANSFERRED')
          AND completedDate IS NOT NULL`,
    )
    .all<{ productionOrderId: string; wk: string; uphDate: string }>();
  const uphAnchorMap = new Map<string, string>();
  for (const r of uphAnchorRes.results ?? []) {
    const raw = r as unknown as Record<string, unknown>;
    const date =
      typeof raw.uphDate === "string"
        ? (raw.uphDate as string)
        : typeof raw.uphdate === "string"
          ? (raw.uphdate as string)
          : null;
    if (!date) continue;
    uphAnchorMap.set(`${r.productionOrderId}||${r.wk}`, date);
  }

  // Candidate JCs: WAITING earlier-dept rows whose (PO, wipKey) has an
  // UPH anchor in the map above. Only six target depts.
  const candRes = await db
    .prepare(
      `SELECT j.id              AS id,
              j.productionOrderId AS productionOrderId,
              COALESCE(j.wipKey,'')  AS wipKey,
              j.branchKey       AS branchKey,
              j.departmentCode  AS departmentCode,
              j.wipType         AS wipType,
              po.itemCategory   AS itemCategory,
              j.sequence        AS sequence,
              j.estMinutes      AS estMinutes,
              j.productionTimeMinutes AS productionTimeMinutes
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE j.status = 'WAITING'
          AND j.completedDate IS NULL
          AND j.departmentCode IN ('FAB_CUT','FAB_SEW','WOOD_CUT','FOAM','FRAMING','WEBBING')`,
    )
    .all<Omit<UphPofoldCandidate, "anchorDate" | "newDate" | "actualMinutes" | "offsetDays" | "clampedToAnchor">>();
  const allWaiting = candRes.results ?? [];

  let noUphAnchorSkipped = 0;
  const plans: UphPofoldCandidate[] = [];
  const dateHistogram: Record<string, number> = {};
  const deptCounts: Record<string, number> = {};
  for (const cand of allWaiting) {
    const key = `${cand.productionOrderId}||${cand.wipKey ?? ""}`;
    const anchorDate = uphAnchorMap.get(key);
    if (!anchorDate) {
      // (PO, wipKey) has no completed UPH — that WIP is still in production,
      // skip per Policy B.
      noUphAnchorSkipped++;
      continue;
    }
    if (!UPH_POFOLD_TARGET_DEPTS.has(cand.departmentCode)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) continue;

    const ltAnchor = ltLookup(cand.itemCategory, "UPHOLSTERY");
    const ltTarget = ltLookup(cand.itemCategory, cand.departmentCode);
    let offset: number;
    let clamped = false;
    if (ltAnchor == null || ltTarget == null) {
      offset = 0;
    } else {
      offset = ltAnchor - ltTarget;
      if (offset > 0) {
        offset = 0;
        clamped = true;
      }
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
      ...cand,
      anchorDate,
      newDate,
      actualMinutes,
      offsetDays: offset,
      clampedToAnchor: clamped,
    });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
    deptCounts[cand.departmentCode] =
      (deptCounts[cand.departmentCode] ?? 0) + 1;
  }

  // Sort by DEPT_ORDER then by PO+wipKey for stable + cascade-safe order.
  const deptRank: Record<string, number> = {};
  UPH_POFOLD_DEPT_ORDER.forEach((d, i) => {
    deptRank[d] = i;
  });
  plans.sort((a, b) => {
    const dA = deptRank[a.departmentCode] ?? 99;
    const dB = deptRank[b.departmentCode] ?? 99;
    if (dA !== dB) return dA - dB;
    const k = `${a.productionOrderId}||${a.wipKey}`.localeCompare(
      `${b.productionOrderId}||${b.wipKey}`,
    );
    if (k !== 0) return k;
    return a.sequence - b.sequence;
  });

  const sample = plans.slice(0, 10).map((p) => ({
    id: p.id,
    productionOrderId: p.productionOrderId,
    wipKey: p.wipKey,
    branchKey: p.branchKey,
    departmentCode: p.departmentCode,
    wipType: p.wipType,
    itemCategory: p.itemCategory,
    anchorDate: p.anchorDate,
    newDate: p.newDate,
    offsetDays: p.offsetDays,
    clampedToAnchor: p.clampedToAnchor,
    actualMinutes: p.actualMinutes,
  }));

  // Distinct (PO, wipKey) pairs in scope — useful counter alongside JC count.
  const distinctWips = new Set(plans.map((p) => `${p.productionOrderId}||${p.wipKey}`));
  const distinctPOs = new Set(plans.map((p) => p.productionOrderId));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatesScanned: allWaiting.length,
      noUphAnchorSkipped,
      planned: plans.length,
      distinctWipKeysAffected: distinctWips.size,
      distinctPOsAffected: distinctPOs.size,
      deptCounts,
      dateHistogram,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  // Per-PO load cache so multiple flips in the same PO share one fetch.
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
        .bind(plan.newDate, plan.actualMinutes, plan.id)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: plan.id,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const poId = plan.productionOrderId;
    let cached = poCache.get(poId);
    if (!cached) {
      try {
        const po = await loadProductionOrderById(db, poId);
        if (!po) continue;
        const allJcs = await findJobCardsByPO(db, poId);
        cached = { po, allJcs };
        poCache.set(poId, cached);
      } catch (err) {
        console.error("[uph-pofold-backfill] PO/JC load failed", {
          jcId: plan.id,
          poId,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const idx = cached.allJcs.findIndex((j) => j.id === plan.id);
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
        { orgId: getOrgId(c), source: "BACKFILL" },
      );
    } catch (err) {
      console.error("[uph-pofold-backfill] WIP cascade failed", {
        jcId: plan.id,
        poId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await postJobCardLabor(db, plan.id, poId);
    } catch (err) {
      console.error("[uph-pofold-backfill] postJobCardLabor failed", {
        jcId: plan.id,
        poId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    candidatesScanned: allWaiting.length,
    noUphAnchorSkipped,
    planned: plans.length,
    distinctWipKeysAffected: distinctWips.size,
    distinctPOsAffected: distinctPOs.size,
    updated,
    errors,
    deptCounts,
    dateHistogram,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/sync-maintenance-history-from-kv?dryRun=true|false
//
// One-shot sync that captures the LIVE kv_config('variants-config[:cust]')
// blob into maintenance_config_history when the latest history snapshot
// differs from the live blob. Symptom this fixes: a customer's
// MaintenanceItemHistoryDialog shows old prices (e.g. RM 150) while the
// inline list shows the current edited value (RM 160) — meaning a prior
// kv_config write didn't create a corresponding history snapshot.
//
// Idempotent: skips scopes whose latest snapshot already matches the
// live blob.
// ---------------------------------------------------------------------------
app.post("/sync-maintenance-history-from-kv", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);

  // Load every kv_config row that's a maintenance blob.
  const kvRes = await db
    .prepare(
      `SELECT key, value FROM kv_config
        WHERE key = 'variants-config' OR key LIKE 'variants-config:%'`,
    )
    .all<{ key: string; value: string }>();
  const kvRows = kvRes.results ?? [];

  const candidates: Array<{
    scope: string;
    kvKey: string;
    liveLen: number;
    latestSnapshotEffectiveFrom: string | null;
    latestSnapshotLen: number | null;
    needsSync: boolean;
  }> = [];
  let willInsert = 0;
  for (const kv of kvRows) {
    const scope =
      kv.key === "variants-config"
        ? "master"
        : `customer:${kv.key.slice("variants-config:".length)}`;
    // Latest snapshot for this scope.
    const latestRes = await db
      .prepare(
        `SELECT effective_from AS "effectiveFrom", config
           FROM maintenance_config_history
          WHERE scope = ?
          ORDER BY effective_from DESC, created_at DESC
          LIMIT 1`,
      )
      .bind(scope)
      .all<Record<string, unknown>>();
    const lr = (latestRes.results ?? [])[0];
    const lrEff =
      typeof lr?.effectiveFrom === "string"
        ? (lr.effectiveFrom as string)
        : typeof lr?.effective_from === "string"
          ? (lr.effective_from as string)
          : null;
    const lrCfg = typeof lr?.config === "string" ? (lr.config as string) : null;
    const needsSync = lrCfg !== kv.value;
    candidates.push({
      scope,
      kvKey: kv.key,
      liveLen: kv.value.length,
      latestSnapshotEffectiveFrom: lrEff,
      latestSnapshotLen: lrCfg ? lrCfg.length : null,
      needsSync,
    });
    if (needsSync) willInsert++;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalScopes: candidates.length,
      willInsert,
      sample: candidates.slice(0, 20),
    });
  }

  let inserted = 0;
  for (const c0 of candidates) {
    if (!c0.needsSync) continue;
    const kv = kvRows.find((k) => k.key === c0.kvKey);
    if (!kv) continue;
    const newId = `mch-sync-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db
      .prepare(
        `INSERT INTO maintenance_config_history
           (id, scope, config, effective_from, notes, created_by)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        newId,
        c0.scope,
        kv.value,
        today,
        "Auto-synced from kv_config (live edit not previously captured)",
      )
      .run();
    inserted++;
  }

  return c.json({
    success: true,
    dryRun: false,
    totalScopes: candidates.length,
    willInsert,
    inserted,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/cleanup-snapshot-from-master-rows?dryRun=true|false
//
// One-shot DELETE for the redundant "Snapshot from Master <date>" rows
// in customer_product_prices that the OLD copy-from-master logic created
// (one per cp, dated today's date, recording the current master price).
//
// The new copy-from-master mirrors the FULL master history, so the
// snapshot row is now redundant — the same price is already reachable
// via the 4-26 (or whichever is most recent) master mirror row.
//
// Idempotent. Migration-temp.
// ---------------------------------------------------------------------------
app.post("/cleanup-snapshot-from-master-rows", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  const candidatesRes = await db
    .prepare(
      `SELECT id, customerProductId, basePriceSen, effectiveFrom, notes
         FROM customer_product_prices
        WHERE notes LIKE 'Snapshot from Master%'`,
    )
    .all<{
      id: string;
      customerProductId: string;
      basePriceSen: number | null;
      effectiveFrom: string;
      notes: string | null;
    }>();
  const candidates = candidatesRes.results ?? [];

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      planned: candidates.length,
      sample: candidates.slice(0, 10),
    });
  }

  let deleted = 0;
  for (let i = 0; i < candidates.length; i += 50) {
    const slice = candidates.slice(i, i + 50);
    const stmts = slice.map((r) =>
      db
        .prepare("DELETE FROM customer_product_prices WHERE id = ?")
        .bind(r.id),
    );
    await db.batch(stmts);
    deleted += slice.length;
  }

  return c.json({
    success: true,
    dryRun: false,
    planned: candidates.length,
    deleted,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/derive-historical-price-baselines?dryRun=true|false
//
// One-shot helper to seed `customer_product_prices` + `product_prices`
// baseline rows from historical SO line snapshots, all anchored at a
// single fixed date (2020-01-01) per Wei Siang's request:
// "把最开始的价钱记录进 2020 年 1 月 1 号".
//
// Why this is needed: the auto-baseline UI logic (customer-products.ts:
// 467, products.ts:954) only fires when scheduling a FUTURE-dated row
// with NO existing history. Wei Siang's manual data entry was past-
// dated (the actual price-change events landed on 2026-04-01 and
// 2026-04-26), so auto-baseline never fired and the pre-2026 baseline
// is missing. The resolver then falls back to the legacy
// `customer_products.basePriceSen` column — which has been overwritten
// with the latest price — and historical SOs would resolve to the
// wrong "as-of-then" price.
//
// Algorithm:
//   1. For each customer_products row that has any existing history:
//      - Find the EARLIEST existing history effectiveFrom for that cp.
//      - Find the OLDEST sales_order_items row with matching
//        (productCode, customerId via SO) where SO.companySODate <
//        the earliest history date.
//      - INSERT a customer_product_prices baseline row dated 2020-01-01
//        with basePriceSen = that line's basePriceSen.
//   2. Same for product_prices (master): for each product with history,
//      derive baseline from the oldest SO line (any customer) for that
//      productCode predating the master's earliest history date,
//      anchored at 2020-01-01.
//
// Constraints:
//   - BEDFRAME / ACCESSORY only. SOFA seatHeightPrices is a per-(height,
//     tier) matrix that cannot be safely derived from a single SO line —
//     manual entry required.
//   - Skips lines with basePriceSen = 0 (bad data / sample lines).
//   - Skips (product, customer) combos that already have a 2020-01-01
//     row (idempotency guard).
//   - If multiple historical SO prices exist for the same (product,
//     customer) before the existing history, only the OLDEST is captured.
//
// Idempotent: re-running on already-baselined cps is a no-op.
// Permission: production-orders:update (admin proxy).
// ---------------------------------------------------------------------------
const PRICE_BASELINE_DATE = "2020-01-01";

type BaselineCandidate = {
  scope: "customer" | "master";
  cpId: string | null;            // customer_products.id when scope='customer'
  productId: string;
  productCode: string;
  customerId: string | null;
  baselineDate: string;
  basePriceSen: number;
  sourceSoLineId: string;
  sourceSoCompanySODate: string;
};

app.post("/derive-historical-price-baselines", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // --- 1. Customer-product baselines ---------------------------------------
  // For each customer_products row that has history, the earliest existing
  // history.effectiveFrom marks where pre-existing data ends. Anything
  // before that date is a gap we may be able to fill from SO snapshots.
  const cpRowsRes = await db
    .prepare(
      `SELECT cp.id           AS "cpId",
              cp.productId    AS productId,
              cp.customerId   AS customerId,
              cp.basePriceSen AS "cpLegacyBase",
              p.code          AS productCode,
              p.category      AS category,
              MIN(cph.effectiveFrom) AS "earliestHistory"
         FROM customer_products cp
         JOIN products p ON p.id = cp.productId
         LEFT JOIN customer_product_prices cph
                ON cph.customerProductId = cp.id
        GROUP BY cp.id, cp.productId, cp.customerId, cp.basePriceSen, p.code, p.category`,
    )
    .all<{
      cpId: string;
      productId: string;
      customerId: string;
      cpLegacyBase: number | null;
      productCode: string;
      category: string;
      earliestHistory: string | null;
    }>();
  const cpRows = cpRowsRes.results ?? [];

  const candidates: BaselineCandidate[] = [];
  const skipped: Array<{ scope: string; key: string; reason: string }> = [];

  for (const cp of cpRows) {
    if (cp.category === "SOFA") {
      skipped.push({
        scope: "customer",
        key: `${cp.productCode}|${cp.customerId}`,
        reason: "SOFA matrix not auto-derived",
      });
      continue;
    }
    // Cutoff: anything strictly before the earliest existing history row.
    // If no history exists yet, treat cutoff as infinity (any SO qualifies).
    const cutoff = cp.earliestHistory ?? "9999-12-31";

    // Find OLDEST SO line for this (productCode, customerId) below cutoff.
    const oldestLine = await db
      .prepare(
        `SELECT soi.id           AS "lineId",
                soi.basePriceSen AS basePriceSen,
                so.companySODate AS "soDate"
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
          WHERE soi.productCode = ?
            AND so.customerId   = ?
            AND so.companySODate IS NOT NULL
            AND so.companySODate != ''
            AND so.companySODate < ?
            AND soi.basePriceSen > 0
          ORDER BY so.companySODate ASC, soi.id ASC
          LIMIT 1`,
      )
      .bind(cp.productCode, cp.customerId, cutoff)
      .first<{ lineId: string; basePriceSen: number; soDate: string }>();

    // Fallback chain when no historical SO line exists for this
    // (productCode, customerId): use the cp.basePriceSen legacy column
    // value. This preserves a sensible 2020-01-01 row even for cps that
    // were assignment-only or seeded via "Copy from Master" without any
    // SO history under that customer. Without this fallback the customer-
    // side history dialog stays empty for all such cps.
    let baselinePriceSen: number | null = oldestLine?.basePriceSen ?? null;
    let sourceLineId = oldestLine?.lineId ?? "(legacy cp.basePriceSen)";
    let sourceDate = oldestLine?.soDate ?? "(legacy)";
    if (
      baselinePriceSen == null &&
      typeof cp.cpLegacyBase === "number" &&
      cp.cpLegacyBase > 0
    ) {
      baselinePriceSen = cp.cpLegacyBase;
      sourceLineId = "(legacy cp.basePriceSen)";
      sourceDate = "(legacy)";
    }
    if (baselinePriceSen == null) {
      skipped.push({
        scope: "customer",
        key: `${cp.productCode}|${cp.customerId}`,
        reason: cp.earliestHistory
          ? `no SO line predates ${cutoff} and no legacy basePriceSen`
          : "no historical SO line and no legacy basePriceSen",
      });
      continue;
    }

    candidates.push({
      scope: "customer",
      cpId: cp.cpId,
      productId: cp.productId,
      productCode: cp.productCode,
      customerId: cp.customerId,
      baselineDate: PRICE_BASELINE_DATE,
      basePriceSen: baselinePriceSen,
      sourceSoLineId: sourceLineId,
      sourceSoCompanySODate: sourceDate,
    });
  }

  // --- 2. Master-product baselines ----------------------------------------
  // For each product (BF/ACC), if its earliest existing master history is
  // after some SO line's date, derive a master baseline from the oldest SO
  // line for that productCode (any customer).
  const prodRowsRes = await db
    .prepare(
      `SELECT p.id          AS productId,
              p.code        AS productCode,
              p.category    AS category,
              p.basePriceSen AS "legacyBase",
              MIN(pp.effectiveFrom) AS "earliestHistory"
         FROM products p
         LEFT JOIN product_prices pp ON pp.productId = p.id
        WHERE p.category IN ('BEDFRAME','ACCESSORY')
        GROUP BY p.id, p.code, p.category, p.basePriceSen`,
    )
    .all<{
      productId: string;
      productCode: string;
      category: string;
      legacyBase: number | null;
      earliestHistory: string | null;
    }>();
  const prodRows = prodRowsRes.results ?? [];

  for (const p of prodRows) {
    const cutoff = p.earliestHistory ?? "9999-12-31";
    const oldestLine = await db
      .prepare(
        `SELECT soi.id           AS "lineId",
                soi.basePriceSen AS basePriceSen,
                so.companySODate AS "soDate"
           FROM sales_order_items soi
           JOIN sales_orders so ON so.id = soi.salesOrderId
          WHERE soi.productCode = ?
            AND so.companySODate IS NOT NULL
            AND so.companySODate != ''
            AND so.companySODate < ?
            AND soi.basePriceSen > 0
          ORDER BY so.companySODate ASC, soi.id ASC
          LIMIT 1`,
      )
      .bind(p.productCode, cutoff)
      .first<{ lineId: string; basePriceSen: number; soDate: string }>();

    // Same fallback chain as customer scope: SO line first, legacy
    // products.basePriceSen second.
    let basePriceSen: number | null = oldestLine?.basePriceSen ?? null;
    let sourceLineId = oldestLine?.lineId ?? "(legacy products.basePriceSen)";
    let sourceDate = oldestLine?.soDate ?? "(legacy)";
    if (
      basePriceSen == null &&
      typeof p.legacyBase === "number" &&
      p.legacyBase > 0
    ) {
      basePriceSen = p.legacyBase;
      sourceLineId = "(legacy products.basePriceSen)";
      sourceDate = "(legacy)";
    }
    if (basePriceSen == null) continue;

    candidates.push({
      scope: "master",
      cpId: null,
      productId: p.productId,
      productCode: p.productCode,
      customerId: null,
      baselineDate: PRICE_BASELINE_DATE,
      basePriceSen,
      sourceSoLineId: sourceLineId,
      sourceSoCompanySODate: sourceDate,
    });
  }

  const sample = candidates.slice(0, 15);
  const byScope = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.scope] = (acc[c.scope] ?? 0) + 1;
    return acc;
  }, {});

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      planned: candidates.length,
      byScope,
      skipped: skipped.slice(0, 30),
      skippedTotal: skipped.length,
      sample,
    });
  }

  let inserted = 0;
  const errors: Array<{ key: string; message: string }> = [];

  for (const cand of candidates) {
    try {
      if (cand.scope === "customer" && cand.cpId) {
        // Re-check (idempotency): another concurrent request might have
        // inserted between the candidate scan and this loop.
        const exists = await db
          .prepare(
            "SELECT id FROM customer_product_prices WHERE customerProductId = ? AND effectiveFrom = ? LIMIT 1",
          )
          .bind(cand.cpId, cand.baselineDate)
          .first<{ id: string }>();
        if (exists) continue;
        await db
          .prepare(
            `INSERT INTO customer_product_prices
               (id, customerProductId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
          )
          .bind(
            `cph-${crypto.randomUUID().slice(0, 8)}`,
            cand.cpId,
            cand.basePriceSen,
            cand.baselineDate,
            `Auto-baseline derived from SO line ${cand.sourceSoLineId} (${cand.sourceSoCompanySODate})`,
          )
          .run();
        inserted++;
      } else if (cand.scope === "master") {
        const exists = await db
          .prepare(
            "SELECT id FROM product_prices WHERE productId = ? AND effectiveFrom = ? LIMIT 1",
          )
          .bind(cand.productId, cand.baselineDate)
          .first<{ id: string }>();
        if (exists) continue;
        await db
          .prepare(
            `INSERT INTO product_prices
               (id, productId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
          )
          .bind(
            `pp-${crypto.randomUUID().slice(0, 8)}`,
            cand.productId,
            cand.basePriceSen,
            cand.baselineDate,
            `Auto-baseline derived from SO line ${cand.sourceSoLineId} (${cand.sourceSoCompanySODate})`,
          )
          .run();
        inserted++;
      }
    } catch (err) {
      errors.push({
        key: `${cand.scope}:${cand.productCode}|${cand.customerId ?? "*"}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    planned: candidates.length,
    inserted,
    errors,
    byScope,
    skipped: skipped.slice(0, 30),
    skippedTotal: skipped.length,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/fab-cut-pofold-backfill?dryRun=true|false
//
// Companion to /uph-pofold-backfill that handles the merged FAB_CUT JC.
// FAB_CUT lives under its own (SO|PO)::baseModel::fabricCode::FAB_CUT
// wipKey (production-builder.ts:271, 792-833) — completely disjoint from
// any UPHOLSTERY wipKey, so the per-WIP UPH-anchor rule in
// /uph-pofold-backfill never picks it up. This endpoint flips merged
// FAB_CUT JCs whose downstream FAB_SEW siblings are already COMPLETED
// (which is the physical signal that cutting did happen).
//
// Eligibility per WAITING merged FAB_CUT JC:
//   1. Resolve the FC's owning PO + (companySOId, productCode→baseModel,
//      fabricCode). Mirror the lookup that /production-orders.ts:1481-1552
//      uses to find the FC from a FAB_SEW (just inverted).
//   2. Build the same candidate keys: `${productionOrderId}::${baseModel}::
//      ${fabricCode}::FAB_CUT` AND (for SOFA) `${companySOId}::...`. The
//      FC's wipKey will match one of those.
//   3. Find every FAB_SEW JC that points back to this FC. Use the SAME
//      reverse lookup the consume code does — match by (po.companySOId =
//      X AND baseModel matches po.productCode AND po.fabricCode = Y) for
//      SOFA, or by po.id for BF/ACC.
//   4. If at least one such FAB_SEW is COMPLETED/TRANSFERRED with a
//      completedDate, the FC is eligible. completedDate = MIN of those
//      FAB_SEW dates − 1 day (FAB_CUT lead = 1, clamped to 0 if it goes
//      past CASCADE_DATE_CLAMP or ahead of any FAB_SEW date).
//
// Each flip fires applyWipInventoryChange (producer-add for the FC's
// wipLabel) + postJobCardLabor. PIC stays NULL.
//
// Migration cleanup: removed alongside the other /api/import/cascade-*
// and /uph-pofold-* endpoints once data hygiene catches up.
// ---------------------------------------------------------------------------
type FcCandidate = {
  fcId: string;
  fcWipKey: string;
  fcWipLabel: string | null;
  fcPoId: string;
  fcEstMinutes: number | null;
  fcProductionTimeMinutes: number | null;
  newDate: string;
  actualMinutes: number;
  triggerSewIds: string[];
  triggerSewMinDate: string;
};

app.post("/fab-cut-pofold-backfill", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Pull all WAITING FAB_CUT JCs + their owning PO context. Avoid
  //    custom aliases — D1/Postgres adapter sometimes lowercases mixed-
  //    case aliases on the way out, leaving `fcPoId` as undefined.
  const fcRes = await db
    .prepare(
      `SELECT j.id,
              COALESCE(j.wipKey,'') AS wipKey,
              j.wipLabel,
              j.productionOrderId,
              j.estMinutes,
              j.productionTimeMinutes,
              po.companySOId,
              po.salesOrderId,
              po.companyCOId,
              po.consignmentOrderId,
              po.productCode,
              po.fabricCode,
              po.itemCategory
         FROM job_cards j
         LEFT JOIN production_orders po ON po.id = j.productionOrderId
        WHERE j.departmentCode = 'FAB_CUT'
          AND j.status = 'WAITING'
          AND j.completedDate IS NULL`,
    )
    .all<Record<string, unknown>>();
  const allFcs = (fcRes.results ?? []).map((r) => {
    const get = (k: string): unknown =>
      r[k] !== undefined ? r[k] : r[k.toLowerCase()];
    return {
      fcId: String(get("id") ?? ""),
      fcWipKey: String(get("wipKey") ?? ""),
      fcWipLabel: get("wipLabel") as string | null,
      fcPoId: String(get("productionOrderId") ?? ""),
      fcEstMinutes: get("estMinutes") as number | null,
      fcProductionTimeMinutes: get("productionTimeMinutes") as number | null,
      companySOId: get("companySOId") as string | null,
      salesOrderId: get("salesOrderId") as string | null,
      companyCOId: get("companyCOId") as string | null,
      consignmentOrderId: get("consignmentOrderId") as string | null,
      productCode: get("productCode") as string | null,
      fabricCode: get("fabricCode") as string | null,
      itemCategory: get("itemCategory") as string | null,
    };
  });

  // 2. Build a per-FC trigger lookup: scan completed FAB_SEW JCs in
  //    matching POs. Cache bom_templates baseModel lookups.
  const baseModelCache = new Map<string, string>();
  const lookupBaseModel = async (productCode: string): Promise<string> => {
    if (!productCode) return "";
    if (baseModelCache.has(productCode)) return baseModelCache.get(productCode)!;
    const r = await db
      .prepare(
        `SELECT baseModel FROM bom_templates
         WHERE productCode = ?
         ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ baseModel: string | null }>();
    const bm = r?.baseModel || productCode;
    baseModelCache.set(productCode, bm);
    return bm;
  };

  let noTriggerSkipped = 0;
  const plans: FcCandidate[] = [];
  const dateHistogram: Record<string, number> = {};
  const skippedReasons: Record<string, number> = {};

  for (const fc of allFcs) {
    if (!fc.productCode) {
      noTriggerSkipped++;
      skippedReasons["no_product_code"] = (skippedReasons["no_product_code"] ?? 0) + 1;
      continue;
    }
    const baseModel = await lookupBaseModel(fc.productCode);
    const fabricCode = fc.fabricCode || "";
    // Parent-doc key — match either SO or CO ids so CO-origin sofa
    // FCs find their cross-PO SEW siblings.
    const parentDocKey =
      fc.companySOId ||
      fc.salesOrderId ||
      fc.companyCOId ||
      fc.consignmentOrderId ||
      "";

    // Find COMPLETED FAB_SEW JCs that point back to this FC via the same
    // (parentDocKey | productionOrderId)::baseModel::fabricCode::FAB_CUT
    // key pattern that production-orders.ts:1481-1552 uses to resolve
    // from SEW to FC. Reverse lookup: SEW lives on a PO whose parent
    // doc id matches this FC's group key (either side).
    const sewRows = await db
      .prepare(
        `SELECT j.id, j.completedDate, po.productCode
           FROM job_cards j
           JOIN production_orders po ON po.id = j.productionOrderId
          WHERE j.departmentCode = 'FAB_SEW'
            AND j.status IN ('COMPLETED','TRANSFERRED')
            AND j.completedDate IS NOT NULL
            AND COALESCE(po.fabricCode,'') = ?
            AND (
              po.id = ?
              OR (
                ? <> ''
                AND (
                  COALESCE(po.companySOId,'') = ?
                  OR COALESCE(po.companyCOId,'') = ?
                )
              )
            )`,
      )
      .bind(fabricCode, fc.fcPoId, parentDocKey, parentDocKey, parentDocKey)
      .all<Record<string, unknown>>();

    // Filter SEW results to those whose PO's productCode also resolves to
    // the same baseModel (avoids cross-model bleed within an SO group).
    const candidateSews: { sewId: string; sewDate: string }[] = [];
    for (const sew of sewRows.results ?? []) {
      const get = (k: string): unknown =>
        sew[k] !== undefined ? sew[k] : sew[k.toLowerCase()];
      const sewId = String(get("id") ?? "");
      const sewDate = String(get("completedDate") ?? "");
      const sewProductCode = String(get("productCode") ?? "");
      if (!sewId || !sewDate || !/^\d{4}-\d{2}-\d{2}$/.test(sewDate)) continue;
      const sewBaseModel = sewProductCode
        ? await lookupBaseModel(sewProductCode)
        : "";
      if (sewBaseModel === baseModel) {
        candidateSews.push({ sewId, sewDate });
      }
    }

    if (candidateSews.length === 0) {
      noTriggerSkipped++;
      skippedReasons["no_completed_fab_sew_sibling"] =
        (skippedReasons["no_completed_fab_sew_sibling"] ?? 0) + 1;
      continue;
    }

    // FAB_CUT happens BEFORE FAB_SEW. Date = min(sew dates) − 1 (FAB_CUT
    // lead = 1, FAB_SEW lead = 1, offset = 0 → use min sew date directly,
    // then clamp to today). Subtract 1 day to keep chronology strict.
    const sortedDates = candidateSews
      .map((s) => s.sewDate)
      .sort();
    const minSewDate = sortedDates[0];
    let newDate = addDaysISO(minSewDate, -1);
    if (newDate > CASCADE_DATE_CLAMP) newDate = CASCADE_DATE_CLAMP;

    const actualMinutes =
      fc.fcProductionTimeMinutes != null
        ? fc.fcProductionTimeMinutes
        : fc.fcEstMinutes != null
          ? fc.fcEstMinutes
          : 0;

    plans.push({
      fcId: fc.fcId,
      fcWipKey: fc.fcWipKey,
      fcWipLabel: fc.fcWipLabel,
      fcPoId: fc.fcPoId,
      fcEstMinutes: fc.fcEstMinutes,
      fcProductionTimeMinutes: fc.fcProductionTimeMinutes,
      newDate,
      actualMinutes,
      triggerSewIds: candidateSews.map((s) => s.sewId),
      triggerSewMinDate: minSewDate,
    });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
  }

  const sample = plans.slice(0, 10).map((p) => ({
    fcId: p.fcId,
    fcWipKey: p.fcWipKey,
    fcWipLabel: p.fcWipLabel,
    fcPoId: p.fcPoId,
    newDate: p.newDate,
    triggerSewMinDate: p.triggerSewMinDate,
    triggerSewCount: p.triggerSewIds.length,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalWaitingFcJcs: allFcs.length,
      noTriggerSkipped,
      skippedReasons,
      planned: plans.length,
      dateHistogram,
      sample,
    });
  }

  let updated = 0;
  const errors: Array<{ fcId: string; message: string }> = [];
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
        .bind(plan.newDate, plan.actualMinutes, plan.fcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        fcId: plan.fcId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let cached = poCache.get(plan.fcPoId);
    if (!cached) {
      try {
        const po = await loadProductionOrderById(db, plan.fcPoId);
        if (!po) continue;
        const allJcs = await findJobCardsByPO(db, plan.fcPoId);
        cached = { po, allJcs };
        poCache.set(plan.fcPoId, cached);
      } catch (err) {
        console.error("[fab-cut-pofold-backfill] PO/JC load failed", {
          fcId: plan.fcId,
          poId: plan.fcPoId,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const idx = cached.allJcs.findIndex((j) => j.id === plan.fcId);
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
        { orgId: getOrgId(c), source: "BACKFILL" },
      );
    } catch (err) {
      console.error("[fab-cut-pofold-backfill] WIP cascade failed", {
        fcId: plan.fcId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await postJobCardLabor(db, plan.fcId, plan.fcPoId);
    } catch (err) {
      console.error("[fab-cut-pofold-backfill] postJobCardLabor failed", {
        fcId: plan.fcId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    totalWaitingFcJcs: allFcs.length,
    noTriggerSkipped,
    skippedReasons,
    planned: plans.length,
    updated,
    errors,
    dateHistogram,
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
                MAX(completedDate) AS "maxDate"
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

// Type definitions used by /refund-backfill-overconsume below.
// These were originally co-located with the now-deleted
// /backfill-cascade-wip-producers route (removed 2026-05-20, PR 0 #2).
// Kept here because /refund-backfill-overconsume still references them.
type RefundCandidateRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  completedDate: string | null;
  branchKey: string | null;
  sequence: number;
  estMinutes: number | null;
  productionTimeMinutes: number | null;
  actualMinutes: number | null;
  overdue: string | null;
};

type RefundSiblingRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  branchKey: string | null;
  sequence: number;
  status: string;
  pic1Id: string | null;
  pic1Name: string | null;
  actualMinutes: number | null;
  productionTimeMinutes: number | null;
  estMinutes: number | null;
  overdue: string | null;
  completedDate: string | null;
};

app.post("/refund-backfill-overconsume", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Refund candidates: cascade-backfilled DOWNSTREAM consumer JCs.
  //
  // Restrict to the depts that consume an upstream sibling in
  // applyWipInventoryChange (production-orders.ts line ~1146-1206):
  //   FAB_SEW    — consumes upstream FAB_CUT '(FC)'
  //   FRAMING    — consumes upstream WOOD_CUT '(WD)'  (no over-consume of
  //                Frame itself, but in chains where WOOD_CUT is CSV
  //                AND FRAMING is backfilled, FRAMING-backfill consumes
  //                (WD) -2 a second time too — same Model-B logic
  //                applies to refund (WD).)
  //   WEBBING    — consumes upstream FRAMING 'Frame'
  //   FOAM       — consumes upstream FRAMING 'Frame' (HEADBOARD chain
  //                where FOAM follows FRAMING; covered by the same
  //                generic per-component consume rule).
  //
  // FAB_CUT and WOOD_CUT are producer-only (no upstream consume) — skip.
  // UPHOLSTERY consumed correctly originally — skip.
  // PACKING is metadata-only — skip.
  //
  // Filter signature mirrors /backfill-cascade-wip-producers exactly so
  // we hit the same JC set the backfill processed.
  const candRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, wipKey, wipLabel,
              wipQty, completedDate, branchKey, sequence, estMinutes,
              productionTimeMinutes, actualMinutes, overdue
         FROM job_cards
        WHERE status IN ('COMPLETED','TRANSFERRED')
          AND completedDate IS NOT NULL
          AND overdue = 'COMPLETED'
          AND UPPER(COALESCE(departmentCode,''))
              IN ('FAB_SEW','FRAMING','WEBBING','FOAM')
          AND actualMinutes = COALESCE(productionTimeMinutes, estMinutes, 0)
          AND pic1Id IS NULL
          AND COALESCE(pic1Name,'') = ''
          AND completedDate >= ?
          AND completedDate <= ?`,
    )
    .bind(
      c.req.query("from") || "2026-01-01",
      c.req.query("to") || "2026-04-30",
    )
    .all<RefundCandidateRow>();
  const candidates = candRes.results ?? [];

  // Group candidates by PO so we can fetch siblings once per PO.
  const byPo = new Map<string, RefundCandidateRow[]>();
  for (const r of candidates) {
    const list = byPo.get(r.productionOrderId) ?? [];
    list.push(r);
    byPo.set(r.productionOrderId, list);
  }

  // Plan list — entries we'd actually UPDATE.
  type RefundPlan = {
    jcId: string;
    poId: string;
    dept: string;
    wipQty: number;
    upstreamWipLabel: string;
    upstreamDept: string;
    upstreamPic: string | null; // for sample only — confirms CSV
  };
  const plan: RefundPlan[] = [];
  const skipReasons: Record<string, number> = {
    noWipKey: 0,
    noWipQty: 0,
    noUpstreamSibling: 0,
    upstreamNoPicTooBackfill: 0,
    upstreamNoLabel: 0,
  };

  for (const [poId, cands] of byPo) {
    // Load every sibling in the PO once. A "sibling" here is any JC in
    // the same productionOrderId — we then filter by (wipKey, branchKey,
    // sequence < cand.sequence) to find the per-component upstream that
    // applyWipInventoryChange would have consumed from.
    const sibsRes = await db
      .prepare(
        `SELECT id, productionOrderId, departmentCode, wipKey, wipLabel,
                wipQty, branchKey, sequence, status, pic1Id, pic1Name,
                actualMinutes, productionTimeMinutes, estMinutes,
                overdue, completedDate
           FROM job_cards
          WHERE productionOrderId = ?`,
      )
      .bind(poId)
      .all<RefundSiblingRow>();
    const sibs = sibsRes.results ?? [];

    for (const cand of cands) {
      if (!cand.wipKey) {
        skipReasons.noWipKey++;
        continue;
      }
      const wipQty = cand.wipQty ?? 0;
      if (!wipQty) {
        skipReasons.noWipQty++;
        continue;
      }
      const myBranch = cand.branchKey ?? "";
      // Mirror production-orders.ts line 1158-1166: same wipKey, same
      // branchKey, sequence < own, take highest. This is the JC whose
      // wipLabel applyWipInventoryChange consumed from at backfill time.
      const upstreams = sibs
        .filter(
          (s) =>
            s.wipKey === cand.wipKey &&
            (s.branchKey ?? "") === myBranch &&
            s.sequence < cand.sequence,
        )
        .sort((a, b) => b.sequence - a.sequence);
      const upstream = upstreams[0];
      if (!upstream) {
        skipReasons.noUpstreamSibling++;
        continue;
      }
      if (!upstream.wipLabel) {
        skipReasons.upstreamNoLabel++;
        continue;
      }

      // Model B gate: refund only when upstream is NOT in the backfill
      // set. "In backfill" matches the same filter used by
      // /backfill-cascade-wip-producers: pic1Id IS NULL AND pic1Name=''.
      // If upstream has PIC, it was CSV-completed → its produce already
      // landed at CSV time; the backfill-D's consume is then the only
      // consume on its label, no double-count, no refund.
      //
      // BUT: that's the OPPOSITE of what we want. Re-read the trace in
      // the header. The "double consume" arises when CSV-D's consume
      // ALREADY FIRED (CSV had a row for D), then cascade overwrote D's
      // metadata, then backfill picked D up and fired D's consume AGAIN.
      // The signature for that case is "D's upstream U has PIC (was
      // also in CSV)" — implying CSV had pairs of (U,D) entries that
      // both fired at CSV time, and only D got cascade-overwritten.
      //
      // The cleanest detector is: "upstream U has PIC". That's what we
      // gate on.
      const upPicId = (upstream.pic1Id ?? "").trim();
      const upPicName = (upstream.pic1Name ?? "").trim();
      const upHasPic = upPicId !== "" || upPicName !== "";
      if (!upHasPic) {
        skipReasons.upstreamNoPicTooBackfill++;
        continue;
      }

      plan.push({
        jcId: cand.id,
        poId,
        dept: (cand.departmentCode || "").toUpperCase(),
        wipQty,
        upstreamWipLabel: upstream.wipLabel,
        upstreamDept: (upstream.departmentCode || "").toUpperCase(),
        upstreamPic: upPicName || upPicId || null,
      });
    }
  }

  // Aggregate stats
  const deptCounts: Record<string, number> = {};
  const upstreamLabelTotals: Record<string, number> = {};
  let totalRefundQty = 0;
  for (const p of plan) {
    deptCounts[p.dept] = (deptCounts[p.dept] ?? 0) + 1;
    upstreamLabelTotals[p.upstreamWipLabel] =
      (upstreamLabelTotals[p.upstreamWipLabel] ?? 0) + p.wipQty;
    totalRefundQty += p.wipQty;
  }
  const sample = plan.slice(0, 10);

  // Top 10 labels by refund magnitude (for cross-check vs current
  // negative wip_items magnitudes).
  const topRefundLabels = Object.entries(upstreamLabelTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([wipLabel, refundQty]) => ({ wipLabel, refundQty }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidateCount: candidates.length,
      planCount: plan.length,
      totalRefundQty,
      deptCounts,
      topRefundLabels,
      skipReasons,
      sample,
    });
  }

  // Live mode: direct UPDATE on wip_items only.
  // INSERT is unnecessary — every upstream wipLabel in our plan came
  // from a CSV-completed upstream JC, which means applyWipInventoryChange
  // already inserted/upserted that label's row at CSV time. We just
  // adjust stockQty.
  //
  // 2026-05-11 — sign param for revert mode. The endpoint is NOT
  // idempotent by design: running it twice double-credits. Add
  // `?revert=true` (sign=-1) to subtract the same qty back, used as a
  // one-shot when refund was accidentally re-run. The plan list is
  // deterministic (same SELECT filter → same rows) so revert on the
  // same dataset exactly inverts a prior wet-run.
  const revertMode = c.req.query("revert") === "true";
  const sign = revertMode ? -1 : 1;
  let updated = 0;
  let skippedRowMissing = 0;
  const errors: Array<{ jcId: string; message: string }> = [];

  for (const p of plan) {
    try {
      const exists = await db
        .prepare("SELECT id FROM wip_items WHERE code = ?")
        .bind(p.upstreamWipLabel)
        .first<{ id: string }>();
      if (!exists) {
        // Defensive: if the upstream label genuinely has no row, skip
        // rather than INSERT a positive stub (would mis-attribute on the
        // FE wip view, which keys negative rows by missing-producer
        // semantics). A missing row means our model is wrong about the
        // CSV-produce having fired — investigate manually.
        skippedRowMissing++;
        continue;
      }
      await db
        .prepare(
          `UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?`,
        )
        .bind(sign * p.wipQty, p.upstreamWipLabel)
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
    candidateCount: candidates.length,
    planCount: plan.length,
    totalRefundQty,
    updated,
    skippedRowMissing,
    deptCounts,
    topRefundLabels,
    skipReasons,
    errors,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/normalize-fullwidth-parens
//
// One-shot data fix: BEDFRAME BOM master templates were authored with the
// full-width Chinese parentheses "（FC）" instead of "(FC)" on the FAB_CUT
// branch wipCode. That typo cascaded into:
//   - bom_master_templates.data (JSON tree, 2 templates)
//   - bom_templates.wipComponents (JSON tree, ~153 product BOMs)
//   - job_cards.wipCode + wipLabel (every FAB_CUT JC built from those BOMs)
//   - wip_items.code (rows produced/consumed under the typo'd label)
//
// Because UPH/FAB_SEW consume looks up the half-width "(FC)" form (after
// resolveWipTokens runs `.replace(/\s+/g, " ").trim()` — the full-width
// parens survive), wip_items splits into two rows per (productCode, label):
// one with full-width that received the FAB_CUT producer-add, one with
// half-width that absorbed the downstream consume → residual negatives.
//
// Fix pattern mirrors migration 0059 (s/Faom/Foam/) but extended:
//   1. bom_master_templates.data  REPLACE both （ and ）
//   2. bom_templates.wipComponents REPLACE both
//   3. job_cards.wipCode + wipLabel + branchKey REPLACE both
//   4. wip_items merge pairs: SUM stockQty into the half-width row, DELETE
//      the full-width row. Orphan full-width rows (no half-width sibling)
//      get renamed in place via REPLACE.
//
// dryRun=true → SELECT counts + 10-row pair sample, no writes.
// dryRun=false → run the full sequence as a single db.batch().
//
// Permission: production-orders:update (matches the other one-shot import
// endpoints; this is a privileged backfill, not a user-facing surface).
// ---------------------------------------------------------------------------
app.post("/normalize-fullwidth-parens", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // ----- Step 1 — bom_master_templates count -----
  const bomMasterCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bom_master_templates
        WHERE data LIKE '%（%' OR data LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const bomMasterCount = bomMasterCountRes?.n ?? 0;

  // ----- Step 2 — bom_templates count -----
  const bomTemplatesCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bom_templates
        WHERE wipComponents LIKE '%（%' OR wipComponents LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const bomTemplatesCount = bomTemplatesCountRes?.n ?? 0;

  // ----- Step 3 — job_cards count (wipCode / wipLabel / branchKey) -----
  const jobCardsCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_cards
        WHERE wipCode    LIKE '%（%' OR wipCode    LIKE '%）%'
           OR wipLabel   LIKE '%（%' OR wipLabel   LIKE '%）%'
           OR branchKey  LIKE '%（%' OR branchKey  LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const jobCardsCount = jobCardsCountRes?.n ?? 0;

  // Per-dept breakdown — confirms the typo is FAB_CUT-only as expected.
  const jobCardsByDeptRes = await db
    .prepare(
      `SELECT departmentCode AS dept, COUNT(*) AS n FROM job_cards
        WHERE wipCode  LIKE '%（%' OR wipCode  LIKE '%）%'
           OR wipLabel LIKE '%（%' OR wipLabel LIKE '%）%'
        GROUP BY departmentCode
        ORDER BY n DESC`,
    )
    .all<{ dept: string; n: number }>();
  const jobCardsByDept = jobCardsByDeptRes.results ?? [];

  // ----- Step 4 — wip_items full-width rows + pair detection -----
  // Row count
  const wipItemsFullwidthCountRes = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM wip_items
        WHERE code LIKE '%（%' OR code LIKE '%）%'`,
    )
    .first<{ n: number }>();
  const wipItemsFullwidthCount = wipItemsFullwidthCountRes?.n ?? 0;

  // Pair detection: a wip_items row with full-width parens "pairs" with a
  // half-width row when (relatedProduct, half-width-version-of-code) match.
  // SQLite REPLACE() chains cleanly inside the JOIN.
  type PairRow = {
    fwId: string;
    fwCode: string;
    fwQty: number;
    fwRelated: string | null;
    hwId: string;
    hwCode: string;
    hwQty: number;
  };
  const pairsRes = await db
    .prepare(
      `SELECT b.id AS "fwId", b.code AS "fwCode", b.stockQty AS "fwQty",
              b.relatedProduct AS "fwRelated",
              a.id AS "hwId", a.code AS "hwCode", a.stockQty AS "hwQty"
         FROM wip_items b
         JOIN wip_items a
           ON a.code = REPLACE(REPLACE(b.code, '（', '('), '）', ')')
          AND COALESCE(a.relatedProduct, '') = COALESCE(b.relatedProduct, '')
        WHERE (b.code LIKE '%（%' OR b.code LIKE '%）%')
          AND b.id != a.id`,
    )
    .all<PairRow>();
  const pairs = pairsRes.results ?? [];
  const pairedFullwidthIds = new Set(pairs.map((p) => p.fwId));
  const orphanCount = wipItemsFullwidthCount - pairedFullwidthIds.size;

  const samplePairs = pairs.slice(0, 10).map((p) => ({
    relatedProduct: p.fwRelated,
    fullwidth: { id: p.fwId, code: p.fwCode, stockQty: p.fwQty },
    halfwidth: { id: p.hwId, code: p.hwCode, stockQty: p.hwQty },
    summed: (p.fwQty || 0) + (p.hwQty || 0),
  }));

  // Orphan-row sample + stockQty distribution. With 0 pairs the orphan list
  // IS the full picture — knowing how many orphans are positive vs negative
  // vs zero tells us whether the rename is harmless rebadge or whether it
  // would re-collide with an existing half-width row that wasn't picked up
  // by the pair join (e.g. relatedProduct mismatch).
  type OrphanRow = {
    id: string;
    code: string;
    relatedProduct: string | null;
    stockQty: number;
  };
  const orphansRes = await db
    .prepare(
      `SELECT id, code, relatedProduct, stockQty FROM wip_items
        WHERE (code LIKE '%（%' OR code LIKE '%）%')
        ORDER BY stockQty DESC`,
    )
    .all<OrphanRow>();
  const orphanRows = orphansRes.results ?? [];
  let orphanPositive = 0,
    orphanNegative = 0,
    orphanZero = 0,
    orphanPosTotal = 0,
    orphanNegTotal = 0;
  for (const o of orphanRows) {
    const q = o.stockQty || 0;
    if (q > 0) {
      orphanPositive++;
      orphanPosTotal += q;
    } else if (q < 0) {
      orphanNegative++;
      orphanNegTotal += q;
    } else {
      orphanZero++;
    }
  }

  // Detect rename-collisions: a full-width row whose half-width form
  // already exists in wip_items, but with a DIFFERENT relatedProduct
  // (or null vs ""). The pair join above would have missed those —
  // surfacing them here lets us decide manually if any need merging.
  const renameCollisionRes = await db
    .prepare(
      `SELECT b.id AS "fwId", b.code AS "fwCode", b.relatedProduct AS "fwRelated",
              b.stockQty AS "fwQty",
              a.id AS "hwId", a.code AS "hwCode", a.relatedProduct AS "hwRelated",
              a.stockQty AS "hwQty"
         FROM wip_items b
         JOIN wip_items a
           ON a.code = REPLACE(REPLACE(b.code, '（', '('), '）', ')')
        WHERE (b.code LIKE '%（%' OR b.code LIKE '%）%')
          AND b.id != a.id
          AND COALESCE(a.relatedProduct, '') != COALESCE(b.relatedProduct, '')`,
    )
    .all<PairRow & { hwRelated: string | null }>();
  const renameCollisions = renameCollisionRes.results ?? [];

  const sampleOrphans = orphanRows.slice(0, 10).map((o) => ({
    id: o.id,
    code: o.code,
    relatedProduct: o.relatedProduct,
    stockQty: o.stockQty,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      summary: {
        bomMasterTemplates: bomMasterCount,
        bomTemplates: bomTemplatesCount,
        jobCards: jobCardsCount,
        jobCardsByDept,
        wipItemsFullwidth: wipItemsFullwidthCount,
        wipItemsPaired: pairedFullwidthIds.size,
        wipItemsOrphan: orphanCount,
        orphanStockQty: {
          positive: orphanPositive,
          positiveTotal: orphanPosTotal,
          negative: orphanNegative,
          negativeTotal: orphanNegTotal,
          zero: orphanZero,
        },
        renameCollisions: renameCollisions.length,
      },
      sampleOrphans,
      sampleRenameCollisions: renameCollisions.slice(0, 10),
      samplePairs,
    });
  }

  // ----- Live mode — run all steps as a single db.batch() -----
  // D1 batches are atomic: every statement in the array commits together
  // or none do. That gives us the "single transaction" semantic without
  // BEGIN/COMMIT (which D1 doesn't expose).
  const stmts: D1PreparedStatement[] = [];

  // 1) BOM master templates — JSON blob in `data` column.
  stmts.push(
    db.prepare(
      `UPDATE bom_master_templates
          SET data = REPLACE(REPLACE(data, '（', '('), '）', ')')
        WHERE data LIKE '%（%' OR data LIKE '%）%'`,
    ),
  );

  // 2) BOM product templates — JSON blob in `wipComponents` column.
  stmts.push(
    db.prepare(
      `UPDATE bom_templates
          SET wipComponents = REPLACE(REPLACE(wipComponents, '（', '('), '）', ')')
        WHERE wipComponents LIKE '%（%' OR wipComponents LIKE '%）%'`,
    ),
  );

  // 3) job_cards — wipCode + wipLabel + branchKey. Three separate UPDATEs
  // so the WHERE filter is column-scoped (SQLite doesn't fold these into
  // one efficient pass).
  stmts.push(
    db.prepare(
      `UPDATE job_cards
          SET wipCode = REPLACE(REPLACE(wipCode, '（', '('), '）', ')')
        WHERE wipCode LIKE '%（%' OR wipCode LIKE '%）%'`,
    ),
  );
  stmts.push(
    db.prepare(
      `UPDATE job_cards
          SET wipLabel = REPLACE(REPLACE(wipLabel, '（', '('), '）', ')')
        WHERE wipLabel LIKE '%（%' OR wipLabel LIKE '%）%'`,
    ),
  );
  stmts.push(
    db.prepare(
      `UPDATE job_cards
          SET branchKey = REPLACE(REPLACE(branchKey, '（', '('), '）', ')')
        WHERE branchKey LIKE '%（%' OR branchKey LIKE '%）%'`,
    ),
  );

  // 4a) wip_items pair merge — sum full-width stockQty into the half-width
  // sibling row, then DELETE the full-width row. We bind one statement per
  // pair so each row is targeted by primary key — robust against future
  // shape changes and lets us count exact effects per pair.
  for (const p of pairs) {
    stmts.push(
      db
        .prepare(
          `UPDATE wip_items SET stockQty = stockQty + ? WHERE id = ?`,
        )
        .bind(p.fwQty, p.hwId),
    );
    stmts.push(
      db.prepare(`DELETE FROM wip_items WHERE id = ?`).bind(p.fwId),
    );
  }

  // 4b) Orphan full-width rows — no half-width sibling, so just rename in
  // place. The WHERE clause excludes rows we already DELETEd above by
  // re-checking that they still match the LIKE filter (deleted rows can't
  // match anything).
  stmts.push(
    db.prepare(
      `UPDATE wip_items
          SET code = REPLACE(REPLACE(code, '（', '('), '）', ')')
        WHERE code LIKE '%（%' OR code LIKE '%）%'`,
    ),
  );

  const batchResults = await db.batch(stmts);

  // Each batchResults[i] has .meta.changes (D1 standard).
  // Indices: 0=bomMaster, 1=bomTemplates, 2=jcWipCode, 3=jcWipLabel,
  // 4=jcBranchKey, then per-pair (UPDATE+DELETE pairs), then orphan rename.
  const changes = batchResults.map((r) => r.meta?.changes ?? 0);
  const pairUpdates = pairs.length;
  const orphanRenameIdx = 5 + pairUpdates * 2;

  return c.json({
    success: true,
    dryRun: false,
    summary: {
      bomMasterTemplatesUpdated: changes[0] ?? 0,
      bomTemplatesUpdated: changes[1] ?? 0,
      jobCardsWipCodeUpdated: changes[2] ?? 0,
      jobCardsWipLabelUpdated: changes[3] ?? 0,
      jobCardsBranchKeyUpdated: changes[4] ?? 0,
      wipItemsPairUpdates: pairUpdates,
      wipItemsPairDeletes: pairUpdates,
      wipItemsOrphanRenames: changes[orphanRenameIdx] ?? 0,
    },
    samplePairs,
  });
});

// ---------------------------------------------------------------------------
// /dedupe-wip-items — Layer 4 cleanup pass.
//
// Background. After Layer 1 (backfill), Layer 2 (refund), Layer 3 (fullwidth
// paren normalize), residual state is 1,118 wip_items rows / 209 negative
// rows / -316 magnitude. A trace agent identified that 112 of those 209
// negative rows have a sibling positive row at the SAME `code` (different
// `id`) — i.e. the producer-add wrote to one row and the consume-decrement
// wrote to another instead of upserting onto the same row. Net 84% of
// residual magnitude is "same-code duplicates".
//
// Root cause. wip_items has no UNIQUE constraint on `code` (PK is `id`,
// `code` only carries the non-UNIQUE idx_wip_items_code from migration
// 0037). applyWipInventoryChange (production-orders.ts ~1071-1351) does a
// SELECT-by-code → if NULL INSERT a new row, otherwise UPDATE by id. Two
// concurrent JC PATCHes for the same code can both see NULL and both
// INSERT, producing two rows that diverge (one accumulates +qty from the
// producer side, one accumulates -qty from the consume side). Earlier
// rollback paths use `UPDATE ... WHERE code = ?` which then mass-updates
// every dup row simultaneously, compounding drift.
//
// What this endpoint does. Pure SQL — does NOT call applyWipInventoryChange.
//   1. Find groups of wip_items rows sharing the same `code` (COUNT > 1).
//   2. For each group: pick a canonical row (prefer non-PENDING deptStatus,
//      then non-empty relatedProduct, ties broken by lowest id).
//   3. Sum stockQty across all rows in the group → set canonical.stockQty
//      to that sum.
//   4. DELETE the non-canonical rows.
//
// Dry-run returns full counts + 10-row sample. Live-mode runs the merge
// inside a single db.batch() (D1's atomic-batch primitive — "transaction"
// without BEGIN/COMMIT, mirrors /normalize-fullwidth-parens above).
// ---------------------------------------------------------------------------
app.post("/dedupe-wip-items", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  type WipRow = {
    id: string;
    code: string;
    type: string;
    relatedProduct: string | null;
    deptStatus: string | null;
    stockQty: number;
    status: string;
  };

  // ----- Step 1 — find dup-code groups -----
  // Inner query: codes where COUNT(*) > 1.
  // Outer fetch: every row whose code is in that set, with all the
  // columns we need to pick a canonical and report the sample.
  const dupCodesRes = await db
    .prepare(
      `SELECT code, COUNT(*) AS n, SUM(stockQty) AS "netQty"
         FROM wip_items
        GROUP BY code
       HAVING COUNT(*) > 1`,
    )
    .all<{ code: string; n: number; netQty: number }>();
  const dupCodes = dupCodesRes.results ?? [];

  if (dupCodes.length === 0) {
    return c.json({
      success: true,
      dryRun,
      groupCount: 0,
      rowsToMerge: 0,
      rowsToUpdate: 0,
      message: "No duplicate-code groups found in wip_items.",
    });
  }

  // Pull every row in every dup-code group in one query. SQLite's IN
  // clause with bound list keeps this clean for the typical N≈100 groups.
  const codesList = dupCodes.map((d) => d.code);
  const placeholders = codesList.map(() => "?").join(",");
  const rowsRes = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, deptStatus, stockQty, status
         FROM wip_items
        WHERE code IN (${placeholders})`,
    )
    .bind(...codesList)
    .all<WipRow>();
  const allRows = rowsRes.results ?? [];

  // Group by code.
  const byCode = new Map<string, WipRow[]>();
  for (const r of allRows) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }

  // ----- Step 2 — pick canonical + plan merges -----
  // Canonical preference: non-PENDING deptStatus > non-empty relatedProduct
  // > lowest id. Score each row, pick the lowest score.
  function canonicalScore(r: WipRow): [number, number, string] {
    const deptStatusScore =
      (r.deptStatus || "").toUpperCase() === "PENDING" ? 1 : 0;
    const relatedScore = (r.relatedProduct ?? "").trim() === "" ? 1 : 0;
    return [deptStatusScore, relatedScore, r.id];
  }
  function pickCanonical(rows: WipRow[]): WipRow {
    return rows.slice().sort((a, b) => {
      const sa = canonicalScore(a);
      const sb = canonicalScore(b);
      if (sa[0] !== sb[0]) return sa[0] - sb[0];
      if (sa[1] !== sb[1]) return sa[1] - sb[1];
      return sa[2] < sb[2] ? -1 : sa[2] > sb[2] ? 1 : 0;
    })[0];
  }

  type Plan = {
    code: string;
    canonical: WipRow;
    rows: WipRow[];
    netSum: number;
    nonCanonicalIds: string[];
  };
  const plan: Plan[] = [];
  let predictedNegativeAfter = 0;
  let rowsToMerge = 0;

  for (const [code, rows] of byCode) {
    const canonical = pickCanonical(rows);
    const netSum = rows.reduce((acc, r) => acc + (r.stockQty || 0), 0);
    const nonCanonicalIds = rows
      .filter((r) => r.id !== canonical.id)
      .map((r) => r.id);
    rowsToMerge += nonCanonicalIds.length;
    if (netSum < 0) predictedNegativeAfter += 1;
    plan.push({ code, canonical, rows, netSum, nonCanonicalIds });
  }

  // ----- Pre/post stats over the WHOLE wip_items table -----
  // Three separate queries — the combined SUM(CASE)+COUNT(*) variant came
  // back with NULL fields under D1 in dry-run #1 (likely an alias quoting
  // quirk), so split for robustness.
  const totalRowsRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM wip_items`)
    .first<{ n: number }>();
  const totalRowsBefore = totalRowsRes?.n ?? 0;
  const negRowsRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM wip_items WHERE stockQty < 0`)
    .first<{ n: number }>();
  const negRowsBefore = negRowsRes?.n ?? 0;
  const negTotalRes = await db
    .prepare(
      `SELECT COALESCE(SUM(stockQty), 0) AS n FROM wip_items WHERE stockQty < 0`,
    )
    .first<{ n: number }>();
  const negTotalBefore = negTotalRes?.n ?? 0;

  // Predicted residual:
  //   - rows: totalRowsBefore - rowsToMerge (we DELETE rowsToMerge rows;
  //     canonical updates don't change row count).
  //   - negative rows: count groups where netSum < 0, plus any rows
  //     OUTSIDE dup-code groups that are already negative. Since
  //     non-dup negatives stay untouched, the post count =
  //     (negRowsBefore − negativeRowsInDupGroups) + predictedNegativeAfter.
  let negativeRowsInDupGroupsBefore = 0;
  let negativeMagnitudeInDupGroupsBefore = 0;
  for (const [, rows] of byCode) {
    for (const r of rows) {
      if ((r.stockQty || 0) < 0) {
        negativeRowsInDupGroupsBefore += 1;
        negativeMagnitudeInDupGroupsBefore += r.stockQty || 0;
      }
    }
  }
  // Sum of netSum for groups where netSum < 0 — magnitude of negatives that
  // SURVIVE the dedupe (groups that net out positive contribute 0 to neg
  // total post-dedupe).
  let predictedNegativeMagnitudeAfter = 0;
  for (const p of plan) {
    if (p.netSum < 0) predictedNegativeMagnitudeAfter += p.netSum;
  }

  const predictedNegRowsTotalAfter =
    negRowsBefore - negativeRowsInDupGroupsBefore + predictedNegativeAfter;
  const predictedNegTotalAfter =
    negTotalBefore -
    negativeMagnitudeInDupGroupsBefore +
    predictedNegativeMagnitudeAfter;

  // ----- Sample for the dry-run response -----
  const sampleGroups = plan.slice(0, 10).map((p) => ({
    code: p.code,
    rows: p.rows.map((r) => ({
      id: r.id,
      stockQty: r.stockQty,
      deptStatus: r.deptStatus,
      relatedProduct: r.relatedProduct,
      status: r.status,
    })),
    canonical: p.canonical.id,
    canonicalReason:
      ((p.canonical.deptStatus || "").toUpperCase() !== "PENDING"
        ? "non-PENDING deptStatus"
        : "PENDING (no non-PENDING in group)") +
      ((p.canonical.relatedProduct ?? "").trim() !== ""
        ? " + non-empty relatedProduct"
        : " + empty relatedProduct") +
      " + lowest id tiebreak",
    netSum: p.netSum,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      groupCount: plan.length,
      rowsToMerge,
      rowsToUpdate: plan.length,
      negativeMagnitudeBefore: negTotalBefore,
      negativeRowsBefore: negRowsBefore,
      totalRowsBefore,
      predictedNegativeAfter: predictedNegRowsTotalAfter,
      predictedNegativeMagnitudeAfter: predictedNegTotalAfter,
      predictedTotalRowsAfter: totalRowsBefore - rowsToMerge,
      negativeRowsInDupGroupsBefore,
      negativeMagnitudeInDupGroupsBefore,
      sampleGroups,
    });
  }

  // ----- Live mode — single atomic batch -----
  // Per-group: 1 UPDATE (canonical.stockQty := netSum) + N DELETEs (where
  // N = nonCanonicalIds.length). D1 batch is atomic, so partial state
  // can't leak.
  const stmts: D1PreparedStatement[] = [];
  for (const p of plan) {
    stmts.push(
      db
        .prepare(`UPDATE wip_items SET stockQty = ? WHERE id = ?`)
        .bind(p.netSum, p.canonical.id),
    );
    for (const id of p.nonCanonicalIds) {
      stmts.push(db.prepare(`DELETE FROM wip_items WHERE id = ?`).bind(id));
    }
  }

  let batchOk = true;
  let batchError: string | null = null;
  let updatesApplied = 0;
  let deletesApplied = 0;
  try {
    const batchResults = await db.batch(stmts);
    let i = 0;
    for (const p of plan) {
      const upd = batchResults[i++];
      if ((upd?.meta?.changes ?? 0) > 0) updatesApplied += 1;
      for (const _id of p.nonCanonicalIds) {
        const del = batchResults[i++];
        if ((del?.meta?.changes ?? 0) > 0) deletesApplied += 1;
      }
    }
  } catch (e) {
    batchOk = false;
    batchError = e instanceof Error ? e.message : String(e);
  }

  return c.json({
    success: batchOk,
    dryRun: false,
    groupCount: plan.length,
    rowsToMerge,
    rowsToUpdate: plan.length,
    updatesApplied,
    deletesApplied,
    negativeMagnitudeBefore: negTotalBefore,
    negativeRowsBefore: negRowsBefore,
    totalRowsBefore,
    predictedNegativeAfter: predictedNegRowsTotalAfter,
    predictedNegativeMagnitudeAfter: predictedNegTotalAfter,
    predictedTotalRowsAfter: totalRowsBefore - rowsToMerge,
    sampleGroups,
    batchError,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/zero-out-negative-wips
//
// One-shot cleanup for the residual ~96 negative wip_items rows accumulated
// by BUG-2026-04-30-002 (double-consume on WAITING→IN_PROGRESS→COMPLETED;
// the code-side fix landed in production-orders.ts in the same deploy).
// These negatives are bug artifacts, not legitimate "missed dept"
// visibility signals — the user wants them zeroed out.
//
// Logic: find every wip_items row with stockQty < 0 and set its stockQty
// to 0 in a single UPDATE. This endpoint deliberately does NOT call
// applyWipInventoryChange — it's a pure raw-SQL cleanup, no cascades, no
// labor entries, no fg_units side effects. The double-consume code fix
// must already be deployed when this runs live so no NEW negatives accrue
// during the cleanup window.
//
// Dry-run mode (?dryRun=true): SELECT only, returns count + magnitude +
// sample 10. Live mode (?dryRun=false): single UPDATE statement.
// Permission gate: production-orders:update (same as the rest of this
// file's privileged backfill endpoints).
// ---------------------------------------------------------------------------
app.post("/zero-out-negative-wips", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Pre-stats: count + total magnitude of all currently-negative rows.
  const countRes = await db
    .prepare(`SELECT COUNT(*) AS n FROM wip_items WHERE stockQty < 0`)
    .first<{ n: number }>();
  const negativeRowsBefore = countRes?.n ?? 0;
  const magnitudeRes = await db
    .prepare(
      `SELECT COALESCE(SUM(stockQty), 0) AS n FROM wip_items WHERE stockQty < 0`,
    )
    .first<{ n: number }>();
  const totalMagnitudeBefore = magnitudeRes?.n ?? 0;

  // Sample 10 for spot-check visibility in the dry-run response.
  const sampleRes = await db
    .prepare(
      `SELECT code, stockQty, deptStatus
         FROM wip_items
        WHERE stockQty < 0
        ORDER BY stockQty ASC
        LIMIT 10`,
    )
    .all<{ code: string; stockQty: number; deptStatus: string | null }>();
  const sample = (sampleRes.results ?? []).map((r) => ({
    code: r.code,
    qty: r.stockQty,
    deptStatus: r.deptStatus,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      rowsAffected: negativeRowsBefore,
      totalMagnitudeBefore,
      sample,
    });
  }

  // Live: single UPDATE. D1 reports affected row count via meta.changes.
  const updRes = await db
    .prepare(`UPDATE wip_items SET stockQty = 0 WHERE stockQty < 0`)
    .run();
  const rowsAffected = updRes.meta?.changes ?? 0;

  return c.json({
    success: true,
    dryRun: false,
    rowsAffected,
    totalMagnitudeBefore,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/rebuild-wip-from-jcs
//
// One-shot reconciliation that rebuilds wip_items.stockQty from current
// job_cards truth. After the cleanup chain (CSV import, cascade-upstream-
// completion, /backfill-cascade-wip-producers, /refund-backfill-overconsume,
// /dedupe-wip-items, /normalize-fullwidth-parens, /zero-out-negative-wips)
// wip_items still holds +1,114 phantom inflation across 498 rows because
// /backfill-cascade-wip-producers double-fired producer-add on a subset of
// CSV-imported JCs whose pic1Id was empty. Rather than try yet another
// surgical refund pass, the user wants ONE deterministic SET-from-truth
// reconciliation: walk every JC, compute what each wip_items.code SHOULD
// be, and overwrite.
//
// Mirrors `applyWipInventoryChange` (production-orders.ts:965-1413) but
// fires each contribution exactly once per JC — bypassing the historical
// double-fire risk that produced the drift in the first place. Pure SQL
// reads + JS aggregation; pure UPDATE/INSERT/DELETE writes on wip_items.
// Does NOT call applyWipInventoryChange and does NOT touch any other
// table (job_cards / production_orders / fg_units / fg_batches /
// cost_ledger / BOM tables are all read-only or untouched).
//
// Per-code expected formula:
//
//   producer-add (non-PACKING, COMPLETED|TRANSFERRED, wipLabel=code):
//     +SUM(wipQty)   — every dept that produces output, including UPH self-add.
//
//   per-component consume (non-UPH, non-FAB_CUT, non-WOOD_CUT, non-PACKING,
//   IN_PROGRESS|COMPLETED|TRANSFERRED, wipKey+branchKey-aware):
//     for each such JC, find the upstream sibling at MAX(sequence) below own
//     within (wipKey, branchKey). That sibling's wipLabel gets -wipQty.
//     Note: applyWipInventoryChange now (post-eb58741) skips the consume on
//     IN_PROGRESS→COMPLETED to avoid double-fire — for the rebuild, fire
//     ONCE per active-or-done JC (which is exactly what one transition would
//     have done if there were no bugs).
//
//   UPH branch-terminal consume (UPH, COMPLETED|TRANSFERRED):
//     for each UPH JC, group its same-wipKey siblings by branchKey, and for
//     each branchKey find the JC at MAX(sequence) below UPH's sequence.
//     That JC's wipLabel gets -wipQty per UPH JC.
//
//   PACKING never touches wip_items (line 992-993). Skipped entirely.
//
// Sofa Fab Sew zero-out (production-orders.ts:1346-1376):
//   When the first FAB_SEW JC in a (salesOrderId, fabricCode) sofa group
//   transitions to IN_PROGRESS, EVERY FAB_CUT wipLabel in that group is
//   forced to 0 (the bolt physically leaves Fab Cut's shelf the moment Fab
//   Sew picks it up). This is an irreversible state change at IN_PROGRESS
//   time. For the rebuild we honour it as: if ANY FAB_SEW JC in a sofa PO
//   group's (salesOrderId, fabricCode) is in IN_PROGRESS|COMPLETED|
//   TRANSFERRED, force every FAB_CUT wipLabel in that group's POs to 0
//   regardless of producer-add count.
//
// Edge cases:
//   - JC with empty/NULL wipLabel: no producer-add, no self-consume.
//   - JC with NULL wipKey: no consume sibling lookup (skip).
//   - JC with NULL branchKey: matched to siblings with NULL branchKey
//     (treat NULL == NULL — mirrors the JS filter `(j.branchKey ?? "")` in
//     applyWipInventoryChange).
//   - PO status (CANCELLED etc): NOT filtered. Mirrors current
//     applyWipInventoryChange semantics — it has never filtered by PO
//     status. JCs in CANCELLED POs that are themselves still COMPLETED
//     contribute. (Cancelling a PO does not retro-zero the wip_items it
//     fired; preserve that behaviour.)
//
// Idempotency: a single rebuild pass produces a deterministic result
// regardless of whether wip_items currently holds positives, negatives, or
// 0. We SET absolute values via UPDATE/INSERT; we do not add/subtract.
//
// Output: dry-run shows planned writes + sample of biggest changes; live
// applies via db.batch() for atomicity.
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
type RebuildJcRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  status: string;
  sequence: number;
  wipKey: string | null;
  wipLabel: string | null;
  wipQty: number | null;
  branchKey: string | null;
};

type RebuildPoRow = {
  id: string;
  productCode: string | null;
  itemCategory: string | null;
  salesOrderId: string | null;
  consignmentOrderId: string | null;
  fabricCode: string | null;
  quantity: number | null;
};

type RebuildWipRow = {
  id: string;
  code: string;
  type: string;
  relatedProduct: string | null;
  deptStatus: string | null;
  stockQty: number;
  status: string;
};

app.post("/rebuild-wip-from-jcs", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // BUG-2026-05-12: full-scan rebuild blew past Cloudflare's request wall on
  // prod-size data (5000+ JCs × 5000+ POs in-memory diff). Operator couldn't
  // get FOAM 326-stuck-at-326 corrected because every dry-run hung > 3 min.
  // Two scope filters bolted on so the operator can run dept-scoped (or
  // code-substring-scoped) rebuilds that fit inside the request budget:
  //
  //   ?byDept=FOAM          → filter `expected` map to codes whose JC is in
  //                           that dept (uses the (DEPT) suffix in the
  //                           synthesized label as the heuristic). Also
  //                           filters wip_items SELECT to a subset.
  //   ?codeContains=<frag>  → filter wip_items + expected codes by substring
  //                           (case-sensitive). Use for ad-hoc cleanup of a
  //                           specific product code or wipKey.
  //
  // When both filters are unset the endpoint behaves exactly as before
  // (whole-tenant rebuild). Filters compose with AND.
  const scopeByDept = (c.req.query("byDept") || "").trim().toUpperCase();
  const scopeCodeContains = (c.req.query("codeContains") || "").trim();
  const hasScope = scopeByDept !== "" || scopeCodeContains !== "";
  const matchesScope = (code: string): boolean => {
    if (!hasScope) return true;
    if (scopeByDept && !code.includes(`(${scopeByDept})`)) return false;
    if (scopeCodeContains && !code.includes(scopeCodeContains)) return false;
    return true;
  };

  // ----- Step 1 — load all JCs (one query) -----
  const jcRes = await db
    .prepare(
      `SELECT id, productionOrderId, departmentCode, status, sequence,
              wipKey, wipLabel, wipQty, branchKey
         FROM job_cards`,
    )
    .all<RebuildJcRow>();
  const allJcs = jcRes.results ?? [];

  // ----- Step 2 — load PO essentials for sofa-FAB_SEW edge case -----
  // We need itemCategory, salesOrderId, fabricCode for sofa zero-out, and
  // productCode + quantity for the synthesized fallback wipLabel logic
  // (mirrors applyWipInventoryChange's wipLabel fallback at line 1003-1015).
  const poRes = await db
    .prepare(
      `SELECT id, productCode, itemCategory, salesOrderId,
              consignmentOrderId, fabricCode, quantity
         FROM production_orders`,
    )
    .all<RebuildPoRow>();
  const poById = new Map<string, RebuildPoRow>();
  for (const p of poRes.results ?? []) poById.set(p.id, p);

  // ----- Step 3 — load current wip_items rows -----
  const wipRes = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, deptStatus, stockQty, status
         FROM wip_items`,
    )
    .all<RebuildWipRow>();
  const wipByCode = new Map<string, RebuildWipRow>();
  for (const w of wipRes.results ?? []) {
    // Defensive: if duplicates somehow exist (post-dedupe should be 0),
    // keep the first; rebuild will collapse via UPDATE on canonical id.
    if (!wipByCode.has(w.code)) wipByCode.set(w.code, w);
  }
  const totalRowsBefore = wipRes.results?.length ?? 0;

  // Helper: synthesize wipLabel exactly as applyWipInventoryChange does
  // when jcRow.wipLabel is empty (line 1003-1015). This guarantees the
  // rebuild keys match what the live cascade would have written.
  const synthLabel = (jc: RebuildJcRow, po: RebuildPoRow | undefined): string => {
    const direct = (jc.wipLabel ?? "").trim();
    if (direct) return direct;
    const dept = (jc.departmentCode ?? "").toUpperCase();
    const parts: string[] = [];
    const pc = (po?.productCode ?? "").trim();
    if (pc) parts.push(pc);
    const wc = (jc.wipKey ?? "").trim();
    if (wc) parts.push(wc);
    if (dept) parts.push(`(${dept})`);
    return parts.join(" ").trim();
  };

  // Helper: effective wipQty mirrors `jcRow.wipQty || poRow.quantity || 1`.
  const effQty = (jc: RebuildJcRow, po: RebuildPoRow | undefined): number => {
    const q = jc.wipQty;
    if (typeof q === "number" && q !== 0) return q;
    const pq = po?.quantity;
    if (typeof pq === "number" && pq !== 0) return pq;
    return 1;
  };

  // ----- Step 4 — index siblings per (productionOrderId) for sibling lookup -----
  // applyWipInventoryChange's child lookup walks `allJcRows` filtered by
  // (wipKey, branchKey, sequence < own). The original code's `allJcRows`
  // was the JC list FOR THAT PO — sibling matching never crossed PO
  // boundaries. Preserve that: index by productionOrderId.
  const jcsByPo = new Map<string, RebuildJcRow[]>();
  for (const jc of allJcs) {
    const list = jcsByPo.get(jc.productionOrderId) ?? [];
    list.push(jc);
    jcsByPo.set(jc.productionOrderId, list);
  }

  const findUpstream = (jc: RebuildJcRow): RebuildJcRow | null => {
    if (!jc.wipKey) return null;
    const myBranch = jc.branchKey ?? "";
    const siblings = jcsByPo.get(jc.productionOrderId) ?? [];
    let best: RebuildJcRow | null = null;
    for (const s of siblings) {
      if (s.wipKey !== jc.wipKey) continue;
      if ((s.branchKey ?? "") !== myBranch) continue;
      if (s.sequence >= jc.sequence) continue;
      if (!s.wipLabel) continue;
      if (!best || s.sequence > best.sequence) best = s;
    }
    return best;
  };

  // For UPH branch-terminal consume: per UPH JC, return one sibling per
  // branchKey at MAX sequence below UPH's seq.
  const findUphBranchTerminals = (uph: RebuildJcRow): RebuildJcRow[] => {
    if (!uph.wipKey) return [];
    const siblings = jcsByPo.get(uph.productionOrderId) ?? [];
    const byBranch = new Map<string, RebuildJcRow>();
    for (const s of siblings) {
      if (s.wipKey !== uph.wipKey) continue;
      if (s.sequence >= uph.sequence) continue;
      if (!s.wipLabel) continue;
      const bk = s.branchKey ?? "";
      const cur = byBranch.get(bk);
      if (!cur || s.sequence > cur.sequence) byBranch.set(bk, s);
    }
    return Array.from(byBranch.values());
  };

  // ----- Step 5 — accumulate expected stockQty per code -----
  const expected = new Map<string, number>();
  // Track first-seen JC metadata per code so INSERT path has type/related.
  const codeMeta = new Map<
    string,
    { type: string; relatedProduct: string; deptStatus: string }
  >();
  const bumpExpected = (code: string, delta: number): void => {
    if (!code) return;
    expected.set(code, (expected.get(code) ?? 0) + delta);
  };
  const recordMeta = (
    code: string,
    type: string,
    relatedProduct: string,
    deptStatus: string,
  ): void => {
    if (!code) return;
    if (codeMeta.has(code)) return;
    codeMeta.set(code, { type, relatedProduct, deptStatus });
  };

  const shortType = (wipType: string | null | undefined, deptCode: string): string => {
    const t = (wipType ?? "").toUpperCase();
    if (t === "HEADBOARD") return "HB";
    if (t === "SOFA_BASE") return "BASE";
    if (t === "SOFA_CUSHION") return "CUSHION";
    if (t === "SOFA_ARMREST") return "ARMREST";
    if (t) return t;
    return deptCode || "WIP";
  };

  // BUG-2026-04-30-003 mirror: Plan B "UPH-all-done subtract".
  // Pre-compute the set of POs where EVERY UPH JC is COMPLETED/TRANSFERRED.
  // In production-orders.ts:1346-1381, when an UPH JC transitions to DONE
  // and ALL UPH JCs in the PO are now DONE, the cascade subtracts each
  // UPH JC's +wipQty from its own wipLabel (WIP→FG transition).
  //
  // Net effect for an UPH JC in a fully-UPH-complete PO:
  //   producer-add (+wipQty) + Plan B subtract (-wipQty) = 0
  //
  // Simpler form: SKIP the producer-add for UPH JCs whose PO is fully
  // UPH-complete. Both forms are equivalent; skipping is cleaner.
  // Reverse symmetry (production-orders.ts:1067-1102) is structurally
  // mirrored too: a partially-UPH-done PO sees its DONE UPH JCs producer-add
  // normally (because Plan B subtract has not fired and Plan B reverse
  // does not apply), which matches the live ledger state.
  const fullUphPoIds = new Set<string>();
  {
    type UphCounts = { total: number; done: number };
    const perPo = new Map<string, UphCounts>();
    for (const jc of allJcs) {
      const dept = (jc.departmentCode ?? "").toUpperCase();
      if (dept !== "UPHOLSTERY") continue;
      const slot = perPo.get(jc.productionOrderId) ?? { total: 0, done: 0 };
      slot.total += 1;
      const st = (jc.status ?? "").toUpperCase();
      if (st === "COMPLETED" || st === "TRANSFERRED") slot.done += 1;
      perPo.set(jc.productionOrderId, slot);
    }
    for (const [poId, c] of perPo) {
      if (c.total > 0 && c.done === c.total) fullUphPoIds.add(poId);
    }
  }

  // 5a — producer-add: every JC with status DONE, dept != PACKING, label
  // non-empty contributes +effQty to its own wipLabel.
  // 5b — UPH self-add is just the same loop (UPH falls through with
  // dept!=PACKING and gets its own row written too — see line 1284-1306).
  // BUG-2026-04-30-003 mirror: skip producer-add for UPH JCs in
  // fully-UPH-complete POs (their net contribution is 0 after Plan B
  // subtract).
  for (const jc of allJcs) {
    const dept = (jc.departmentCode ?? "").toUpperCase();
    if (dept === "PACKING") continue;
    const status = (jc.status ?? "").toUpperCase();
    const isDone = status === "COMPLETED" || status === "TRANSFERRED";
    if (!isDone) continue;
    // BUG-2026-04-30-003 mirror: UPH in fully-UPH-done PO → net 0, skip.
    if (dept === "UPHOLSTERY" && fullUphPoIds.has(jc.productionOrderId)) {
      continue;
    }
    const po = poById.get(jc.productionOrderId);
    const label = synthLabel(jc, po);
    if (!label) continue;
    const qty = effQty(jc, po);
    bumpExpected(label, +qty);
    // wipType isn't on RebuildJcRow (we omitted it from SELECT — the
    // shortType is dept-aware enough). Use deptCode as the type seed.
    // The shortType helper only really needs wipType for a few enum
    // outputs; absent that, the dept code is a reasonable fallback for
    // INSERT metadata. (wip_items.type is informational, not load-bearing
    // for stock math.)
    recordMeta(
      label,
      shortType(null, dept),
      po?.productCode ?? "",
      dept === "UPHOLSTERY" ? "UPHOLSTERY" : dept,
    );
  }

  // 5c — per-component consume: non-UPH, non-FAB_CUT, non-WOOD_CUT,
  // non-PACKING JCs with status active|done — each contributes -effQty
  // to its upstream sibling's wipLabel.
  for (const jc of allJcs) {
    const dept = (jc.departmentCode ?? "").toUpperCase();
    if (
      dept === "UPHOLSTERY" ||
      dept === "FAB_CUT" ||
      dept === "WOOD_CUT" ||
      dept === "PACKING" ||
      dept === ""
    ) {
      continue;
    }
    const status = (jc.status ?? "").toUpperCase();
    const isActive =
      status === "IN_PROGRESS" ||
      status === "COMPLETED" ||
      status === "TRANSFERRED";
    if (!isActive) continue;
    const upstream = findUpstream(jc);
    if (!upstream || !upstream.wipLabel) continue;
    const po = poById.get(jc.productionOrderId);
    const qty = effQty(jc, po);
    bumpExpected(upstream.wipLabel, -qty);
    // If the upstream wip_items row doesn't exist yet (skipped dept), make
    // sure we still record meta so an INSERT can land if needed.
    const upPo = poById.get(upstream.productionOrderId);
    recordMeta(
      upstream.wipLabel,
      shortType(null, (upstream.departmentCode ?? "").toUpperCase()),
      upPo?.productCode ?? "",
      "PENDING",
    );
  }

  // 5d — UPH branch-terminal consume: each UPH JC (DONE) consumes -effQty
  // on each of its branch terminals' wipLabels.
  for (const jc of allJcs) {
    const dept = (jc.departmentCode ?? "").toUpperCase();
    if (dept !== "UPHOLSTERY") continue;
    const status = (jc.status ?? "").toUpperCase();
    const isDone = status === "COMPLETED" || status === "TRANSFERRED";
    if (!isDone) continue;
    const po = poById.get(jc.productionOrderId);
    const qty = effQty(jc, po);
    const terminals = findUphBranchTerminals(jc);
    for (const t of terminals) {
      if (!t.wipLabel) continue;
      bumpExpected(t.wipLabel, -qty);
      const tPo = poById.get(t.productionOrderId);
      recordMeta(
        t.wipLabel,
        shortType(null, (t.departmentCode ?? "").toUpperCase()),
        tPo?.productCode ?? "",
        "PENDING",
      );
    }
  }

  // ----- Step 6 — sofa FAB_SEW zero-out edge case -----
  // Group sofa POs by (parentDocId, fabricCode). parentDocId = SO id OR
  // CO id — without the CO branch, CO sofa groups skipped this step
  // entirely and FAB_CUT WIP for CO sofas drifted away from truth.
  // If any FAB_SEW JC across the group is IN_PROGRESS|COMPLETED|
  // TRANSFERRED, every FAB_CUT wipLabel in that group's POs is forced
  // to 0.
  type SofaGroupKey = string; // `${parentDocId}|${fabricCode}`
  const sofaGroups = new Map<SofaGroupKey, RebuildPoRow[]>();
  for (const po of poById.values()) {
    if ((po.itemCategory ?? "").toUpperCase() !== "SOFA") continue;
    const parentDocId = po.salesOrderId || po.consignmentOrderId || "";
    if (!parentDocId || !po.fabricCode) continue;
    const k = `${parentDocId}|${po.fabricCode}`;
    const list = sofaGroups.get(k) ?? [];
    list.push(po);
    sofaGroups.set(k, list);
  }

  const zeroedFabCutLabels = new Set<string>();
  for (const [, pos] of sofaGroups) {
    // Has any FAB_SEW in this group transitioned past WAITING?
    let triggered = false;
    for (const po of pos) {
      const jcs = jcsByPo.get(po.id) ?? [];
      for (const jc of jcs) {
        if ((jc.departmentCode ?? "").toUpperCase() !== "FAB_SEW") continue;
        const st = (jc.status ?? "").toUpperCase();
        if (
          st === "IN_PROGRESS" ||
          st === "COMPLETED" ||
          st === "TRANSFERRED"
        ) {
          triggered = true;
          break;
        }
      }
      if (triggered) break;
    }
    if (!triggered) continue;
    // Force every FAB_CUT wipLabel in this group to 0.
    for (const po of pos) {
      const jcs = jcsByPo.get(po.id) ?? [];
      for (const jc of jcs) {
        if ((jc.departmentCode ?? "").toUpperCase() !== "FAB_CUT") continue;
        const label = synthLabel(jc, po);
        if (!label) continue;
        zeroedFabCutLabels.add(label);
      }
    }
  }
  for (const label of zeroedFabCutLabels) {
    expected.set(label, 0);
  }

  // ----- Step 7 — diff against current wip_items, build plan -----
  type UpdatePlan = { id: string; code: string; from: number; to: number };
  type InsertPlan = {
    code: string;
    qty: number;
    type: string;
    relatedProduct: string;
    deptStatus: string;
  };
  type DeletePlan = { id: string; code: string; from: number };

  const updates: UpdatePlan[] = [];
  const inserts: InsertPlan[] = [];
  const deletes: DeletePlan[] = [];

  // Drift before = sum(current stockQty across all rows) — sum(expected
  // across all expected codes ∪ current codes).
  let totalCurrentSum = 0;
  for (const w of wipRes.results ?? []) totalCurrentSum += w.stockQty || 0;
  let totalExpectedSum = 0;
  for (const v of expected.values()) totalExpectedSum += v;
  // For codes that exist in wip_items but NOT in expected, treat expected as 0.
  for (const w of wipRes.results ?? []) {
    if (!expected.has(w.code)) {
      // expected effectively 0 for this code; drift is -(current).
    }
  }
  const totalDriftBefore = totalCurrentSum - totalExpectedSum;

  // For each code in expected: if existing row, plan UPDATE (or DELETE if
  // expected==0 and current!=0); else if expected != 0, plan INSERT.
  for (const [code, qty] of expected) {
    if (!matchesScope(code)) continue;
    const cur = wipByCode.get(code);
    if (cur) {
      if ((cur.stockQty || 0) === qty) continue;
      if (qty === 0) {
        deletes.push({ id: cur.id, code, from: cur.stockQty });
      } else {
        updates.push({ id: cur.id, code, from: cur.stockQty, to: qty });
      }
    } else if (qty !== 0) {
      const meta = codeMeta.get(code) ?? {
        type: "WIP",
        relatedProduct: "",
        deptStatus: "PENDING",
      };
      inserts.push({
        code,
        qty,
        type: meta.type,
        relatedProduct: meta.relatedProduct,
        deptStatus: meta.deptStatus,
      });
    }
  }

  // For codes in wip_items but NOT in expected: expected = 0. If
  // current != 0, plan DELETE. (If current == 0, leave alone — don't
  // delete already-zero unrelated rows.)
  for (const w of wipRes.results ?? []) {
    if (!matchesScope(w.code)) continue;
    if (expected.has(w.code)) continue;
    if ((w.stockQty || 0) !== 0) {
      deletes.push({ id: w.id, code: w.code, from: w.stockQty });
    }
  }

  // ----- Aggregates for response -----
  // Per-dept summary (rough — keyed off codeMeta.type which is dept-ish).
  const byDept: Record<
    string,
    { update: number; insert: number; delete: number; netDelta: number }
  > = {};
  const deptOf = (code: string): string => {
    const meta = codeMeta.get(code);
    if (meta) return meta.deptStatus || meta.type || "UNKNOWN";
    // Fall back to whatever the existing wip_items row says.
    const w = wipByCode.get(code);
    return w?.deptStatus || w?.type || "UNKNOWN";
  };
  const bumpDept = (code: string, kind: "update" | "insert" | "delete", delta: number): void => {
    const k = deptOf(code);
    const slot = byDept[k] ?? { update: 0, insert: 0, delete: 0, netDelta: 0 };
    slot[kind] += 1;
    slot.netDelta += delta;
    byDept[k] = slot;
  };
  for (const u of updates) bumpDept(u.code, "update", u.to - u.from);
  for (const i of inserts) bumpDept(i.code, "insert", i.qty);
  for (const d of deletes) bumpDept(d.code, "delete", -d.from);

  // Sample: 20 biggest absolute changes (worst inflated rows getting
  // brought down, biggest insertions, biggest deletions).
  type SampleRow = {
    code: string;
    currentQty: number;
    expectedQty: number;
    diff: number;
    op: "update" | "insert" | "delete";
  };
  const sampleAll: SampleRow[] = [];
  for (const u of updates) {
    sampleAll.push({
      code: u.code,
      currentQty: u.from,
      expectedQty: u.to,
      diff: u.to - u.from,
      op: "update",
    });
  }
  for (const i of inserts) {
    sampleAll.push({
      code: i.code,
      currentQty: 0,
      expectedQty: i.qty,
      diff: i.qty,
      op: "insert",
    });
  }
  for (const d of deletes) {
    sampleAll.push({
      code: d.code,
      currentQty: d.from,
      expectedQty: 0,
      diff: -d.from,
      op: "delete",
    });
  }
  sampleAll.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const sample = sampleAll.slice(0, 20);

  // Drift after: should be 0 if formula is correct. Compute by simulating
  // the planned writes.
  let projectedSum = totalCurrentSum;
  for (const u of updates) projectedSum += u.to - u.from;
  for (const i of inserts) projectedSum += i.qty;
  for (const d of deletes) projectedSum += -d.from;
  const totalDriftAfter = projectedSum - totalExpectedSum;

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      totalRowsBefore,
      totalCodesExpected: expected.size,
      rowsToUpdate: updates.length,
      rowsToInsert: inserts.length,
      rowsToDelete: deletes.length,
      totalCurrentSum,
      totalExpectedSum,
      totalDriftBefore,
      totalDriftAfter,
      sofaFabCutZeroedLabelCount: zeroedFabCutLabels.size,
      fullUphPoCount: fullUphPoIds.size,
      byDept,
      sample,
    });
  }

  // ----- Live mode — single atomic batch -----
  const stmts: D1PreparedStatement[] = [];
  for (const u of updates) {
    stmts.push(
      db
        .prepare(`UPDATE wip_items SET stockQty = ? WHERE id = ?`)
        .bind(u.to, u.id),
    );
  }
  for (const i of inserts) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO wip_items (id, code, type, relatedProduct, deptStatus, stockQty, status)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
           ON CONFLICT (org_id, code) DO UPDATE SET
             stockQty = EXCLUDED.stockQty,
             deptStatus = EXCLUDED.deptStatus`,
        )
        .bind(
          `wip-rebuild-${crypto.randomUUID().slice(0, 8)}`,
          i.code,
          i.type,
          i.relatedProduct,
          i.deptStatus,
          i.qty,
        ),
    );
  }
  for (const d of deletes) {
    stmts.push(
      db.prepare(`DELETE FROM wip_items WHERE id = ?`).bind(d.id),
    );
  }

  let batchOk = true;
  let batchError: string | null = null;
  let updatesApplied = 0;
  let insertsApplied = 0;
  let deletesApplied = 0;
  try {
    const batchResults = await db.batch(stmts);
    let i = 0;
    for (const _u of updates) {
      const r = batchResults[i++];
      if ((r?.meta?.changes ?? 0) > 0) updatesApplied += 1;
    }
    for (const _ins of inserts) {
      const r = batchResults[i++];
      if ((r?.meta?.changes ?? 0) > 0) insertsApplied += 1;
    }
    for (const _d of deletes) {
      const r = batchResults[i++];
      if ((r?.meta?.changes ?? 0) > 0) deletesApplied += 1;
    }
  } catch (err) {
    batchOk = false;
    batchError = err instanceof Error ? err.message : String(err);
  }

  return c.json({
    success: batchOk,
    dryRun: false,
    totalRowsBefore,
    rowsUpdated: updatesApplied,
    rowsInserted: insertsApplied,
    rowsDeleted: deletesApplied,
    rowsToUpdate: updates.length,
    rowsToInsert: inserts.length,
    rowsToDelete: deletes.length,
    totalDriftBefore,
    totalDriftAfter,
    sofaFabCutZeroedLabelCount: zeroedFabCutLabels.size,
    byDept,
    sample,
    batchError,
  });
});

// ---------------------------------------------------------------------------
// /backfill-fab-cut-merge — one-shot retroactive Option C consolidation.
//
// New SOs created after the Option C deploy (commit a871743) emit one merged
// FAB_CUT JC per (companySOId, baseModel, fabricCode). Pre-existing SOs
// still have per-piece FAB_CUT JCs from the legacy BOM cascade. This
// endpoint walks every existing FAB_CUT JC, groups them by the same merge
// key, and collapses each group into one merged row matching the
// production-builder.ts `aggregateFcSlots` output. Per-piece children get
// deleted; the anchor JC's id is reused as the merged row's id so any
// existing references (cost_ledger, scan_override_audit) stay valid.
//
// Idempotent: groups that already have a merged row (scopeLevel='SO' style
// wipKey or single-JC group) are skipped. Re-running the endpoint after a
// successful run is a no-op.
//
// Always run with `?dryRun=true` first. The dry-run path executes zero
// writes and returns a per-group plan so the operator can sanity-check
// the merge before committing.
// ---------------------------------------------------------------------------
type FcRow = {
  id: string;
  productionOrderId: string;
  wipKey: string;
  wipLabel: string;
  wipCode: string;
  wipType: string;
  wipQty: number;
  status: string;
  completedDate: string | null;
  dueDate: string | null;
  sequence: number;
  branchKey: string | null;
  category: string | null;
  productionTimeMinutes: number | null;
  estMinutes: number | null;
  pic1Id: string | null;
  pic1Name: string | null;
  pic2Id: string | null;
  pic2Name: string | null;
  // Joined PO context
  poProductCode: string | null;
  poFabricCode: string | null;
  poSizeLabel: string | null;
  poGapInches: number | null;
  poDivanHeightInches: number | null;
  poLegHeightInches: number | null;
  poItemCategory: string | null;
  poCompanySOId: string | null;
  poSalesOrderId: string | null;
  poCompanyCOId: string | null;
  poConsignmentOrderId: string | null;
  bomBaseModel: string | null;
};

// Mirror of _shared/production-builder.ts joinModelLabel — keeps duplicates
// in source order so cutter sees every piece in the group, not just unique
// productCodes. See the canonical version for full rationale.
function joinModelLabel(productCodes: string[]): string {
  const all = productCodes.filter(Boolean);
  if (all.length === 0) return "";
  if (all.length === 1) return all[0];
  const firstDash = all[0].indexOf("-");
  if (firstDash > 0) {
    const prefix = all[0].slice(0, firstDash + 1);
    if (all.every((m) => m.startsWith(prefix))) {
      return prefix + all.map((m) => m.slice(prefix.length)).join("+");
    }
  }
  return all.join("+");
}

function buildFcWipLabel(
  modelLabel: string,
  sizeLabel: string,
  totalH: number,
  divanHeightInches: number | null,
  fabricCode: string,
  isBF: boolean,
): string {
  return [
    modelLabel,
    // BF: "5FT" frame size; SOFA: "28" seat width. Both meaningful.
    sizeLabel ? `(${sizeLabel})` : "",
    isBF && totalH > 0 ? `(${totalH}")` : "",
    isBF && divanHeightInches ? `(DV ${divanHeightInches}")` : "",
    fabricCode || "",
    "(FC)",
  ]
    .filter(Boolean)
    .join(" | ");
}

app.post("/backfill-fab-cut-merge", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // Pull every FAB_CUT JC with its PO context + bom_templates baseModel in
  // one query. The LEFT JOIN tolerates orphan POs / missing BOM rows
  // (legacy seed data) — we fall back to productCode as baseModel below.
  // Use double-quoted AS aliases so Postgres preserves the camelCase
  // exactly as written. Unquoted aliases get folded to all-lowercase
  // (`poProductCode` → `poproductcode`) and the db-pg snake→camel
  // transform can't resurrect them. Bug: dry-run reported 1380 FC JCs
  // but every newWipKey came out as `pord-XXX::::::FAB_CUT` (empty
  // baseModel + fabric) because row.poProductCode was undefined.
  const rowsRes = await db
    .prepare(
      `SELECT
         jc.id, jc.productionOrderId, jc.wipKey, jc.wipLabel, jc.wipCode,
         jc.wipType, jc.wipQty, jc.status, jc.completedDate, jc.dueDate,
         jc.sequence, jc.branchKey, jc.category, jc.productionTimeMinutes,
         jc.estMinutes, jc.pic1Id, jc.pic1Name, jc.pic2Id, jc.pic2Name,
         po.productCode       AS "poProductCode",
         po.fabricCode        AS "poFabricCode",
         po.sizeLabel         AS "poSizeLabel",
         po.gapInches         AS "poGapInches",
         po.divanHeightInches AS "poDivanHeightInches",
         po.legHeightInches   AS "poLegHeightInches",
         po.itemCategory      AS "poItemCategory",
         po.companySOId       AS "poCompanySOId",
         po.salesOrderId      AS "poSalesOrderId",
         po.companyCOId       AS "poCompanyCOId",
         po.consignmentOrderId AS "poConsignmentOrderId",
         bt.baseModel         AS "bomBaseModel"
       FROM job_cards jc
       JOIN production_orders po ON po.id = jc.productionOrderId
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode
        AND bt.versionStatus = 'ACTIVE'
       WHERE jc.departmentCode = 'FAB_CUT'`,
    )
    .all<FcRow>();
  const allRows = rowsRes.results ?? [];

  // Category-aware grouping (mirrors production-builder.ts aggregateFcSlots).
  //   SOFA  → cross-PO merge by (companySOId, baseModel, fabric)
  //   BF/ACC → per-PO merge (each set already has its own line-suffixed
  //            po_no — distinct sets must NOT collapse just because they
  //            share baseModel + fabric, e.g. 2 BF lines of same model in
  //            same SO are 2 different cutting jobs).
  const groups = new Map<string, FcRow[]>();
  let skippedNoSO = 0;
  for (const row of allRows) {
    // Parent doc id — SO id or CO id. Without the CO branch, every CO
    // sofa row hit `skippedNoSO++` and never participated in merge.
    const parentDocKey =
      row.poCompanySOId ??
      row.poSalesOrderId ??
      row.poCompanyCOId ??
      row.poConsignmentOrderId ??
      "";
    const baseModel = row.bomBaseModel || row.poProductCode || "";
    const fabric = row.poFabricCode ?? "";
    const isSofa = (row.poItemCategory ?? "") === "SOFA";
    if (isSofa && !parentDocKey) {
      skippedNoSO++;
      continue;
    }
    const key = isSofa
      ? `SOFA::${parentDocKey}::${baseModel}::${fabric}`
      : `PO::${row.productionOrderId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  // Plan per group. Single-JC groups are no-ops; multi-JC groups become a
  // merge: anchor = first row (ordered by createdAt via id sort), the rest
  // get deleted, anchor gets UPDATE-d to merged values.
  type Plan = {
    mergeKey: string;
    anchorJcId: string;
    siblingJcIds: string[];
    newWipKey: string;
    newWipLabel: string;
    // Merged FC wipType = itemCategory so cascade stamps wip_items.type
    // with the set-level category instead of the anchor's per-piece type.
    newWipType: string;
    newWipQty: number;
    newProdTime: number;
    completedDate: string | null;
    status: string;
    dueDate: string | null;
    pieceCount: number;
  };
  const plans: Plan[] = [];
  let alreadyMerged = 0;
  for (const [mergeKey, group] of groups.entries()) {
    if (group.length === 0) continue;
    if (group.length === 1) {
      // Single-JC group — already-merged shape OR a one-piece BF SOID. No-op
      // either way.
      alreadyMerged++;
      continue;
    }
    // Pick anchor = lowest-id row (deterministic). Sort siblings same way.
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const anchor = sorted[0];
    const siblings = sorted.slice(1);
    const totalProdTime = sorted.reduce(
      (sum, r) => sum + (r.productionTimeMinutes ?? r.estMinutes ?? 0),
      0,
    );
    // SOFA cross-PO merge needs to count each PO ONCE, not once per WIP node.
    // backfillJobCardsForPo creates one FAB_CUT JC per WIP component
    // (SOFA_BASE / SOFA_CUSHION / SOFA_ARMREST), so a 6-PO sofa group can
    // surface as 18 rows here — collapse to 1 row per productionOrderId
    // before computing wipQty / label so:
    //   - wipQty = sum of unique PO line qtys (= 6, not 18)
    //   - label  = joinModelLabel of unique PO productCodes (= 6 entries
    //              repeated by line qty, not 18 = 3 WIPs × 6 POs).
    // BF/ACC same-PO merge keeps the per-row min logic — set count semantics
    // (HB qty=1 + DV qty=2 → min=1 set) was correct for per-WIP rows.
    const isSofaForQty = (anchor.poItemCategory ?? "") === "SOFA";
    const perPoRows = isSofaForQty
      ? Array.from(
          sorted
            .reduce((m, r) => {
              if (!m.has(r.productionOrderId)) m.set(r.productionOrderId, r);
              return m;
            }, new Map<string, FcRow>())
            .values(),
        )
      : sorted;
    const newWipQty = isSofaForQty
      ? perPoRows.reduce((sum, r) => sum + (r.wipQty || 1), 0)
      : Math.min(...sorted.map((r) => r.wipQty || 1));
    const productCodes = perPoRows.map((r) => r.poProductCode ?? "");
    const modelLabel = joinModelLabel(productCodes);
    const totalH =
      (anchor.poGapInches ?? 0) +
      (anchor.poDivanHeightInches ?? 0) +
      (anchor.poLegHeightInches ?? 0);
    const isBF = (anchor.poItemCategory ?? "") === "BEDFRAME";
    const newWipLabel = buildFcWipLabel(
      modelLabel,
      anchor.poSizeLabel ?? "",
      totalH,
      anchor.poDivanHeightInches,
      anchor.poFabricCode ?? "",
      isBF,
    );
    const baseModel = anchor.bomBaseModel || anchor.poProductCode || "";
    const isSofa = (anchor.poItemCategory ?? "") === "SOFA";
    const newWipKey = isSofa
      ? `${anchor.poCompanySOId ?? anchor.poSalesOrderId}::${baseModel}::${anchor.poFabricCode ?? ""}::FAB_CUT`
      : `${anchor.productionOrderId}::${baseModel}::${anchor.poFabricCode ?? ""}::FAB_CUT`;
    // If ANY child already DONE, the merged JC carries that DONE state +
    // earliest completedDate. Otherwise WAITING.
    const doneRows = sorted.filter(
      (r) => r.status === "COMPLETED" || r.status === "TRANSFERRED",
    );
    const status = doneRows.length === sorted.length ? "COMPLETED" : "WAITING";
    const completedDate =
      status === "COMPLETED"
        ? doneRows
            .map((r) => r.completedDate)
            .filter((d): d is string => !!d)
            .sort()[0] ?? null
        : null;
    const dueDate =
      sorted
        .map((r) => r.dueDate)
        .filter((d): d is string => !!d)
        .sort()[0] ?? null;
    plans.push({
      mergeKey,
      anchorJcId: anchor.id,
      siblingJcIds: siblings.map((r) => r.id),
      newWipKey,
      newWipLabel,
      // BEDFRAME / SOFA / ACCESSORY — set-level category. Falls back to
      // the anchor's wipType only when itemCategory is somehow missing
      // (legacy seed without proper category).
      newWipType:
        anchor.poItemCategory ?? anchor.wipType ?? "FAB_CUT",
      newWipQty,
      newProdTime: totalProdTime,
      completedDate,
      status,
      dueDate,
      pieceCount: sorted.length,
    });
  }

  if (dryRun) {
    return c.json({
      mode: "dry-run",
      totalFcJcs: allRows.length,
      skippedNoSO,
      groupsTotal: groups.size,
      groupsAlreadyMerged: alreadyMerged,
      groupsToMerge: plans.length,
      jcsToDelete: plans.reduce((s, p) => s + p.siblingJcIds.length, 0),
      sample: plans.slice(0, 10),
    });
  }

  // Execute. UPDATE each anchor with merged fields + DELETE all siblings.
  // Wrap each group's writes in a single batch so a partial failure
  // doesn't leave a half-merged group.
  let mergedGroups = 0;
  let deletedSiblings = 0;
  const errors: { mergeKey: string; error: string }[] = [];
  for (const plan of plans) {
    try {
      const stmts: D1PreparedStatement[] = [
        db
          .prepare(
            `UPDATE job_cards
                SET wipKey = ?, wipLabel = ?, wipType = ?, wipQty = ?,
                    productionTimeMinutes = ?, estMinutes = ?,
                    actualMinutes = ?,
                    status = ?, completedDate = ?, dueDate = ?,
                    sequence = 0, prerequisiteMet = 1,
                    branchKey = ''
              WHERE id = ?`,
          )
          .bind(
            plan.newWipKey,
            plan.newWipLabel,
            plan.newWipType,
            plan.newWipQty,
            plan.newProdTime,
            plan.newProdTime,
            plan.status === "COMPLETED" ? plan.newProdTime : null,
            plan.status,
            plan.completedDate,
            plan.dueDate,
            plan.anchorJcId,
          ),
      ];
      for (const id of plan.siblingJcIds) {
        stmts.push(
          db.prepare("DELETE FROM job_cards WHERE id = ?").bind(id),
        );
      }
      await db.batch(stmts);
      mergedGroups++;
      deletedSiblings += plan.siblingJcIds.length;
    } catch (err) {
      errors.push({
        mergeKey: plan.mergeKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    mode: "executed",
    totalFcJcs: allRows.length,
    skippedNoSO,
    groupsTotal: groups.size,
    groupsAlreadyMerged: alreadyMerged,
    groupsToMerge: plans.length,
    mergedGroups,
    deletedSiblings,
    errors,
  });
});


// ---------------------------------------------------------------------------
// /backfill-fc-label-refresh — one-shot retroactive FAB_CUT wipLabel/wipQty
// refresh.
//
// Background: production-builder.ts `aggregateFcSlots` had a per-PO collapse
// bug where each BOM top-level sub-WIP that traversed FAB_CUT (SOFA: Base +
// Back Cushion + Armrest; BF: HB + Divan) pushed its OWN slot. Joining slot
// productCodes inflated labels — SOFA `5531-1A(LHF)+1A(LHF)+1A(LHF)+...`
// from 1 PO with 3 sub-WIPs, BF `1013-(S)+(S)` from 1 PO with HB+DV. Fix in
// commits 5346bb7 + ce019a6 now collapses one slot per PO before joining;
// new SO confirms / PUT-cascades produce the correct label. This endpoint
// rewrites the labels on already-cascaded JCs that still carry the inflated
// form — non-destructive, only UPDATEs wipLabel + wipQty + productionTime,
// leaves status / completedDate / PIC / dueDate untouched so in-progress
// scans aren't disturbed.
//
// Idempotent. Re-running after a successful run is a no-op (labels already
// match what the fixed cascade would produce).
//
// Always run with `?dryRun=true` first.
// ---------------------------------------------------------------------------
type FcRefreshJcRow = {
  id: string;
  productionOrderId: string;
  wipLabel: string;
  wipQty: number;
  productionTimeMinutes: number | null;
  estMinutes: number | null;
  poProductCode: string | null;
  poFabricCode: string | null;
  poSizeLabel: string | null;
  poGapInches: number | null;
  poDivanHeightInches: number | null;
  poLegHeightInches: number | null;
  poItemCategory: string | null;
  poCompanySOId: string | null;
  poSalesOrderId: string | null;
  poCompanyCOId: string | null;
  poConsignmentOrderId: string | null;
  bomBaseModel: string | null;
};

type PoRow = {
  id: string;
  productCode: string | null;
  companySOId: string | null;
  salesOrderId: string | null;
  companyCOId: string | null;
  consignmentOrderId: string | null;
  fabricCode: string | null;
  itemCategory: string | null;
  bomBaseModel: string | null;
};

app.post("/backfill-fc-label-refresh", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Pull every FAB_CUT JC with its anchor PO context. Each JC has ONE
  //    anchor PO (productionOrderId). For SOFA cross-PO merged JCs the
  //    anchor is whichever PO won the deterministic jcId seed; siblings
  //    are NOT in job_cards anymore (they were lumped into the anchor),
  //    so we'll find them by querying production_orders separately.
  const jcRowsRes = await db
    .prepare(
      `SELECT
         jc.id, jc.productionOrderId, jc.wipLabel, jc.wipQty,
         jc.productionTimeMinutes, jc.estMinutes,
         po.productCode       AS "poProductCode",
         po.fabricCode        AS "poFabricCode",
         po.sizeLabel         AS "poSizeLabel",
         po.gapInches         AS "poGapInches",
         po.divanHeightInches AS "poDivanHeightInches",
         po.legHeightInches   AS "poLegHeightInches",
         po.itemCategory      AS "poItemCategory",
         po.companySOId       AS "poCompanySOId",
         po.salesOrderId      AS "poSalesOrderId",
         po.companyCOId       AS "poCompanyCOId",
         po.consignmentOrderId AS "poConsignmentOrderId",
         bt.baseModel         AS "bomBaseModel"
       FROM job_cards jc
       JOIN production_orders po ON po.id = jc.productionOrderId
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode
        AND bt.versionStatus = 'ACTIVE'
       WHERE jc.departmentCode = 'FAB_CUT'
         AND jc.orgId = ?`,
    )
    .bind(orgId)
    .all<FcRefreshJcRow>();
  const jcRows = jcRowsRes.results ?? [];

  // 2. Pull all production_orders (org-scoped) with their baseModel so we
  //    can reconstruct each merge group's full PO list. SOFA merged JCs
  //    span multiple POs that share (companySOId, baseModel, fabricCode).
  const posRes = await db
    .prepare(
      `SELECT
         po.id, po.productCode, po.companySOId, po.salesOrderId,
         po.companyCOId, po.consignmentOrderId, po.fabricCode,
         po.itemCategory,
         bt.baseModel AS "bomBaseModel"
       FROM production_orders po
       LEFT JOIN bom_templates bt
         ON bt.productCode = po.productCode
        AND bt.versionStatus = 'ACTIVE'
       WHERE po.orgId = ?`,
    )
    .bind(orgId)
    .all<PoRow>();
  const allPos = posRes.results ?? [];

  // 3. Build groupKey → PO rows index. Same keying as production-builder
  //    `aggregateFcSlots`:
  //      SOFA  → SOFA::{parentDocKey}::{baseModel}::{fabric}
  //      BF/ACC → PO::{poId}
  const groupKeyForPo = (po: PoRow): string => {
    const isSofa = (po.itemCategory ?? "") === "SOFA";
    if (!isSofa) return `PO::${po.id}`;
    const parentDocKey =
      po.companySOId ??
      po.salesOrderId ??
      po.companyCOId ??
      po.consignmentOrderId ??
      "";
    const baseModel = po.bomBaseModel || po.productCode || "";
    const fabric = po.fabricCode ?? "";
    return `SOFA::${parentDocKey}::${baseModel}::${fabric}`;
  };
  const posByGroup = new Map<string, PoRow[]>();
  for (const po of allPos) {
    const key = groupKeyForPo(po);
    if (!posByGroup.has(key)) posByGroup.set(key, []);
    posByGroup.get(key)!.push(po);
  }

  // 4. For each FC JC, compute the merge groupKey from its anchor PO,
  //    pull the PO list from the index, and rebuild the label.
  type Plan = {
    jcId: string;
    groupKey: string;
    poCount: number;
    oldLabel: string;
    newLabel: string;
    oldQty: number;
    newQty: number;
    oldProdTime: number | null;
    newProdTime: number;
  };
  const plans: Plan[] = [];
  let skippedNoAnchorPo = 0;
  let skippedNoGroup = 0;
  let unchanged = 0;

  for (const jc of jcRows) {
    if (!jc.poItemCategory) {
      // PO context missing — can't recompute, skip rather than corrupt.
      skippedNoAnchorPo++;
      continue;
    }
    const anchorPo: PoRow = {
      id: jc.productionOrderId,
      productCode: jc.poProductCode,
      companySOId: jc.poCompanySOId,
      salesOrderId: jc.poSalesOrderId,
      companyCOId: jc.poCompanyCOId,
      consignmentOrderId: jc.poConsignmentOrderId,
      fabricCode: jc.poFabricCode,
      itemCategory: jc.poItemCategory,
      bomBaseModel: jc.bomBaseModel,
    };
    const key = groupKeyForPo(anchorPo);
    const groupPos = posByGroup.get(key);
    if (!groupPos || groupPos.length === 0) {
      skippedNoGroup++;
      continue;
    }
    // Per-PO collapse: each PO contributes ONE productCode entry to the
    // label. Sort by id so the order is deterministic across runs (and
    // matches createdAt for the SO line order, since poIds are seeded
    // pord-{soId}-{NN}).
    const sortedPos = [...groupPos].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const productCodes = sortedPos
      .map((p) => p.productCode ?? "")
      .filter(Boolean);
    const modelLabel = joinModelLabel(productCodes);
    const isBF = (jc.poItemCategory ?? "") === "BEDFRAME";
    const totalH =
      (jc.poGapInches ?? 0) +
      (jc.poDivanHeightInches ?? 0) +
      (jc.poLegHeightInches ?? 0);
    const newLabel = buildFcWipLabel(
      modelLabel,
      jc.poSizeLabel ?? "",
      totalH,
      jc.poDivanHeightInches,
      jc.poFabricCode ?? "",
      isBF,
    );

    // wipQty:
    //   SOFA → 1 set per PO (SOFA qty=1 enforced upstream) → poCount.
    //   BF/ACC → group is 1 PO, qty stays as it was (cascade-correct).
    const isSofa = (jc.poItemCategory ?? "") === "SOFA";
    const newQty = isSofa ? sortedPos.length : jc.wipQty;

    // productionTimeMinutes — wasn't part of the cascade bug, but if the
    // backfill-fab-cut-merge endpoint stamped a value derived from
    // inflated slot rows it may be too high. Leave it as-is unless the
    // operator explicitly requests a recompute via a future flag.
    const newProdTime =
      jc.productionTimeMinutes ?? jc.estMinutes ?? 0;

    if (newLabel === jc.wipLabel && newQty === jc.wipQty) {
      unchanged++;
      continue;
    }
    plans.push({
      jcId: jc.id,
      groupKey: key,
      poCount: sortedPos.length,
      oldLabel: jc.wipLabel,
      newLabel,
      oldQty: jc.wipQty,
      newQty,
      oldProdTime: jc.productionTimeMinutes,
      newProdTime,
    });
  }

  if (dryRun) {
    return c.json({
      mode: "dry-run",
      totalFcJcs: jcRows.length,
      totalPos: allPos.length,
      groupsIndexed: posByGroup.size,
      skippedNoAnchorPo,
      skippedNoGroup,
      unchanged,
      toUpdate: plans.length,
      sample: plans.slice(0, 20),
    });
  }

  // Execute. Only UPDATE wipLabel + wipQty — leave status / completedDate /
  // PIC / dueDate / sequence untouched so in-progress JCs keep their
  // scanned state.
  let updated = 0;
  const errors: { jcId: string; error: string }[] = [];
  for (const plan of plans) {
    try {
      await db
        .prepare(
          `UPDATE job_cards
              SET wipLabel = ?, wipQty = ?
            WHERE id = ?`,
        )
        .bind(plan.newLabel, plan.newQty, plan.jcId)
        .run();
      updated++;
    } catch (err) {
      errors.push({
        jcId: plan.jcId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    mode: "executed",
    totalFcJcs: jcRows.length,
    totalPos: allPos.length,
    groupsIndexed: posByGroup.size,
    skippedNoAnchorPo,
    skippedNoGroup,
    unchanged,
    toUpdate: plans.length,
    updated,
    errors,
  });
});


// ---------------------------------------------------------------------------
// /backfill-split-multi-qty — one-shot retroactive SO→PO split repair.
//
// Background: production-builder.ts:412-414 added the SO→PO split-by-quantity
// rule on 2026-04-28 (commit a95d91f). For non-SOFA items, a line with
// quantity=N now fans out to N separate POs each quantity=1 (e.g. SO-X-01,
// SO-X-02). SOs confirmed BEFORE that deploy went through the legacy path
// which created ONE PO carrying the full line quantity. Downstream BOM
// expansion then inflated wipQty across every dept (Option-C merged FAB_CUT
// JC = min(group.wipQty), so the merged JC inherits the inflated set count).
// /backfill-fab-cut-merge only consolidates existing FC JCs — it cannot
// reverse the missed split.
//
// This endpoint walks production_orders for non-SOFA POs with quantity>1,
// groups them by salesOrderId, and for each affected SO:
//   1. Pre-flight — every PO of that SO must be PENDING with no JC ever
//      scanned (pic1Id / pic2Id null) and no cost_ledger entry referencing
//      any of those POs. Anything in progress is SKIPPED (audit data wins).
//   2. Hard-delete the affected SO's POs. job_cards CASCADE on
//      productionOrderId, piece_pics CASCADE on jobCardId, so JC + piece
//      data goes with them. fg_units / fg_batches are only created on
//      PO completion, which the PENDING guard already excludes.
//   3. Re-run createProductionOrdersForOrder against the SO's current items.
//      The modern split logic fans out one PO per piece (quantity=1) and
//      Option-C aggregator emits a single FC JC per PO with wipQty=1.
//
// dryRun=true returns the per-SO plan without writes — same convention as
// /backfill-fab-cut-merge. Idempotent: re-runs are no-ops once every PO
// has quantity<=1 (or every multi-qty PO has been touched, in which case
// the pre-flight skips it).
// ---------------------------------------------------------------------------
type SplitCandidatePo = {
  poId: string;
  poNo: string;
  salesOrderId: string | null;
  consignmentOrderId: string | null;
  status: string;
  quantity: number;
  itemCategory: string | null;
};

app.post("/backfill-split-multi-qty", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Find all non-SOFA POs with quantity > 1. Sofa stays single-PO by
  //    design (one set per line), so its quantity carries through unchanged.
  const candRes = await db
    .prepare(
      `SELECT id AS "poId", poNo, salesOrderId, consignmentOrderId,
              status, quantity, itemCategory
         FROM production_orders
        WHERE itemCategory <> 'SOFA'
          AND quantity > 1`,
    )
    .all<SplitCandidatePo>();
  const candidates = candRes.results ?? [];

  // 2. Group by source-order id (SO or CO). The cascade re-run operates
  //    at the order level — one rebuild emits all the order's POs together,
  //    so we can't split SO-A and SO-B work independently if both happen
  //    to need the fix.
  const bySource = new Map<string, SplitCandidatePo[]>();
  for (const p of candidates) {
    const sourceId = p.salesOrderId ?? p.consignmentOrderId ?? "";
    if (!sourceId) continue; // Orphan PO — skip; nothing to re-cascade.
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId)!.push(p);
  }

  type Plan = {
    sourceType: "SO" | "CO";
    sourceId: string;
    sourceNumber: string | null;
    affectedPoNos: string[];
    skipReason?: string;
  };
  const plans: Plan[] = [];

  for (const [sourceId, pos] of bySource.entries()) {
    const sourceType: "SO" | "CO" = pos[0].salesOrderId ? "SO" : "CO";
    const sourceNumber = pos[0].poNo.replace(/-\d+$/, "");

    // Pre-flight A: all POs of this SO must be PENDING. Any IN_PROGRESS /
    // COMPLETED / CANCELLED row means hand-edits or partial work — skip.
    const allPosForSource = await db
      .prepare(
        `SELECT id, status FROM production_orders
          WHERE ${sourceType === "SO" ? "salesOrderId" : "consignmentOrderId"} = ?`,
      )
      .bind(sourceId)
      .all<{ id: string; status: string }>();
    const allPos = allPosForSource.results ?? [];
    const nonPending = allPos.filter((p) => p.status !== "PENDING");
    if (nonPending.length > 0) {
      plans.push({
        sourceType,
        sourceId,
        sourceNumber,
        affectedPoNos: pos.map((p) => p.poNo),
        skipReason: `${nonPending.length} non-PENDING PO(s) on this order — skipping to preserve in-flight work`,
      });
      continue;
    }
    const allPoIds = allPos.map((p) => p.id);
    const placeholders = allPoIds.map(() => "?").join(", ");

    // Pre-flight B: no JC has been scanned (pic1Id or pic2Id set).
    if (allPoIds.length > 0) {
      const scannedRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM job_cards
            WHERE productionOrderId IN (${placeholders})
              AND (pic1Id IS NOT NULL OR pic2Id IS NOT NULL)`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((scannedRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${scannedRes?.n} job card(s) already scanned — pic data would be lost`,
        });
        continue;
      }
    }

    // Pre-flight C: no cost_ledger entry references any of these POs.
    if (allPoIds.length > 0) {
      const ledgerRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM cost_ledger
            WHERE refType = 'PRODUCTION_ORDER'
              AND refId IN (${placeholders})`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((ledgerRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${ledgerRes?.n} cost_ledger entries reference these POs — refusing to delete`,
        });
        continue;
      }
    }

    // Pre-flight D: every fg_unit on these POs must still be PENDING.
    // fg_units rows are stubbed at PO-fan-out time (one per piece) so any
    // PO will have rows; only PENDING means no physical FG exists yet.
    // PACKED / LOADED / DELIVERED / RETURNED / UPHOLSTERED means real-world
    // work the operator should not lose. fg_scan_history CASCADEs on
    // fg_unit_id so deleting PENDING fg_units cleans its history too.
    if (allPoIds.length > 0) {
      const fguRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM fg_units
            WHERE po_id IN (${placeholders}) AND status <> 'PENDING'`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((fguRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${fguRes?.n} fg_unit(s) past PENDING — refusing to delete (real FG exists)`,
        });
        continue;
      }
    }

    // Pre-flight E: no fg_batches row points at these POs. Only created
    // on PO completion which the PENDING guard above already excludes,
    // but a stray row would FK-block the DELETE.
    if (allPoIds.length > 0) {
      const fgbRes = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM fg_batches
            WHERE production_order_id IN (${placeholders})`,
        )
        .bind(...allPoIds)
        .first<{ n: number }>();
      if ((fgbRes?.n ?? 0) > 0) {
        plans.push({
          sourceType,
          sourceId,
          sourceNumber,
          affectedPoNos: pos.map((p) => p.poNo),
          skipReason: `${fgbRes?.n} fg_batches row(s) reference these POs — refusing to delete`,
        });
        continue;
      }
    }

    plans.push({
      sourceType,
      sourceId,
      sourceNumber,
      affectedPoNos: pos.map((p) => p.poNo),
    });
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatePoCount: candidates.length,
      affectedSourceCount: bySource.size,
      plans,
    });
  }

  // Execute. Per-source rebuild: hard-delete all POs (cascade kills JCs +
  // piece_pics), then call createProductionOrdersForOrder which fans out
  // fresh POs through the modern split path.
  const executed: Array<{
    sourceId: string;
    sourceNumber: string | null;
    deletedPoCount: number;
    createdPoNos: string[];
  }> = [];
  const skipped: Plan[] = [];

  for (const plan of plans) {
    if (plan.skipReason) {
      skipped.push(plan);
      continue;
    }
    if (plan.sourceType !== "SO") {
      skipped.push({ ...plan, skipReason: "CO re-cascade not implemented in this backfill" });
      continue;
    }

    // Re-load SO header + items.
    const so = await db
      .prepare(`SELECT * FROM sales_orders WHERE id = ?`)
      .bind(plan.sourceId)
      .first<{
        id: string;
        companySOId: string | null;
        companySODate: string | null;
        customerPOId: string | null;
        reference: string | null;
        customerName: string;
        customerState: string | null;
        hookkaExpectedDD: string | null;
        customerDeliveryDate: string | null;
      }>();
    if (!so) {
      skipped.push({ ...plan, skipReason: "Source SO not found" });
      continue;
    }
    const itemsRes = await db
      .prepare(`SELECT * FROM sales_order_items WHERE salesOrderId = ?`)
      .bind(plan.sourceId)
      .all<{
        lineNo: number;
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
      }>();
    const items = itemsRes.results ?? [];
    if (items.length === 0) {
      skipped.push({ ...plan, skipReason: "Source SO has no items" });
      continue;
    }

    // Re-run cascade FIRST (it does pure reads + builds statements). We then
    // run DELETE + the cascade INSERTs together in one batch so a partial
    // failure can't leave the SO with deleted POs and no replacements.
    // forceRebuild=true so the builder doesn't bail on the about-to-be-
    // deleted POs; deterministic poIds (pord-{soId}-NN) collide with the
    // existing rows but the DELETE in the same batch frees them first.
    const built = await createProductionOrdersForOrder(
      db,
      {
        id: so.id,
        sourceType: "SO",
        companyOrderId: so.companySOId ?? "",
        companyOrderDate: so.companySODate,
        customerPOId: so.customerPOId,
        reference: so.reference,
        customerName: so.customerName,
        customerState: so.customerState,
        hookkaExpectedDD: so.hookkaExpectedDD,
        customerDeliveryDate: so.customerDeliveryDate,
      },
      items.map((it) => ({
        lineNo: it.lineNo,
        productId: it.productId,
        productCode: it.productCode,
        productName: it.productName,
        itemCategory: it.itemCategory,
        sizeCode: it.sizeCode,
        sizeLabel: it.sizeLabel,
        fabricCode: it.fabricCode,
        quantity: it.quantity,
        gapInches: it.gapInches,
        divanHeightInches: it.divanHeightInches,
        legHeightInches: it.legHeightInches,
        specialOrder: it.specialOrder,
        notes: it.notes,
      })),
      { forceRebuild: true },
    );
    // Delete order matters: fg_units → production_orders. fg_units.po_id is
    // a NOT-NULL FK with no CASCADE, so it has to come out first or the
    // PO DELETE FK-fails. fg_scan_history CASCADEs on fg_unit_id and
    // job_cards CASCADE on productionOrderId (piece_pics in turn CASCADE
    // on jobCardId), so those subtrees clean up by themselves.
    const deleteFgUnitsStmt = db
      .prepare(
        `DELETE FROM fg_units WHERE po_id IN (
           SELECT id FROM production_orders WHERE salesOrderId = ?)`,
      )
      .bind(plan.sourceId);
    const deletePosStmt = db
      .prepare(`DELETE FROM production_orders WHERE salesOrderId = ?`)
      .bind(plan.sourceId);
    await db.batch([deleteFgUnitsStmt, deletePosStmt, ...built.statements]);

    executed.push({
      sourceId: plan.sourceId,
      sourceNumber: plan.sourceNumber,
      deletedPoCount: plan.affectedPoNos.length,
      createdPoNos: built.created.map((c) => c.poNo),
    });
  }

  return c.json({
    success: true,
    dryRun: false,
    candidatePoCount: candidates.length,
    affectedSourceCount: bySource.size,
    executedCount: executed.length,
    skippedCount: skipped.length,
    executed,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/queen-price-correction-rm5?dryRun=true|false
//
// One-shot price correction for Queen Size BEDFRAMEs. Wei Siang flagged that
// the 4/26 surcharge across all Queen SKUs was applied at +RM30 instead of
// the intended +RM25 — every Queen master + customer override row needs to
// drop by RM5 (500 sen). NOT idempotent: each run subtracts another 500.
// dryRun=true returns the row counts without writing.
//
// Scope:
//   1. product_prices rows where productId is Queen BEDFRAME AND effective_from
//      = '2026-04-26' AND base_price_sen IS NOT NULL  → -500 sen each.
//   2. customer_product_prices rows that are the CURRENTLY-ACTIVE row for any
//      (customer, Queen product) pair — pick the newest row per cp where
//      effective_from <= today AND base_price_sen IS NOT NULL → -500 sen.
//
// Customers whose active cp row has base_price_sen = NULL inherit from
// master; the master edit propagates automatically — no cp edit needed.
//
// Migration-temp. Delete this endpoint once the correction is live + verified.
// ---------------------------------------------------------------------------
app.post("/queen-price-correction-rm5", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);

  // 1. Queen-class BEDFRAME product ids. The "Queen" cohort isn't just
  // sizeCode='Q' — three other sizeCodes are functionally Queen too
  // (variants on 152CM / 153CM width that the catalog tracks separately):
  //   Q       → 5FT canonical Queen        (32 SKUs)
  //   152X200 → 152CMX200CM                ( 3 SKUs)
  //   153X200 → 153CMX200CM                ( 1 SKU)
  //   153     → 153CMX210CM (e.g. DIVAN)   ( 1 SKU)
  // → 37 total. Wei Siang flagged 2026-05-05 that all four buckets had
  // the same +RM30 surcharge applied 4/26 and need the same -RM5 fix.
  const queenRes = await db
    .prepare(
      `SELECT id, code FROM products
        WHERE category = 'BEDFRAME'
          AND sizeCode IN ('Q', '152X200', '153X200', '153')`,
    )
    .all<{ id: string; code: string }>();
  const queen = queenRes.results ?? [];
  if (queen.length === 0) {
    return c.json(
      { success: false, error: "No Queen BEDFRAME products found" },
      404,
    );
  }
  const queenIds = queen.map((p) => p.id);
  const placeholders = queenIds.map(() => "?").join(",");

  // 2. Master product_prices rows at 4/26 with concrete prices.
  const masterRowsRes = await db
    .prepare(
      `SELECT id, productId, basePriceSen, effectiveFrom
         FROM product_prices
        WHERE productId IN (${placeholders})
          AND effectiveFrom = '2026-04-26'
          AND basePriceSen IS NOT NULL`,
    )
    .bind(...queenIds)
    .all<{
      id: string;
      productId: string;
      basePriceSen: number;
      effectiveFrom: string;
    }>();
  const masterRows = (masterRowsRes.results ?? []).filter(
    (r) => typeof r.basePriceSen === "number",
  );

  // 3. All customer_product Queen assignments.
  const cpRes = await db
    .prepare(
      `SELECT id, customerId, productId
         FROM customer_products
        WHERE productId IN (${placeholders})`,
    )
    .bind(...queenIds)
    .all<{ id: string; customerId: string; productId: string }>();
  const cps = cpRes.results ?? [];

  // 4. For each cp, fetch the currently-active price row with concrete price.
  //    Sequential awaits (not Promise.all) to keep memory + connection usage
  //    bounded; ~88 rows is well within the request budget.
  const cpRowsToUpdate: Array<{
    rowId: string;
    cpId: string;
    customerId: string;
    productId: string;
    oldBaseSen: number;
    newBaseSen: number;
    effectiveFrom: string;
  }> = [];
  for (const cp of cps) {
    const active = await db
      .prepare(
        `SELECT id, basePriceSen, effectiveFrom
           FROM customer_product_prices
          WHERE customerProductId = ?
            AND effectiveFrom <= ?
            AND basePriceSen IS NOT NULL
          ORDER BY effectiveFrom DESC
          LIMIT 1`,
      )
      .bind(cp.id, today)
      .first<{ id: string; basePriceSen: number; effectiveFrom: string }>();
    if (active && typeof active.basePriceSen === "number") {
      cpRowsToUpdate.push({
        rowId: active.id,
        cpId: cp.id,
        customerId: cp.customerId,
        productId: cp.productId,
        oldBaseSen: active.basePriceSen,
        newBaseSen: active.basePriceSen - 500,
        effectiveFrom: active.effectiveFrom,
      });
    }
  }

  // Date histogram for the customer side — confirms the (4/26 + 4/01)
  // distribution the planner expected before going live.
  const cpDateBuckets: Record<string, number> = {};
  for (const r of cpRowsToUpdate) {
    cpDateBuckets[r.effectiveFrom] = (cpDateBuckets[r.effectiveFrom] ?? 0) + 1;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      queenProductCount: queen.length,
      masterRowsToUpdate: masterRows.length,
      customerRowsToUpdate: cpRowsToUpdate.length,
      customerRowsByEffectiveFrom: cpDateBuckets,
      sampleMaster: masterRows.slice(0, 3).map((r) => ({
        rowId: r.id,
        productId: r.productId,
        oldRM: r.basePriceSen / 100,
        newRM: (r.basePriceSen - 500) / 100,
      })),
      sampleCustomer: cpRowsToUpdate.slice(0, 5).map((r) => ({
        rowId: r.rowId,
        customerId: r.customerId,
        productId: r.productId,
        effectiveFrom: r.effectiveFrom,
        oldRM: r.oldBaseSen / 100,
        newRM: r.newBaseSen / 100,
      })),
    });
  }

  // 5. Apply. Batched to keep round-trip count down.
  const masterStmts = masterRows.map((r) =>
    db
      .prepare(`UPDATE product_prices SET basePriceSen = ? WHERE id = ?`)
      .bind(r.basePriceSen - 500, r.id),
  );
  const custStmts = cpRowsToUpdate.map((r) =>
    db
      .prepare(`UPDATE customer_product_prices SET basePriceSen = ? WHERE id = ?`)
      .bind(r.newBaseSen, r.rowId),
  );
  let masterUpdated = 0;
  for (let i = 0; i < masterStmts.length; i += 50) {
    await db.batch(masterStmts.slice(i, i + 50));
    masterUpdated += Math.min(50, masterStmts.length - i);
  }
  let custUpdated = 0;
  for (let i = 0; i < custStmts.length; i += 50) {
    await db.batch(custStmts.slice(i, i + 50));
    custUpdated += Math.min(50, custStmts.length - i);
  }

  return c.json({
    success: true,
    dryRun: false,
    masterUpdated,
    customerUpdated: custUpdated,
    customerRowsByEffectiveFrom: cpDateBuckets,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/cancel-leaked-co-pos?dryRun=true|false
//
// Backfill for the CO-cancel cascade gap (Wei Siang, 2026-05-05): every
// production_order whose parent consignment_order is CANCELLED but whose
// own status is still active (anything other than COMPLETED / CANCELLED)
// gets flipped to CANCELLED. Non-terminal job_cards under those POs also
// flip to CANCELLED so the production page stops surfacing them.
//
// Idempotent — re-running it after the first pass returns 0/0.
// Migration-temp. Safe to delete once the leak is verified clean.
// ---------------------------------------------------------------------------
app.post("/cancel-leaked-co-pos", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const now = new Date().toISOString();

  // POs whose parent CO is CANCELLED but they themselves aren't.
  const leakRes = await db
    .prepare(
      `SELECT po.id AS poId, po.poNo, po.status AS "poStatus",
              co.id AS "coId", co.companyCOId, co.status AS "coStatus"
         FROM production_orders po
         JOIN consignment_orders co ON co.id = po.consignmentOrderId
        WHERE co.status = 'CANCELLED'
          AND po.status NOT IN ('COMPLETED', 'CANCELLED')`,
    )
    .all<{
      poId: string;
      poNo: string;
      poStatus: string;
      coId: string;
      companyCOId: string;
      coStatus: string;
    }>();
  const leaks = leakRes.results ?? [];

  // Non-terminal job_cards under those POs.
  let jcLeakCount = 0;
  let jcSample: Array<{ id: string; departmentCode: string | null }> = [];
  if (leaks.length > 0) {
    const poIds = leaks.map((l) => l.poId);
    const placeholders = poIds.map(() => "?").join(", ");
    const jcRes = await db
      .prepare(
        `SELECT id, departmentCode FROM job_cards
           WHERE productionOrderId IN (${placeholders})
             AND status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`,
      )
      .bind(...poIds)
      .all<{ id: string; departmentCode: string | null }>();
    jcLeakCount = (jcRes.results ?? []).length;
    jcSample = (jcRes.results ?? []).slice(0, 5);

    if (!dryRun) {
      const stmts: ReturnType<D1Database["prepare"]>[] = [];
      for (const l of leaks) {
        stmts.push(
          db
            .prepare(
              "UPDATE production_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
            )
            .bind(now, l.poId),
        );
      }
      for (const jc of jcRes.results ?? []) {
        stmts.push(
          db
            .prepare(
              "UPDATE job_cards SET status = 'CANCELLED' WHERE id = ?",
            )
            .bind(jc.id),
        );
      }
      // Batch in chunks of 50 to stay well under D1's per-batch budget.
      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50));
      }
    }
  }

  return c.json({
    success: true,
    dryRun,
    leakedPoCount: leaks.length,
    leakedJobCardCount: jcLeakCount,
    leaks: leaks.map((l) => ({
      poNo: l.poNo,
      poStatus: l.poStatus,
      companyCOId: l.companyCOId,
    })),
    sampleJobCards: jcSample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/apply-houzs-sofa-pricesheet?dryRun=true|false&scope=master|houzs|both
//
// One-shot: applies the Dorsettloft 4/01 price sheet (Houzs HOK code mapping)
// to our 7 SOFA base models' compartment-level prices. Both PRICE_2 (Fabric
// B&C) and PRICE_3 (Fabric A) tiers are written into seatHeightPrices with
// per-entry tier markers, plus basePriceSen mirrors the smallest-height
// PRICE_2 value. The 4/01 row is edited in place (matches Wei Siang's prior
// preference on the Queen-bedframe correction); when no 4/01 row exists for
// a (product,scope) pair, a new row is inserted.
//
// Mapping rules (all confirmed with Wei Siang 2026-05-05):
//   • 5530/5535       → DSL 9028
//   • 5531/5539       → DSL 9028 × 0.945, Math.round (Houzs %5.5 discount tier)
//   • 5536            → DSL 9058 (with special-cases below)
//   • 5537/5540       → DSL 8030
// Variant translator (our → sheet):
//   1A → 1R, 2A → 2R, 1S/2S/3S → "1/2/3 SEATER", CNR → CORNER, others same.
// 3S prefers the "(2 + 1)" / "(2+1)" split version over "(no split)".
// 32"/35" fallback when target DSL lacks the cell:
//   use 8030 same-variant price minus (backrest_count × 50), where
//   backrests = {1S/1A/1R/1NA:1, 2S/2A/2R/2NA:2, 3S:3, L:1, CORNER:1, STOOL:0}.
// Special overrides:
//   • 5530/5535/5536 CNR @ 32"/35" → borrow that DSL's CORNER@30 value
//     (no fallback to 8030 — 8030 has no CORNER row).
//   • 5537/5540 CNR @ all heights  → 5530 CORNER (9028) + RM 50, BC and A.
//   • 5536 STOOL  @ all heights    → flat RM 550 (current — 9058 has no STOOL,
//     9028 STOOL only at 22/26/28; user opted to keep current rather than
//     fall back).
//   • 5536 CSL                     → untouched (no source anywhere in sheet).
// ---------------------------------------------------------------------------
const SOFA_PRICESHEET = {
  "8030": {
    "1 SEATER":            { 24:[874,920], 25:[874,920], 26:[874,920], 27:[874,920], 28:[874,920], 30:[920,966], 32:[1150,1196], 35:[1150,1196] },
    "2 SEATER (no split)": { 24:[1254,1320], 25:[1254,1320], 26:[1254,1320], 27:[1254,1320], 28:[1254,1320], 30:[1320,1386], 32:[1650,1716], 35:[1650,1716] },
    "3 SEATER (no split)": { 24:[1672,1760], 25:[1672,1760], 26:[1672,1760], 27:[1672,1760], 28:[1672,1760], 30:[1760,1848] },
    "3 SEATER (2+1)":      { 24:[1752,1840], 25:[1752,1840], 26:[1752,1840], 27:[1752,1840], 28:[1752,1840] },
    "3 SEATER (2 + 1)":    { 32:[2280,2368], 35:[2280,2368] },
    "STOOL":               { 24:[500,520], 25:[500,520], 26:[500,520], 27:[500,520], 28:[500,520], 30:[500,520], 32:[600,620], 35:[600,620] },
    "1NA":                 { 24:[550,590], 25:[550,590], 26:[550,590], 27:[550,590], 28:[550,590], 30:[550,590], 32:[760,800], 35:[760,800] },
    "1R":                  { 24:[700,750], 25:[700,750], 26:[700,750], 27:[700,750], 28:[700,750], 30:[700,750], 32:[910,960], 35:[910,960] },
    "2NA":                 { 24:[1100,1180], 25:[1100,1180], 26:[1100,1180], 27:[1100,1180], 28:[1100,1180], 30:[1100,1180], 32:[1520,1600], 35:[1520,1600] },
    "2R":                  { 24:[1250,1340], 25:[1250,1340], 26:[1250,1340], 27:[1250,1340], 28:[1250,1340], 30:[1250,1340], 32:[1670,1760], 35:[1670,1760] },
    "L":                   { 24:[1000,1050], 25:[1000,1050], 26:[1000,1050], 27:[1000,1050], 28:[1000,1050], 30:[1050,1100], 32:[1060,1110], 35:[1060,1110] },
  },
  "9028": {
    "1 SEATER":            { 22:[805,851], 24:[805,851], 26:[874,920], 28:[874,920], 30:[920,966], 32:[966,1012], 35:[1012,1058] },
    "2 SEATER":            { 22:[1155,1221], 24:[1155,1221], 26:[1254,1320], 28:[1254,1320], 30:[1320,1386], 32:[1386,1452], 35:[1452,1518] },
    "3 SEATER":            { 22:[1540,1628], 24:[1540,1628], 26:[1672,1760], 28:[1672,1760], 30:[1760,1848], 32:[1848,1936], 35:[1936,2024] },
    "3 SEATER (2+1)":      { 22:[1771,1859], 24:[1620,1708], 26:[1752,1840], 28:[1752,1840], 30:[1840,1928], 32:[1928,2016], 35:[2016,2104] },
    "L":                   { 22:[1050,1100], 24:[1050,1100], 26:[1100,1150], 28:[1100,1150], 30:[1160,1210], 32:[1200,1250] },
    "1NA":                 { 22:[500,540], 24:[500,540], 26:[550,590], 28:[550,590], 30:[550,590], 32:[600,640] },
    "1R":                  { 22:[650,700], 24:[650,700], 26:[700,750], 28:[700,740], 30:[700,750], 32:[750,800] },
    "2NA":                 { 22:[1000,1080], 24:[1000,1080], 26:[1100,1180], 28:[1100,1180], 30:[1100,1180], 32:[1200,1280] },
    "2R":                  { 22:[1150,1240], 24:[1150,1240], 26:[1250,1340], 28:[1250,1340], 30:[1250,1340], 32:[1350,1440] },
    "CORNER":              { 22:[900,960], 24:[900,960], 26:[900,960], 28:[900,960], 30:[900,960] },
    "STOOL":               { 22:[500,520], 26:[500,520], 28:[500,520] },
  },
  "9058": {
    "1 SEATER":            { 24:[782,828], 26:[828,874], 28:[828,874], 30:[828,874] },
    "2 SEATER":            { 24:[1122,1188], 26:[1188,1254], 28:[1188,1254], 30:[1188,1254] },
    "3 SEATER":            { 24:[1496,1584], 26:[1584,1672], 28:[1584,1672], 30:[1584,1672] },
    "3 SEATER (2+1)":      { 24:[1576,1664], 26:[1664,1752], 28:[1664,1752], 30:[1664,1752] },
    "L":                   { 24:[1050,1100], 26:[1100,1150], 28:[1100,1150], 30:[1100,1150] },
    "1NA":                 { 24:[550,590], 26:[550,590], 28:[550,590], 30:[550,590] },
    "1R":                  { 24:[700,750], 26:[700,750], 28:[700,750], 30:[700,750] },
    "2NA":                 { 24:[1100,1180], 26:[1100,1180], 28:[1100,1180], 30:[1100,1180] },
    "2R":                  { 24:[1250,1340], 26:[1250,1340], 28:[1250,1340], 30:[1250,1340] },
    "CORNER":              { 24:[900,960], 26:[900,960], 28:[900,960], 30:[900,960], 32:[900,960] },
  },
} as const;
type SheetCell = readonly [number, number]; // [BC_RM, A_RM]
type SheetTbl = Record<string, Record<string, Record<number, readonly [number, number]>>>;

const MODEL_MAP_HOUZS: Record<string, { dsl: "9028" | "9058" | "8030"; mult: number }> = {
  "5530": { dsl: "9028", mult: 1 },
  "5531": { dsl: "9028", mult: 0.945 },
  "5535": { dsl: "9028", mult: 1 },
  "5536": { dsl: "9058", mult: 1 },
  "5537": { dsl: "8030", mult: 1 },
  "5539": { dsl: "9028", mult: 0.945 },
  "5540": { dsl: "8030", mult: 1 },
};
const BACKREST_COUNT: Record<string, number> = {
  "1S": 1, "1A": 1, "1R": 1, "1NA": 1,
  "2S": 2, "2A": 2, "2R": 2, "2NA": 2,
  "3S": 3,
  "L": 1, "CORNER": 1, "CNR": 1,
  "STOOL": 0,
};

function ourVariantToSheetVariant(sizeCode: string): string {
  const v = sizeCode.trim().toUpperCase().replace(/\s*\(.*\)\s*/g, "");
  const map: Record<string, string> = {
    "1A": "1R", "2A": "2R",
    "1S": "1 SEATER", "2S": "2 SEATER", "3S": "3 SEATER",
    "CNR": "CORNER",
  };
  return map[v] ?? v;
}
function backrestKeyOf(sizeCode: string): string {
  return sizeCode.trim().toUpperCase().replace(/\s*\(.*\)\s*/g, "");
}
function lookupSheetCell(
  dsl: "8030" | "9028" | "9058",
  sheetVariant: string,
  height: number,
): SheetCell | null {
  // 3S → prefer (2+1) split forms first, then (no split) / plain
  const candidates: string[] = [];
  if (sheetVariant === "3 SEATER") {
    candidates.push("3 SEATER (2 + 1)", "3 SEATER (2+1)", "3 SEATER (no split)", "3 SEATER");
  } else if (sheetVariant === "2 SEATER") {
    candidates.push("2 SEATER", "2 SEATER (no split)");
  } else {
    candidates.push(sheetVariant);
  }
  const tbl = SOFA_PRICESHEET as unknown as SheetTbl;
  for (const cv of candidates) {
    const t = tbl[dsl]?.[cv];
    if (t && t[height]) return t[height];
  }
  return null;
}
function priceFor(
  baseModel: string,
  sizeCode: string,
  height: number,
): SheetCell | null {
  // CSL: skip — no source anywhere.
  if (sizeCode.startsWith("CSL")) return null;

  const mm = MODEL_MAP_HOUZS[baseModel];
  if (!mm) return null;
  const sv = ourVariantToSheetVariant(sizeCode);
  const bk = backrestKeyOf(sizeCode);

  // 5536 STOOL: 9058 has no STOOL row, but Wei Siang opted to follow 9028's
  // STOOL prices (incl. Fabric A). Override the DSL lookup to 9028 for this
  // specific (model, variant) — every other rule (32/35 fallback to 8030,
  // mult, etc.) applies normally.
  let dslForLookup: "8030" | "9028" | "9058" = mm.dsl;
  if (baseModel === "5536" && bk === "STOOL") dslForLookup = "9028";

  // Special: 5537 / 5540 CNR → 5530 CORNER (9028) + RM 50 across all heights
  if ((baseModel === "5537" || baseModel === "5540") && bk === "CNR") {
    const corner = lookupSheetCell("9028", "CORNER", height)
      ?? lookupSheetCell("9028", "CORNER", 30); // 32/35 borrow 30
    if (!corner) return null;
    return [corner[0] + 50, corner[1] + 50];
  }

  // Special: 5530/5535/5536 CNR @ 32/35 → borrow this DSL's CORNER@30
  if (bk === "CNR" && (height === 32 || height === 35)) {
    const corner30 = lookupSheetCell(mm.dsl, "CORNER", 30);
    if (!corner30) return null;
    return [
      Math.round(corner30[0] * mm.mult),
      Math.round(corner30[1] * mm.mult),
    ];
  }

  // Standard sheet lookup
  let cell = lookupSheetCell(dslForLookup, sv, height);
  if (cell) {
    return [Math.round(cell[0] * mm.mult), Math.round(cell[1] * mm.mult)];
  }

  // 32/35 fallback: 8030 - (backrests × 50)
  if (height === 32 || height === 35) {
    cell = lookupSheetCell("8030", sv, height);
    if (cell) {
      const backrests = BACKREST_COUNT[bk] ?? 0;
      const deduction = backrests * 50;
      return [
        Math.round((cell[0] - deduction) * mm.mult),
        Math.round((cell[1] - deduction) * mm.mult),
      ];
    }
  }

  return null;
}

const HEIGHTS_TO_FILL = [24, 28, 30, 32, 35];

app.post("/apply-houzs-sofa-pricesheet", async (c) => {
  const denied = await requirePermission(c, "products", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const scope = (c.req.query("scope") || "both").toLowerCase(); // master | houzs | both
  const effectiveFrom = "2026-04-01";

  const targetBases = Object.keys(MODEL_MAP_HOUZS);
  const placeholders = targetBases.map(() => "?").join(",");
  const prodRes = await db
    .prepare(
      `SELECT id, code, baseModel, sizeCode, basePriceSen, seatHeightPrices
         FROM products
        WHERE category = 'SOFA' AND baseModel IN (${placeholders})`,
    )
    .bind(...targetBases)
    .all<{
      id: string; code: string; baseModel: string; sizeCode: string;
      basePriceSen: number | null; seatHeightPrices: string | null;
    }>();
  const prods = prodRes.results ?? [];

  // Compute new seatHeightPrices array per product. For each height, push two
  // entries (PRICE_2 BC + PRICE_3 A). Drop the height entirely when priceFor
  // returns null (per "missing → blank" rule). basePriceSen = smallest-height
  // PRICE_2 value, or null when nothing fills.
  type PerProductPlan = {
    id: string;
    code: string;
    baseModel: string;
    sizeCode: string;
    skipped: boolean;
    skipReason?: string;
    newBasePriceSen: number | null;
    newSeatHeightPrices: Array<{ height: string; priceSen: number; tier: "PRICE_2" | "PRICE_3" }>;
    cellsFilled: number;
    cellsBlank: number;
  };
  const plans: PerProductPlan[] = [];
  for (const p of prods) {
    if (p.sizeCode.startsWith("CSL")) {
      plans.push({ id: p.id, code: p.code, baseModel: p.baseModel, sizeCode: p.sizeCode,
        skipped: true, skipReason: "CSL — no sheet source",
        newBasePriceSen: p.basePriceSen, newSeatHeightPrices: [], cellsFilled: 0, cellsBlank: 0 });
      continue;
    }
    const newSeats: Array<{ height: string; priceSen: number; tier: "PRICE_2" | "PRICE_3" }> = [];
    let cellsFilled = 0, cellsBlank = 0;
    let smallestBC: number | null = null;
    for (const h of HEIGHTS_TO_FILL) {
      const cell = priceFor(p.baseModel, p.sizeCode, h);
      if (!cell) { cellsBlank++; continue; }
      cellsFilled++;
      newSeats.push({ height: String(h), priceSen: cell[0] * 100, tier: "PRICE_2" });
      newSeats.push({ height: String(h), priceSen: cell[1] * 100, tier: "PRICE_3" });
      if (smallestBC === null) smallestBC = cell[0] * 100;
    }
    plans.push({ id: p.id, code: p.code, baseModel: p.baseModel, sizeCode: p.sizeCode,
      skipped: false, newBasePriceSen: smallestBC, newSeatHeightPrices: newSeats,
      cellsFilled, cellsBlank });
  }

  const summary = {
    productsTotal: prods.length,
    productsSkipped: plans.filter(p => p.skipped).length,
    productsToWrite: plans.filter(p => !p.skipped).length,
    productsFullyBlank: plans.filter(p => !p.skipped && p.cellsFilled === 0).map(p => p.code),
    cellsFilled: plans.reduce((s, p) => s + p.cellsFilled, 0),
    cellsBlank: plans.reduce((s, p) => s + p.cellsBlank, 0),
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, scope, effectiveFrom,
      summary,
      sample: plans.filter(p => !p.skipped).slice(0, 3).map(p => ({
        code: p.code,
        newBasePriceRM: p.newBasePriceSen ? p.newBasePriceSen / 100 : null,
        newSeatHeightPrices: p.newSeatHeightPrices.map(s => ({
          h: s.height, t: s.tier, RM: s.priceSen / 100,
        })),
      })),
    });
  }

  // Live execute. For each product:
  //   - if scope includes master: upsert product_prices @ 4/01
  //   - if scope includes houzs:  upsert customer_product_prices @ 4/01
  //     (lookup customer_products row by (customerId='cust-1', productId))
  let masterRowsWritten = 0, houzsRowsWritten = 0, houzsSkipped = 0;
  for (const plan of plans) {
    if (plan.skipped) continue;
    const seatJson = JSON.stringify(plan.newSeatHeightPrices);

    if (scope === "master" || scope === "both") {
      const existing = await db
        .prepare(
          `SELECT id FROM product_prices
            WHERE productId = ? AND effectiveFrom = ?`,
        )
        .bind(plan.id, effectiveFrom)
        .first<{ id: string }>();
      if (existing) {
        await db
          .prepare(
            `UPDATE product_prices
                SET basePriceSen = ?, seatHeightPrices = ?
              WHERE id = ?`,
          )
          .bind(plan.newBasePriceSen, seatJson, existing.id)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO product_prices
               (id, productId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
          )
          .bind(
            `pp-${crypto.randomUUID().slice(0, 12)}`,
            plan.id, plan.newBasePriceSen, seatJson, effectiveFrom,
            "Houzs price-sheet apply (Wei Siang 2026-05-05)",
          )
          .run();
      }
      masterRowsWritten++;
    }

    if (scope === "houzs" || scope === "both") {
      const cp = await db
        .prepare(
          `SELECT id FROM customer_products
            WHERE customerId = 'cust-1' AND productId = ?`,
        )
        .bind(plan.id)
        .first<{ id: string }>();
      if (!cp) { houzsSkipped++; continue; }
      const existing = await db
        .prepare(
          `SELECT id FROM customer_product_prices
            WHERE customerProductId = ? AND effectiveFrom = ?`,
        )
        .bind(cp.id, effectiveFrom)
        .first<{ id: string }>();
      if (existing) {
        await db
          .prepare(
            `UPDATE customer_product_prices
                SET basePriceSen = ?, seatHeightPrices = ?
              WHERE id = ?`,
          )
          .bind(plan.newBasePriceSen, seatJson, existing.id)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO customer_product_prices
               (id, customerProductId, basePriceSen, price1Sen, seatHeightPrices,
                effectiveFrom, notes, createdBy)
             VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
          )
          .bind(
            `cpp-${crypto.randomUUID().slice(0, 12)}`,
            cp.id, plan.newBasePriceSen, seatJson, effectiveFrom,
            "Houzs price-sheet apply (Wei Siang 2026-05-05)",
          )
          .run();
      }
      // Also keep the cp row's legacy basePriceSen mirror in sync — readers
      // that ignore history fall back to it. Same value as the smallest-height
      // PRICE_2.
      await db
        .prepare(
          `UPDATE customer_products
              SET basePriceSen = ?, seatHeightPrices = ?
            WHERE id = ?`,
        )
        .bind(plan.newBasePriceSen, seatJson, cp.id)
        .run();
      houzsRowsWritten++;
    }
  }
  // Mirror smallest-height PRICE_2 onto the products table itself for legacy
  // readers (cost ledger derives from it via `products.basePriceSen` when
  // history isn't queried).
  if (scope === "master" || scope === "both") {
    for (const plan of plans) {
      if (plan.skipped) continue;
      await db
        .prepare(
          `UPDATE products
              SET basePriceSen = ?, seatHeightPrices = ?
            WHERE id = ?`,
        )
        .bind(plan.newBasePriceSen, JSON.stringify(plan.newSeatHeightPrices), plan.id)
        .run();
    }
  }

  return c.json({
    success: true, dryRun: false, scope, effectiveFrom,
    summary, masterRowsWritten, houzsRowsWritten, houzsSkipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/recompute-so-sofa-prices?dryRun=true|false&statuses=...
//
// Bulk recompute of basePriceSen / unitPriceSen / lineTotalSen on every SOFA
// line item in active sales_orders. Wei Siang fixed master + Houzs cascade
// 2026-05-05 and now wants those numbers to flow into open SOs.
//
// Per item:
//   1. Look up fabric_tracking.sofaPriceTier by fabric_code.
//   2. Pick the customer_product_prices row for (customerId, productId)
//      that's active as of the SO's companySODate (fall back to today, then
//      master if no customer override exists).
//   3. From seatHeightPrices, find { height: sizeCode, tier } match.
//   4. New basePriceSen = priceSen.
//   5. New unitPriceSen = base + legPriceSen + divanPriceSen + specialOrderPriceSen.
//   6. New lineTotalSen = unitPriceSen × quantity.
//
// Items that don't match the 7-model SOFA set are skipped silently.
// Items where fabric tier or seat-height entry can't be resolved get logged
// in the response but not changed. SO subtotal_sen + grand_total_sen are
// recomputed off the new line totals.
//
// Idempotent — running it twice produces the same result.
// ---------------------------------------------------------------------------
const SOFA_TARGET_BASES = ["5530","5531","5535","5536","5537","5539","5540"];
type SoiRow = {
  id: string;
  salesOrderId: string;
  productId: string | null;
  productCode: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string | null;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
};
type SoRow = {
  id: string;
  companySOId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: string | null;
  companySODate: string | null;
  createdAt: string | null;
};

app.post("/recompute-so-sofa-prices", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const statusFilter = (c.req.query("statuses") || "").trim()
    ? c.req.query("statuses")!.split(",").map(s => s.trim()).filter(Boolean)
    : ["IN_PRODUCTION", "READY_TO_SHIP", "CONFIRMED", "DRAFT"];
  const today = new Date().toISOString().slice(0, 10);

  // 1. Fabric → tier map. Table is `fabric_trackings` (plural) per
  //    routes/fabric-tracking.ts. Split tiers (sofa vs bedframe) live in
  //    sofaPriceTier / bedframePriceTier; legacy priceTier is the fallback.
  const ftRes = await db
    .prepare(
      `SELECT fabricCode, sofaPriceTier, bedframePriceTier, priceTier
         FROM fabric_trackings`,
    )
    .all<{
      fabricCode: string;
      sofaPriceTier: string | null;
      bedframePriceTier: string | null;
      priceTier: string | null;
    }>();
  const fabricSofaTierMap = new Map<string, string>();
  const fabricBedframeTierMap = new Map<string, string>();
  for (const r of (ftRes.results ?? [])) {
    fabricSofaTierMap.set(
      r.fabricCode,
      r.sofaPriceTier ?? r.priceTier ?? "PRICE_2",
    );
    fabricBedframeTierMap.set(
      r.fabricCode,
      r.bedframePriceTier ?? r.priceTier ?? "PRICE_2",
    );
  }

  // 2. Pull SOs in scope + their items (single broad fetch).
  const soPlaceholders = statusFilter.map(() => "?").join(",");
  const soRes = await db
    .prepare(
      `SELECT id, companySOId, customerId, customerName, status,
              companySODate, created_at AS createdAt
         FROM sales_orders
        WHERE status IN (${soPlaceholders})`,
    )
    .bind(...statusFilter)
    .all<SoRow>();
  const sos = soRes.results ?? [];
  if (sos.length === 0) {
    return c.json({ success: true, dryRun, scope: statusFilter, soCount: 0 });
  }
  const soIds = sos.map(s => s.id);
  const soById = new Map(sos.map(s => [s.id, s] as const));

  // 3. All SOFA + BEDFRAME + ACCESSORY line items for those SOs. SOFA uses
  //    the seatHeightPrices matrix keyed on (height, tier); BEDFRAME and
  //    ACCESSORY use the SKU-level basePriceSen directly (no matrix).
  const itemsRes = await db
    .prepare(
      `SELECT id, salesOrderId, productId, productCode, itemCategory, sizeCode,
              fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
              legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
              basePriceSen, unitPriceSen, lineTotalSen
         FROM sales_order_items
        WHERE itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
          AND salesOrderId IN (${soIds.map(() => "?").join(",")})`,
    )
    .bind(...soIds)
    .all<SoiRow>();
  const items = (itemsRes.results ?? []).filter((it) => {
    if (!it.productCode) return false;
    if (it.itemCategory === "SOFA") {
      return SOFA_TARGET_BASES.some((b) => it.productCode!.startsWith(b + "-"));
    }
    // BEDFRAME + ACCESSORY — accept all (no whitelist).
    return it.itemCategory === "BEDFRAME" || it.itemCategory === "ACCESSORY";
  });

  // 4. Pre-load customer_product_prices history for every (customerId,
  //    productId) combo touched by these items. Map → array of history rows.
  const cpKeys = Array.from(new Set(items.map((it) => {
    const so = soById.get(it.salesOrderId);
    if (!so?.customerId || !it.productId) return null;
    return `${so.customerId}|${it.productId}`;
  }).filter((k): k is string => k !== null)));
  const cpHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const k of cpKeys) {
    const [customerId, productId] = k.split("|");
    const cpRes = await db
      .prepare(
        `SELECT cpp.basePriceSen, cpp.seatHeightPrices, cpp.effectiveFrom
           FROM customer_products cp
           JOIN customer_product_prices cpp ON cpp.customerProductId = cp.id
          WHERE cp.customerId = ? AND cp.productId = ?
          ORDER BY cpp.effectiveFrom DESC`,
      )
      .bind(customerId, productId)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    cpHistMap.set(k, cpRes.results ?? []);
  }

  // 5. Pre-load master product_prices for products without customer overrides.
  const productIds = Array.from(new Set(items.map(it => it.productId).filter((p): p is string => !!p)));
  const masterHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const pid of productIds) {
    const mhRes = await db
      .prepare(
        `SELECT basePriceSen, seatHeightPrices, effectiveFrom
           FROM product_prices
          WHERE productId = ?
          ORDER BY effectiveFrom DESC`,
      )
      .bind(pid)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    masterHistMap.set(pid, mhRes.results ?? []);
  }

  type SeatHeightEntry = { height: string; priceSen: number; tier?: string };
  function pickActive(
    rows: Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>,
    asOf: string,
  ): { basePriceSen: number; entries: SeatHeightEntry[] } | null {
    const usable = rows
      .filter((r) => r.effectiveFrom <= asOf && r.basePriceSen != null)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const r = usable[0];
    if (!r) return null;
    let entries: SeatHeightEntry[] = [];
    try {
      entries = (JSON.parse(r.seatHeightPrices ?? "[]") || []) as SeatHeightEntry[];
    } catch { /* ignore */ }
    return { basePriceSen: r.basePriceSen!, entries };
  }
  function lookupSeatHeight(
    entries: SeatHeightEntry[], height: string, tier: string,
  ): number | null {
    // Exact (height, tier) match
    let m = entries.find(e => e.height === height && e.tier === tier);
    if (m) return m.priceSen;
    // Same height, tier missing → treat as PRICE_2 default
    if (tier === "PRICE_2") {
      m = entries.find(e => e.height === height && !e.tier);
      if (m) return m.priceSen;
    }
    // No height match
    return null;
  }

  type ChangePlan = {
    soId: string;
    companySOId: string | null;
    customerName: string | null;
    status: string | null;
    itemId: string;
    productCode: string | null;
    sizeCode: string | null;
    fabricCode: string | null;
    fabricTier: string | null;
    quantity: number;
    oldBaseRM: number;
    newBaseRM: number | null;
    oldUnitRM: number;
    newUnitRM: number | null;
    oldLineRM: number;
    newLineRM: number | null;
    skipReason?: string;
  };
  const plans: ChangePlan[] = [];
  for (const it of items) {
    const so = soById.get(it.salesOrderId)!;
    // Sofa + Accessory share sofaPriceTier; Bedframe uses bedframePriceTier.
    const tier = it.fabricCode
      ? (it.itemCategory === "BEDFRAME"
          ? fabricBedframeTierMap.get(it.fabricCode)
          : fabricSofaTierMap.get(it.fabricCode)) || "PRICE_2"
      : "PRICE_2";
    const asOf = (so.companySODate || so.createdAt || today).slice(0, 10);
    const cpKey = so.customerId && it.productId ? `${so.customerId}|${it.productId}` : null;
    const cpHist = cpKey ? cpHistMap.get(cpKey) ?? [] : [];
    const masterHist = it.productId ? masterHistMap.get(it.productId) ?? [] : [];
    const cpActive = cpHist.length ? pickActive(cpHist, asOf) : null;
    const masterActive = pickActive(masterHist, asOf);
    const active = cpActive ?? masterActive;
    const plan: ChangePlan = {
      soId: it.salesOrderId,
      companySOId: so.companySOId,
      customerName: so.customerName,
      status: so.status,
      itemId: it.id,
      productCode: it.productCode,
      sizeCode: it.sizeCode,
      fabricCode: it.fabricCode,
      fabricTier: tier,
      quantity: it.quantity,
      oldBaseRM: it.basePriceSen / 100,
      newBaseRM: null,
      oldUnitRM: it.unitPriceSen / 100,
      newUnitRM: null,
      oldLineRM: it.lineTotalSen / 100,
      newLineRM: null,
    };
    if (!active) { plan.skipReason = "no active price row (cust + master both missing)"; plans.push(plan); continue; }
    let priceSen: number | null = null;
    if (it.itemCategory === "SOFA") {
      // Sofa uses the per-(seatHeight, tier) matrix.
      if (!it.sizeCode) { plan.skipReason = "missing sizeCode (seat height)"; plans.push(plan); continue; }
      priceSen = lookupSeatHeight(active.entries, it.sizeCode, tier);
      if (priceSen == null) { plan.skipReason = `no seat-height entry for ${it.sizeCode}/${tier}`; plans.push(plan); continue; }
    } else {
      // BEDFRAME / ACCESSORY — basePriceSen is per-SKU; product code already
      // encodes the size (e.g. "1003-(Q)"). No tier lookup needed.
      priceSen = active.basePriceSen;
    }
    const newUnit = priceSen + it.legPriceSen + it.divanPriceSen + it.specialOrderPriceSen;
    const newLine = newUnit * it.quantity;
    plan.newBaseRM = priceSen / 100;
    plan.newUnitRM = newUnit / 100;
    plan.newLineRM = newLine / 100;
    plans.push(plan);
  }

  // 6. Combo pass — mirrors src/pages/sales/create.tsx:1103-1267. Sofa lines
  //    on the same SO that share baseModel + fabric tier + seat height and
  //    whose component sizes match a sofa_combo_rule's componentSizes get
  //    re-distributed so the GROUP SUM == comboTotal (rule price for that
  //    seatHeight). Without this pass, recompute restores full-retail
  //    per-piece prices and silently strips the combo discount.
  //
  // ⚠️ DRIFT WARNING — canonical engine is applySofaCombos
  //    (src/api/lib/sofa-combo.ts), pinned by
  //    tests/sofa-combo-drift-guard.test.mjs. As of 2026-07-23 this inline copy
  //    is BEHIND it: applySofaCombos now loops so MULTIPLE identical sets in one
  //    order each get the combo; this copy still matches a single set per group.
  //    It's a manual repricer (rarely run), but if you run it on an order with
  //    two identical combo sets it will over-charge the 2nd. TODO: refactor this
  //    route to call applySofaCombos instead of re-implementing the maths.
  type ComboRule = {
    baseModel: string;
    componentSizes: unknown; // string[] | string[][]
    fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY";
    pricesByHeight: Record<string, number>;
    customerId: string | null;
    effectiveFrom: string;
  };
  const comboRes = await db
    .prepare(
      `SELECT baseModel, componentSizes, fabricTier, pricesByHeight,
              customerId, effectiveFrom
         FROM sofa_combo_rules
        WHERE effectiveFrom <= ?`,
    )
    .bind(today)
    .all<{
      baseModel: string; componentSizes: string;
      fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY";
      pricesByHeight: string; customerId: string | null; effectiveFrom: string;
    }>();
  const comboRules: ComboRule[] = (comboRes.results ?? []).map((r) => ({
    baseModel: r.baseModel, fabricTier: r.fabricTier,
    customerId: r.customerId, effectiveFrom: r.effectiveFrom,
    componentSizes: (() => { try { return JSON.parse(r.componentSizes); } catch { return []; } })(),
    pricesByHeight: (() => { try { return JSON.parse(r.pricesByHeight); } catch { return {}; } })(),
  }));
  // Greedy subset matcher — mirrors findComboSubset in create.tsx.
  // Returns the subset of the input plans whose compartment variants fill
  // the rule's pieces (one plan per rule slot, greedy first-match), or
  // null when the rule can't be fully satisfied. Extras outside the
  // returned subset stay at full master price (no discount bleed).
  function findComboSubset(
    groups: unknown,
    items: Array<{ variant: string; plan: ChangePlan }>,
  ): ChangePlan[] | null {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const isGrouped = Array.isArray(groups[0]);
    const remaining = items.slice();
    const matched: ChangePlan[] = [];
    if (!isGrouped) {
      for (const ruleSize of (groups as string[])) {
        const idx = remaining.findIndex((it) => it.variant === ruleSize);
        if (idx === -1) return null;
        matched.push(remaining[idx].plan);
        remaining.splice(idx, 1);
      }
      return matched;
    }
    for (const groupOpts of (groups as string[][])) {
      const idx = remaining.findIndex((it) => groupOpts.includes(it.variant));
      if (idx === -1) return null;
      matched.push(remaining[idx].plan);
      remaining.splice(idx, 1);
    }
    return matched;
  }
  // Index plans by SO for grouping. Sofa-only.
  const plansBySo = new Map<string, ChangePlan[]>();
  for (const p of plans) {
    if (p.skipReason || p.newLineRM == null) continue;
    const arr = plansBySo.get(p.soId) ?? [];
    arr.push(p);
    plansBySo.set(p.soId, arr);
  }
  let comboMatches = 0;
  for (const [soId, soPlans] of plansBySo) {
    const so = soById.get(soId)!;
    const sofaPlans = soPlans.filter((p) => {
      const it = items.find(i => i.id === p.itemId);
      return it?.itemCategory === "SOFA";
    });
    if (sofaPlans.length < 2) continue;
    // Group by baseModel.
    const byBase = new Map<string, ChangePlan[]>();
    for (const p of sofaPlans) {
      const baseModel = (p.productCode || "").split("-")[0];
      const arr = byBase.get(baseModel) ?? [];
      arr.push(p);
      byBase.set(baseModel, arr);
    }
    for (const [baseModel, group] of byBase) {
      if (group.length < 2) continue;
      // Uniform tier + seatHeight required.
      const tiers = new Set(group.map((g) => g.fabricTier));
      if (tiers.size > 1) continue;
      const heights = new Set(group.map((g) => g.sizeCode));
      if (heights.size > 1) continue;
      const seatHeight = [...heights][0]!;
      const groupTier = [...tiers][0]!;
      // Compartment variants — strip the productCode prefix to get the
      // (1A(LHF), 2NA, etc.) token used by combo rule matching. Pair
      // each variant with its plan so findComboSubset can return the
      // matched plans directly.
      const groupItems = group.map((g) => {
        const code = g.productCode || "";
        const dash = code.indexOf("-");
        return { variant: dash >= 0 ? code.slice(dash + 1) : "", plan: g };
      }).filter((x) => x.variant);
      // For each candidate rule, attempt to find a satisfying SUBSET of
      // the group. Rules whose pieces can't be filled get dropped.
      // Priority customer+tier > customer+ANY > master+tier > master+ANY
      // (mirrors create.tsx).
      const candidates = comboRules
        .filter((r) =>
          r.baseModel === baseModel
            && (r.effectiveFrom <= (so.companySODate || so.createdAt || today)),
        )
        .map((r) => ({ r, subset: findComboSubset(r.componentSizes, groupItems) }))
        .filter((x): x is { r: ComboRule; subset: ChangePlan[] } => x.subset !== null);
      if (candidates.length === 0) continue;
      const priorityOf = (r: ComboRule): number => {
        const isCustomer = r.customerId === so.customerId && so.customerId;
        const tierMatch = r.fabricTier === groupTier;
        if (isCustomer && tierMatch) return 4;
        if (isCustomer && r.fabricTier === "ANY") return 3;
        if (!r.customerId && tierMatch) return 2;
        if (!r.customerId && r.fabricTier === "ANY") return 1;
        return 0;
      };
      const best = candidates
        .map(({ r, subset }) => ({ r, subset, p: priorityOf(r) }))
        .filter((x) => x.p > 0)
        .sort((a, b) =>
          b.p - a.p || (a.r.effectiveFrom < b.r.effectiveFrom ? 1 : -1),
        )[0];
      if (!best) continue;
      const comboTotalRM = (best.r.pricesByHeight[seatHeight] ?? 0) / 100;
      if (comboTotalRM <= 0) continue;
      // Subset sum only — extras (non-subset plans in the group) keep
      // their full master price, no discount bleed.
      const subsetSumRM = best.subset.reduce((s, p) => s + (p.newLineRM ?? 0), 0);
      if (subsetSumRM <= comboTotalRM) continue;
      const ratio = comboTotalRM / subsetSumRM;
      // Distribute proportionally across the SUBSET only.
      let runningGroupSumSen = 0;
      const adjusted: ChangePlan[] = [];
      for (const p of best.subset) {
        const it = items.find(i => i.id === p.itemId)!;
        const oldLineSen = (p.newLineRM ?? 0) * 100;
        const adjustedLineSen = Math.floor(oldLineSen * ratio);
        const surchargesPerUnit =
          it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
        const adjustedUnitSen = Math.max(
          0, Math.round(adjustedLineSen / Math.max(1, it.quantity)),
        );
        const newBaseSen = Math.max(0, adjustedUnitSen - surchargesPerUnit);
        const newUnitSen = newBaseSen + surchargesPerUnit;
        const newLineSen = newUnitSen * it.quantity;
        p.newBaseRM = newBaseSen / 100;
        p.newUnitRM = newUnitSen / 100;
        p.newLineRM = newLineSen / 100;
        runningGroupSumSen += newLineSen;
        adjusted.push(p);
      }
      // Rounding residual → push into highest-base line in group.
      const residualSen = (comboTotalRM * 100) - runningGroupSumSen;
      if (residualSen !== 0 && adjusted.length > 0) {
        const target = adjusted.slice().sort(
          (a, b) => (b.newBaseRM ?? 0) - (a.newBaseRM ?? 0),
        )[0];
        const it = items.find(i => i.id === target.itemId)!;
        const surchargesPerUnit =
          it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
        const cur = (target.newBaseRM ?? 0) * 100;
        const adj = cur + Math.round(residualSen / Math.max(1, it.quantity));
        const newBase = Math.max(0, adj);
        const newUnit = newBase + surchargesPerUnit;
        const newLine = newUnit * it.quantity;
        target.newBaseRM = newBase / 100;
        target.newUnitRM = newUnit / 100;
        target.newLineRM = newLine / 100;
      }
      comboMatches++;
    }
  }

  // Summary stats
  const willChange = plans.filter(p => p.newLineRM != null && p.newLineRM !== p.oldLineRM);
  const noChange = plans.filter(p => p.newLineRM != null && p.newLineRM === p.oldLineRM);
  const skipped = plans.filter(p => p.skipReason);
  const sumDiff = willChange.reduce((s, p) => s + ((p.newLineRM ?? 0) - p.oldLineRM), 0);
  const summary = {
    soCount: sos.length,
    sofaItemsConsidered: items.length,
    willChange: willChange.length,
    noChange: noChange.length,
    skipped: skipped.length,
    skipReasons: skipped.reduce<Record<string, number>>((acc, p) => {
      acc[p.skipReason!] = (acc[p.skipReason!] || 0) + 1; return acc;
    }, {}),
    comboMatchedGroups: comboMatches,
    sumLineDiffRM: Math.round(sumDiff * 100) / 100,
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, scope: statusFilter, summary,
      sampleChanges: willChange.slice(0, 10).map(p => ({
        so: p.companySOId, cust: p.customerName, status: p.status,
        product: p.productCode, sz: p.sizeCode, fab: p.fabricCode, tier: p.fabricTier,
        oldBase: p.oldBaseRM, newBase: p.newBaseRM,
        oldLine: p.oldLineRM, newLine: p.newLineRM,
        diff: Math.round(((p.newLineRM ?? 0) - p.oldLineRM) * 100) / 100,
        qty: p.quantity,
      })),
      sampleSkipped: skipped.slice(0, 5).map(p => ({
        so: p.companySOId, product: p.productCode, sz: p.sizeCode, fab: p.fabricCode, reason: p.skipReason,
      })),
    });
  }

  // Live execute. Update items first; then recompute each affected SO total.
  let itemsUpdated = 0;
  const dirtySoIds = new Set<string>();
  for (let i = 0; i < willChange.length; i += 50) {
    const batch = willChange.slice(i, i + 50);
    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    for (const p of batch) {
      stmts.push(
        db.prepare(
          `UPDATE sales_order_items
              SET basePriceSen = ?, unitPriceSen = ?, lineTotalSen = ?
            WHERE id = ?`,
        ).bind(
          Math.round((p.newBaseRM ?? 0) * 100),
          Math.round((p.newUnitRM ?? 0) * 100),
          Math.round((p.newLineRM ?? 0) * 100),
          p.itemId,
        ),
      );
      dirtySoIds.add(p.soId);
    }
    if (stmts.length > 0) await db.batch(stmts);
    itemsUpdated += batch.length;
  }

  // Recompute SO subtotal/total: sum sales_order_items.line_total_sen.
  let sosUpdated = 0;
  for (const soId of dirtySoIds) {
    const sumRes = await db
      .prepare(
        `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub
           FROM sales_order_items WHERE salesOrderId = ?`,
      )
      .bind(soId)
      .first<{ sub: number }>();
    const sub = sumRes?.sub ?? 0;
    // SO has subtotal_sen / grand_total_sen — keep tax/discount untouched,
    // just refresh subtotal + grand. (Tax/discount columns are not on every
    // SO; do a defensive UPDATE that only sets subtotal_sen and let an
    // existing grand_total_sen stay if the column doesn't exist via the
    // adapter quirks. We'll set grand_total_sen = subtotal_sen since the
    // current SOs in this dataset don't carry separate tax.)
    await db
      .prepare(
        `UPDATE sales_orders
            SET subtotalSen = ?, totalSen = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(sub, sub, new Date().toISOString(), soId)
      .run();
    sosUpdated++;
  }

  return c.json({
    success: true, dryRun: false, scope: statusFilter, summary,
    itemsUpdated, sosUpdated,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/recompute-co-sofa-prices?dryRun=true|false&statuses=...
//
// CO twin of /recompute-so-sofa-prices — same logic, different tables.
// Rebuilds basePriceSen / unitPriceSen / lineTotalSen on every CO line item
// in active consignment_orders, with the same per-line price resolution
// (customer override → master fallback at companyCODate, fabric tier from
// fabric_trackings.sofaPriceTier or bedframePriceTier) and the same sofa-
// combo subset matching pass (extras keep master price, no discount bleed).
//
// CO create flow doesn't currently bake combo discount, so this is also
// the first time CO line items get combo redistribution.
// ---------------------------------------------------------------------------
app.post("/recompute-co-sofa-prices", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const statusFilter = (c.req.query("statuses") || "").trim()
    ? c.req.query("statuses")!.split(",").map(s => s.trim()).filter(Boolean)
    : ["IN_PRODUCTION", "READY_TO_SHIP", "CONFIRMED", "DRAFT"];
  const today = new Date().toISOString().slice(0, 10);

  // Fabric → tier maps (same as SO version).
  const ftRes = await db
    .prepare(
      `SELECT fabricCode, sofaPriceTier, bedframePriceTier, priceTier
         FROM fabric_trackings`,
    )
    .all<{ fabricCode: string; sofaPriceTier: string | null; bedframePriceTier: string | null; priceTier: string | null }>();
  const fabricSofaTierMap = new Map<string, string>();
  const fabricBedframeTierMap = new Map<string, string>();
  for (const r of (ftRes.results ?? [])) {
    fabricSofaTierMap.set(r.fabricCode, r.sofaPriceTier ?? r.priceTier ?? "PRICE_2");
    fabricBedframeTierMap.set(r.fabricCode, r.bedframePriceTier ?? r.priceTier ?? "PRICE_2");
  }

  // Pull COs in scope.
  const coPlaceholders = statusFilter.map(() => "?").join(",");
  const coRes = await db
    .prepare(
      `SELECT id, companyCOId, customerId, customerName, status,
              companyCODate, created_at AS createdAt
         FROM consignment_orders
        WHERE status IN (${coPlaceholders})`,
    )
    .bind(...statusFilter)
    .all<{ id: string; companyCOId: string | null; customerId: string | null; customerName: string | null; status: string | null; companyCODate: string | null; createdAt: string | null }>();
  const cos = coRes.results ?? [];
  if (cos.length === 0) {
    return c.json({ success: true, dryRun, scope: statusFilter, coCount: 0 });
  }
  const coIds = cos.map(s => s.id);
  const coById = new Map(cos.map(s => [s.id, s] as const));

  type CoiRow = SoiRow & { consignmentOrderId: string };
  const itemsRes = await db
    .prepare(
      `SELECT id, consignmentOrderId AS salesOrderId, productId, productCode, itemCategory, sizeCode,
              fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
              legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
              basePriceSen, unitPriceSen, lineTotalSen
         FROM consignment_order_items
        WHERE itemCategory IN ('SOFA','BEDFRAME','ACCESSORY')
          AND consignmentOrderId IN (${coIds.map(() => "?").join(",")})`,
    )
    .bind(...coIds)
    .all<CoiRow>();
  const items = (itemsRes.results ?? []).filter((it) => {
    if (!it.productCode) return false;
    if (it.itemCategory === "SOFA") {
      return SOFA_TARGET_BASES.some((b) => it.productCode!.startsWith(b + "-"));
    }
    return it.itemCategory === "BEDFRAME" || it.itemCategory === "ACCESSORY";
  });

  // Pre-load customer + master price history (mirrors SO version).
  const cpKeys = Array.from(new Set(items.map((it) => {
    const co = coById.get(it.salesOrderId);
    if (!co?.customerId || !it.productId) return null;
    return `${co.customerId}|${it.productId}`;
  }).filter((k): k is string => k !== null)));
  const cpHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const k of cpKeys) {
    const [customerId, productId] = k.split("|");
    const cpRes = await db
      .prepare(
        `SELECT cpp.basePriceSen, cpp.seatHeightPrices, cpp.effectiveFrom
           FROM customer_products cp
           JOIN customer_product_prices cpp ON cpp.customerProductId = cp.id
          WHERE cp.customerId = ? AND cp.productId = ?
          ORDER BY cpp.effectiveFrom DESC`,
      )
      .bind(customerId, productId)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    cpHistMap.set(k, cpRes.results ?? []);
  }
  const productIds = Array.from(new Set(items.map(it => it.productId).filter((p): p is string => !!p)));
  const masterHistMap = new Map<string, Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>>();
  for (const pid of productIds) {
    const mhRes = await db
      .prepare(
        `SELECT basePriceSen, seatHeightPrices, effectiveFrom
           FROM product_prices
          WHERE productId = ?
          ORDER BY effectiveFrom DESC`,
      )
      .bind(pid)
      .all<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>();
    masterHistMap.set(pid, mhRes.results ?? []);
  }

  type SeatHeightEntry = { height: string; priceSen: number; tier?: string };
  function pickActive(rows: Array<{ basePriceSen: number | null; seatHeightPrices: string | null; effectiveFrom: string }>, asOf: string) {
    const usable = rows.filter((r) => r.effectiveFrom <= asOf && r.basePriceSen != null).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const r = usable[0];
    if (!r) return null;
    let entries: SeatHeightEntry[] = [];
    try { entries = (JSON.parse(r.seatHeightPrices ?? "[]") || []) as SeatHeightEntry[]; } catch { /* ignore */ }
    return { basePriceSen: r.basePriceSen!, entries };
  }
  function lookupSeatHeight(entries: SeatHeightEntry[], height: string, tier: string): number | null {
    let m = entries.find(e => e.height === height && e.tier === tier);
    if (m) return m.priceSen;
    if (tier === "PRICE_2") {
      m = entries.find(e => e.height === height && !e.tier);
      if (m) return m.priceSen;
    }
    return null;
  }

  type ChangePlan2 = {
    coId: string; companyCOId: string | null; customerName: string | null; status: string | null;
    itemId: string; productCode: string | null; sizeCode: string | null;
    fabricCode: string | null; fabricTier: string | null; quantity: number;
    oldBaseRM: number; newBaseRM: number | null;
    oldUnitRM: number; newUnitRM: number | null;
    oldLineRM: number; newLineRM: number | null;
    skipReason?: string;
  };
  const plans: ChangePlan2[] = [];
  for (const it of items) {
    const co = coById.get(it.salesOrderId)!;
    const tier = it.fabricCode
      ? (it.itemCategory === "BEDFRAME"
          ? fabricBedframeTierMap.get(it.fabricCode)
          : fabricSofaTierMap.get(it.fabricCode)) || "PRICE_2"
      : "PRICE_2";
    const asOf = (co.companyCODate || co.createdAt || today).slice(0, 10);
    const cpKey = co.customerId && it.productId ? `${co.customerId}|${it.productId}` : null;
    const cpHist = cpKey ? cpHistMap.get(cpKey) ?? [] : [];
    const masterHist = it.productId ? masterHistMap.get(it.productId) ?? [] : [];
    const cpActive = cpHist.length ? pickActive(cpHist, asOf) : null;
    const masterActive = pickActive(masterHist, asOf);
    const active = cpActive ?? masterActive;
    const plan: ChangePlan2 = {
      coId: it.salesOrderId, companyCOId: co.companyCOId, customerName: co.customerName, status: co.status,
      itemId: it.id, productCode: it.productCode, sizeCode: it.sizeCode,
      fabricCode: it.fabricCode, fabricTier: tier, quantity: it.quantity,
      oldBaseRM: it.basePriceSen / 100, newBaseRM: null,
      oldUnitRM: it.unitPriceSen / 100, newUnitRM: null,
      oldLineRM: it.lineTotalSen / 100, newLineRM: null,
    };
    if (!active) { plan.skipReason = "no active price row"; plans.push(plan); continue; }
    let priceSen: number | null = null;
    if (it.itemCategory === "SOFA") {
      if (!it.sizeCode) { plan.skipReason = "missing sizeCode"; plans.push(plan); continue; }
      priceSen = lookupSeatHeight(active.entries, it.sizeCode, tier);
      if (priceSen == null) { plan.skipReason = `no seat-height entry for ${it.sizeCode}/${tier}`; plans.push(plan); continue; }
    } else {
      priceSen = active.basePriceSen;
    }
    const newUnit = priceSen + it.legPriceSen + it.divanPriceSen + it.specialOrderPriceSen;
    const newLine = newUnit * it.quantity;
    plan.newBaseRM = priceSen / 100;
    plan.newUnitRM = newUnit / 100;
    plan.newLineRM = newLine / 100;
    plans.push(plan);
  }

  // Sofa combo subset pass (mirrors SO version).
  type ComboRule = { baseModel: string; componentSizes: unknown; fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY"; pricesByHeight: Record<string, number>; customerId: string | null; effectiveFrom: string };
  const comboRes = await db
    .prepare(
      `SELECT baseModel, componentSizes, fabricTier, pricesByHeight, customerId, effectiveFrom
         FROM sofa_combo_rules
        WHERE effectiveFrom <= ?`,
    )
    .bind(today)
    .all<{ baseModel: string; componentSizes: string; fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY"; pricesByHeight: string; customerId: string | null; effectiveFrom: string }>();
  const comboRules: ComboRule[] = (comboRes.results ?? []).map((r) => ({
    baseModel: r.baseModel, fabricTier: r.fabricTier, customerId: r.customerId, effectiveFrom: r.effectiveFrom,
    componentSizes: (() => { try { return JSON.parse(r.componentSizes); } catch { return []; } })(),
    pricesByHeight: (() => { try { return JSON.parse(r.pricesByHeight); } catch { return {}; } })(),
  }));
  function findComboSubsetCo(groups: unknown, items2: Array<{ variant: string; plan: ChangePlan2 }>): ChangePlan2[] | null {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const isGrouped = Array.isArray(groups[0]);
    const remaining = items2.slice();
    const matched: ChangePlan2[] = [];
    if (!isGrouped) {
      for (const ruleSize of (groups as string[])) {
        const idx = remaining.findIndex((it) => it.variant === ruleSize);
        if (idx === -1) return null;
        matched.push(remaining[idx].plan); remaining.splice(idx, 1);
      }
      return matched;
    }
    for (const groupOpts of (groups as string[][])) {
      const idx = remaining.findIndex((it) => groupOpts.includes(it.variant));
      if (idx === -1) return null;
      matched.push(remaining[idx].plan); remaining.splice(idx, 1);
    }
    return matched;
  }

  const plansByCo = new Map<string, ChangePlan2[]>();
  for (const p of plans) {
    if (p.skipReason || p.newLineRM == null) continue;
    const arr = plansByCo.get(p.coId) ?? [];
    arr.push(p); plansByCo.set(p.coId, arr);
  }
  let comboMatches = 0;
  for (const [coId, coPlans] of plansByCo) {
    const co = coById.get(coId)!;
    const sofaPlans = coPlans.filter((p) => {
      const it = items.find(i => i.id === p.itemId);
      return it?.itemCategory === "SOFA";
    });
    if (sofaPlans.length < 2) continue;
    const byBase = new Map<string, ChangePlan2[]>();
    for (const p of sofaPlans) {
      const baseModel = (p.productCode || "").split("-")[0];
      const arr = byBase.get(baseModel) ?? [];
      arr.push(p); byBase.set(baseModel, arr);
    }
    for (const [baseModel, group] of byBase) {
      if (group.length < 2) continue;
      const tiers = new Set(group.map((g) => g.fabricTier));
      if (tiers.size > 1) continue;
      const heights = new Set(group.map((g) => g.sizeCode));
      if (heights.size > 1) continue;
      const seatHeight = [...heights][0]!;
      const groupTier = [...tiers][0]!;
      const groupItems = group.map((g) => {
        const code = g.productCode || "";
        const dash = code.indexOf("-");
        return { variant: dash >= 0 ? code.slice(dash + 1) : "", plan: g };
      }).filter((x) => x.variant);
      const candidates = comboRules
        .filter((r) => r.baseModel === baseModel && r.effectiveFrom <= (co.companyCODate || co.createdAt || today))
        .map((r) => ({ r, subset: findComboSubsetCo(r.componentSizes, groupItems) }))
        .filter((x): x is { r: ComboRule; subset: ChangePlan2[] } => x.subset !== null);
      if (candidates.length === 0) continue;
      const priorityOf = (r: ComboRule): number => {
        const isCustomer = r.customerId === co.customerId && co.customerId;
        const tierMatch = r.fabricTier === groupTier;
        if (isCustomer && tierMatch) return 4;
        if (isCustomer && r.fabricTier === "ANY") return 3;
        if (!r.customerId && tierMatch) return 2;
        if (!r.customerId && r.fabricTier === "ANY") return 1;
        return 0;
      };
      const best = candidates
        .map(({ r, subset }) => ({ r, subset, p: priorityOf(r) }))
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p || (a.r.effectiveFrom < b.r.effectiveFrom ? 1 : -1))[0];
      if (!best) continue;
      const comboTotalRM = (best.r.pricesByHeight[seatHeight] ?? 0) / 100;
      if (comboTotalRM <= 0) continue;
      const subsetSumRM = best.subset.reduce((s, p) => s + (p.newLineRM ?? 0), 0);
      if (subsetSumRM <= comboTotalRM) continue;
      const ratio = comboTotalRM / subsetSumRM;
      let runningGroupSumSen = 0;
      const adjusted: ChangePlan2[] = [];
      for (const p of best.subset) {
        const it = items.find(i => i.id === p.itemId)!;
        const oldLineSen = (p.newLineRM ?? 0) * 100;
        const adjustedLineSen = Math.floor(oldLineSen * ratio);
        const surchargesPerUnit = it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
        const adjustedUnitSen = Math.max(0, Math.round(adjustedLineSen / Math.max(1, it.quantity)));
        const newBaseSen = Math.max(0, adjustedUnitSen - surchargesPerUnit);
        const newUnitSen = newBaseSen + surchargesPerUnit;
        const newLineSen = newUnitSen * it.quantity;
        p.newBaseRM = newBaseSen / 100; p.newUnitRM = newUnitSen / 100; p.newLineRM = newLineSen / 100;
        runningGroupSumSen += newLineSen; adjusted.push(p);
      }
      const residualSen = (comboTotalRM * 100) - runningGroupSumSen;
      if (residualSen !== 0 && adjusted.length > 0) {
        const target = adjusted.slice().sort((a, b) => (b.newBaseRM ?? 0) - (a.newBaseRM ?? 0))[0];
        const it = items.find(i => i.id === target.itemId)!;
        const surchargesPerUnit = it.divanPriceSen + it.legPriceSen + it.specialOrderPriceSen;
        const cur = (target.newBaseRM ?? 0) * 100;
        const adj = cur + Math.round(residualSen / Math.max(1, it.quantity));
        const newBase = Math.max(0, adj);
        const newUnit = newBase + surchargesPerUnit;
        const newLine = newUnit * it.quantity;
        target.newBaseRM = newBase / 100; target.newUnitRM = newUnit / 100; target.newLineRM = newLine / 100;
      }
      comboMatches++;
    }
  }

  const willChange = plans.filter(p => p.newLineRM != null && p.newLineRM !== p.oldLineRM);
  const noChange = plans.filter(p => p.newLineRM != null && p.newLineRM === p.oldLineRM);
  const skipped = plans.filter(p => p.skipReason);
  const sumDiff = willChange.reduce((s, p) => s + ((p.newLineRM ?? 0) - p.oldLineRM), 0);
  const summary = {
    coCount: cos.length, itemsConsidered: items.length, willChange: willChange.length,
    noChange: noChange.length, skipped: skipped.length,
    skipReasons: skipped.reduce<Record<string, number>>((acc, p) => { acc[p.skipReason!] = (acc[p.skipReason!] || 0) + 1; return acc; }, {}),
    comboMatchedGroups: comboMatches,
    sumLineDiffRM: Math.round(sumDiff * 100) / 100,
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, scope: statusFilter, summary,
      sampleChanges: willChange.slice(0, 20).map(p => ({
        co: p.companyCOId, cust: p.customerName, status: p.status,
        product: p.productCode, sz: p.sizeCode, fab: p.fabricCode, tier: p.fabricTier,
        oldBase: p.oldBaseRM, newBase: p.newBaseRM,
        oldLine: p.oldLineRM, newLine: p.newLineRM,
        diff: Math.round(((p.newLineRM ?? 0) - p.oldLineRM) * 100) / 100,
        qty: p.quantity,
      })),
    });
  }

  let itemsUpdated = 0;
  const dirtyCoIds = new Set<string>();
  for (let i = 0; i < willChange.length; i += 50) {
    const batch = willChange.slice(i, i + 50);
    const stmts: ReturnType<D1Database["prepare"]>[] = [];
    for (const p of batch) {
      stmts.push(
        db.prepare(`UPDATE consignment_order_items SET basePriceSen = ?, unitPriceSen = ?, lineTotalSen = ? WHERE id = ?`)
          .bind(Math.round((p.newBaseRM ?? 0) * 100), Math.round((p.newUnitRM ?? 0) * 100), Math.round((p.newLineRM ?? 0) * 100), p.itemId),
      );
      dirtyCoIds.add(p.coId);
    }
    if (stmts.length > 0) await db.batch(stmts);
    itemsUpdated += batch.length;
  }
  let cosUpdated = 0;
  for (const coId of dirtyCoIds) {
    const sumRes = await db
      .prepare(`SELECT COALESCE(SUM(lineTotalSen), 0) AS sub FROM consignment_order_items WHERE consignmentOrderId = ?`)
      .bind(coId).first<{ sub: number }>();
    const sub = sumRes?.sub ?? 0;
    await db.prepare(`UPDATE consignment_orders SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?`)
      .bind(sub, sub, new Date().toISOString(), coId).run();
    cosUpdated++;
  }
  return c.json({ success: true, dryRun: false, scope: statusFilter, summary, itemsUpdated, cosUpdated });
});

// ---------------------------------------------------------------------------
// POST /api/import/resync-co-totals — CO twin of resync-so-totals.
// ---------------------------------------------------------------------------
app.post("/resync-co-totals", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const cosRes = await db.prepare(
    `SELECT id, subtotalSen, totalSen FROM consignment_orders
      WHERE status IN ('IN_PRODUCTION','READY_TO_SHIP','CONFIRMED','DRAFT')`,
  ).all<{ id: string; subtotalSen: number; totalSen: number }>();
  const cos = cosRes.results ?? [];
  let outOfSync = 0, updated = 0;
  const samples: Array<{ coId: string; oldSub: number; newSub: number; diff: number }> = [];
  const now = new Date().toISOString();
  for (const co of cos) {
    const sumRes = await db.prepare(
      `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub FROM consignment_order_items WHERE consignmentOrderId = ?`,
    ).bind(co.id).first<{ sub: number }>();
    const newSub = sumRes?.sub ?? 0;
    if (newSub === co.subtotalSen && newSub === co.totalSen) continue;
    outOfSync++;
    if (samples.length < 10) samples.push({ coId: co.id, oldSub: co.subtotalSen, newSub, diff: newSub - co.subtotalSen });
    if (!dryRun) {
      await db.prepare(`UPDATE consignment_orders SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?`)
        .bind(newSub, newSub, now, co.id).run();
      updated++;
    }
  }
  return c.json({ success: true, dryRun, coCount: cos.length, outOfSync, updated, samples });
});

// ---------------------------------------------------------------------------
// POST /api/import/resync-so-totals
//
// Single-purpose resync: walk every active SO, set subtotal_sen + total_sen
// = SUM(sales_order_items.line_total_sen) for that SO. Idempotent.
//
// Needed because the first live run of recompute-so-sofa-prices crashed
// mid-execution on a wrong column name (grand_total vs total) — the line-
// item UPDATEs landed but the SO total UPDATEs didn't, leaving 41-of-60
// sampled SOs with stale subtotals.
// ---------------------------------------------------------------------------
app.post("/resync-so-totals", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  const sosRes = await db
    .prepare(
      `SELECT id, subtotalSen, totalSen
         FROM sales_orders
        WHERE status IN ('IN_PRODUCTION','READY_TO_SHIP','CONFIRMED','DRAFT')`,
    )
    .all<{ id: string; subtotalSen: number; totalSen: number }>();
  const sos = sosRes.results ?? [];

  let outOfSync = 0;
  let updated = 0;
  const samples: Array<{ soId: string; oldSub: number; newSub: number; diff: number }> = [];
  const now = new Date().toISOString();

  for (const so of sos) {
    const sumRes = await db
      .prepare(
        `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub
           FROM sales_order_items WHERE salesOrderId = ?`,
      )
      .bind(so.id)
      .first<{ sub: number }>();
    const newSub = sumRes?.sub ?? 0;
    if (newSub === so.subtotalSen && newSub === so.totalSen) continue;
    outOfSync++;
    if (samples.length < 10) {
      samples.push({ soId: so.id, oldSub: so.subtotalSen, newSub, diff: newSub - so.subtotalSen });
    }
    if (!dryRun) {
      await db
        .prepare(
          `UPDATE sales_orders
              SET subtotalSen = ?, totalSen = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(newSub, newSub, now, so.id)
        .run();
      updated++;
    }
  }

  return c.json({
    success: true, dryRun,
    soCount: sos.length, outOfSync, updated, samples,
  });
});

// ===========================================================================
// Historical-purchase backfill — three one-shot endpoints used by the driver
// at scripts/import-historical-purchases.py. We're back-filling 1206 source
// PI line items across 19 suppliers from a CSV-style xlsx export.
//
// Per-project rule (project_migration_in_progress): these endpoints are
// scheduled for deletion post-migration. Don't refactor or extract shared
// helpers between them — duplication is OK here, removal is the next move.
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/import/suppliers-from-history
//
// Body: { suppliers: [{ code, name }, ...] }
// Insert if not exists by code. Defaults: status=ACTIVE, isActive=1.
// ---------------------------------------------------------------------------
type SupplierFromHistory = { code?: string; name?: string };
type SuppliersFromHistoryBody = { suppliers?: SupplierFromHistory[] };

app.post("/suppliers-from-history", async (c) => {
  const denied = await requirePermission(c, "suppliers", "create");
  if (denied) return denied;

  let body: SuppliersFromHistoryBody;
  try {
    body = (await c.req.json()) as SuppliersFromHistoryBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const list = Array.isArray(body.suppliers) ? body.suppliers : null;
  if (!list) {
    return c.json(
      { success: false, error: "body.suppliers must be an array" },
      400,
    );
  }

  const db = c.var.DB;
  let inserted = 0;
  let skipped = 0;
  const errors: { code: string; message: string }[] = [];

  for (const s of list) {
    const code = String(s?.code ?? "").trim();
    const name = String(s?.name ?? "").trim();
    if (!code || !name) {
      errors.push({ code, message: "code and name are required" });
      continue;
    }
    try {
      const existing = await db
        .prepare("SELECT id FROM suppliers WHERE code = ? LIMIT 1")
        .bind(code)
        .first<{ id: string }>();
      if (existing) {
        skipped++;
        continue;
      }
      const id = `sup-${crypto.randomUUID().slice(0, 8)}`;
      await db
        .prepare(
          `INSERT INTO suppliers (id, code, name, contactPerson, phone, email,
             address, state, paymentTerms, status, rating,
             currency, statementType, agingOn, creditTerm,
             isActive, isGroupCompany, outstandingSen)
           VALUES (?, ?, ?, '', '', '', '', '', 'NET30', 'ACTIVE', 3,
                   'MYR', 'OPEN_ITEM', 'INVOICE_DATE', 'C.O.D.',
                   1, 0, 0)`,
        )
        .bind(id, code, name)
        .run();
      inserted++;
    } catch (err) {
      errors.push({
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    total: list.length,
    inserted,
    skipped,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/supplier-bindings-from-history
//
// Body: { bindings: [{ materialCode, supplierCode, supplierSKU,
//                       unitPriceSen, isMainSupplier }, ...] }
// Look up supplier_id by code; UPSERT into supplier_material_bindings keyed
// on (materialCode, supplierId). leadTimeDays=0, moq=1 on insert; unitPrice
// + isMainSupplier are always updated.
// ---------------------------------------------------------------------------
type BindingInput = {
  materialCode?: string;
  supplierCode?: string;
  supplierSKU?: string;
  unitPriceSen?: number;
  isMainSupplier?: number | boolean;
};
type BindingsFromHistoryBody = { bindings?: BindingInput[] };

app.post("/supplier-bindings-from-history", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "create");
  if (denied) return denied;

  let body: BindingsFromHistoryBody;
  try {
    body = (await c.req.json()) as BindingsFromHistoryBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const list = Array.isArray(body.bindings) ? body.bindings : null;
  if (!list) {
    return c.json(
      { success: false, error: "body.bindings must be an array" },
      400,
    );
  }

  const db = c.var.DB;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { ref: string; message: string }[] = [];

  // Cache supplier code → id within one request to avoid repeated lookups.
  const supplierCache = new Map<string, string | null>();
  // Cache material existence — silently skip bindings whose materialCode
  // doesn't exist in raw_materials yet (Phase A should have created them).
  const materialCache = new Map<string, boolean>();

  async function resolveSupplier(code: string): Promise<string | null> {
    if (supplierCache.has(code)) return supplierCache.get(code) ?? null;
    const row = await db
      .prepare("SELECT id FROM suppliers WHERE code = ? LIMIT 1")
      .bind(code)
      .first<{ id: string }>();
    const id = row?.id ?? null;
    supplierCache.set(code, id);
    return id;
  }
  async function materialExists(code: string): Promise<boolean> {
    if (materialCache.has(code)) return materialCache.get(code) === true;
    const row = await db
      .prepare("SELECT 1 AS x FROM raw_materials WHERE itemCode = ? LIMIT 1")
      .bind(code)
      .first<{ x: number }>();
    const exists = !!row;
    materialCache.set(code, exists);
    return exists;
  }

  for (const b of list) {
    const materialCode = String(b?.materialCode ?? "").trim();
    const supplierCode = String(b?.supplierCode ?? "").trim();
    const supplierSKU = String(b?.supplierSKU ?? "").trim();
    const unitPrice = Math.round(Number(b?.unitPriceSen) || 0);
    const isMain =
      b?.isMainSupplier === true ||
      Number(b?.isMainSupplier) === 1
        ? 1
        : 0;
    const ref = `${supplierCode}::${materialCode}`;

    if (!materialCode || !supplierCode || !supplierSKU) {
      errors.push({
        ref,
        message: "materialCode, supplierCode, supplierSKU required",
      });
      continue;
    }
    try {
      const supplierId = await resolveSupplier(supplierCode);
      if (!supplierId) {
        errors.push({ ref, message: `unknown supplier code ${supplierCode}` });
        continue;
      }
      if (!(await materialExists(materialCode))) {
        skipped++;
        continue;
      }

      // We need materialName to satisfy the NOT NULL constraint on the
      // supplier_material_bindings table. Pull it from the raw_materials row.
      const rmRow = await db
        .prepare(
          "SELECT description FROM raw_materials WHERE itemCode = ? LIMIT 1",
        )
        .bind(materialCode)
        .first<{ description: string }>();
      const materialName = rmRow?.description ?? materialCode;

      const existing = await db
        .prepare(
          `SELECT id FROM supplier_material_bindings
            WHERE materialCode = ? AND supplierId = ? LIMIT 1`,
        )
        .bind(materialCode, supplierId)
        .first<{ id: string }>();

      if (existing) {
        await db
          .prepare(
            `UPDATE supplier_material_bindings
                SET supplierSku = ?, unitPrice = ?, isMainSupplier = ?,
                    materialName = ?
              WHERE id = ?`,
          )
          .bind(supplierSKU, unitPrice, isMain, materialName, existing.id)
          .run();
        updated++;
      } else {
        const id = `smb-${crypto.randomUUID().slice(0, 8)}`;
        await db
          .prepare(
            `INSERT INTO supplier_material_bindings (id, supplierId, materialCode,
               materialName, supplierSku, unitPrice, currency, leadTimeDays,
               paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
             VALUES (?, ?, ?, ?, ?, ?, 'MYR', 0, 'NET30', 1, ?, '2030-12-31', ?)`,
          )
          .bind(
            id,
            supplierId,
            materialCode,
            materialName,
            supplierSKU,
            unitPrice,
            new Date().toISOString().slice(0, 10),
            isMain,
          )
          .run();
        inserted++;
      }
    } catch (err) {
      errors.push({
        ref,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    total: list.length,
    inserted,
    updated,
    skipped,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/historical-purchases-backfill
//
// Body: { documents: [{ docNo, docDate, supplierCode, items: [...] }, ...] }
// For each document, atomically create:
//   1. one purchase_orders row (status=CLOSED)
//   2. one purchase_order_items per item with non-null materialCode
//   3. one grns row (status=POSTED, qcStatus=PASSED) — triggers stock post
//   4. one grn_items per item with non-null materialCode
//   5. rm_batches + cost_ledger + raw_materials.balanceQty bump (replicated
//      from grn.ts postGRNToStock)
//   6. one purchase_invoices row (status=APPROVED) — amountSen = sum of
//      ALL resolved lines (stocked + fee + rebate + tax)
//   7. one purchase_invoice_items per resolved item (migration 0107).
//      Stocked items keep their material_code; non-stocked lines (fees,
//      tax, rebate, discount) are categorised with a description-based
//      line_type heuristic so the detail screen can render them clearly.
//
// Idempotency: skip if a purchase_invoices row with piNo = docNo already
// exists.
// ---------------------------------------------------------------------------
type BackfillDocItem = {
  materialCode?: string | null;
  supplierSKU?: string | null;
  description?: string | null;
  qty?: number;
  unitPriceSen?: number;
};
type BackfillDoc = {
  docNo?: string;
  docDate?: string;
  supplierCode?: string;
  items?: BackfillDocItem[];
};
type BackfillPOItem = {
  description?: string;
  materialCode?: string | null;
  supplierSKU?: string;
  qty: number;
  unitPriceSen: number;
};
type BackfillPODoc = {
  poNo: string;
  docDate: string;
  supplierCode: string;
  items: BackfillPOItem[];
};
type BackfillBody = {
  documents?: BackfillDoc[];
  skipStock?: boolean;
  purchaseOrders?: BackfillPODoc[];
};

app.post("/historical-purchases-backfill", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: BackfillBody;
  try {
    body = (await c.req.json()) as BackfillBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const docs = Array.isArray(body.documents) ? body.documents : [];
  const skipStock = body.skipStock === true;
  const purchaseOrdersOnly = Array.isArray(body.purchaseOrders)
    ? body.purchaseOrders
    : [];

  if (docs.length === 0 && purchaseOrdersOnly.length === 0) {
    return c.json(
      {
        success: false,
        error:
          "body.documents or body.purchaseOrders (or both) must be a non-empty array",
      },
      400,
    );
  }

  const db = c.var.DB;
  let posCreated = 0;
  let grnsCreated = 0;
  let pisCreated = 0;
  let posOnlyCreated = 0;
  let lineItemsTotal = 0;
  let documentsProcessed = 0;
  let skipped = 0;
  const errors: { docNo: string; message: string }[] = [];

  // Per-batch caches (one request worth of docs).
  const supplierCache = new Map<
    string,
    { id: string; name: string } | null
  >();
  const rmCache = new Map<string, { id: string; description: string } | null>();

  async function resolveSupplier(code: string) {
    if (supplierCache.has(code)) return supplierCache.get(code) ?? null;
    const row = await db
      .prepare("SELECT id, name FROM suppliers WHERE code = ? LIMIT 1")
      .bind(code)
      .first<{ id: string; name: string }>();
    supplierCache.set(code, row ?? null);
    return row ?? null;
  }
  async function resolveRm(code: string) {
    if (rmCache.has(code)) return rmCache.get(code) ?? null;
    const row = await db
      .prepare(
        "SELECT id, description FROM raw_materials WHERE itemCode = ? LIMIT 1",
      )
      .bind(code)
      .first<{ id: string; description: string }>();
    rmCache.set(code, row ?? null);
    return row ?? null;
  }

  for (const doc of docs) {
    const docNo = String(doc?.docNo ?? "").trim();
    const docDate = String(doc?.docDate ?? "").trim();
    const supplierCode = String(doc?.supplierCode ?? "").trim();
    const itemsIn = Array.isArray(doc?.items) ? doc.items : [];

    if (!docNo || !docDate || !supplierCode || itemsIn.length === 0) {
      errors.push({
        docNo: docNo || "(missing)",
        message: "docNo, docDate, supplierCode, items required",
      });
      continue;
    }

    try {
      // Idempotency: skip if a PI with this piNo already exists.
      const existingPi = await db
        .prepare("SELECT id FROM purchase_invoices WHERE piNo = ? LIMIT 1")
        .bind(docNo)
        .first<{ id: string }>();
      if (existingPi) {
        skipped++;
        continue;
      }

      const supplier = await resolveSupplier(supplierCode);
      if (!supplier) {
        errors.push({
          docNo,
          message: `unknown supplier code ${supplierCode}`,
        });
        continue;
      }

      // Resolve items. Stocked items (materialCode set + RM exists) feed the
      // PO/GRN; non-stocked items (null materialCode, or unresolved code) are
      // PI-only (added to PI amountSen total).
      type Resolved = {
        materialCode: string | null;
        materialName: string;
        supplierSKU: string;
        qty: number;
        unitPriceSen: number;
        rmId: string | null;
      };
      const resolved: Resolved[] = [];
      for (const it of itemsIn) {
        const qty = Number(it?.qty) || 0;
        const unitPriceSen = Math.round(Number(it?.unitPriceSen) || 0);
        const desc = String(it?.description ?? "").trim();
        const matCode = it?.materialCode
          ? String(it.materialCode).trim()
          : null;
        const supSku = String(it?.supplierSKU ?? matCode ?? "").trim();
        let rmRow: { id: string; description: string } | null = null;
        if (matCode) {
          rmRow = await resolveRm(matCode);
        }
        resolved.push({
          materialCode: rmRow ? matCode : null,
          materialName: rmRow?.description ?? desc ?? matCode ?? "",
          supplierSKU: supSku,
          qty,
          unitPriceSen,
          rmId: rmRow?.id ?? null,
        });
      }
      const stockedItems = resolved.filter((r) => r.rmId !== null);

      // Compute totals. Math.round defends against float drift when qty is
      // a fraction (e.g. fabric: 261.6 * 890 = 232824.00000000003 in JS).
      // amountSen / totalSen / subtotalSen are INTEGER NOT NULL.
      const stockedSubtotal = Math.round(
        stockedItems.reduce((s, r) => s + r.qty * r.unitPriceSen, 0),
      );
      const piAmountSen = Math.round(
        resolved.reduce((s, r) => s + r.qty * r.unitPriceSen, 0),
      );

      // ----- PO -----
      const poId = `po-${crypto.randomUUID().slice(0, 8)}`;
      const poNo = `PO-IMPORT-${docNo}`;
      const nowIso = new Date().toISOString();
      const grnId = `grn-${crypto.randomUUID().slice(0, 8)}`;
      const grnNumber = `GRN-IMPORT-${docNo}`;
      const piId = `pi-${crypto.randomUUID().slice(0, 8)}`;

      // Build the per-document statement bundle. We push into one D1 batch
      // so the whole document is atomic — D1 batch is transactional.
      const statements: D1PreparedStatement[] = [];

      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_orders (id, poNo, supplierId, supplierName,
               subtotalSen, totalSen, status, orderDate, expectedDate,
               receivedDate, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'CLOSED', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            poId,
            poNo,
            supplier.id,
            supplier.name,
            stockedSubtotal,
            stockedSubtotal,
            docDate,
            docDate,
            docDate,
            `Imported from historical PI ${docNo}`,
            nowIso,
            nowIso,
          ),
      );

      // PO items + GRN items in matching order. poItemIndex links GRN line N
      // to PO line N — same convention as POST /api/grn.
      for (let i = 0; i < stockedItems.length; i++) {
        const it = stockedItems[i];
        const poItemId = `poi-${crypto.randomUUID().slice(0, 8)}`;
        const lineTotal = Math.round(it.qty * it.unitPriceSen);
        statements.push(
          db
            .prepare(
              `INSERT INTO purchase_order_items (id, purchaseOrderId,
                 materialCategory, materialName, supplierSKU, quantity,
                 unitPriceSen, totalSen, receivedQty, unit)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 'pcs')`,
            )
            .bind(
              poItemId,
              poId,
              it.materialName,
              it.supplierSKU,
              it.qty,
              it.unitPriceSen,
              lineTotal,
              it.qty, // mark as fully received since GRN is POSTED
            ),
        );
      }

      // ----- GRN -----
      statements.push(
        db
          .prepare(
            `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
               supplierName, receiveDate, receivedBy, totalAmount, qcStatus,
               status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'PASSED', 'POSTED', ?)`,
          )
          .bind(
            grnId,
            grnNumber,
            poId,
            poNo,
            supplier.id,
            supplier.name,
            docDate,
            stockedSubtotal,
            `Imported from historical PI ${docNo}`,
          ),
      );

      // GRN items + the rm_batches / cost_ledger / balanceQty cascade.
      // The grn.ts postGRNToStock() helper would normally do this on the
      // DRAFT → POSTED transition, but we're inserting straight as POSTED,
      // so we replicate the side-effects inline.
      const receivedIso = `${docDate}T00:00:00.000Z`;
      for (let i = 0; i < stockedItems.length; i++) {
        const it = stockedItems[i];
        statements.push(
          db
            .prepare(
              `INSERT INTO grn_items (grnId, poItemIndex, materialCode,
                 materialName, orderedQty, receivedQty, acceptedQty,
                 rejectedQty, rejectionReason, unitPrice)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
            )
            .bind(
              grnId,
              i,
              it.supplierSKU,
              it.materialName,
              it.qty,
              it.qty,
              it.qty,
              it.unitPriceSen,
            ),
        );

        if (!skipStock && it.rmId && it.qty > 0) {
          const batchId = `rmb-grn-${grnId}-${i + 1}`;
          const ledgerId = `cl-${crypto.randomUUID().slice(0, 8)}`;
          const totalCostSen = Math.round(it.qty * it.unitPriceSen);
          statements.push(
            db
              .prepare(
                `INSERT INTO rm_batches (id, rmId, source, sourceRefId,
                   receivedDate, originalQty, remainingQty, unitCostSen,
                   created_at, notes)
                 VALUES (?, ?, 'GRN', ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                batchId,
                it.rmId,
                grnId,
                receivedIso,
                it.qty,
                it.qty,
                it.unitPriceSen,
                nowIso,
                `GRN ${grnNumber} line ${i + 1}`,
              ),
            db
              .prepare(
                `INSERT INTO cost_ledger (id, date, type, itemType, itemId,
                   batchId, qty, direction, unitCostSen, totalCostSen,
                   refType, refId, notes)
                 VALUES (?, ?, 'RM_RECEIPT', 'RM', ?, ?, ?, 'IN', ?, ?,
                         'GRN', ?, ?)`,
              )
              .bind(
                ledgerId,
                receivedIso,
                it.rmId,
                batchId,
                it.qty,
                it.unitPriceSen,
                totalCostSen,
                grnId,
                `Received via ${grnNumber}`,
              ),
            db
              .prepare(
                "UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?",
              )
              .bind(it.qty, it.rmId),
          );
        }
      }

      // ----- PI -----
      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_invoices (id, piNo, purchaseOrderId, poRef,
               supplierId, supplierName, invoiceDate, dueDate, amountSen,
               status, remarks, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'APPROVED', ?, ?, ?)`,
          )
          .bind(
            piId,
            docNo,
            poId,
            poNo,
            supplier.id,
            supplier.name,
            docDate,
            piAmountSen,
            `Imported from historical PI ${docNo}; GRN ${grnNumber}`,
            nowIso,
            nowIso,
          ),
      );

      // ----- PI line items -----
      // Migration 0107 added purchase_invoice_items so we now persist the
      // per-line breakdown that was previously dropped on import. Stocked
      // items keep their materialCode link; non-stocked lines (fees, tax,
      // rebate, discount) are tagged with a heuristic line_type derived
      // from the description so the detail screen can render them as
      // labelled non-stock rows instead of stocked items.
      for (let i = 0; i < resolved.length; i++) {
        const it = resolved[i];
        const piItemId = `pii-${piId}-${i + 1}`;
        const lineTotal = Math.round(it.qty * it.unitPriceSen);
        let lineType: "STOCKED" | "FEE" | "TAX" | "REBATE" | "DISCOUNT" | "OTHER";
        if (it.rmId !== null) {
          lineType = "STOCKED";
        } else {
          const desc = it.materialName || "";
          if (/SST/i.test(desc)) lineType = "TAX";
          else if (/TRANSPORT|FEE|CHARGES/i.test(desc)) lineType = "FEE";
          else if (/REBATE/i.test(desc)) lineType = "REBATE";
          else if (/DISCOUNT/i.test(desc)) lineType = "DISCOUNT";
          else lineType = "OTHER";
        }
        statements.push(
          db
            .prepare(
              `INSERT INTO purchase_invoice_items (id, pi_id, material_code,
                 material_name, supplier_sku, qty, unit_price_sen,
                 line_total_sen, line_type, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
            )
            .bind(
              piItemId,
              piId,
              it.materialCode,
              it.materialName,
              it.supplierSKU,
              it.qty,
              it.unitPriceSen,
              lineTotal,
              lineType,
              nowIso,
            ),
        );
      }

      await db.batch(statements);

      posCreated++;
      grnsCreated++;
      pisCreated++;
      lineItemsTotal += resolved.length;
      documentsProcessed++;
    } catch (err) {
      errors.push({
        docNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----- Standalone PO seeding (original numbers, no GRN/PI/stock) -----
  for (const po of purchaseOrdersOnly) {
    const poNo = String(po?.poNo ?? "").trim();
    const docDate = String(po?.docDate ?? "").trim();
    const supplierCode = String(po?.supplierCode ?? "").trim();
    const itemsIn = Array.isArray(po?.items) ? po.items : [];

    if (!poNo || !docDate || !supplierCode || itemsIn.length === 0) {
      errors.push({
        docNo: poNo || "(missing)",
        message: "poNo, docDate, supplierCode, items required for purchaseOrders entry",
      });
      continue;
    }

    try {
      // Idempotency: skip if a purchase_orders row with this poNo already exists.
      const existingPo = await db
        .prepare("SELECT id FROM purchase_orders WHERE poNo = ? LIMIT 1")
        .bind(poNo)
        .first<{ id: string }>();
      if (existingPo) {
        skipped++;
        continue;
      }

      const supplier = await resolveSupplier(supplierCode);
      if (!supplier) {
        errors.push({
          docNo: poNo,
          message: `unknown supplier code ${supplierCode}`,
        });
        continue;
      }

      // Resolve items — look up RM for description; fall back to item description.
      const resolvedPoItems: Array<{
        materialName: string;
        supplierSKU: string;
        qty: number;
        unitPriceSen: number;
        lineTotal: number;
      }> = [];
      for (const it of itemsIn) {
        const qty = Number(it?.qty) || 0;
        const unitPriceSen = Math.round(Number(it?.unitPriceSen) || 0);
        const desc = String(it?.description ?? "").trim();
        const matCode = it?.materialCode ? String(it.materialCode).trim() : null;
        const supSku = String(it?.supplierSKU ?? matCode ?? "").trim();
        let materialName = desc;
        if (matCode) {
          const rmRow = await resolveRm(matCode);
          if (rmRow) materialName = rmRow.description;
        }
        resolvedPoItems.push({
          materialName: materialName || matCode || "",
          supplierSKU: supSku,
          qty,
          unitPriceSen,
          lineTotal: Math.round(qty * unitPriceSen),
        });
      }

      const subtotalSen = Math.round(
        resolvedPoItems.reduce((s, r) => s + r.qty * r.unitPriceSen, 0),
      );
      const nowIso = new Date().toISOString();
      const poId = `po-${crypto.randomUUID().slice(0, 8)}`;

      const poStatements: D1PreparedStatement[] = [];

      poStatements.push(
        db
          .prepare(
            `INSERT INTO purchase_orders (id, poNo, supplierId, supplierName,
               subtotalSen, totalSen, status, orderDate, expectedDate,
               receivedDate, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, NULL, ?, ?, ?)`,
          )
          .bind(
            poId,
            poNo,
            supplier.id,
            supplier.name,
            subtotalSen,
            subtotalSen,
            docDate,
            docDate,
            `Imported historical PO ${poNo}`,
            nowIso,
            nowIso,
          ),
      );

      for (let i = 0; i < resolvedPoItems.length; i++) {
        const it = resolvedPoItems[i];
        const poItemId = `poi-${crypto.randomUUID().slice(0, 8)}`;
        poStatements.push(
          db
            .prepare(
              `INSERT INTO purchase_order_items (id, purchaseOrderId,
                 materialCategory, materialName, supplierSKU, quantity,
                 unitPriceSen, totalSen, receivedQty, unit)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, 0, 'pcs')`,
            )
            .bind(
              poItemId,
              poId,
              it.materialName,
              it.supplierSKU,
              it.qty,
              it.unitPriceSen,
              it.lineTotal,
            ),
        );
      }

      await db.batch(poStatements);

      posOnlyCreated++;
      lineItemsTotal += resolvedPoItems.length;
    } catch (err) {
      errors.push({
        docNo: poNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    total: docs.length + purchaseOrdersOnly.length,
    documentsProcessed,
    posCreated,
    grnsCreated,
    pisCreated,
    posOnlyCreated,
    lineItemsTotal,
    skipped,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/migrate-do-from-excel?dryRun=true|false
//
// Bulk DO migration. Body: { entries: [{ custPO, doNo }, ...], deliveryDate?: "YYYY-MM-DD" }
//
// For each Cust_PO with a known DO number from the legacy Excel sheet:
//   1. Find the matching sales_order by customerPOId
//   2. Stamp ALL its production_orders' PACKING JCs as COMPLETED 2026-05-05
//   3. Insert a delivery_orders row with do_no = the legacy DO number,
//      status = LOADED (= "Dispatched" UI label per
//      src/pages/delivery/index.tsx:170-178)
//   4. Insert delivery_order_items rows mirroring each PO
//   5. Update the SO's status to DISPATCHED-equivalent (depends on enum)
//
// Idempotent: if a delivery_orders row already exists with that do_no, skip.
// ---------------------------------------------------------------------------
app.post("/migrate-do-from-excel", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "create");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);
  let body: { entries?: Array<{ custPO: string; doNo: string; dispatchDate?: string }>; deliveryDate?: string };
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: "Invalid JSON" }, 400); }
  const entries = (body?.entries ?? []).filter(e => typeof e?.custPO === "string" && typeof e?.doNo === "string" && e.custPO && e.doNo);
  if (entries.length === 0) {
    return c.json({ success: false, error: "Provide entries: [{custPO, doNo}, ...]" }, 400);
  }
  const defaultDeliveryDate = (body.deliveryDate ?? today).slice(0, 10);
  // Per-entry dispatchDate (from Aut/aiy DO Date column) is used for the DO's
  // dispatchedAt timestamp + JC completedDate. Fallback to body.deliveryDate
  // when not supplied.
  const dispatchDateByEntry = new Map<string, string>();
  for (const e of entries) {
    const k = `${e.custPO}|${e.doNo}`;
    if (e.dispatchDate) dispatchDateByEntry.set(k, String(e.dispatchDate).slice(0, 10));
  }

  // 1. Get every existing DO's (doNo, id) so we can append line items to
  //    an existing DO when the legacy Excel has multiple custPOs sharing
  //    one DO number (multi-SO-per-DO is common in the old system).
  const existingDoRes = await db
    .prepare(`SELECT id, doNo FROM delivery_orders`)
    .all<{ id: string; doNo: string }>();
  const existingDoMap = new Map<string, string>(
    (existingDoRes.results ?? []).map(r => [r.doNo, r.id]),
  );

  // 2. Pre-fetch all SOs (with customerPOId) + production_orders (with PACKING JCs) in 2 passes.
  const soRes = await db
    .prepare(
      `SELECT id, customerPOId, customerId, customerName, customerState,
              companySO, companySOId, hubId
         FROM sales_orders
        WHERE customerPOId IS NOT NULL AND customerPOId <> ''`,
    )
    .all<{
      id: string; customerPOId: string; customerId: string;
      customerName: string; customerState: string | null;
      companySO: string | null; companySOId: string | null; hubId: string | null;
    }>();
  const soByCustPo = new Map<string, typeof soRes.results[number]>();
  for (const s of (soRes.results ?? [])) {
    soByCustPo.set(s.customerPOId, s);
  }

  // 2b. Pre-fetch every PO that is already in some delivery_order_items row
  //     so we can skip custPOs already migrated (idempotency).
  const alreadyMigratedRes = await db
    .prepare(`SELECT DISTINCT productionOrderId FROM delivery_order_items WHERE productionOrderId IS NOT NULL`)
    .all<{ productionOrderId: string }>();
  const migratedPoIds = new Set<string>(
    (alreadyMigratedRes.results ?? []).map(r => r.productionOrderId),
  );

  type Plan = {
    custPO: string; doNo: string; soId?: string;
    customerId?: string; companySOId?: string;
    poIds: string[];
    packingJcsToStamp: Array<{ poId: string; jcId: string }>;
    upstreamJcsToStamp: Array<{ poId: string; jcId: string; departmentCode: string }>;
    skipReason?: string;
  };
  // When ?stampUpstream=true, also stamp non-PACKING JCs (FAB_CUT, FAB_SEW,
  // WOOD_CUT, FOAM, FRAMING, WEBBING, BONDING, UPHOLSTERY) as COMPLETED. Used
  // when the legacy system already shipped the goods but our digital twin's
  // upstream JCs are still WIP.
  const stampUpstream = c.req.query("stampUpstream") === "true";

  const plans: Plan[] = [];
  for (const e of entries) {
    const plan: Plan = { custPO: e.custPO, doNo: e.doNo, poIds: [], packingJcsToStamp: [], upstreamJcsToStamp: [] };
    const so = soByCustPo.get(e.custPO);
    if (!so) { plan.skipReason = "No matching SO"; plans.push(plan); continue; }
    plan.soId = so.id;
    plan.customerId = so.customerId;
    plan.companySOId = so.companySOId ?? undefined;
    // Find production_orders for this SO + their PACKING JCs.
    const poRes = await db
      .prepare(
        `SELECT id, poNo FROM production_orders
          WHERE salesOrderId = ?
            AND status NOT IN ('CANCELLED')`,
      )
      .bind(so.id)
      .all<{ id: string; poNo: string | null }>();
    const poIds = (poRes.results ?? []).map(p => p.id);
    // Idempotency: if every PO of this SO is already in delivery_order_items,
    // skip — this custPO was already migrated.
    if (poIds.length > 0 && poIds.every(id => migratedPoIds.has(id))) {
      plan.skipReason = "Already migrated";
      plans.push(plan);
      continue;
    }
    plan.poIds = poIds;
    if (poIds.length > 0) {
      const placeholders = poIds.map(() => "?").join(",");
      const jcRes = await db
        .prepare(
          `SELECT id, productionOrderId, status, completedDate, departmentCode
             FROM job_cards
            WHERE productionOrderId IN (${placeholders})`,
        )
        .bind(...poIds)
        .all<{ id: string; productionOrderId: string; status: string; completedDate: string | null; departmentCode: string }>();
      for (const jc of (jcRes.results ?? [])) {
        if (["COMPLETED","TRANSFERRED","CANCELLED"].includes(jc.status)) continue;
        if (jc.departmentCode === "PACKING") {
          plan.packingJcsToStamp.push({ poId: jc.productionOrderId, jcId: jc.id });
        } else if (stampUpstream) {
          plan.upstreamJcsToStamp.push({ poId: jc.productionOrderId, jcId: jc.id, departmentCode: jc.departmentCode });
        }
      }
    }
    plans.push(plan);
  }

  const usable = plans.filter(p => !p.skipReason);
  const skipped = plans.filter(p => p.skipReason);
  const summary = {
    entries: entries.length,
    noSoMatch: skipped.filter(p => p.skipReason === "No matching SO").length,
    alreadyMigrated: skipped.filter(p => p.skipReason === "Already migrated").length,
    usableCount: usable.length,
    totalPackingJcsToStamp: usable.reduce((s, p) => s + p.packingJcsToStamp.length, 0),
    totalUpstreamJcsToStamp: usable.reduce((s, p) => s + p.upstreamJcsToStamp.length, 0),
    totalPOsToBundle: usable.reduce((s, p) => s + p.poIds.length, 0),
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, summary,
      sample: usable.slice(0, 5).map(p => ({
        custPO: p.custPO, doNo: p.doNo,
        soId: p.soId, poIds: p.poIds, packingJcsCount: p.packingJcsToStamp.length,
      })),
    });
  }

  // Live execute. Per-plan: stamp PACKING JCs + INSERT or APPEND delivery_orders + items.
  // Multiple legacy custPOs commonly share one DO number (multi-SO-per-DO).
  // First entry with a given doNo creates the header; subsequent entries with
  // the same doNo append their items to the existing DO and update totals.
  let dosCreated = 0, dosAppendedTo = 0, packingStamped = 0, upstreamStamped = 0;
  const errors: Array<{ custPO: string; error: string }> = [];
  for (const plan of usable) {
    try {
      const stmts: ReturnType<D1Database["prepare"]>[] = [];
      const planKey = `${plan.custPO}|${plan.doNo}`;
      const planDispatchDate = dispatchDateByEntry.get(planKey) ?? defaultDeliveryDate;
      const planDispatchedAt = `${planDispatchDate}T00:00:00.000Z`;
      // Stamp upstream JCs (when stampUpstream=true) — use dispatch date so the
      // historical timeline is preserved (legacy DO date = when it was actually done).
      for (const j of plan.upstreamJcsToStamp) {
        stmts.push(
          db.prepare(
            `UPDATE job_cards SET status = 'COMPLETED', completedDate = ?, overdue = 'COMPLETED'
              WHERE id = ?`,
          ).bind(planDispatchDate, j.jcId),
        );
      }
      // Stamp PACKING JCs
      for (const j of plan.packingJcsToStamp) {
        stmts.push(
          db.prepare(
            `UPDATE job_cards SET status = 'COMPLETED', completedDate = ?, overdue = 'COMPLETED'
              WHERE id = ?`,
          ).bind(planDispatchDate, j.jcId),
        );
      }
      const so = soByCustPo.get(plan.custPO)!;
      const placeholders = plan.poIds.map(() => "?").join(",");
      const totalsRes = plan.poIds.length > 0
        ? await db.prepare(
            `SELECT COALESCE(SUM(po.quantity * COALESCE(p.unitM3, 0)), 0) AS totalM3,
                    COALESCE(SUM(po.quantity), 0) AS totalItems
               FROM production_orders po
               LEFT JOIN products p ON p.code = po.productCode
              WHERE po.id IN (${placeholders})`,
          ).bind(...plan.poIds).first<{ totalM3: number; totalItems: number }>()
        : { totalM3: 0, totalItems: 0 };

      let doId = existingDoMap.get(plan.doNo);
      const isAppend = !!doId;
      if (!doId) {
        doId = `do-${crypto.randomUUID().slice(0, 8)}`;
        stmts.push(
          db.prepare(
            `INSERT INTO delivery_orders
               (id, doNo, salesOrderId, companySO, companySOId, customerId,
                customerPOId, customerName, customerState, hubId,
                deliveryDate, totalM3, totalItems, status, dispatchedAt,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOADED', ?, ?, ?)`,
          ).bind(
            doId, plan.doNo, plan.soId ?? null, so.companySO, so.companySOId,
            so.customerId, plan.custPO, so.customerName, so.customerState ?? null,
            so.hubId ?? null, planDispatchDate, totalsRes?.totalM3 ?? 0,
            totalsRes?.totalItems ?? 0,
            planDispatchedAt,
            new Date().toISOString(), new Date().toISOString(),
          ),
        );
        existingDoMap.set(plan.doNo, doId);
      } else {
        // Append: increment totals on the existing DO header AND back-fill the
        // dispatchedAt/deliveryDate with the legacy DO date when the entry
        // carries one. Earlier runs without per-entry dispatchDate stamped
        // dispatchedAt = run-time, which the user wants overwritten with the
        // real legacy DO date.
        stmts.push(
          db.prepare(
            `UPDATE delivery_orders
                SET totalM3 = totalM3 + ?,
                    totalItems = totalItems + ?,
                    dispatchedAt = COALESCE(?, dispatchedAt),
                    deliveryDate = COALESCE(?, deliveryDate),
                    updated_at = ?
              WHERE id = ?`,
          ).bind(
            totalsRes?.totalM3 ?? 0,
            totalsRes?.totalItems ?? 0,
            dispatchDateByEntry.has(planKey) ? planDispatchedAt : null,
            dispatchDateByEntry.has(planKey) ? planDispatchDate : null,
            new Date().toISOString(),
            doId,
          ),
        );
      }
      // INSERT delivery_order_items — one per production_order
      if (plan.poIds.length > 0) {
        const poItemsRes = await db.prepare(
          `SELECT po.id, po.poNo, po.productCode, po.productName, po.sizeLabel,
                  po.fabricCode, po.quantity, po.rackingNumber, po.salesOrderNo,
                  COALESCE(p.unitM3, 0) AS unitM3
             FROM production_orders po
             LEFT JOIN products p ON p.code = po.productCode
            WHERE po.id IN (${placeholders})`,
        ).bind(...plan.poIds).all<{
          id: string; poNo: string | null; productCode: string | null;
          productName: string | null; sizeLabel: string | null;
          fabricCode: string | null; quantity: number;
          rackingNumber: string | null; salesOrderNo: string | null;
          unitM3: number;
        }>();
        for (const r of (poItemsRes.results ?? [])) {
          const itemId = `doi-${crypto.randomUUID().slice(0, 8)}`;
          stmts.push(
            db.prepare(
              `INSERT INTO delivery_order_items
                 (id, deliveryOrderId, productionOrderId, poNo, productCode,
                  productName, sizeLabel, fabricCode, quantity, itemM3,
                  rackingNumber, packingStatus, salesOrderNo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`,
            ).bind(
              itemId, doId, r.id, r.poNo ?? "", r.productCode ?? "",
              r.productName ?? "", r.sizeLabel ?? "", r.fabricCode ?? "",
              r.quantity, r.quantity * r.unitM3,
              r.rackingNumber ?? "", r.salesOrderNo ?? "",
            ),
          );
        }
      }
      // Update SO status to READY_TO_SHIP if not already past
      stmts.push(
        db.prepare(
          `UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ?
            WHERE id = ?
              AND status IN ('IN_PRODUCTION','CONFIRMED','DRAFT')`,
        ).bind(new Date().toISOString(), plan.soId ?? ""),
      );
      // Batch in groups of 50
      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50));
      }
      if (isAppend) dosAppendedTo++; else dosCreated++;
      packingStamped += plan.packingJcsToStamp.length;
      upstreamStamped += plan.upstreamJcsToStamp.length;
    } catch (err) {
      errors.push({ custPO: plan.custPO, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({
    success: true, dryRun: false, summary,
    dosCreated, dosAppendedTo, packingStamped, upstreamStamped,
    errorCount: errors.length, errors: errors.slice(0, 10),
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/revert-dos-to-draft
//
// One-shot test helper. Flips every LOADED DO back to DRAFT (= "Pending
// Dispatch" in the UI) so the user can re-test the dispatch flow on the
// previously-migrated DOs. Optionally back-fills dispatchedAt / deliveryDate
// from the legacy Aut/aiy DO Date map (body.dateMap = { doNo: "YYYY-MM-DD" }).
//
// Bypasses the regular PUT /api/delivery-orders/:id reversal logic — does NOT
// unstamp PACKING JCs (they stay COMPLETED, since the items physically ARE
// packed).
// ---------------------------------------------------------------------------
app.post("/revert-dos-to-draft", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  let body: { dateMap?: Record<string, string> } = {};
  try { body = await c.req.json(); } catch { /* allow empty body */ }
  const dateMap = body.dateMap ?? {};

  // Pull every LOADED DO
  const res = await db
    .prepare(`SELECT id, doNo, status, dispatchedAt FROM delivery_orders WHERE status = 'LOADED'`)
    .all<{ id: string; doNo: string; status: string; dispatchedAt: string | null }>();
  const loadedDOs = res.results ?? [];

  let reverted = 0;
  let datesBackfilled = 0;
  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  for (const d of loadedDOs) {
    const legacyDate = dateMap[d.doNo];
    if (legacyDate) {
      stmts.push(
        db.prepare(
          `UPDATE delivery_orders
              SET status = 'DRAFT',
                  dispatchedAt = ?,
                  deliveryDate = ?,
                  updated_at = ?
            WHERE id = ?`,
        ).bind(`${legacyDate}T00:00:00.000Z`, legacyDate, new Date().toISOString(), d.id),
      );
      datesBackfilled++;
    } else {
      stmts.push(
        db.prepare(
          `UPDATE delivery_orders
              SET status = 'DRAFT', updated_at = ?
            WHERE id = ?`,
        ).bind(new Date().toISOString(), d.id),
      );
    }
    reverted++;
  }
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50));
  }
  return c.json({
    success: true,
    loadedDOsFound: loadedDOs.length,
    reverted,
    datesBackfilled,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-so-reference
//
// One-shot fix for SOs created via the Scan PO modal before the
// `reference` field was wired up. The customer's Ref No was extracted by
// Claude into po_scan_samples but never landed on sales_orders. Walks
// every PO_SCAN_CLAUDE-source SO and copies yourRefNo from the matching
// po_scan_samples row (joined by customerPOId / poIdentifier) into
// sales_orders.reference. Idempotent: only fills when reference is empty.
//
// Will be deleted once the OCR migration window closes.
// ---------------------------------------------------------------------------
// One-shot backfill of sales_orders.hookkaExpectedDD = customerDeliveryDate - per-category buffer.
// Picks up SOs where the column was left empty (early OCR-flow deploys before
// the auto-derive fix landed, or any other path that skipped the calc).
// Idempotent: only fills empty values.
app.post("/backfill-so-expected-dd", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const buf = await loadHookkaDDBuffer(db);

  const targetsRes = await db
    .prepare(
      `SELECT so.id, so.customerDeliveryDate,
              (SELECT itemCategory FROM sales_order_items
                WHERE salesOrderId = so.id ORDER BY lineNo LIMIT 1) AS "firstCat"
         FROM sales_orders so
        WHERE so.orgId = ?
          AND (so.hookkaExpectedDD IS NULL OR so.hookkaExpectedDD = '')
          AND so.customerDeliveryDate IS NOT NULL
          AND so.customerDeliveryDate <> ''`,
    )
    .bind(orgId)
    .all<{ id: string; customerDeliveryDate: string; firstCat: string | null }>();
  const targets = targetsRes.results ?? [];

  let updated = 0;
  for (const t of targets) {
    const cat = t.firstCat || "BEDFRAME";
    const days = hookkaDDBufferFor(buf, cat);
    const expected = addDays(t.customerDeliveryDate.slice(0, 10), -days);
    await db
      .prepare("UPDATE sales_orders SET hookkaExpectedDD = ? WHERE id = ?")
      .bind(expected, t.id)
      .run();
    updated++;
  }

  return c.json({ success: true, targetsFound: targets.length, updated });
});

// Backfill sales_order_items.productName from product master where the
// stored name looks like the OCR's PDF description (contains common PDF
// markers like "HK", "COL:", or matches the productCode).
app.post("/backfill-so-item-product-name", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  // Note: Postgres lowercases unquoted identifiers, so aliases must be
  // double-quoted to round-trip as camelCase ("canonName" not "canonname").
  // Without the quotes, .all<{ canonName: string }>() returns undefined
  // for r.canonName and silently skips every row.
  const targetsRes = await db
    .prepare(
      `SELECT soi.id, soi.productCode, soi.productName, p.name AS "canonName"
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
         LEFT JOIN products p ON p.code = soi.productCode AND p.orgId = so.orgId
        WHERE so.orgId = ?
          AND soi.productCode IS NOT NULL AND soi.productCode <> ''
          AND p.name IS NOT NULL`,
    )
    .bind(orgId)
    .all<{ id: string; productCode: string; productName: string; canonName: string }>();
  const all = targetsRes.results ?? [];

  let updated = 0;
  for (const r of all) {
    // Only overwrite when current name looks like PDF junk:
    // - contains "HK" or "COL:" or "COLOUR:" (PDF description tokens)
    // - or matches productCode literally (which would mean no real name)
    // - or contains a slash (PDFs love slashes; product names don't)
    const looksJunk =
      /(?:^HK\d|COL:|COLOUR:|\/)/i.test(r.productName) ||
      r.productName === r.productCode ||
      r.productName === "";
    if (!looksJunk) continue;
    if (r.productName === r.canonName) continue;
    await db
      .prepare("UPDATE sales_order_items SET productName = ? WHERE id = ?")
      .bind(r.canonName, r.id)
      .run();
    updated++;
  }
  return c.json({ success: true, candidates: all.length, updated });
});

// ---------------------------------------------------------------------------
// POST /backfill-5543-co2606002 — ONE-SHOT (owner 2026-07-02). A phantom
// product code "5543-1C(LHF)" (never in the catalog) got onto consignment
// order CO-2606-002 and cascaded into its production order, finished units,
// CN lines and stock movements. The owner corrected the 5543 BOM in the
// catalog and wants the existing chain relabelled to the real "5543-1B(LHF)".
//
// Only the DENORMALISED product_code / product_name snapshots are touched, in
// the 5 tables that carry them. job_cards / wip_items key off wip_code (NOT the
// product code) so they are deliberately untouched, and the pieces breakdown is
// derived LIVE from the (now-fixed) BOM at print time — so nothing is
// re-exploded and no completed production is destroyed.
//
// AUDIT-FIRST: with no body it only REPORTS what it would change (read-only).
// To apply, POST { "apply": true, "confirm": "5543-1B" }. Idempotent — a second
// run finds zero phantom rows.
app.post("/backfill-5543-co2606002", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;

  const OLD = "5543-1C(LHF)";
  const NEW = "5543-1B(LHF)";
  const CO_NO = "CO-2606-002";

  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const doApply = body.apply === true && body.confirm === "5543-1B";

  // Resolve the consignment order by its Hookka number.
  const co = await db
    .prepare('SELECT id AS "id" FROM consignment_orders WHERE company_co_id = ?')
    .bind(CO_NO)
    .first<{ id: string }>();
  if (!co?.id)
    return c.json({ success: false, error: `Consignment order ${CO_NO} not found` }, 404);
  const coId = co.id;

  // Canonical new name + guard that the replacement code EXISTS in the catalog
  // (else the live BOM/pieces lookup by code breaks after relabelling).
  const prod = await db
    .prepare('SELECT name AS "name" FROM products WHERE code = ?')
    .bind(NEW)
    .first<{ name: string }>();
  const newName = prod?.name ?? null;
  const newCodeInCatalog = !!prod;

  // POs + CNs under this CO (ids only) to scope the downstream snapshot tables.
  const posRes = await db
    .prepare('SELECT id AS "id" FROM production_orders WHERE consignment_order_id = ?')
    .bind(coId)
    .all<{ id: string }>();
  const poIds = (posRes.results ?? []).map((p) => p.id);
  const cnsRes = await db
    .prepare('SELECT id AS "id" FROM consignment_notes WHERE consignment_order_id = ?')
    .bind(coId)
    .all<{ id: string }>();
  const cnIds = (cnsRes.results ?? []).map((r) => r.id);

  const inList = (arr: string[]) => arr.map(() => "?").join(",");

  // Each snapshot table + how to scope it to THIS CO's chain.
  type Target = { table: string; scopeSql: string; scopeBind: string[] };
  const targets: Target[] = [
    { table: "consignment_order_items", scopeSql: "consignment_order_id = ?", scopeBind: [coId] },
    { table: "production_orders", scopeSql: "consignment_order_id = ?", scopeBind: [coId] },
  ];
  if (poIds.length) {
    targets.push({ table: "fg_units", scopeSql: `po_id IN (${inList(poIds)})`, scopeBind: poIds });
    targets.push({ table: "stock_movements", scopeSql: `production_order_id IN (${inList(poIds)})`, scopeBind: poIds });
  }
  // CN lines link either by PO id or by CN id — cover both.
  if (poIds.length || cnIds.length) {
    const parts: string[] = [];
    const binds: string[] = [];
    if (poIds.length) { parts.push(`production_order_id IN (${inList(poIds)})`); binds.push(...poIds); }
    if (cnIds.length) { parts.push(`consignment_note_id IN (${inList(cnIds)})`); binds.push(...cnIds); }
    targets.push({ table: "consignment_items", scopeSql: `(${parts.join(" OR ")})`, scopeBind: binds });
  }

  // AUDIT every target (read-only): the exact rows carrying the phantom code,
  // plus the DISTINCT codes present so OLD can be confirmed to match precisely.
  type RowVM = { id: string; productCode: string | null; productName: string | null };
  const report: Array<{
    table: string;
    distinctCodesInChain: string[];
    phantomRows: RowVM[];
    updated?: number;
  }> = [];
  let totalPhantom = 0;
  for (const t of targets) {
    const distinctRes = await db
      .prepare(`SELECT DISTINCT product_code AS "productCode" FROM ${t.table} WHERE ${t.scopeSql}`)
      .bind(...t.scopeBind)
      .all<{ productCode: string | null }>();
    const rowsRes = await db
      .prepare(`SELECT id AS "id", product_code AS "productCode", product_name AS "productName" FROM ${t.table} WHERE ${t.scopeSql} AND product_code = ?`)
      .bind(...t.scopeBind, OLD)
      .all<RowVM>();
    const phantomRows = rowsRes.results ?? [];
    totalPhantom += phantomRows.length;
    report.push({
      table: t.table,
      distinctCodesInChain: (distinctRes.results ?? [])
        .map((r) => r.productCode ?? "")
        .filter(Boolean),
      phantomRows,
    });
  }

  if (!doApply) {
    return c.json({
      success: true,
      mode: "audit",
      co: { number: CO_NO, id: coId },
      old: OLD,
      new: NEW,
      newName,
      newCodeInCatalog,
      poCount: poIds.length,
      cnCount: cnIds.length,
      totalPhantomRows: totalPhantom,
      report,
      note: newCodeInCatalog
        ? 'Review phantomRows. To apply, POST { "apply": true, "confirm": "5543-1B" }.'
        : `REFUSING to apply: replacement code ${NEW} is NOT in the products catalog — fix the catalog/BOM first or the live pieces lookup will break.`,
    });
  }

  // APPLY — refuse if the replacement code isn't a real catalog product.
  if (!newCodeInCatalog || !newName) {
    return c.json(
      { success: false, error: `Replacement code ${NEW} not found in products catalog; aborting.` },
      400,
    );
  }
  for (const t of targets) {
    await db
      .prepare(`UPDATE ${t.table} SET product_code = ?, product_name = ? WHERE ${t.scopeSql} AND product_code = ?`)
      .bind(NEW, newName, ...t.scopeBind, OLD)
      .run();
    const entry = report.find((r) => r.table === t.table);
    if (entry) entry.updated = entry.phantomRows.length;
  }
  return c.json({
    success: true,
    mode: "apply",
    co: { number: CO_NO, id: coId },
    old: OLD,
    new: NEW,
    newName,
    totalPhantomRows: totalPhantom,
    report,
  });
});

// ---------------------------------------------------------------------------
// POST /create-updated-at-indexes — ONE-SHOT (owner 2026-07-04, IT-hygiene
// audit follow-up). The dashboard snapshot freshness probe runs
// MAX(updated_at) across its source tables on every read; ~15 tables carry an
// updated_at column with NO index on it, so each probe is a sequential scan
// that gets linearly slower as data grows. SELF-DISCOVERING: asks Postgres
// which public tables have an updated_at column but no index covering it —
// no hardcoded list to go stale. Plain CREATE INDEX briefly locks writes; the
// tables are small (ms-scale builds), and IF NOT EXISTS keeps it idempotent.
// AUDIT-FIRST — apply with { "apply": true, "confirm": "indexes" }.
app.post("/create-updated-at-indexes", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;
  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const apply = body.apply === true && body.confirm === "indexes";

  const res = await db
    .prepare(
      `SELECT c.table_name AS "tableName",
              EXISTS (
                SELECT 1 FROM pg_indexes i
                 WHERE i.schemaname = 'public'
                   AND i.tablename = c.table_name
                   AND i.indexdef ILIKE '%(updated_at%'
              ) AS "hasIndex"
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`,
    )
    .all<{ tableName: string; hasIndex: boolean }>();
  const all = res.results ?? [];
  const missing = all.filter(
    (r) => !r.hasIndex && /^[a-z0-9_]+$/.test(r.tableName),
  );

  if (!apply) {
    return c.json({
      success: true,
      apply: false,
      tablesWithUpdatedAt: all.length,
      alreadyIndexed: all.length - missing.length,
      missing: missing.map((m) => m.tableName),
      note: 'Audit only. Apply with { "apply": true, "confirm": "indexes" }.',
    });
  }

  const created: string[] = [];
  const failed: Array<{ table: string; error: string }> = [];
  for (const m of missing) {
    try {
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_${m.tableName}_updated_at ON ${m.tableName} (updated_at)`,
        )
        .run();
      created.push(m.tableName);
    } catch (err) {
      failed.push({
        table: m.tableName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return c.json({ success: true, apply: true, created, failed });
});

// POST /backfill-punch-autofill-blocked — ONE-SHOT (owner 2026-07-04).
// Repairs the days already bitten by the punch-autofill safety-gate bug: an
// APPROVED non-production request row that landed BEFORE the worker's
// punch-out made the blanket COUNT(*) gate skip the whole day, so the punched
// hours were never logged (the "AUNG KYAW SOE 1.33h day"). Candidates =
// punched days whose working_hour_entries are ALL "Non-production (approved)"
// rows. Apply re-runs the (now fixed) autofill for exactly those days — it
// generates the punch rows minus the hours the approval already claimed, and
// still never touches any day that has office-keyed or auto rows.
// AUDIT-FIRST — apply with { "apply": true, "confirm": "autofill" }.
app.post("/backfill-punch-autofill-blocked", async (c) => {
  const denied = await requirePermission(c, "users", "create");
  if (denied) return denied;
  const db = c.var.DB;

  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const apply = body.apply === true && body.confirm === "autofill";

  const cands = await db
    .prepare(
      `SELECT a.id AS "attendanceId", a.employeeId AS "workerId", a.date,
              a.clockIn AS "clockIn", a.clockOut AS "clockOut",
              w.name AS "workerName", w.departmentCode AS "homeDeptCode",
              (SELECT COALESCE(SUM(e.hours), 0) FROM working_hour_entries e
                WHERE e.attendanceId = a.id) AS "nonProdHours"
         FROM attendance_records a
         JOIN workers w ON w.id = a.employeeId
        WHERE a.clockIn IS NOT NULL AND a.clockOut IS NOT NULL
          AND EXISTS (SELECT 1 FROM working_hour_entries e WHERE e.attendanceId = a.id)
          AND NOT EXISTS (
            SELECT 1 FROM working_hour_entries e
             WHERE e.attendanceId = a.id
               AND e.notes NOT LIKE 'Non-production (approved)%'
          )
        ORDER BY a.date, w.name`,
    )
    .all<{
      attendanceId: string;
      workerId: string;
      date: string;
      clockIn: string;
      clockOut: string;
      workerName: string;
      homeDeptCode: string | null;
      nonProdHours: number;
    }>();
  const days = cands.results ?? [];

  if (!apply) {
    return c.json({
      success: true,
      apply: false,
      count: days.length,
      days: days.map((d) => ({
        worker: d.workerName,
        date: d.date,
        punch: `${d.clockIn}→${d.clockOut}`,
        nonProdApprovedHours: Number(d.nonProdHours) || 0,
      })),
      note: 'Audit only. Apply with { "apply": true, "confirm": "autofill" }.',
    });
  }

  const results: Array<{ worker: string; date: string; created: number }> = [];
  for (const d of days) {
    try {
      const r = await autofillWorkingHoursFromPunch(db, {
        attendanceId: d.attendanceId,
        workerId: d.workerId,
        date: d.date,
        clockIn: d.clockIn,
        clockOut: d.clockOut,
        homeDeptCode: d.homeDeptCode,
      });
      results.push({ worker: d.workerName, date: d.date, created: r.created });
    } catch (err) {
      console.error("[backfill-punch-autofill-blocked] failed", {
        attendanceId: d.attendanceId,
        err: err instanceof Error ? err.message : String(err),
      });
      results.push({ worker: d.workerName, date: d.date, created: -1 });
    }
  }
  return c.json({ success: true, apply: true, count: days.length, results });
});

// POST /backfill-complete-stray-jc-co2606002 — ONE-SHOT (owner 2026-07-03).
// The 5543 production order pord-co-72dcea0a-01 is stuck PENDING because ONE
// junk job card is WAITING: a leftover from the OLD broken 5543 BOM whose
// wip_key still reads "5543-1C(LHF)::…::Base {MODULE}" with the unexpanded
// {MODULE} template placeholder. The physical sofa is done (the other 12 cards
// are COMPLETED). This marks that ONE stray card COMPLETED and recomputes so
// the PO flips to COMPLETED. It touches ONLY that card, creates no inventory
// (the finished unit already exists), and refuses to run unless the target is
// genuinely the WAITING {MODULE} junk card. AUDIT-FIRST — apply with
// { "apply": true, "confirm": "complete-jc" }.
app.post("/backfill-complete-stray-jc-co2606002", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;

  const PO_ID = "pord-co-72dcea0a-01";
  const JC_ID = "jc-1vxvn3i011nbi7-05";

  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const doApply = body.apply === true && body.confirm === "complete-jc";

  const jc = await db
    .prepare(
      'SELECT id AS "id", status AS "status", wip_key AS "wipKey", wip_label AS "wipLabel", completed_date AS "completedDate" FROM job_cards WHERE id = ? AND production_order_id = ?',
    )
    .bind(JC_ID, PO_ID)
    .first<{
      id: string;
      status: string;
      wipKey: string | null;
      wipLabel: string | null;
      completedDate: string | null;
    }>();
  const poBefore = await db
    .prepare('SELECT status AS "status", completed_date AS "completedDate" FROM production_orders WHERE id = ?')
    .bind(PO_ID)
    .first<{ status: string; completedDate: string | null }>();
  if (!jc || !poBefore)
    return c.json({ success: false, error: "job card or PO not found" }, 404);

  // Only ever touch the genuine junk card: WAITING + the {MODULE} placeholder.
  const isJunk =
    jc.status === "WAITING" && String(jc.wipKey ?? "").includes("{MODULE}");

  if (!doApply) {
    return c.json({
      success: true,
      mode: "audit",
      po: { id: PO_ID, status: poBefore.status },
      strayCard: jc,
      isJunkWaitingCard: isJunk,
      note: isJunk
        ? 'Target is the junk WAITING {MODULE} card. To apply, POST { "apply": true, "confirm": "complete-jc" }.'
        : "Target is NOT a junk WAITING {MODULE} card — refusing to change it.",
    });
  }

  if (!isJunk)
    return c.json(
      { success: false, error: "Target is not the expected junk WAITING {MODULE} card; aborting." },
      400,
    );

  // Stamp with the latest real sibling completion date so it reads sensibly.
  const maxRow = await db
    .prepare('SELECT MAX(completed_date) AS "maxDate" FROM job_cards WHERE production_order_id = ? AND completed_date IS NOT NULL')
    .bind(PO_ID)
    .first<{ maxDate: string | null }>();
  const doneDate = maxRow?.maxDate || new Date().toISOString().slice(0, 10);

  await db
    .prepare("UPDATE job_cards SET status = 'COMPLETED', completed_date = ? WHERE id = ? AND status = 'WAITING'")
    .bind(doneDate, JC_ID)
    .run();
  const recompute = await recomputePoStatusAndProgress(db, PO_ID);

  const poAfter = await db
    .prepare('SELECT status AS "status", completed_date AS "completedDate", progress AS "progress" FROM production_orders WHERE id = ?')
    .bind(PO_ID)
    .first<{ status: string; completedDate: string | null; progress: number }>();
  return c.json({
    success: true,
    mode: "apply",
    jcId: JC_ID,
    completedDate: doneDate,
    poBefore: poBefore.status,
    poAfter,
    recompute,
  });
});

// Cascade-backfill productName/sizeLabel/sizeCode/fabricCode to downstream
// snapshot tables (production_orders, delivery_order_items, invoice_items)
// from the canonical sales_order_items values. Run AFTER
// /backfill-ocr-so-fields so SO items are clean first.
app.post("/backfill-downstream-product-names", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  const cleanItems = await db
    .prepare(
      `SELECT soi.salesOrderId, soi.lineNo, soi.productCode, soi.productName,
              soi.sizeLabel, soi.sizeCode, soi.fabricCode
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE so.orgId = ?`,
    )
    .bind(orgId)
    .all<{
      salesOrderId: string;
      lineNo: number;
      productCode: string | null;
      productName: string | null;
      sizeLabel: string | null;
      sizeCode: string | null;
      fabricCode: string | null;
    }>();

  let poUpdated = 0;
  let doUpdated = 0;
  let invUpdated = 0;

  for (const item of cleanItems.results ?? []) {
    if (!item.productName) continue;
    const poRes = await db
      .prepare(
        `UPDATE production_orders SET productName = ?, sizeLabel = ?, sizeCode = ?, fabricCode = ?
           WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(
        item.productName,
        item.sizeLabel ?? "",
        item.sizeCode ?? "",
        item.fabricCode ?? "",
        item.salesOrderId,
        item.lineNo,
      )
      .run()
      .catch(() => ({ meta: { changes: 0 } }));
    poUpdated += poRes.meta?.changes ?? 0;

    const doRes = await db
      .prepare(
        `UPDATE delivery_order_items SET productName = ?, sizeLabel = ?, sizeCode = ?, fabricCode = ?
           WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(
        item.productName,
        item.sizeLabel ?? "",
        item.sizeCode ?? "",
        item.fabricCode ?? "",
        item.salesOrderId,
        item.lineNo,
      )
      .run()
      .catch(() => ({ meta: { changes: 0 } }));
    doUpdated += doRes.meta?.changes ?? 0;

    const invRes = await db
      .prepare(
        `UPDATE invoice_items SET productName = ?
           WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(item.productName, item.salesOrderId, item.lineNo)
      .run()
      .catch(() => ({ meta: { changes: 0 } }));
    invUpdated += invRes.meta?.changes ?? 0;
  }

  return c.json({
    success: true,
    cleanItemsScanned: cleanItems.results?.length ?? 0,
    productionOrdersUpdated: poUpdated,
    deliveryOrderItemsUpdated: doUpdated,
    invoiceItemsUpdated: invUpdated,
  });
});

app.post("/backfill-so-reference", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const orgId = getOrgId(c);

  // SOs that need either reference OR customerSOId. Match any with
  // empty value so re-runs don't clobber operator-edited values.
  const targetsRes = await db
    .prepare(
      `SELECT id, customerPOId, reference, customerSOId
         FROM sales_orders
        WHERE orgId = ?
          AND ((reference IS NULL OR reference = '')
               OR (customerSOId IS NULL OR customerSOId = ''))
          AND customerPOId IS NOT NULL
          AND customerPOId <> ''`,
    )
    .bind(orgId)
    .all<{ id: string; customerPOId: string; reference: string | null; customerSOId: string | null }>();
  const targets = targetsRes.results ?? [];

  let updatedReference = 0;
  let updatedCustomerSO = 0;
  const skipped: { soId: string; customerPO: string; reason: string }[] = [];

  for (const t of targets) {
    const sampleRes = await db
      .prepare(
        `SELECT correctedJson, rawExtracted
           FROM po_scan_samples
          WHERE poIdentifier = ?
          ORDER BY createdAt DESC
          LIMIT 1`,
      )
      .bind(t.customerPOId)
      .first<{ correctedJson: string | null; rawExtracted: string | null }>();
    if (!sampleRes) {
      skipped.push({ soId: t.id, customerPO: t.customerPOId, reason: "no sample" });
      continue;
    }

    const blob = sampleRes.correctedJson || sampleRes.rawExtracted || "";
    let parsed: { yourRefNo?: unknown; customerSO?: unknown };
    try {
      parsed = JSON.parse(blob) as { yourRefNo?: unknown; customerSO?: unknown };
    } catch {
      skipped.push({ soId: t.id, customerPO: t.customerPOId, reason: "bad JSON" });
      continue;
    }

    const newRef =
      typeof parsed.yourRefNo === "string" && parsed.yourRefNo
        ? parsed.yourRefNo
        : null;
    const newCustSO =
      typeof parsed.customerSO === "string" && parsed.customerSO
        ? parsed.customerSO
        : null;

    if (!newRef && !newCustSO) {
      skipped.push({ soId: t.id, customerPO: t.customerPOId, reason: "no fields" });
      continue;
    }

    if (newRef && (!t.reference || t.reference === "")) {
      await db
        .prepare("UPDATE sales_orders SET reference = ? WHERE id = ?")
        .bind(newRef, t.id)
        .run();
      updatedReference++;
    }
    if (newCustSO && (!t.customerSOId || t.customerSOId === "")) {
      await db
        .prepare("UPDATE sales_orders SET customerSOId = ? WHERE id = ?")
        .bind(newCustSO, t.id)
        .run();
      updatedCustomerSO++;
    }
  }

  return c.json({
    success: true,
    targetsFound: targets.length,
    updatedReference,
    updatedCustomerSO,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-ocr-so-fields
//
// One-shot cleanup for SOs created via the Scan PO modal before the
// catalog-bound rule was enforced (commits ea7f08b, 83a699a, and the
// follow-up scan-po-modal cleanup). The earlier OCR path persisted PDF
// text directly into category-A fields (productName, sizeLabel, sizeCode,
// fabricId, specialOrder), which now diverge from the catalog values
// after a maintenance edit.
//
// What it does (idempotent — only rewrites obvious wrongs):
//   1. Targets sales_order_items belonging to SOs that look OCR-created:
//        - parent SO has customerPOImageB64 NOT NULL (proxy for
//          PO_SCAN_CLAUDE source — added in migration 0108), OR
//        - productName matches one of the junk patterns (literal
//          productCode, contains "/", "HK", "COL:", "COLOUR:").
//   2. Re-resolves productName / sizeCode / sizeLabel from products.code.
//   3. For SOFA items: snaps sizeLabel to the quoted '28"' shape the
//      Edit dropdown keys against; fills sizeCode from sizeLabel if blank.
//   4. Cleans specialOrder: drops any comma-token that doesn't appear in
//      the variants-config catalog (Specials list, scoped per category).
//      Tokens are matched case-insensitively but stored with the catalog
//      casing. Empty result becomes "".
//
// Returns: { candidates, productNameUpdated, sizeUpdated,
//            specialOrderCleaned }.
//
// 2026-05-09: fabricId backfill step removed — picker now keys on
// fabricCode directly; sales_order_items.fabricId column is being dropped.
//
// Permission: sales-orders:update (same gate as the PATCH handler).
// ---------------------------------------------------------------------------
app.post("/backfill-ocr-so-fields", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  // ----- 1. Load variants-config Specials lists (per category) -----------
  // Same shape the scan-po catalog endpoint reads. Tolerant of both string
  // entries and {value:...} priced-option entries.
  const cfgRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("variants-config")
    .first<{ value: string }>();

  const extractValues = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x: unknown) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object" && "value" in x) {
          const v = (x as { value?: unknown }).value;
          return typeof v === "string" ? v : "";
        }
        return "";
      })
      .filter(Boolean);
  };
  let bedframeSpecials: string[] = [];
  let sofaSpecials: string[] = [];
  if (cfgRow?.value) {
    try {
      const cfg = JSON.parse(cfgRow.value) as Record<string, unknown>;
      bedframeSpecials = extractValues(cfg.specials);
      sofaSpecials = extractValues(cfg.sofaSpecials);
    } catch {
      // Bad JSON — leave catalogs empty. We'll skip specialOrder cleaning
      // entirely (safer than dropping all tokens).
    }
  }

  // ----- 2. Find candidate items ----------------------------------------
  // Two-track match:
  //   a) parent SO has a PO image (definitive OCR signal)
  //   b) productName looks like PDF junk (catches old rows from before
  //      the image column existed in migration 0108)
  // Diagnostic: drop the p.orgId = so.orgId condition so we can see if the
  // join was failing only because of that (single-tenant deploys still
  // resolve correctly; cross-tenant collisions on identical productCode
  // are vanishingly unlikely in this codebase).
  const targetsRes = await db
    .prepare(
      `SELECT soi.id,
              soi.productCode,
              soi.productName,
              soi.itemCategory,
              soi.sizeCode,
              soi.sizeLabel,
              soi.fabricCode,
              soi.specialOrder,
              p.id   AS "canonProductId",
              p.name AS "canonName",
              p.sizeCode  AS "canonSizeCode",
              p.sizeLabel AS "canonSizeLabel",
              p.category  AS "canonCategory"
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
         LEFT JOIN products p ON p.code = soi.productCode
        WHERE so.orgId = ?
          AND (so.customerPOImageB64 IS NOT NULL
               OR soi.productName = soi.productCode
               OR soi.productName LIKE '%/%'
               OR soi.productName LIKE 'HK%'
               OR soi.productName LIKE '%COL:%'
               OR soi.productName LIKE '%COLOUR:%')`,
    )
    .bind(orgId)
    .all<{
      id: string;
      productCode: string | null;
      productName: string | null;
      itemCategory: string | null;
      sizeCode: string | null;
      sizeLabel: string | null;
      fabricCode: string | null;
      specialOrder: string | null;
      canonProductId: string | null;
      canonName: string | null;
      canonSizeCode: string | null;
      canonSizeLabel: string | null;
      canonCategory: string | null;
    }>();
  const candidates = targetsRes.results ?? [];

  let productNameUpdated = 0;
  let sizeUpdated = 0;
  let specialOrderCleaned = 0;
  let nullCanonName = 0;
  let alreadyMatches = 0;
  const notUpdatedSamples: { code: string; name: string; canonName: string | null }[] = [];

  // 2026-05-09: fabricId resolve removed. Picker now keys on fabricCode
  // directly so no client-side namespace translation is needed; the
  // sales_order_items.fabricId column is being dropped.

  for (const r of candidates) {
    // -- productName -----------------------------------------------------
    const looksJunk =
      r.productName === "" ||
      r.productName === null ||
      (r.productCode && r.productName === r.productCode) ||
      (r.productName != null &&
        /(?:^HK\d|COL:|COLOUR:|\/)/i.test(r.productName));
    if (looksJunk && r.canonName && r.productName !== r.canonName) {
      await db
        .prepare("UPDATE sales_order_items SET productName = ? WHERE id = ?")
        .bind(r.canonName, r.id)
        .run();
      productNameUpdated++;
    } else if (looksJunk) {
      // Diagnostic: this row should have been updated but wasn't.
      if (!r.canonName) {
        nullCanonName++;
        if (notUpdatedSamples.length < 5) {
          notUpdatedSamples.push({
            code: r.productCode ?? "",
            name: r.productName ?? "",
            canonName: r.canonName,
          });
        }
      } else {
        alreadyMatches++;
      }
    }

    // -- size (sizeCode / sizeLabel) ------------------------------------
    // Only rewrite when the stored value is empty OR clearly wrong (sofa
    // stored as bare number "28" → snap to '28"'; or junky bedframe size
    // like "5FT/QUEEN" mismatched against the catalog).
    const isSofa =
      (r.itemCategory ?? r.canonCategory) === "SOFA";
    let newSizeLabel = r.sizeLabel ?? "";
    let newSizeCode = r.sizeCode ?? "";

    if (!newSizeLabel && r.canonSizeLabel) newSizeLabel = r.canonSizeLabel;
    if (!newSizeCode && r.canonSizeCode) newSizeCode = r.canonSizeCode;

    if (isSofa && newSizeLabel && /^\d+(\.\d+)?$/.test(newSizeLabel.trim())) {
      newSizeLabel = `${newSizeLabel.trim()}"`;
    }
    if (isSofa && !newSizeCode && newSizeLabel) {
      newSizeCode = newSizeLabel.replace(/"/g, "").trim();
    }
    // SOFA sizeCode should be the numeric seat height ("24"), NOT the
    // catalog variant tag ("1A(LHF)"). The old POST path fell back to
    // resolvedProduct.sizeCode (which IS the variant tag for SOFA
    // products) whenever the client didn't send sizeCode. Heal those:
    // when sizeCode contains letters/parens but sizeLabel is a clean
    // numeric value, derive numeric sizeCode from sizeLabel.
    if (isSofa && newSizeCode && newSizeLabel) {
      const looksVariantTag = /[A-Za-z()]/.test(newSizeCode);
      const labelStripped = newSizeLabel.replace(/"/g, "").trim();
      const labelLooksNumeric = /^\d+(\.\d+)?$/.test(labelStripped);
      if (looksVariantTag && labelLooksNumeric) {
        newSizeCode = labelStripped;
      }
    }

    // BEDFRAME junk fix — when sizeLabel got back-doored as the productCode
    // suffix (e.g. "(K)" instead of catalog's "6FT"), snap it to canon.
    // Triggers when sizeLabel is wrapped in parens AND its inner content
    // matches sizeCode — that's the OCR-suffix-copy signature.
    if (!isSofa && newSizeLabel && r.canonSizeLabel) {
      const inner = newSizeLabel.replace(/^\(|\)$/g, "").trim();
      const looksLikeSuffix =
        /^\(.+\)$/.test(newSizeLabel) &&
        (inner === (r.sizeCode ?? "") ||
          inner === (r.canonSizeCode ?? "") ||
          inner.toUpperCase() === (r.canonSizeCode ?? "").toUpperCase());
      if (looksLikeSuffix) {
        newSizeLabel = r.canonSizeLabel;
      }
    }
    const sizeChanged =
      newSizeLabel !== (r.sizeLabel ?? "") ||
      newSizeCode !== (r.sizeCode ?? "");
    if (sizeChanged) {
      await db
        .prepare(
          "UPDATE sales_order_items SET sizeLabel = ?, sizeCode = ? WHERE id = ?",
        )
        .bind(newSizeLabel, newSizeCode, r.id)
        .run();
      sizeUpdated++;
    }

    // 2026-05-09: fabricId backfill removed — column being dropped.

    // -- specialOrder cleaning ------------------------------------------
    // Only when we have a catalog loaded — otherwise we'd risk wiping
    // valid values just because the kv_config row is unreadable.
    if (r.specialOrder && r.specialOrder.trim() !== "") {
      const specialList = isSofa ? sofaSpecials : bedframeSpecials;
      if (specialList.length > 0) {
        const tokens = r.specialOrder
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const cleaned: string[] = [];
        for (const t of tokens) {
          const match = specialList.find(
            (c) => c.toLowerCase() === t.toLowerCase(),
          );
          if (match) cleaned.push(match);
        }
        const cleanedStr = cleaned.join(", ");
        if (cleanedStr !== r.specialOrder) {
          await db
            .prepare(
              "UPDATE sales_order_items SET specialOrder = ? WHERE id = ?",
            )
            .bind(cleanedStr, r.id)
            .run();
          specialOrderCleaned++;
        }
      }
    }
  }

  return c.json({
    success: true,
    candidates: candidates.length,
    productNameUpdated,
    sizeUpdated,
    specialOrderCleaned,
    nullCanonName,
    alreadyMatches,
    notUpdatedSamples,
  });
});

// (Removed 2026-05-09) POST /api/import/backfill-sofa-sizelabel-quote
//   added inch quotes to bare-numeric SOFA sizeLabel rows ('30' → '30"').
//   Reversed direction in DUP-001: the kv_config.sofaSizes dropdown source
//   is bare numerics, so the bare-numeric form IS canonical and the quoted
//   form was the dirty side. The 518-row backfill in commit af372e8
//   stripped quotes from the legacy quoted rows; running this endpoint
//   again would re-introduce the same drift. Deleted.

// One-shot migration (2026-05): SOFA items with non-standard sizeLabel
// (e.g. "12", "44", '24" x 37"', "24 X 24") get the size moved into the
// specialOrder field and sizeLabel cleared. Lets us drop those values
// from kv_config.sofaSizes without orphaning the source SOs. Standard
// seat heights (24"/26"/28"/30"/32"/35") are untouched.
app.post("/migrate-nonstandard-sofa-sizes", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  const STANDARD_SIZES = new Set([
    '24"', '26"', '28"', '30"', '32"', '35"',
    "24", "26", "28", "30", "32", "35",
  ]);

  const targets = await db
    .prepare(
      `SELECT soi.id, soi.salesOrderId, soi.lineNo, soi.productCode,
              soi.sizeLabel, soi.sizeCode, soi.specialOrder
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE so.orgId = ?
          AND soi.itemCategory = 'SOFA'
          AND soi.sizeLabel IS NOT NULL
          AND soi.sizeLabel <> ''`,
    )
    .bind(orgId)
    .all<{
      id: string;
      salesOrderId: string;
      lineNo: number;
      productCode: string | null;
      sizeLabel: string | null;
      sizeCode: string | null;
      specialOrder: string | null;
    }>();

  const migrated: Array<{
    soId: string;
    line: number;
    code: string | null;
    oldSize: string;
    newSpecialOrder: string;
  }> = [];

  for (const r of targets.results ?? []) {
    const sl = (r.sizeLabel ?? "").trim();
    if (!sl) continue;
    if (STANDARD_SIZES.has(sl)) continue;

    // Build the spec token. Prefer the more descriptive sizeLabel form
    // ("24" x 37"") over the bare sizeCode.
    const token = `Custom Size ${sl}`;
    const existing = (r.specialOrder ?? "").trim();
    const tokens = existing
      ? existing.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (!tokens.some((t) => t.toLowerCase() === token.toLowerCase())) {
      tokens.push(token);
    }
    const newSpecialOrder = tokens.join(", ");

    await db
      .prepare(
        `UPDATE sales_order_items
            SET sizeLabel = '', sizeCode = '', specialOrder = ?
          WHERE id = ?`,
      )
      .bind(newSpecialOrder, r.id)
      .run();

    // Cascade to production_orders snapshot (delivery_order_items +
    // invoice_items don't carry specialOrder so skip those).
    await db
      .prepare(
        `UPDATE production_orders
            SET sizeLabel = '', sizeCode = ''
          WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(r.salesOrderId, r.lineNo)
      .run()
      .catch(() => null);

    migrated.push({
      soId: r.salesOrderId,
      line: r.lineNo,
      code: r.productCode,
      oldSize: sl,
      newSpecialOrder,
    });
  }

  return c.json({
    success: true,
    scanned: targets.results?.length ?? 0,
    migrated: migrated.length,
    items: migrated,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/rebuild-production-orders-from-soi
//
// Option D one-shot fixer (2026-05-06). Finds every SO whose
// SUM(non-cancelled items.quantity) doesn't match
// SUM(non-cancelled production_orders.quantity) — meaning the items table
// (the new single source of truth) has drifted from the cached PO fan-out
// (e.g. an SO was edited via the legacy PUT path that didn't rebuild POs).
// For each affected SO, if every JC is still WAITING/CANCELLED (the same
// gate the PUT handler enforces), teardown all POs/JCs/fg_units and rebuild
// from sales_order_items via createProductionOrdersForOrder. Locked SOs are
// reported but skipped.
//
// Auth: sales-orders:update (same as the audit endpoints in this file).
// Tenant: getOrgId(c) is invoked for parity with the other admin endpoints,
// even though sales_orders + production_orders aren't tenant-scoped on this
// schema (single-tenant deployment for the migration window).
// ---------------------------------------------------------------------------
app.post("/rebuild-production-orders-from-soi", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  void getOrgId(c); // parity with sibling admin endpoints
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Find every SO with a SUM(items.quantity) vs SUM(po.quantity) mismatch
  //    over non-cancelled rows. NULL SUMs (no items / no POs) coalesce to 0.
  const candRes = await db
    .prepare(
      `SELECT so.id AS soId,
              so.companySOId AS companySOId,
              so.status AS status,
              COALESCE(soi.qty, 0) AS expected,
              COALESCE(po.qty, 0) AS actual
         FROM sales_orders so
         LEFT JOIN (
           SELECT salesOrderId, SUM(quantity) AS qty
             FROM sales_order_items
            GROUP BY salesOrderId
         ) soi ON soi.salesOrderId = so.id
         LEFT JOIN (
           SELECT salesOrderId, SUM(quantity) AS qty
             FROM production_orders
            WHERE status <> 'CANCELLED'
            GROUP BY salesOrderId
         ) po ON po.salesOrderId = so.id
        WHERE so.status IN ('CONFIRMED', 'IN_PRODUCTION')
          AND COALESCE(soi.qty, 0) <> COALESCE(po.qty, 0)`,
    )
    .all<{
      soId: string;
      companySOId: string | null;
      status: string;
      expected: number;
      actual: number;
    }>();
  const candidates = candRes.results ?? [];

  type CandidateReport = {
    soId: string;
    companySOId: string | null;
    status: string;
    expected: number;
    actual: number;
  };
  type LockedReport = CandidateReport & {
    reason: string;
    jcStatus: string;
    deptCode: string;
  };
  type RebuiltReport = CandidateReport & {
    deletedPoCount: number;
    createdPoNos: string[];
  };
  type ErrorReport = CandidateReport & { error: string };

  const candidateReports: CandidateReport[] = candidates.map((r) => ({
    soId: r.soId,
    companySOId: r.companySOId,
    status: r.status,
    expected: r.expected,
    actual: r.actual,
  }));
  const locked: LockedReport[] = [];
  const rebuilt: RebuiltReport[] = [];
  const errors: ErrorReport[] = [];

  for (const cand of candidates) {
    const cr: CandidateReport = {
      soId: cand.soId,
      companySOId: cand.companySOId,
      status: cand.status,
      expected: cand.expected,
      actual: cand.actual,
    };

    // 2. JC lock — same Option D gate as PUT /:id. Any JC past WAITING/CANCELLED
    //    means production has started and we can't safely rebuild.
    const startedRes = await db
      .prepare(
        `SELECT jc.status, jc.departmentCode
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.salesOrderId = ?
            AND jc.status NOT IN ('WAITING', 'CANCELLED')
          ORDER BY jc.sequence ASC, jc.id ASC
          LIMIT 1`,
      )
      .bind(cand.soId)
      .first<{ status: string | null; departmentCode: string | null }>();
    if (startedRes && startedRes.status) {
      locked.push({
        ...cr,
        reason: "production_started",
        jcStatus: startedRes.status,
        deptCode: startedRes.departmentCode || "",
      });
      continue;
    }

    if (dryRun) {
      // Dry-run still reports as a rebuild candidate (no writes).
      rebuilt.push({ ...cr, deletedPoCount: 0, createdPoNos: [] });
      continue;
    }

    // 3. Teardown + rebuild — same shape as PUT /:id (fg_units → job_cards
    //    → production_orders; rebuild via createProductionOrdersForOrder).
    try {
      const so = await db
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(cand.soId)
        .first<{
          id: string;
          companySOId: string | null;
          companySODate: string | null;
          customerPOId: string | null;
          reference: string | null;
          customerName: string;
          customerState: string | null;
          hookkaExpectedDD: string | null;
          customerDeliveryDate: string | null;
        }>();
      if (!so) {
        errors.push({ ...cr, error: "Sales order disappeared mid-run" });
        continue;
      }
      const itemsRes = await db
        .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
        .bind(cand.soId)
        .all<{
          lineNo: number;
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
        }>();
      const items = itemsRes.results ?? [];
      if (items.length === 0) {
        errors.push({ ...cr, error: "Sales order has no items" });
        continue;
      }

      const built = await createProductionOrdersForOrder(
        db,
        {
          id: so.id,
          sourceType: "SO",
          companyOrderId: so.companySOId ?? "",
          companyOrderDate: so.companySODate,
          customerPOId: so.customerPOId,
          reference: so.reference,
          customerName: so.customerName,
          customerState: so.customerState,
          hookkaExpectedDD: so.hookkaExpectedDD,
          customerDeliveryDate: so.customerDeliveryDate,
        },
        items.map((it) => ({
          lineNo: it.lineNo,
          productId: it.productId,
          productCode: it.productCode,
          productName: it.productName,
          itemCategory: it.itemCategory,
          sizeCode: it.sizeCode,
          sizeLabel: it.sizeLabel,
          fabricCode: it.fabricCode,
          quantity: it.quantity,
          gapInches: it.gapInches,
          divanHeightInches: it.divanHeightInches,
          legHeightInches: it.legHeightInches,
          specialOrder: it.specialOrder,
          notes: it.notes,
        })),
        { forceRebuild: true },
      );

      // Count existing POs before delete so the report shows what was wiped.
      const existingPosRes = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM production_orders WHERE salesOrderId = ?",
        )
        .bind(cand.soId)
        .first<{ n: number }>();
      const deletedPoCount = existingPosRes?.n ?? 0;

      const deleteFgUnitsStmt = db
        .prepare(
          `DELETE FROM fg_units WHERE po_id IN (
             SELECT id FROM production_orders WHERE salesOrderId = ?)`,
        )
        .bind(cand.soId);
      const deleteJcsStmt = db
        .prepare(
          `DELETE FROM job_cards WHERE productionOrderId IN (
             SELECT id FROM production_orders WHERE salesOrderId = ?)`,
        )
        .bind(cand.soId);
      const deletePosStmt = db
        .prepare("DELETE FROM production_orders WHERE salesOrderId = ?")
        .bind(cand.soId);

      await db.batch([
        deleteFgUnitsStmt,
        deleteJcsStmt,
        deletePosStmt,
        ...built.statements,
      ]);

      rebuilt.push({
        ...cr,
        deletedPoCount,
        createdPoNos: built.created.map((p) => p.poNo),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ ...cr, error: msg });
    }
  }

  return c.json({
    success: true,
    dryRun,
    candidateCount: candidateReports.length,
    rebuiltCount: rebuilt.length,
    lockedCount: locked.length,
    errorCount: errors.length,
    candidates: candidateReports,
    rebuilt,
    locked,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-supplier-material-bindings
//
// One-shot maintenance endpoint that seeds supplier_material_bindings rows
// for every active raw_material that doesn't already have a binding, using
// the most-recent purchase_order_items mention of that material as the
// source of truth for {supplierId, supplierSku, unitPrice}.
//
// Why: the procurement Create-PO modal silently drops lines that have no
// binding. After Phase 1.2 the operator can manually pick a supplier for
// such lines, but this endpoint catches up the historical RMs in one shot
// so most lines already auto-fill.
//
// Logic per RM:
//   1. SELECT itemCode, description FROM raw_materials
//      WHERE NOT EXISTS (SELECT 1 FROM supplier_material_bindings smb
//                          WHERE smb.materialCode = rm.itemCode)
//   2. Look up the most-recent purchase_order_items row whose
//      materialName LIKE '%<itemCode>%', joined to purchase_orders
//      to get supplierId. Order by po.created_at DESC.
//   3. If found: INSERT one binding with isMainSupplier=1, moq=1,
//      leadTimeDays=0, supplierSku=itemCode (operator can refine later).
//   4. If no PO history mentions the itemCode: skip (operator must seed
//      manually via Maintenance).
//
// Idempotent: only inserts when no existing binding for that materialCode.
// Returns {scanned, seeded, skippedNoHistory, errors} with sample arrays
// for a quick spot-check before/after running.
//
// Body: { dryRun?: boolean }
// ---------------------------------------------------------------------------
type BackfillBindingsBody = { dryRun?: boolean };

app.post("/backfill-supplier-material-bindings", async (c) => {
  // Same gate as POST /api/purchase-orders — anyone who can create a PO can
  // seed bindings (this is operator-driven cleanup, not admin-only).
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: BackfillBindingsBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as BackfillBindingsBody;
  } catch {
    body = {};
  }
  const dryRun = body.dryRun === true;

  const db = c.var.DB;

  // Find every RM that has no binding yet. NOT EXISTS keeps it idempotent —
  // RMs already covered (manually or by a previous run) are skipped.
  // Postgres alias quoting (AS "fooBar") preserves case on D1 as well.
  const candidatesRes = await db
    .prepare(
      `SELECT rm.itemCode    AS "itemCode",
              rm.description AS "description",
              rm.itemGroup   AS "itemGroup"
         FROM raw_materials rm
        WHERE NOT EXISTS (
                SELECT 1 FROM supplier_material_bindings smb
                 WHERE smb.materialCode = rm.itemCode
              )`,
    )
    .all<{ itemCode: string; description: string; itemGroup: string }>();
  const candidates = candidatesRes.results ?? [];

  let seeded = 0;
  let skippedNoHistory = 0;
  const seededSamples: {
    itemCode: string;
    supplierId: string;
    unitPriceSen: number;
  }[] = [];
  const skippedSamples: { itemCode: string; description: string }[] = [];
  const errors: { itemCode: string; message: string }[] = [];

  for (const rm of candidates) {
    try {
      // Look up the most-recent PO line item that mentions this RM's
      // itemCode anywhere in materialName. Procurement modal stores
      // materialName as "<rmCode> - <description>", so the LIKE catches
      // both that path and historical Excel-import variants.
      const hit = await db
        .prepare(
          `SELECT po.supplierId    AS "supplierId",
                  poi.unitPriceSen AS "unitPriceSen",
                  poi.supplierSKU  AS "supplierSKU"
             FROM purchase_order_items poi
             JOIN purchase_orders po ON po.id = poi.purchaseOrderId
            WHERE poi.materialName LIKE ?
            ORDER BY po.created_at DESC, po.id DESC
            LIMIT 1`,
        )
        .bind(`%${rm.itemCode}%`)
        .first<{ supplierId: string; unitPriceSen: number; supplierSKU: string | null }>();

      if (!hit || !hit.supplierId) {
        skippedNoHistory++;
        if (skippedSamples.length < 10) {
          skippedSamples.push({
            itemCode: rm.itemCode,
            description: rm.description,
          });
        }
        continue;
      }

      if (!dryRun) {
        const id = `smb-${crypto.randomUUID().slice(0, 8)}`;
        await db
          .prepare(
            `INSERT INTO supplier_material_bindings (id, supplierId, materialCode,
               materialName, supplierSku, unitPrice, currency, leadTimeDays,
               paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
             VALUES (?, ?, ?, ?, ?, ?, 'MYR', 0, 'NET30', 1, ?, '2030-12-31', 1)`,
          )
          .bind(
            id,
            hit.supplierId,
            rm.itemCode,
            rm.description,
            // supplierSku falls back to the rm itemCode when historical PO
            // line had nothing useful; this is conservative — operator can
            // refine per real supplier catalog later.
            hit.supplierSKU || rm.itemCode,
            hit.unitPriceSen || 0,
            new Date().toISOString().slice(0, 10),
          )
          .run();
      }

      seeded++;
      if (seededSamples.length < 10) {
        seededSamples.push({
          itemCode: rm.itemCode,
          supplierId: hit.supplierId,
          unitPriceSen: hit.unitPriceSen || 0,
        });
      }
    } catch (err) {
      errors.push({
        itemCode: rm.itemCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned: candidates.length,
    seeded,
    skippedNoHistory,
    errorCount: errors.length,
    seededSamples,
    skippedSamples,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-supplier-bindings-multi
//
// Smarter v2 of /backfill-supplier-material-bindings. Where v1 picked the
// single most-recent supplier for each RM, this endpoint scans the FULL PO
// history and, per RM:
//
//   * Lists every supplier that ever ordered the material
//   * Sums historical qty per supplier
//   * Inserts a binding for every (materialCode, supplierId) pair NOT
//     already in supplier_material_bindings (operator-set bindings win)
//   * Marks the supplier with the highest historical qty as isMainSupplier=1
//     — but only if no existing binding for that materialCode is already
//     flagged main. If all suppliers from history were already bound and
//     none is currently main, the highest-qty existing supplier is promoted
//     in-place.
//
// MATCH STRATEGY — two passes, code-first then description-fallback:
//
//   1. Code match (strict): poi.materialName equals or starts with the RM's
//      itemCode followed by space/dash. Avoids the AM275 ⊃ AM275-2 prefix bug.
//   2. Description fallback: when the code pass yields zero, match by
//      rm.description (which the historical-import path stored as the
//      poi.materialName for AutoCount-imported PIs). Covers the very common
//      fabric/filler case where the AutoCount export only carried generic
//      descriptions like "FABRIC" or "BEIGE" with no RM code.
//
// The description-fallback intentionally produces broad bindings for generic
// descriptions (every fabric RM gets bound to every fabric supplier). That's
// the behavior the operator asked for: "bind these materials to the
// suppliers I've historically ordered them from" — and for fabric, the
// AutoCount records don't preserve which fabric model went to which PO.
//
// Tenant-scoped: every read and write is filtered by the request's orgId.
//
// Body: { dryRun?: boolean, ensureMainOnExisting?: boolean,
//         disableDescriptionFallback?: boolean }
//   ensureMainOnExisting=true: if NO binding for an RM is currently main
//   AND we have history, promote the highest-qty supplier to main even if
//   that binding already existed (covers the case where v1 left main=0).
//   disableDescriptionFallback=true: only use code-based matching (the
//   tighter v2 behavior, useful for re-running without re-binding fabrics).
// ---------------------------------------------------------------------------
type BackfillBindingsMultiBody = {
  dryRun?: boolean;
  ensureMainOnExisting?: boolean;
  disableDescriptionFallback?: boolean;
};

app.post("/backfill-supplier-bindings-multi", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  const orgId = getOrgId(c);

  let body: BackfillBindingsMultiBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as BackfillBindingsMultiBody;
  } catch {
    body = {};
  }
  const dryRun = body.dryRun === true;
  const ensureMainOnExisting = body.ensureMainOnExisting === true;
  const useDescriptionFallback = body.disableDescriptionFallback !== true;

  const db = c.var.DB;

  // Every active RM in this org. Inactive RMs are skipped — operator deactivated
  // them deliberately, and binding them would just clutter the picker.
  const rmsRes = await db
    .prepare(
      `SELECT itemCode    AS "itemCode",
              description AS "description"
         FROM raw_materials
        WHERE orgId = ? AND isActive = 1`,
    )
    .bind(orgId)
    .all<{ itemCode: string; description: string }>();
  const rms = rmsRes.results ?? [];

  let bindingsInserted = 0;
  let mainAssignedNew = 0;
  let mainPromotedExisting = 0;
  let rmsWithoutHistory = 0;
  let rmsFullyCovered = 0;
  const seededSamples: {
    itemCode: string;
    supplierId: string;
    totalQty: number;
    isMain: boolean;
    matchSource: "code" | "description";
  }[] = [];
  const promotedSamples: { itemCode: string; supplierId: string }[] = [];
  const skippedSamples: { itemCode: string; description: string }[] = [];
  const errors: { itemCode: string; message: string }[] = [];

  let rmsMatchedByCode = 0;
  let rmsMatchedByDescription = 0;
  for (const rm of rms) {
    try {
      // Pass 1 — code match: poi.materialName equals or starts with the
      // RM's itemCode followed by space/dash. Strict prefix matching avoids
      // the AM275 ⊃ AM275-2 over-match.
      const codeExact = rm.itemCode;
      const codeDash = `${rm.itemCode} - %`;
      const codeSpace = `${rm.itemCode} %`;
      const codeAggsRes = await db
        .prepare(
          `SELECT po.supplierId        AS "supplierId",
                  SUM(poi.quantity)    AS "totalQty",
                  COUNT(*)             AS "poCount",
                  MAX(po.created_at)   AS "latestPoDate"
             FROM purchase_order_items poi
             JOIN purchase_orders po ON po.id = poi.purchaseOrderId
            WHERE po.orgId = ?
              AND (poi.materialName = ? OR poi.materialName LIKE ? OR poi.materialName LIKE ?)
            GROUP BY po.supplierId
            ORDER BY SUM(poi.quantity) DESC, MAX(po.created_at) DESC`,
        )
        .bind(orgId, codeExact, codeDash, codeSpace)
        .all<{
          supplierId: string;
          totalQty: number;
          poCount: number;
          latestPoDate: string;
        }>();
      let aggs = (codeAggsRes.results ?? []).filter((a) => a.supplierId);
      let matchSource: "code" | "description" = "code";

      // Pass 2 — description fallback: AutoCount-imported PIs stored only
      // generic descriptions ("FABRIC", "BEIGE") in materialName with no RM
      // code, so the code pass misses them. Match by rm.description (exact
      // or as a prefix segment in poi.materialName) so the operator's
      // historical fabric/filler buys propagate to the model-numbered RMs.
      // Skip empties and absurdly short descriptions (< 2 chars) to avoid
      // ridiculous wide matches.
      if (
        useDescriptionFallback &&
        aggs.length === 0 &&
        rm.description &&
        rm.description.trim().length >= 2
      ) {
        const descExact = rm.description.trim();
        const descSpace = `${descExact} %`;
        const descSpaceMid = `% ${descExact} %`;
        const descSpaceEnd = `% ${descExact}`;
        const descAggsRes = await db
          .prepare(
            `SELECT po.supplierId        AS "supplierId",
                    SUM(poi.quantity)    AS "totalQty",
                    COUNT(*)             AS "poCount",
                    MAX(po.created_at)   AS "latestPoDate"
               FROM purchase_order_items poi
               JOIN purchase_orders po ON po.id = poi.purchaseOrderId
              WHERE po.orgId = ?
                AND (poi.materialName = ?
                     OR poi.materialName LIKE ?
                     OR poi.materialName LIKE ?
                     OR poi.materialName LIKE ?)
              GROUP BY po.supplierId
              ORDER BY SUM(poi.quantity) DESC, MAX(po.created_at) DESC`,
          )
          .bind(orgId, descExact, descSpace, descSpaceMid, descSpaceEnd)
          .all<{
            supplierId: string;
            totalQty: number;
            poCount: number;
            latestPoDate: string;
          }>();
        aggs = (descAggsRes.results ?? []).filter((a) => a.supplierId);
        if (aggs.length > 0) matchSource = "description";
      }

      if (aggs.length === 0) {
        rmsWithoutHistory++;
        if (skippedSamples.length < 20) {
          skippedSamples.push({
            itemCode: rm.itemCode,
            description: rm.description,
          });
        }
        continue;
      }
      if (matchSource === "code") rmsMatchedByCode++;
      else rmsMatchedByDescription++;

      // Existing bindings for this RM — operator-set rows must not be touched.
      const existingRes = await db
        .prepare(
          `SELECT supplierId        AS "supplierId",
                  isMainSupplier    AS "isMainSupplier",
                  id                AS "id"
             FROM supplier_material_bindings
            WHERE orgId = ? AND materialCode = ?`,
        )
        .bind(orgId, rm.itemCode)
        .all<{ supplierId: string; isMainSupplier: number; id: string }>();
      const existing = existingRes.results ?? [];
      const existingSupplierIds = new Set(existing.map((r) => r.supplierId));
      let hasMain = existing.some((r) => r.isMainSupplier === 1);

      // Highest-qty supplier from history is the main candidate. If multiple
      // suppliers are tied on qty, ORDER BY tiebreak (latestPoDate) decides.
      const mainCandidate = aggs[0].supplierId;

      let insertedForThisRm = 0;
      for (const agg of aggs) {
        if (existingSupplierIds.has(agg.supplierId)) continue;

        // Pull the latest unitPrice + supplierSKU + unit for this (rm, supplier)
        // pair. Mirror whichever match strategy actually produced the
        // aggregate (code vs description) so the latest-row lookup hits
        // the same set of POs the aggregate considered.
        const latest = await (matchSource === "code"
          ? db
              .prepare(
                `SELECT poi.unitPriceSen AS "unitPriceSen",
                        poi.supplierSKU  AS "supplierSKU",
                        poi.unit         AS "unit"
                   FROM purchase_order_items poi
                   JOIN purchase_orders po ON po.id = poi.purchaseOrderId
                  WHERE po.orgId = ?
                    AND po.supplierId = ?
                    AND (poi.materialName = ? OR poi.materialName LIKE ? OR poi.materialName LIKE ?)
                  ORDER BY po.created_at DESC, po.id DESC
                  LIMIT 1`,
              )
              .bind(orgId, agg.supplierId, codeExact, codeDash, codeSpace)
          : db
              .prepare(
                `SELECT poi.unitPriceSen AS "unitPriceSen",
                        poi.supplierSKU  AS "supplierSKU",
                        poi.unit         AS "unit"
                   FROM purchase_order_items poi
                   JOIN purchase_orders po ON po.id = poi.purchaseOrderId
                  WHERE po.orgId = ?
                    AND po.supplierId = ?
                    AND (poi.materialName = ?
                         OR poi.materialName LIKE ?
                         OR poi.materialName LIKE ?
                         OR poi.materialName LIKE ?)
                  ORDER BY po.created_at DESC, po.id DESC
                  LIMIT 1`,
              )
              .bind(
                orgId,
                agg.supplierId,
                rm.description.trim(),
                `${rm.description.trim()} %`,
                `% ${rm.description.trim()} %`,
                `% ${rm.description.trim()}`,
              )
        ).first<{
          unitPriceSen: number;
          supplierSKU: string | null;
          unit: string | null;
        }>();

        const isMain = agg.supplierId === mainCandidate && !hasMain ? 1 : 0;

        if (!dryRun) {
          const id = `smb-${crypto.randomUUID().slice(0, 8)}`;
          await db
            .prepare(
              `INSERT INTO supplier_material_bindings (id, orgId, supplierId, materialCode,
                 materialName, supplierSku, unitPrice, currency, leadTimeDays,
                 paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'MYR', 0, 'NET30', 1, ?, '2030-12-31', ?)`,
            )
            .bind(
              id,
              orgId,
              agg.supplierId,
              rm.itemCode,
              rm.description,
              latest?.supplierSKU || rm.itemCode,
              latest?.unitPriceSen || 0,
              new Date().toISOString().slice(0, 10),
              isMain,
            )
            .run();
        }

        bindingsInserted++;
        insertedForThisRm++;
        if (isMain) {
          mainAssignedNew++;
          hasMain = true;
        }
        if (seededSamples.length < 30) {
          seededSamples.push({
            itemCode: rm.itemCode,
            supplierId: agg.supplierId,
            totalQty: Number(agg.totalQty) || 0,
            isMain: isMain === 1,
            matchSource,
          });
        }
      }

      if (insertedForThisRm === 0) {
        rmsFullyCovered++;
      }

      // Promote a main supplier on existing bindings when nothing was inserted
      // (or when the inserts didn't create a main because all candidates were
      // already bound). Only fires when ensureMainOnExisting flag is set —
      // operator opt-in, since this changes existing rows.
      if (ensureMainOnExisting && !hasMain && existing.length > 0) {
        // Pick the highest-qty supplier from history that ALSO has an existing
        // binding row. If history's mainCandidate is already bound, promote it.
        const promoteCandidate = aggs.find((a) =>
          existingSupplierIds.has(a.supplierId),
        );
        if (promoteCandidate) {
          const row = existing.find(
            (r) => r.supplierId === promoteCandidate.supplierId,
          );
          if (row && !dryRun) {
            await db
              .prepare(
                `UPDATE supplier_material_bindings SET isMainSupplier = 1 WHERE id = ?`,
              )
              .bind(row.id)
              .run();
          }
          if (row) {
            mainPromotedExisting++;
            if (promotedSamples.length < 20) {
              promotedSamples.push({
                itemCode: rm.itemCode,
                supplierId: promoteCandidate.supplierId,
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        itemCode: rm.itemCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    ensureMainOnExisting,
    descriptionFallbackEnabled: useDescriptionFallback,
    rmsScanned: rms.length,
    rmsMatchedByCode,
    rmsMatchedByDescription,
    rmsWithoutHistory,
    rmsFullyCovered,
    bindingsInserted,
    mainAssignedNew,
    mainPromotedExisting,
    errorCount: errors.length,
    seededSamples,
    promotedSamples,
    skippedSamples,
    errors,
  });
});

// ---------------------------------------------------------------------------
// Phase 2.4 — Phantom GRN backfill for historical RECEIVED POs.
//
// 556 historical POs imported from Google Sheets are at status='RECEIVED'
// but have no GRN row attached. Three-way match, GRN-derived analytics,
// and the new 2.3 gate (PO→RECEIVED requires a POSTED GRN) all assume
// the GRN row is the source of truth for what was received. This endpoint
// fills that gap WITHOUT re-posting to inventory: the historical balanceQty
// is already correct from the PI import path, so we skip postGRNToStock
// (no rm_batches + no cost_ledger writes) and just record the receipt
// envelope.
//
// Idempotent: only POs with NO GRN at all get a phantom row. Re-running
// the endpoint is safe.
// ---------------------------------------------------------------------------
type BackfillPhantomGrnsBody = { dryRun?: boolean };

app.post("/backfill-historical-grns", async (c) => {
  // Same gate as POST /api/purchase-orders.
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: BackfillPhantomGrnsBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as BackfillPhantomGrnsBody;
  } catch {
    body = {};
  }
  // Also support ?dryRun=true on the query string for parity with other
  // backfill endpoints that read it from URL params.
  const dryRunQuery = c.req.query("dryRun");
  const dryRun = body.dryRun === true || dryRunQuery === "true";

  const db = c.var.DB;

  // Find every RECEIVED PO with no GRN. Postgres alias quoting (AS "fooBar")
  // preserves case so the JS side gets the field names back as-is.
  const candidatesRes = await db
    .prepare(
      `SELECT po.id           AS "poId",
              po.poNo         AS "poNo",
              po.supplierId   AS "supplierId",
              po.supplierName AS "supplierName",
              po.receivedDate AS "receivedDate",
              po.orderDate    AS "orderDate"
         FROM purchase_orders po
        WHERE po.status = 'RECEIVED'
          AND NOT EXISTS (
                SELECT 1 FROM grns g WHERE g.poId = po.id
              )
        ORDER BY po.poNo`,
    )
    .all<{
      poId: string;
      poNo: string;
      supplierId: string;
      supplierName: string | null;
      receivedDate: string | null;
      orderDate: string | null;
    }>();
  const candidates = candidatesRes.results ?? [];

  // Pre-scan the existing PHANTOM GRN sequence so we can keep numbering
  // contiguous across multiple runs. Format: GRN-PHANTOM-NNN.
  const seqRes = await db
    .prepare(
      `SELECT grnNumber FROM grns
        WHERE grnNumber LIKE 'GRN-PHANTOM-%'
        ORDER BY grnNumber DESC
        LIMIT 1`,
    )
    .first<{ grnNumber: string }>();
  let nextSeq = seqRes?.grnNumber
    ? Number(seqRes.grnNumber.split("-").pop()) + 1
    : 1;

  let created = 0;
  const errors: { poNo: string; message: string }[] = [];
  const sample: { poNo: string; grnNumber: string; lineCount: number }[] = [];

  for (const cand of candidates) {
    try {
      // Pull the parent PO's items so we can mirror them onto the GRN.
      // Each GRN line gets receivedQty = orderedQty = quantity, accepted
      // = received, rejected = 0 — matches "fully received per the PO".
      const itemsRes = await db
        .prepare(
          `SELECT id           AS "id",
                  materialName AS "materialName",
                  supplierSKU  AS "supplierSKU",
                  quantity     AS "quantity",
                  unitPriceSen AS "unitPriceSen"
             FROM purchase_order_items
            WHERE purchaseOrderId = ?`,
        )
        .bind(cand.poId)
        .all<{
          id: string;
          materialName: string | null;
          supplierSKU: string | null;
          quantity: number;
          unitPriceSen: number;
        }>();
      const items = itemsRes.results ?? [];
      if (items.length === 0) {
        // No PO items → nothing to mirror. Surface as an error so the
        // caller can spot-check (could indicate orphan data in 5.4).
        errors.push({
          poNo: cand.poNo,
          message: "PO has no line items — skipped",
        });
        continue;
      }

      const grnNumber = `GRN-PHANTOM-${String(nextSeq).padStart(3, "0")}`;
      nextSeq++;
      const grnId = `grn-${crypto.randomUUID().slice(0, 8)}`;
      // Receive date defaults to the PO's receivedDate, then orderDate,
      // then today — keep the timeline coherent for downstream reports.
      const receiveDate =
        cand.receivedDate || cand.orderDate || new Date().toISOString().slice(0, 10);
      const totalAmount = items.reduce(
        (s, it) => s + (it.quantity || 0) * (it.unitPriceSen || 0),
        0,
      );

      if (!dryRun) {
        const stmts: D1PreparedStatement[] = [];
        stmts.push(
          db
            .prepare(
              `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
                 supplierName, receiveDate, receivedBy, totalAmount,
                 qcStatus, status, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PASSED', 'POSTED', ?)`,
            )
            .bind(
              grnId,
              grnNumber,
              cand.poId,
              cand.poNo,
              cand.supplierId,
              cand.supplierName ?? "",
              receiveDate,
              "phantom-backfill",
              totalAmount,
              "Phantom backfill — historical RECEIVED PO, inventory already correct",
            ),
        );
        items.forEach((item, idx) => {
          stmts.push(
            db
              .prepare(
                `INSERT INTO grn_items (grnId, poItemIndex, materialCode,
                   materialName, orderedQty, receivedQty, acceptedQty,
                   rejectedQty, rejectionReason, unitPrice)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
              )
              .bind(
                grnId,
                idx,
                item.supplierSKU ?? "",
                item.materialName ?? "",
                item.quantity,
                item.quantity,
                item.quantity,
                item.unitPriceSen,
              ),
          );
        });

        await db.batch(stmts);
      }

      created++;
      if (sample.length < 5) {
        sample.push({
          poNo: cand.poNo,
          grnNumber,
          lineCount: items.length,
        });
      }
    } catch (err) {
      errors.push({
        poNo: cand.poNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    candidates: candidates.length,
    created,
    errors,
    sample,
  });
});

// ---------------------------------------------------------------------------
// Phase 5.3 — pre-flight probe for the UNIQUE poNo index.
//
// The retry-on-collision path in purchase-orders.ts depends on
// CREATE UNIQUE INDEX ux_purchase_orders_po_no, which is rolled out via
// the self-applying ensurePendingMigrations() in that route. The CREATE
// will FAIL on first run if duplicate poNos exist on prod (556+
// historical POs, imported in two passes, real risk of collision).
//
// This endpoint surfaces any duplicate poNos so the parent agent can
// dedupe BEFORE the migration tries to land. Read-only; never mutates.
// ---------------------------------------------------------------------------
app.get("/po-no-duplicates", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const res = await c.var.DB.prepare(
    `SELECT poNo       AS "poNo",
            COUNT(*)   AS "count"
       FROM purchase_orders
      GROUP BY poNo
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, poNo ASC`,
  ).all<{ poNo: string; count: number }>();
  const duplicates = (res.results ?? []).map((row) => ({
    poNo: row.poNo,
    count: Number(row.count),
  }));
  return c.json({
    success: true,
    duplicates,
    total: duplicates.length,
  });
});

// ---------------------------------------------------------------------------
// Phase 5.4 — Procurement integrity audit (read-only).
//
// Walks 10 invariants over purchase_orders / purchase_order_items / grns /
// purchase_invoices / supplier_material_bindings and surfaces violations
// for manual review. Never auto-fixes — operator decides per case. Severity
// gradient: 1-2=error (data corruption), 3=warning (catalog drift), 4-10=
// info (history may legitimately violate the current invariant). Use the
// output to decide which one-shot backfills to run next.
// ---------------------------------------------------------------------------
type AuditCheck = {
  name: string;
  severity: "error" | "warning" | "info";
  count: number;
  sample: Record<string, unknown>[];
};

app.post("/audit-procurement-integrity", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const checks: AuditCheck[] = [];

  // 1. po_without_items — error. Empty parent rows are invariant violations.
  {
    const r = await db
      .prepare(
        `SELECT po.id      AS "id",
                po.poNo    AS "poNo",
                po.status  AS "status"
           FROM purchase_orders po
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_order_items poi
                   WHERE poi.purchaseOrderId = po.id
                )
          ORDER BY po.created_at DESC
          LIMIT 5`,
      )
      .all<{ id: string; poNo: string; status: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_orders po
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_order_items poi
                   WHERE poi.purchaseOrderId = po.id
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "po_without_items",
      severity: "error",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 2. po_item_orphans — error. Items pointing at a non-existent PO row.
  {
    const r = await db
      .prepare(
        `SELECT poi.id              AS "id",
                poi.purchaseOrderId AS "purchaseOrderId",
                poi.materialName    AS "materialName"
           FROM purchase_order_items poi
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = poi.purchaseOrderId
                )
          LIMIT 5`,
      )
      .all<{ id: string; purchaseOrderId: string; materialName: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_order_items poi
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = poi.purchaseOrderId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "po_item_orphans",
      severity: "error",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 3. binding_unknown_material — warning. Catalog drift; binding points
  // at an itemCode that no longer exists in raw_materials.
  {
    const r = await db
      .prepare(
        `SELECT smb.id           AS "id",
                smb.materialCode AS "materialCode",
                smb.supplierId   AS "supplierId"
           FROM supplier_material_bindings smb
          WHERE NOT EXISTS (
                  SELECT 1 FROM raw_materials rm
                   WHERE rm.itemCode = smb.materialCode
                )
          LIMIT 5`,
      )
      .all<{ id: string; materialCode: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM supplier_material_bindings smb
          WHERE NOT EXISTS (
                  SELECT 1 FROM raw_materials rm
                   WHERE rm.itemCode = smb.materialCode
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "binding_unknown_material",
      severity: "warning",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 4. po_supplier_orphan — info. Historical PO referencing a deleted
  // supplier row. Not corrupting (the FK on purchase_orders won't allow
  // future inserts) but legacy rows can leak.
  {
    const r = await db
      .prepare(
        `SELECT po.id         AS "id",
                po.poNo       AS "poNo",
                po.supplierId AS "supplierId"
           FROM purchase_orders po
          WHERE po.supplierId IS NOT NULL
            AND po.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = po.supplierId
                )
          LIMIT 5`,
      )
      .all<{ id: string; poNo: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_orders po
          WHERE po.supplierId IS NOT NULL
            AND po.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = po.supplierId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "po_supplier_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 5. grn_supplier_orphan — info.
  {
    const r = await db
      .prepare(
        `SELECT g.id         AS "id",
                g.grnNumber  AS "grnNumber",
                g.supplierId AS "supplierId"
           FROM grns g
          WHERE g.supplierId IS NOT NULL
            AND g.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = g.supplierId
                )
          LIMIT 5`,
      )
      .all<{ id: string; grnNumber: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM grns g
          WHERE g.supplierId IS NOT NULL
            AND g.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = g.supplierId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "grn_supplier_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 6. pi_supplier_orphan — info.
  {
    const r = await db
      .prepare(
        `SELECT pi.id         AS "id",
                pi.piNo       AS "piNo",
                pi.supplierId AS "supplierId"
           FROM purchase_invoices pi
          WHERE pi.supplierId IS NOT NULL
            AND pi.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = pi.supplierId
                )
          LIMIT 5`,
      )
      .all<{ id: string; piNo: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_invoices pi
          WHERE pi.supplierId IS NOT NULL
            AND pi.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = pi.supplierId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "pi_supplier_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 7. grn_po_orphan — info. GRN claims a poId that no longer exists.
  {
    const r = await db
      .prepare(
        `SELECT g.id        AS "id",
                g.grnNumber AS "grnNumber",
                g.poId      AS "poId"
           FROM grns g
          WHERE g.poId IS NOT NULL
            AND g.poId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = g.poId
                )
          LIMIT 5`,
      )
      .all<{ id: string; grnNumber: string; poId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM grns g
          WHERE g.poId IS NOT NULL
            AND g.poId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = g.poId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "grn_po_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 8. pi_po_orphan — info. PI claims a purchaseOrderId that no longer
  // exists.
  {
    const r = await db
      .prepare(
        `SELECT pi.id              AS "id",
                pi.piNo            AS "piNo",
                pi.purchaseOrderId AS "purchaseOrderId"
           FROM purchase_invoices pi
          WHERE pi.purchaseOrderId IS NOT NULL
            AND pi.purchaseOrderId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = pi.purchaseOrderId
                )
          LIMIT 5`,
      )
      .all<{ id: string; piNo: string; purchaseOrderId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_invoices pi
          WHERE pi.purchaseOrderId IS NOT NULL
            AND pi.purchaseOrderId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = pi.purchaseOrderId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "pi_po_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 9. received_qty_overage — info. PO line where receivedQty exceeds
  // 110% of ordered (the GRN gate enforces this for new posts; historical
  // imports may pre-date it).
  {
    const r = await db
      .prepare(
        `SELECT poi.id              AS "id",
                poi.purchaseOrderId AS "purchaseOrderId",
                poi.materialName    AS "materialName",
                poi.quantity        AS "quantity",
                poi.receivedQty     AS "receivedQty"
           FROM purchase_order_items poi
          WHERE poi.quantity > 0
            AND poi.receivedQty > poi.quantity * 1.1
          LIMIT 5`,
      )
      .all<{
        id: string;
        purchaseOrderId: string;
        materialName: string;
        quantity: number;
        receivedQty: number;
      }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_order_items poi
          WHERE poi.quantity > 0
            AND poi.receivedQty > poi.quantity * 1.1`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "received_qty_overage",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 10. status_received_no_grn — info. After Phase 2.4's phantom backfill
  // runs, this should settle to 0; anything that lights up afterwards is
  // a real new-flow gap (a PO marked RECEIVED bypassing the 2.3 gate).
  {
    const r = await db
      .prepare(
        `SELECT po.id     AS "id",
                po.poNo   AS "poNo",
                po.status AS "status"
           FROM purchase_orders po
          WHERE po.status = 'RECEIVED'
            AND NOT EXISTS (
                  SELECT 1 FROM grns g
                   WHERE g.poId = po.id
                )
          LIMIT 5`,
      )
      .all<{ id: string; poNo: string; status: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_orders po
          WHERE po.status = 'RECEIVED'
            AND NOT EXISTS (
                  SELECT 1 FROM grns g
                   WHERE g.poId = po.id
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "status_received_no_grn",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  return c.json({ success: true, checks });
});

// ---------------------------------------------------------------------------
// POST /api/import/recompute-po-status-progress
//
// One-shot backfill that runs the recomputePoStatusAndProgress helper over
// every existing production_orders row. Required after the audit fix
// (2026-05-07): historic POs were stranded at status="PENDING" and
// progress=0 even when their JCs were all done. The helper itself is the
// same one wired into every live JC mutation site, so re-running it here
// gets every row to the canonical state.
//
// Skips ON_HOLD and CANCELLED (admin states). Returns counts +
// representative samples so the operator can sanity-check the diff
// before-and-after.
//
// Body: { dryRun?: boolean } — default false. Dry run computes the diff
// but does not write.
// ---------------------------------------------------------------------------
app.post("/recompute-po-status-progress", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: boolean } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
  } catch {
    body = {};
  }
  const dryRun = body?.dryRun === true;

  const db = c.var.DB;

  // Load every PO id. A few thousand at most — fits in one round-trip.
  const poRes = await db
    .prepare(`SELECT id, poNo, status, progress, completedDate FROM production_orders`)
    .all<{
      id: string;
      poNo: string;
      status: string;
      progress: number | null;
      completedDate: string | null;
    }>();
  const allPos = poRes.results ?? [];

  let scanned = 0;
  let skippedAdminState = 0;
  let statusChanged = 0;
  let progressChanged = 0;
  let completedDateChanged = 0;
  const errors: Array<{ poId: string; poNo: string; message: string }> = [];
  type Sample = {
    poId: string;
    poNo: string;
    before: { status: string; progress: number; completedDate: string | null };
    after: { status: string; progress: number; completedDate: string | null };
  };
  const statusSamples: Sample[] = [];
  const progressSamples: Sample[] = [];

  for (const po of allPos) {
    scanned++;
    if (po.status === "ON_HOLD" || po.status === "CANCELLED") {
      skippedAdminState++;
      continue;
    }

    if (dryRun) {
      // Replicate the helper's read path to compute the diff without writing.
      // Mirrors recomputePoStatusAndProgress exactly so the dry-run report
      // matches what the live run would do.
      const sibs = await db
        .prepare(
          `SELECT id, status, completedDate, wipQty, sequence
             FROM job_cards
            WHERE productionOrderId = ?`,
        )
        .bind(po.id)
        .all<{
          id: string;
          status: string;
          completedDate: string | null;
          wipQty: number | null;
          sequence: number;
        }>();
      const allJcs = sibs.results ?? [];
      const isDone = (s: string) => s === "COMPLETED" || s === "TRANSFERRED";
      const isInProgress = (s: string) =>
        s === "IN_PROGRESS" || s === "PAUSED";
      let derivedStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" = "PENDING";
      if (allJcs.length > 0) {
        if (allJcs.every((j) => isDone(j.status))) derivedStatus = "COMPLETED";
        else if (allJcs.some((j) => isInProgress(j.status)))
          derivedStatus = "IN_PROGRESS";
      }
      let pieces = 0;
      let donePieces = 0;
      for (const j of allJcs) {
        const t = Math.max(1, j.wipQty ?? 1);
        pieces += t;
        if (isDone(j.status)) donePieces += t;
      }
      const newProgress =
        pieces > 0 ? Math.round((donePieces / pieces) * 100) : 0;
      let newCompletedDate: string | null = po.completedDate ?? null;
      if (derivedStatus === "COMPLETED") {
        const dates = allJcs
          .map((j) => j.completedDate || "")
          .filter(Boolean)
          .sort();
        newCompletedDate =
          dates.length > 0
            ? dates[dates.length - 1]
            : (po.completedDate ??
              new Date().toISOString().slice(0, 10));
      }
      const sChanged = po.status !== derivedStatus;
      const pChanged = (po.progress ?? 0) !== newProgress;
      const cChanged =
        derivedStatus === "COMPLETED" &&
        (po.completedDate ?? null) !== (newCompletedDate ?? null);
      if (sChanged) statusChanged++;
      if (pChanged) progressChanged++;
      if (cChanged) completedDateChanged++;
      if (sChanged && statusSamples.length < 10) {
        statusSamples.push({
          poId: po.id,
          poNo: po.poNo,
          before: {
            status: po.status,
            progress: po.progress ?? 0,
            completedDate: po.completedDate ?? null,
          },
          after: {
            status: derivedStatus,
            progress: newProgress,
            completedDate: newCompletedDate,
          },
        });
      }
      if (pChanged && progressSamples.length < 10) {
        progressSamples.push({
          poId: po.id,
          poNo: po.poNo,
          before: {
            status: po.status,
            progress: po.progress ?? 0,
            completedDate: po.completedDate ?? null,
          },
          after: {
            status: derivedStatus,
            progress: newProgress,
            completedDate: newCompletedDate,
          },
        });
      }
      continue;
    }

    try {
      const result = await recomputePoStatusAndProgress(db, po.id);
      if (!result.changed || !result.before || !result.after) continue;
      if (result.statusChanged) {
        statusChanged++;
        if (statusSamples.length < 10) {
          statusSamples.push({
            poId: po.id,
            poNo: po.poNo,
            before: result.before,
            after: result.after,
          });
        }
      }
      if (result.progressChanged) {
        progressChanged++;
        if (progressSamples.length < 10) {
          progressSamples.push({
            poId: po.id,
            poNo: po.poNo,
            before: result.before,
            after: result.after,
          });
        }
      }
      if (result.completedDateChanged) completedDateChanged++;
    } catch (err) {
      errors.push({
        poId: po.id,
        poNo: po.poNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned,
    skippedAdminState,
    statusChanged,
    progressChanged,
    completedDateChanged,
    errors,
    samples: {
      status: statusSamples,
      progress: progressSamples,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-fabcut-rm-issue?dryRun=true|false
//
// One-shot data migration: walk every production_orders row that has at
// least one FAB_CUT JC in COMPLETED/TRANSFERRED status but no RM_ISSUE
// cost_ledger row yet (refType='PRODUCTION_ORDER', refId=po.id).
//
// For each PO, run consumeRawMaterialsForPO(po.id) which:
//   - Resolves materials from bom_templates.wipComponents (active)
//     scoped by po.productCode
//   - Multiplies per-piece qty × parent FC node's pieceCount × po.quantity
//   - FIFO-consumes rm_batches
//   - Writes one cost_ledger RM_ISSUE row per slice (refType=PRODUCTION_ORDER)
//   - Decrements raw_materials.balanceQty
//
// Idempotent on re-run (consumeRawMaterialsForPO checks for existing
// RM_ISSUE row keyed on refType='PRODUCTION_ORDER', refId=po.id).
//
// Why this exists: as of 2026-05-07 the F1 trigger moved from PO
// completion to FAB_CUT JC completion. POs whose FAB_CUT JCs were
// completed BEFORE that change still consume at PO completion if they
// finish; this endpoint forces a retroactive consume for POs that have
// FAB_CUT done but PO not yet COMPLETED (so haven't naturally triggered
// the legacy F1 path either).
//
// dryRun=true → counts only, no DB writes (default)
// dryRun=false → executes the consume batch
// ---------------------------------------------------------------------------
app.post("/backfill-fabcut-rm-issue", async (c) => {
  const dryRun = c.req.query("dryRun") !== "false";
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 200), 10),
    1000,
  );
  const db = c.var.DB;

  // Find DISTINCT POs that have at least one done FAB_CUT JC but no
  // PO-level RM_ISSUE row. Bound at `limit` per call so a single Workers
  // invocation finishes before hitting wall-clock budget.
  const cursor = c.req.query("cursor") || "";
  const candidates = await db
    .prepare(
      `SELECT DISTINCT po.id, po.poNo, po.productCode, po.fabricCode,
              po.itemCategory, po.status
         FROM production_orders po
         INNER JOIN job_cards jc ON jc.productionOrderId = po.id
         WHERE jc.departmentCode = 'FAB_CUT'
           AND jc.status IN ('COMPLETED', 'TRANSFERRED')
           AND po.id > ?
           AND NOT EXISTS (
             SELECT 1 FROM cost_ledger cl
              WHERE cl.refType = 'PRODUCTION_ORDER'
                AND cl.refId = po.id
                AND cl.type = 'RM_ISSUE'
           )
         ORDER BY po.id ASC
         LIMIT ?`,
    )
    .bind(cursor, limit)
    .all<{
      id: string;
      poNo: string | null;
      productCode: string | null;
      fabricCode: string | null;
      itemCategory: string | null;
      status: string | null;
    }>();

  const candidateRows = candidates.results ?? [];
  const total = candidateRows.length;

  if (dryRun) {
    const byCategory: Record<string, number> = {};
    for (const r of candidateRows) {
      const k = r.itemCategory || "(unknown)";
      byCategory[k] = (byCategory[k] ?? 0) + 1;
    }
    const lastId =
      candidateRows.length > 0
        ? candidateRows[candidateRows.length - 1].id
        : "";
    return c.json({
      success: true,
      dryRun: true,
      candidatesScanned: total,
      candidatesByCategory: byCategory,
      sample: candidateRows.slice(0, 10).map((r) => ({
        poId: r.id,
        poNo: r.poNo,
        productCode: r.productCode,
        fabricCode: r.fabricCode,
        itemCategory: r.itemCategory,
        status: r.status,
      })),
      nextCursor: candidateRows.length === limit ? lastId : null,
    });
  }

  // Real run: invoke consumeRawMaterialsForPO per candidate PO. Each
  // call is idempotent. Collect per-PO results.
  let consumed = 0;
  let skipped = 0;
  const errors: { poId: string; error: string }[] = [];
  let totalMaterialCostSen = 0;
  let totalLinesConsumed = 0;
  const shortageSamples: {
    poId: string;
    materialName: string;
    shortageQty: number;
  }[] = [];

  for (const r of candidateRows) {
    try {
      const result = await consumeRawMaterialsForPO(db, r.id);
      if (result.skipped) {
        skipped++;
      } else {
        consumed++;
        totalMaterialCostSen += result.materialCostSen;
        totalLinesConsumed += result.linesConsumed;
        for (const s of result.shortages.slice(0, 3)) {
          if (shortageSamples.length < 20) {
            shortageSamples.push({ poId: r.id, ...s });
          }
        }
      }
    } catch (err) {
      errors.push({
        poId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const lastId =
    candidateRows.length > 0
      ? candidateRows[candidateRows.length - 1].id
      : "";
  return c.json({
    success: true,
    dryRun: false,
    scanned: total,
    consumed,
    skipped,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
    totalMaterialCostSen,
    totalLinesConsumed,
    shortageSamples,
    nextCursor: candidateRows.length === limit ? lastId : null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/audit-orphan-fabric-codes
//
// Read-only diagnostic. Scans production_orders, sales_order_items, and
// consignment_order_items for any non-empty `fabricCode` that does NOT
// resolve to a row in `raw_materials` with a fabric `itemGroup`. For each
// orphan, suggests a canonical match by stripping leading zeros from the
// LAST hyphen-separated segment (the historical typo pattern: M2402-04
// instead of M2402-4).
//
// Response:
//   {
//     totalOrphanRecords: <sum of affectedTables across all codes>,
//     byCode: [
//       {
//         wrongCode, suggestedCode (or null), isSafeTypo,
//         affectedTables: { production_orders, sales_order_items,
//                           consignment_order_items }
//       }
//     ]
//   }
//
// `isSafeTypo` is true ONLY when the leading-zero-stripped form is
// already a valid raw_material — caller can then auto-apply via the
// `/apply-fabric-code-fixes` endpoint without manual review. Anything
// else (pattern doesn't match, or the stripped form still doesn't exist)
// returns isSafeTypo=false and requires a human-supplied mapping.
// ---------------------------------------------------------------------------
app.post("/audit-orphan-fabric-codes", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;

  // 1. Pull every distinct non-empty fabricCode used across the three tables,
  //    along with per-table row counts. UNION ALL preserves duplicates so we
  //    can sum them per-code in one pass.
  const usageRes = await db
    .prepare(
      `SELECT fabricCode, source, n FROM (
         SELECT fabricCode AS fabricCode, 'production_orders' AS source,
                COUNT(*) AS n
           FROM production_orders
          WHERE fabricCode IS NOT NULL AND fabricCode <> ''
          GROUP BY fabricCode
         UNION ALL
         SELECT fabricCode AS fabricCode, 'sales_order_items' AS source,
                COUNT(*) AS n
           FROM sales_order_items
          WHERE fabricCode IS NOT NULL AND fabricCode <> ''
          GROUP BY fabricCode
         UNION ALL
         SELECT fabricCode AS fabricCode, 'consignment_order_items' AS source,
                COUNT(*) AS n
           FROM consignment_order_items
          WHERE fabricCode IS NOT NULL AND fabricCode <> ''
          GROUP BY fabricCode
       ) t`,
    )
    .all<{ fabricCode: string; source: string; n: number }>();
  const usageRows = usageRes.results ?? [];

  // 2. Pull the canonical fabric set from raw_materials so we can both
  //    (a) classify orphans and (b) verify safe-typo suggestions.
  const rmRes = await db
    .prepare(
      `SELECT itemCode FROM raw_materials
        WHERE itemCode IS NOT NULL
          AND itemGroup IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')`,
    )
    .all<{ itemCode: string | null }>();
  const knownCodes = new Set<string>();
  for (const r of rmRes.results ?? []) {
    if (r.itemCode) knownCodes.add(r.itemCode);
  }

  // 3. Aggregate per-code counts, filtering to orphans (codes not in
  //    raw_materials).
  type Counts = {
    production_orders: number;
    sales_order_items: number;
    consignment_order_items: number;
  };
  const byCode = new Map<string, Counts>();
  for (const u of usageRows) {
    if (!u.fabricCode || knownCodes.has(u.fabricCode)) continue;
    let agg = byCode.get(u.fabricCode);
    if (!agg) {
      agg = {
        production_orders: 0,
        sales_order_items: 0,
        consignment_order_items: 0,
      };
      byCode.set(u.fabricCode, agg);
    }
    if (u.source === "production_orders") agg.production_orders += Number(u.n) || 0;
    else if (u.source === "sales_order_items") agg.sales_order_items += Number(u.n) || 0;
    else if (u.source === "consignment_order_items")
      agg.consignment_order_items += Number(u.n) || 0;
  }

  // 4. Suggestion rule — strip leading zeros from the LAST hyphen-separated
  //    segment. If the stripped form already exists in raw_materials,
  //    flag isSafeTypo=true. Anything else returns suggestedCode=null.
  const suggestFor = (wrong: string): string | null => {
    const idx = wrong.lastIndexOf("-");
    if (idx < 0 || idx === wrong.length - 1) return null;
    const head = wrong.slice(0, idx);
    const tail = wrong.slice(idx + 1);
    // Only strip when the tail is purely digits with at least one leading zero.
    if (!/^0+\d+$/.test(tail)) return null;
    const stripped = String(parseInt(tail, 10));
    return `${head}-${stripped}`;
  };

  const result: Array<{
    wrongCode: string;
    suggestedCode: string | null;
    isSafeTypo: boolean;
    affectedTables: Counts;
  }> = [];
  let totalOrphanRecords = 0;
  // Stable ordering for human review — alpha by wrongCode.
  const orphanCodes = Array.from(byCode.keys()).sort();
  for (const wrongCode of orphanCodes) {
    const counts = byCode.get(wrongCode)!;
    const sum =
      counts.production_orders +
      counts.sales_order_items +
      counts.consignment_order_items;
    totalOrphanRecords += sum;
    const candidate = suggestFor(wrongCode);
    const isSafeTypo = candidate !== null && knownCodes.has(candidate);
    result.push({
      wrongCode,
      suggestedCode: isSafeTypo ? candidate : null,
      isSafeTypo,
      affectedTables: counts,
    });
  }

  return c.json({
    totalOrphanRecords,
    byCode: result,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/apply-fabric-code-fixes
//
// Body: { mapping: { "M2402-04": "M2402-4", ... }, dryRun?: boolean }
//
// For each wrongCode → correctCode pair:
//   1. Re-validate that correctCode exists in raw_materials with a fabric
//      itemGroup (don't trust the caller — a hand-rolled mapping could
//      otherwise sneak an orphan code into the orphan-fix path).
//   2. Run UPDATEs against production_orders, sales_order_items,
//      consignment_order_items in a single db.batch() — the three writes
//      either all land or none do, so a partial cascade can't desync the
//      tables.
//   3. Collect affected production_orders.id values so the caller can
//      regen job-cards / fabric-cut JCs downstream (the regen itself is
//      out of scope for this endpoint — it's a separate cascade).
//
// Returns:
//   {
//     applied: [
//       { from, to, rowsUpdated: { ... }, affectedPoIds: [...] }
//     ],
//     rejected: [
//       { from, to, reason }
//     ]
//   }
// ---------------------------------------------------------------------------
app.post("/apply-fabric-code-fixes", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  type Body = {
    mapping?: Record<string, string>;
    dryRun?: boolean;
  };
  let body: Body = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as Body;
  } catch {
    body = {};
  }
  const dryRun = body?.dryRun === true;
  const mapping = body?.mapping && typeof body.mapping === "object"
    ? body.mapping
    : {};
  const pairs = Object.entries(mapping)
    .filter(
      ([from, to]) =>
        typeof from === "string" &&
        typeof to === "string" &&
        from.trim() !== "" &&
        to.trim() !== "",
    )
    .map(([from, to]) => ({ from: from.trim(), to: to.trim() }));

  if (pairs.length === 0) {
    return c.json({
      success: false,
      error: "mapping is required and must contain at least one non-empty pair",
    }, 400);
  }

  const db = c.var.DB;

  // Pre-validate every target in one round-trip — cheap and lets us reject
  // bad pairs before attempting any UPDATEs. Note we ONLY check the target
  // (`to`) side: the source (`from`) is by definition an orphan, that's
  // why we're fixing it.
  const targetCheck = await validateFabricCodes(
    db,
    pairs.map((p) => p.to),
  );
  const unknownTargets = new Set(targetCheck.unknown);

  const applied: Array<{
    from: string;
    to: string;
    rowsUpdated: {
      production_orders: number;
      sales_order_items: number;
      consignment_order_items: number;
    };
    affectedPoIds: string[];
  }> = [];
  const rejected: Array<{ from: string; to: string; reason: string }> = [];

  for (const pair of pairs) {
    if (pair.from === pair.to) {
      rejected.push({
        from: pair.from,
        to: pair.to,
        reason: "from and to are identical — nothing to do",
      });
      continue;
    }
    if (unknownTargets.has(pair.to)) {
      rejected.push({
        from: pair.from,
        to: pair.to,
        reason: "target not in raw_materials",
      });
      continue;
    }

    // Snapshot affected PO ids BEFORE the UPDATE — caller needs them for
    // downstream JC regen. Doing this read in dryRun mode too returns the
    // same ids the live mode would touch.
    const affectedRes = await db
      .prepare(
        `SELECT id FROM production_orders WHERE fabricCode = ?`,
      )
      .bind(pair.from)
      .all<{ id: string }>();
    const affectedPoIds = (affectedRes.results ?? []).map((r) => r.id);

    // Count rows that would change in each table. For the dryRun path we
    // return these counts without writing; for the live path we use them
    // as the expected-rowcount report (db.batch results don't always
    // surface row counts on the postgres compat shim, so we count here).
    const [poCountRes, soiCountRes, coiCountRes] = await Promise.all([
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM production_orders WHERE fabricCode = ?",
        )
        .bind(pair.from)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sales_order_items WHERE fabricCode = ?",
        )
        .bind(pair.from)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM consignment_order_items WHERE fabricCode = ?",
        )
        .bind(pair.from)
        .first<{ n: number }>(),
    ]);
    const rowsUpdated = {
      production_orders: Number(poCountRes?.n) || 0,
      sales_order_items: Number(soiCountRes?.n) || 0,
      consignment_order_items: Number(coiCountRes?.n) || 0,
    };

    if (!dryRun) {
      // Atomic three-statement batch — production_orders, sales_order_items,
      // consignment_order_items must all flip together. db.batch() is the
      // closest primitive the pg compat shim exposes to a transaction; if
      // any statement throws, the whole batch fails and we surface the
      // pair as rejected.
      try {
        await db.batch([
          db
            .prepare(
              "UPDATE production_orders SET fabricCode = ? WHERE fabricCode = ?",
            )
            .bind(pair.to, pair.from),
          db
            .prepare(
              "UPDATE sales_order_items SET fabricCode = ? WHERE fabricCode = ?",
            )
            .bind(pair.to, pair.from),
          db
            .prepare(
              "UPDATE consignment_order_items SET fabricCode = ? WHERE fabricCode = ?",
            )
            .bind(pair.to, pair.from),
        ]);
      } catch (err) {
        rejected.push({
          from: pair.from,
          to: pair.to,
          reason:
            err instanceof Error
              ? `update batch failed: ${err.message}`
              : "update batch failed",
        });
        continue;
      }
    }

    applied.push({
      from: pair.from,
      to: pair.to,
      rowsUpdated,
      affectedPoIds,
    });
  }

  return c.json({
    dryRun,
    applied,
    rejected,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-jc-production-time-from-bom?dryRun=true|false
//
// Per-WIP-tree refresh of job_cards.productionTimeMinutes from the CURRENT
// active BOM template's wipComponents JSON. Distinct from
// /api/bom/resync-job-card-times (which overwrites from kv_config master
// productionTimes keyed by deptCode+category): this endpoint walks the BOM
// JSON tree per top-level WIP and stamps the dept-specific minutes that
// the BOM walker emits — matching what the SO->JC cascade does on PO create.
//
// Why this exists: bom_templates.wipComponents is the canonical store of
// per-WIP per-process minutes. When the operator edits a single WIP node
// (e.g. 5536-CSL bumped 40 -> 60 in UPHOLSTERY), existing JCs created BEFORE
// that edit keep stamping the old 40. Daily Breakdown then shows stale
// numbers. This backfill walks every active JC's PO -> BOM tree, finds the
// matching (wipKey, deptCode) entry, and overwrites productionTimeMinutes
// + estMinutes when drifted.
//
// Scope (operator directive 2026-05-08 "全部都要 fix 掉的"):
//   - Default ?includeCompleted=true → ALL statuses get rewritten,
//     including COMPLETED + TRANSFERRED. Operator consciously accepts
//     that historical Employee Efficiency / Total JC Time numbers will
//     retroactively reflect current BOM truth instead of stale snapshots.
//   - ?includeCompleted=false → COMPLETED/TRANSFERRED drift surfaced in
//     `completedDrifts` for review but NOT applied. (Original conservative
//     behavior pre-2026-05-08.)
//   - JCs whose wipKey is "FG" (FG-level l1Processes) are SKIPPED — those
//     belong to the kv_config-master path and are out of scope here.
//
// 5536-CSL / 5540-CSL guard: when the BOM walker emits 0 for a JC that
// previously stored a non-zero productionTimeMinutes, DO NOT zero it out.
// The 0 reflects a missing UPH stanza on the top-level BOM node (the
// chaise might genuinely have no upholstery, OR the BOM is missing UPH
// data — operator hasn't disambiguated). Preserving the stored value
// keeps already-credited work intact, and we surface the JC under
// `bomZeroPreservedSamples[]` so the operator can audit the BOM gap.
//
// Surgical: only productionTimeMinutes + estMinutes change. pic1Id /
// pic2Id / status / completedDate / actualMinutes / wipKey / wipCode /
// wipLabel / wipQty are preserved.
//
// Query string:
//   ?dryRun=true                 → SELECT-only summary, sample 30 worst.
//   ?dryRun=false                → apply UPDATEs in db.batch chunks of 50.
//   ?includeCompleted=false      → exclude COMPLETED/TRANSFERRED writes.
//
// Response shape: { success, dryRun, scanned, drifted, updated,
//   completedDrifts: [{jcId, poNo, productCode, wipKey, deptCode,
//                      oldMinutes, newMinutes}], topDrifts: [...] }
// ---------------------------------------------------------------------------
type JcBackfillRow = {
  id: string;
  productionOrderId: string;
  status: string;
  wipKey: string | null;
  departmentCode: string | null;
  productionTimeMinutes: number | null;
  estMinutes: number | null;
  poNo: string | null;
  productCode: string | null;
  quantity: number | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
};

type DriftSample = {
  jcId: string;
  poNo: string;
  productCode: string;
  wipKey: string;
  deptCode: string;
  status: string;
  oldMinutes: number;
  newMinutes: number;
  delta: number;
};

const ACTIVE_JC_STATUSES = ["WAITING", "IN_PROGRESS", "PAUSED", "BLOCKED"];
const COMPLETED_JC_STATUSES = ["COMPLETED", "TRANSFERRED"];

app.post("/backfill-jc-production-time-from-bom", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  // Default ON per operator directive — only set false to opt back into
  // active-only scope.
  const includeCompleted = c.req.query("includeCompleted") !== "false";

  // 1. Load every JC across the statuses we care about, joined to PO so we
  // have the variant context the BOM walker needs without a second pass.
  const allStatuses = [...ACTIVE_JC_STATUSES, ...COMPLETED_JC_STATUSES];
  const placeholders = allStatuses.map(() => "?").join(",");
  const sel = await db
    .prepare(
      `SELECT
         jc.id                    AS id,
         jc.productionOrderId     AS productionOrderId,
         jc.status                AS status,
         jc.wipKey                AS wipKey,
         jc.departmentCode        AS departmentCode,
         jc.productionTimeMinutes AS productionTimeMinutes,
         jc.estMinutes            AS estMinutes,
         po.poNo                  AS poNo,
         po.productCode           AS productCode,
         po.quantity              AS quantity,
         po.itemCategory          AS itemCategory,
         po.sizeCode              AS sizeCode,
         po.sizeLabel             AS sizeLabel,
         po.fabricCode            AS fabricCode,
         po.divanHeightInches     AS divanHeightInches,
         po.legHeightInches       AS legHeightInches,
         po.gapInches             AS gapInches
       FROM job_cards jc
       LEFT JOIN production_orders po ON po.id = jc.productionOrderId
       WHERE jc.status IN (${placeholders})
       ORDER BY jc.id ASC`,
    )
    .bind(...allStatuses)
    .all<JcBackfillRow>();
  const rows = sel.results ?? [];

  // 2. Cache BOM template lookups per-productCode. Many JCs share the same
  // product, so a Map saves O(n) DB calls.
  type BomCacheEntry = {
    wipComponents: string | null;
    l1Processes: string | null;
    baseModel: string | null;
  } | null;
  const bomCache = new Map<string, BomCacheEntry>();
  async function loadBom(productCode: string): Promise<BomCacheEntry> {
    if (bomCache.has(productCode)) return bomCache.get(productCode)!;
    const active = await db
      .prepare(
        `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{
        wipComponents: string | null;
        l1Processes: string | null;
        baseModel: string | null;
      }>();
    if (active) {
      bomCache.set(productCode, active);
      return active;
    }
    const latest = await db
      .prepare(
        `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{
        wipComponents: string | null;
        l1Processes: string | null;
        baseModel: string | null;
      }>();
    bomCache.set(productCode, latest ?? null);
    return latest ?? null;
  }

  // 3. Walk each JC, look up its expected per-WIP per-dept minutes from the
  // current BOM tree, classify drift.
  const activeDrifts: DriftSample[] = [];
  const completedDrifts: DriftSample[] = [];
  const updates: Array<{ id: string; newMinutes: number }> = [];
  // 5536-CSL / 5540-CSL guard: BOM walker emitted 0 minutes but stored
  // value is non-zero — preserve and surface for operator audit.
  const bomZeroPreservedSamples: Array<{
    jcId: string;
    poNo: string;
    productCode: string;
    wipKey: string;
    deptCode: string;
    storedMinutes: number;
    status: string;
  }> = [];
  let bomZeroPreservedCount = 0;
  let scanned = 0;
  let unchanged = 0;
  let skippedNoBom = 0;
  let skippedFg = 0;
  let skippedNoMatch = 0;

  for (const r of rows) {
    scanned++;
    const productCode = r.productCode ?? "";
    const wipKey = r.wipKey ?? "";
    const deptCode = r.departmentCode ?? "";
    if (!productCode || !wipKey || !deptCode) {
      skippedNoMatch++;
      continue;
    }
    // FG-level (wipKey="FG") JCs are driven by l1Processes, which is the
    // master Production Times path — out of scope for the BOM-tree backfill.
    if (wipKey === "FG") {
      skippedFg++;
      continue;
    }

    const bom = await loadBom(productCode);
    if (!bom || !bom.wipComponents) {
      skippedNoBom++;
      continue;
    }

    const variants: BomVariantContext = {
      productCode,
      model: bom.baseModel ?? productCode,
      sizeLabel: r.sizeLabel ?? "",
      sizeCode: r.sizeCode ?? "",
      fabricCode: r.fabricCode ?? "",
      divanHeightInches: r.divanHeightInches ?? null,
      legHeightInches: r.legHeightInches ?? null,
      gapInches: r.gapInches ?? null,
    };
    const wips = breakBomIntoWips(bom.wipComponents, productCode, variants);
    const wip = wips.find((w) => w.wipKey === wipKey);
    if (!wip) {
      skippedNoMatch++;
      continue;
    }
    const proc = wip.processes.find((p) => p.deptCode === deptCode);
    if (!proc) {
      skippedNoMatch++;
      continue;
    }

    const oldMinutes = r.productionTimeMinutes ?? 0;
    const newMinutes = proc.minutes;

    // 5536-CSL / 5540-CSL guard: BOM walker says 0 but JC has non-zero
    // stored minutes. Likely a missing UPH stanza on the top-level BOM
    // node — DO NOT zero out (would erase already-credited work). Surface
    // for operator review and skip the write.
    if (newMinutes === 0 && oldMinutes > 0) {
      bomZeroPreservedCount++;
      if (bomZeroPreservedSamples.length < 50) {
        bomZeroPreservedSamples.push({
          jcId: r.id,
          poNo: r.poNo ?? "",
          productCode,
          wipKey,
          deptCode,
          storedMinutes: oldMinutes,
          status: r.status,
        });
      }
      continue;
    }

    if (oldMinutes === newMinutes && (r.estMinutes ?? 0) === newMinutes) {
      unchanged++;
      continue;
    }

    const sample: DriftSample = {
      jcId: r.id,
      poNo: r.poNo ?? "",
      productCode,
      wipKey,
      deptCode,
      status: r.status,
      oldMinutes,
      newMinutes,
      delta: newMinutes - oldMinutes,
    };
    if (COMPLETED_JC_STATUSES.includes(r.status)) {
      completedDrifts.push(sample);
      // Operator directive 2026-05-08: when includeCompleted=true (default)
      // also queue the COMPLETED/TRANSFERRED rows for UPDATE. Surgical —
      // only productionTimeMinutes + estMinutes change, not status / pics /
      // completedDate / actualMinutes.
      if (includeCompleted) {
        updates.push({ id: r.id, newMinutes });
      }
    } else {
      activeDrifts.push(sample);
      updates.push({ id: r.id, newMinutes });
    }
  }

  // Sort top-N by absolute delta so the operator sees the worst drifts first.
  const sortByAbsDelta = (a: DriftSample, b: DriftSample) =>
    Math.abs(b.delta) - Math.abs(a.delta);
  activeDrifts.sort(sortByAbsDelta);
  completedDrifts.sort(sortByAbsDelta);

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      includeCompleted,
      scanned,
      activeDrifted: activeDrifts.length,
      completedDrifted: completedDrifts.length,
      // wouldUpdate reflects the actual write queue for the configured
      // includeCompleted scope — easier for operator to compare against
      // the live-run `updated` count.
      wouldUpdate: updates.length,
      unchanged,
      bomZeroPreserved: bomZeroPreservedCount,
      skipped: {
        fgWipKey: skippedFg,
        noBom: skippedNoBom,
        noWipOrDeptMatch: skippedNoMatch,
      },
      topActiveDrifts: activeDrifts.slice(0, 30),
      topCompletedDrifts: completedDrifts.slice(0, 30),
      bomZeroPreservedSamples,
    });
  }

  // 4. Real run — apply UPDATEs in chunks of 50.
  const CHUNK = 50;
  let updated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const stmts = slice.map((u) =>
      db
        .prepare(
          `UPDATE job_cards
             SET productionTimeMinutes = ?, estMinutes = ?
             WHERE id = ?`,
        )
        .bind(u.newMinutes, u.newMinutes, u.id),
    );
    if (stmts.length > 0) {
      try {
        await db.batch(stmts);
        updated += stmts.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          {
            success: false,
            error: `Batch UPDATE failed at chunk ${i}: ${message}`,
            updatedBeforeFailure: updated,
          },
          500,
        );
      }
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    includeCompleted,
    scanned,
    activeDrifted: activeDrifts.length,
    completedDrifted: completedDrifts.length,
    updated,
    unchanged,
    bomZeroPreserved: bomZeroPreservedCount,
    skipped: {
      fgWipKey: skippedFg,
      noBom: skippedNoBom,
      noWipOrDeptMatch: skippedNoMatch,
    },
    topActiveDrifts: activeDrifts.slice(0, 30),
    topCompletedDrifts: completedDrifts.slice(0, 30),
    bomZeroPreservedSamples,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/refresh-jcs-by-id
//
// Narrow JC wipCode/wipLabel refresh. Takes EXPLICIT jcIds list (no sweep,
// no heuristic filter). For each JC:
//   - FAB_CUT cross-PO merge JC (id starts with jc-fc-so- / jc-fc-po-):
//     wipLabel rebuilt via cross-PO-merge format with current SO context
//     (mirrors buildFcWipLabel in production-builder.ts); wipCode via BOM
//     walker (anchor piece's FAB_CUT process).
//   - Standard BOM-tree JC: re-walks current ACTIVE BOM template against
//     current SO context, matches by wipKey or dept fallback, returns the
//     resolved process's wipCode/wipLabel.
//
// Surgical: ONLY wipCode + wipLabel change. status, pic1Id, pic2Id,
// completedDate, productionTimeMinutes, wipKey, branchKey, wipQty are all
// preserved. Operator's work credit is unaffected.
//
// Body: { jcIds: string[], dryRun: boolean }
// Returns: { success, dryRun, requested, found, notFound, changed,
//            unchanged, updated?, results, errors? }
//
// This is the surgical replacement for /backfill-jc-wip-labels-from-bom
// (reverted in commit 25d00c0). That version swept system-wide with a
// heuristic skip filter that wrongly excluded jc-fc-po- prefixed JCs (the
// 22 ((K))/((Q)) rows on FAB_CUT). This endpoint processes ONLY the
// explicit jcIds passed in body — no auto-discovery, no skip heuristic,
// no scope creep.
// ---------------------------------------------------------------------------
type RefreshJcRow = {
  id: string;
  productionOrderId: string;
  status: string;
  wipKey: string | null;
  departmentCode: string | null;
  wipCode: string | null;
  wipLabel: string | null;
  poNo: string | null;
  productCode: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
};

app.post("/refresh-jcs-by-id", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { jcIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as { jcIds?: unknown; dryRun?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const jcIds = Array.isArray(body.jcIds)
    ? body.jcIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!jcIds || jcIds.length === 0) {
    return c.json(
      {
        success: false,
        error: "body.jcIds must be a non-empty array of strings",
      },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  // Load JCs by exact id list — no sweep, no filter, just SELECT WHERE IN.
  const placeholders = jcIds.map(() => "?").join(",");
  const sel = await db
    .prepare(
      `SELECT
         jc.id                AS id,
         jc.productionOrderId AS productionOrderId,
         jc.status            AS status,
         jc.wipKey            AS wipKey,
         jc.departmentCode    AS departmentCode,
         jc.wipCode           AS wipCode,
         jc.wipLabel          AS wipLabel,
         po.poNo              AS poNo,
         po.productCode       AS productCode,
         po.itemCategory      AS itemCategory,
         po.sizeCode          AS sizeCode,
         po.sizeLabel         AS sizeLabel,
         po.fabricCode        AS fabricCode,
         po.divanHeightInches AS divanHeightInches,
         po.legHeightInches   AS legHeightInches,
         po.gapInches         AS gapInches
       FROM job_cards jc
       LEFT JOIN production_orders po ON po.id = jc.productionOrderId
       WHERE jc.id IN (${placeholders})`,
    )
    .bind(...jcIds)
    .all<RefreshJcRow>();
  const rows = sel.results ?? [];
  const foundIds = new Set(rows.map((r) => r.id));
  const notFound = jcIds.filter((id) => !foundIds.has(id));

  // BOM cache (one ACTIVE template per productCode; falls back to most
  // recent draft if no ACTIVE row).
  const bomCache = new Map<
    string,
    { wipComponents: string | null; baseModel: string | null } | null
  >();
  async function loadBom(productCode: string) {
    if (bomCache.has(productCode)) return bomCache.get(productCode);
    const active = await db
      .prepare(
        `SELECT wipComponents, baseModel FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null; baseModel: string | null }>();
    if (active) {
      bomCache.set(productCode, active);
      return active;
    }
    const latest = await db
      .prepare(
        `SELECT wipComponents, baseModel FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null; baseModel: string | null }>();
    bomCache.set(productCode, latest ?? null);
    return latest;
  }

  type Result = {
    jcId: string;
    poNo?: string;
    productCode?: string;
    deptCode?: string;
    isFcMerge?: boolean;
    before?: { wipCode: string; wipLabel: string };
    after?: { wipCode: string; wipLabel: string };
    changed?: boolean;
    error?: string;
  };
  const results: Result[] = [];
  const updates: Array<{
    id: string;
    newWipCode: string;
    newWipLabel: string;
  }> = [];

  for (const r of rows) {
    const productCode = r.productCode || "";
    if (!productCode) {
      results.push({ jcId: r.id, error: "PO missing productCode" });
      continue;
    }
    // FC-merge detection: jcId convention OR wipKey shape. The id-prefix
    // form was added later (jc-fc-so- / jc-fc-po-); legacy FC-merge JCs
    // created before that convention have jcId `jc-pord-so-...` but their
    // wipKey still follows the merge format
    // `{idShape}::{baseModel}::{fabricCode}::FAB_CUT` where segment 0 is
    // a poId / SO- / CO- id (NOT a productCode). Detect both forms so the
    // walker uses buildFcWipLabel-style logic instead of trying to match
    // a non-existent BOM tree node.
    const wkSegs = (r.wipKey || "").split("::");
    const isFcMergeByKey =
      wkSegs.length === 4 &&
      wkSegs[3] === "FAB_CUT" &&
      (wkSegs[0].startsWith("pord-") ||
        wkSegs[0].startsWith("SO-") ||
        wkSegs[0].startsWith("CO-"));
    const isFcMerge =
      r.id.startsWith("jc-fc-so-") ||
      r.id.startsWith("jc-fc-po-") ||
      isFcMergeByKey;
    const oldWipCode = r.wipCode ?? "";
    const oldWipLabel = r.wipLabel ?? "";
    let newWipCode = oldWipCode;
    let newWipLabel = oldWipLabel;

    if (isFcMerge) {
      // FAB_CUT cross-PO merge JC: wipLabel format is buildFcWipLabel-style
      // (productCode | (size) | (totalH") | (DV divanH") | fabric | (FC));
      // wipCode is the BOM walker's FAB_CUT process output for the anchor
      // piece (DIVAN/HEADBOARD).
      const totalH =
        (r.gapInches ?? 0) +
        (r.divanHeightInches ?? 0) +
        (r.legHeightInches ?? 0);
      const isBF = r.itemCategory === "BEDFRAME";
      newWipLabel = [
        productCode,
        r.sizeLabel ? `(${r.sizeLabel})` : "",
        isBF && totalH > 0 ? `(${totalH}")` : "",
        isBF && r.divanHeightInches ? `(DV ${r.divanHeightInches}")` : "",
        r.fabricCode || "",
        "(FC)",
      ]
        .filter(Boolean)
        .join(" | ");

      const bom = await loadBom(productCode);
      if (bom?.wipComponents) {
        const variants: BomVariantContext = {
          productCode,
          model: bom.baseModel ?? productCode,
          sizeLabel: r.sizeLabel ?? "",
          sizeCode: r.sizeCode ?? "",
          fabricCode: r.fabricCode ?? "",
          divanHeightInches: r.divanHeightInches ?? null,
          legHeightInches: r.legHeightInches ?? null,
          gapInches: r.gapInches ?? null,
        };
        const wips = breakBomIntoWips(
          bom.wipComponents,
          productCode,
          variants,
        );
        const anchor = wips.find((w) =>
          w.processes.some((p) => p.deptCode === "FAB_CUT"),
        );
        if (anchor) {
          const proc = anchor.processes.find((p) => p.deptCode === "FAB_CUT");
          newWipCode = proc?.wipCode || anchor.wipCode || oldWipCode;
        }
      }
    } else {
      // Standard BOM-tree JC: re-walk current ACTIVE BOM, match by wipKey
      // or single-dept fallback, use process's wipCode/wipLabel.
      const bom = await loadBom(productCode);
      if (!bom?.wipComponents) {
        results.push({
          jcId: r.id,
          poNo: r.poNo ?? undefined,
          productCode,
          deptCode: r.departmentCode ?? undefined,
          error: "No active BOM template",
        });
        continue;
      }
      const variants: BomVariantContext = {
        productCode,
        model: bom.baseModel ?? productCode,
        sizeLabel: r.sizeLabel ?? "",
        sizeCode: r.sizeCode ?? "",
        fabricCode: r.fabricCode ?? "",
        divanHeightInches: r.divanHeightInches ?? null,
        legHeightInches: r.legHeightInches ?? null,
        gapInches: r.gapInches ?? null,
      };
      const wips = breakBomIntoWips(bom.wipComponents, productCode, variants);
      let wip = wips.find((w) => w.wipKey === r.wipKey);
      // Fallback 1: match on wipKey segments 0-2 (productCode::idx::wipType).
      // The 4th segment is the rawTopCode template — if the BOM template was
      // edited, the old JC's wipKey diverges from the new walker's output but
      // the first 3 segments are stable. Common case: BOM editor changed
      // {DIVAN_HEIGHT} Divan- {SIZE} → {PRODUCT_CODE} Divan- {SIZE} (or
      // similar), JCs created under the old template need to match the new
      // walker output by wipType + position.
      if (!wip && r.wipKey) {
        const oldSegs = r.wipKey.split("::");
        if (oldSegs.length >= 3) {
          const oldPrefix = oldSegs.slice(0, 3).join("::");
          wip = wips.find((w) => {
            const newSegs = w.wipKey.split("::");
            return newSegs.slice(0, 3).join("::") === oldPrefix;
          });
        }
      }
      // Fallback 2: match on wipKey segments 1-2 only (idx::wipType), ignoring
      // segment 0 (productCode). Used when PO's productCode was corrected
      // (e.g. SOFA variant swap LHF↔RHF via /backfill-po-from-so-lines): the
      // JC's old wipKey has the stale productCode but idx + wipType are
      // stable within the BOM tree so segments 1-2 still identify the WIP.
      if (!wip && r.wipKey) {
        const oldSegs = r.wipKey.split("::");
        if (oldSegs.length >= 3) {
          const oldIdxType = `${oldSegs[1]}::${oldSegs[2]}`;
          wip = wips.find((w) => {
            const newSegs = w.wipKey.split("::");
            return (
              newSegs.length >= 3 &&
              `${newSegs[1]}::${newSegs[2]}` === oldIdxType
            );
          });
        }
      }
      // Fallback 3: pick the only WIP that has a process for this dept.
      if (!wip && r.departmentCode) {
        const candidates = wips.filter((w) =>
          w.processes.some((p) => p.deptCode === r.departmentCode),
        );
        if (candidates.length === 1) wip = candidates[0];
      }
      if (!wip) {
        results.push({
          jcId: r.id,
          poNo: r.poNo ?? undefined,
          productCode,
          deptCode: r.departmentCode ?? undefined,
          error:
            "No matching WIP in BOM (wipKey + segment-prefix + idx-type + dept fallback all failed)",
        });
        continue;
      }
      const proc = wip.processes.find((p) => p.deptCode === r.departmentCode);
      if (!proc) {
        results.push({
          jcId: r.id,
          poNo: r.poNo ?? undefined,
          productCode,
          deptCode: r.departmentCode ?? undefined,
          error: "Matched WIP but no process for this dept",
        });
        continue;
      }
      newWipCode = proc.wipCode || wip.wipCode || oldWipCode;
      newWipLabel = proc.wipLabel || wip.wipLabel || oldWipLabel;
    }

    const changed = newWipCode !== oldWipCode || newWipLabel !== oldWipLabel;
    results.push({
      jcId: r.id,
      poNo: r.poNo ?? undefined,
      productCode,
      deptCode: r.departmentCode ?? undefined,
      isFcMerge,
      before: { wipCode: oldWipCode, wipLabel: oldWipLabel },
      after: { wipCode: newWipCode, wipLabel: newWipLabel },
      changed,
    });
    if (changed) {
      updates.push({ id: r.id, newWipCode, newWipLabel });
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      requested: jcIds.length,
      found: rows.length,
      notFound,
      changed: updates.length,
      unchanged: rows.length - updates.length,
      results,
    });
  }

  // Live UPDATE in chunks of 50 (D1 batch limit-friendly). On chunk error,
  // record + continue so partial progress lands; caller can re-run.
  const CHUNK = 50;
  let updated = 0;
  const errors: Array<{ chunk: number; message: string }> = [];
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const stmts = slice.map((u) =>
      db
        .prepare(
          `UPDATE job_cards SET wipCode = ?, wipLabel = ? WHERE id = ?`,
        )
        .bind(u.newWipCode, u.newWipLabel, u.id),
    );
    if (stmts.length === 0) continue;
    try {
      await db.batch(stmts);
      updated += stmts.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ chunk: i, message });
    }
  }

  return c.json({
    success: errors.length === 0,
    dryRun: false,
    requested: jcIds.length,
    found: rows.length,
    notFound,
    updated,
    changed: updates.length,
    unchanged: rows.length - updates.length,
    results,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-po-from-so-lines
//
// One-shot backfill: re-syncs production_orders attributes to match their
// source sales_order_items. For each input soId:
//
//   1. Loads SO line items (sorted by lineNo).
//   2. Expands lines into per-PO list using the generator's own expansion
//      logic (SOFA non-project: 1 PO per line carrying line.quantity;
//      BEDFRAME/ACCESSORY: pieceCount = line.quantity, each PO carries 1).
//   3. Loads production_orders for the SO sorted by suffix.
//   4. PO count check: if expected != actual → reject (caller must
//      decide whether to create/delete POs; out of scope for this
//      backfill which only updates existing rows).
//   5. For each PO at index i, UPDATEs PO attributes to match expected
//      unit's: productCode, sizeLabel, sizeCode, fabricCode,
//      divanHeightInches, legHeightInches, gapInches, salesOrderItemId.
//      DOES NOT touch status, currentDepartment, dueDate, completedDate,
//      progress, customerPOId, etc. — those are operational state, not
//      source attributes.
//
// Body: { soIds: string[], dryRun: boolean }
// Returns: { success, dryRun, processed: [{soId, status, changes?, error?}] }
//
// Supports both internal soId and companySOId in input (resolved per-SO).
//
// Per memory feedback_isolated_branch_for_schema_changes: cascade integrity
// work; called from main but operator must dry-run + confirm before live.
// ---------------------------------------------------------------------------
type BackfillExpectedUnit = {
  lineId: string;
  lineSuffix: string | null;
  lineNo: number | null;
  productCode: string | null;
  productName: string | null;
  productId: string | null;
  itemCategory: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  specialOrder: string | null;
  unitQty: number;
};

app.post("/backfill-po-from-so-lines", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "update");
  if (denied) return denied;

  let body: { soIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as { soIds?: unknown; dryRun?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const soIdsRaw = Array.isArray(body.soIds)
    ? body.soIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : null;
  if (!soIdsRaw || soIdsRaw.length === 0) {
    return c.json(
      {
        success: false,
        error: "body.soIds must be a non-empty array of strings",
      },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  type ProcessResult = {
    soId: string;
    companySOId?: string | null;
    status: "ok" | "skipped" | "error";
    expectedPoCount?: number;
    actualPoCount?: number;
    changes?: Array<{
      poId: string;
      poNo: string;
      diffs: Record<
        string,
        { from: unknown; to: unknown }
      >;
    }>;
    error?: string;
    isProjectOrder?: boolean;
  };
  const processed: ProcessResult[] = [];
  const allUpdateStatements: D1PreparedStatement[] = [];

  for (const soIdRaw of soIdsRaw) {
    // Resolve to internal id
    let soRow = await db
      .prepare(
        "SELECT id, companySOId, isProjectOrder FROM sales_orders WHERE id = ? LIMIT 1",
      )
      .bind(soIdRaw)
      .first<{ id: string; companySOId: string | null; isProjectOrder: number | null }>();
    if (!soRow) {
      soRow = await db
        .prepare(
          "SELECT id, companySOId, isProjectOrder FROM sales_orders WHERE companySOId = ? LIMIT 1",
        )
        .bind(soIdRaw)
        .first<{ id: string; companySOId: string | null; isProjectOrder: number | null }>();
    }
    if (!soRow) {
      processed.push({
        soId: soIdRaw,
        status: "error",
        error: "SO not found by id or companySOId",
      });
      continue;
    }
    const soId = soRow.id;
    const isProject = !!soRow.isProjectOrder;

    // Load SO line items
    const linesRes = await db
      .prepare(
        `SELECT id, lineNo, lineSuffix, productId, productCode, productName,
                itemCategory, sizeCode, sizeLabel, fabricCode,
                divanHeightInches, legHeightInches, gapInches,
                specialOrder, quantity
           FROM sales_order_items WHERE salesOrderId = ?
           ORDER BY lineNo ASC`,
      )
      .bind(soId)
      .all<{
        id: string;
        lineNo: number | null;
        lineSuffix: string | null;
        productId: string | null;
        productCode: string | null;
        productName: string | null;
        itemCategory: string | null;
        sizeCode: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        gapInches: number | null;
        specialOrder: string | null;
        quantity: number;
      }>();
    const lines = linesRes.results ?? [];

    // Expand into per-PO unit list — mirrors createProductionOrdersForOrder:
    //   SOFA non-project: 1 entry per line (line.quantity carried on the PO)
    //   BEDFRAME/ACC + project SOFA: line.quantity entries per line
    const expected: BackfillExpectedUnit[] = [];
    for (const line of lines) {
      const isSofa = (line.itemCategory ?? "BEDFRAME") === "SOFA";
      const isSetItem = isSofa && !isProject;
      const pieceCount = isSetItem ? 1 : Math.max(1, line.quantity || 1);
      const perPoQty = isSetItem ? line.quantity || 1 : 1;
      for (let p = 0; p < pieceCount; p++) {
        expected.push({
          lineId: line.id,
          lineSuffix: line.lineSuffix,
          lineNo: line.lineNo,
          productCode: line.productCode,
          productName: line.productName,
          productId: line.productId,
          itemCategory: line.itemCategory,
          sizeLabel: line.sizeLabel,
          sizeCode: line.sizeCode,
          fabricCode: line.fabricCode,
          divanHeightInches: line.divanHeightInches,
          legHeightInches: line.legHeightInches,
          gapInches: line.gapInches,
          specialOrder: line.specialOrder,
          unitQty: perPoQty,
        });
      }
    }

    // Load existing POs sorted by id (which encodes suffix)
    const posRes = await db
      .prepare(
        `SELECT id, poNo, productCode, productName, productId, itemCategory,
                sizeCode, sizeLabel, fabricCode,
                divanHeightInches, legHeightInches, gapInches,
                specialOrder, quantity, status
           FROM production_orders WHERE salesOrderId = ? AND status <> 'CANCELLED'
           ORDER BY id ASC`,
      )
      .bind(soId)
      .all<{
        id: string;
        poNo: string;
        productCode: string | null;
        productName: string | null;
        productId: string | null;
        itemCategory: string | null;
        sizeCode: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        gapInches: number | null;
        specialOrder: string | null;
        quantity: number;
        status: string;
      }>();
    const pos = posRes.results ?? [];

    // PO count check
    if (pos.length !== expected.length) {
      processed.push({
        soId,
        companySOId: soRow.companySOId,
        status: "skipped",
        expectedPoCount: expected.length,
        actualPoCount: pos.length,
        isProjectOrder: isProject,
        error: `PO count mismatch (expected ${expected.length}, got ${pos.length}) — needs CREATE/DELETE which is out of scope for this backfill. Operator must investigate manually.`,
      });
      continue;
    }

    // Pair PO[i] with expected[i] and compute diffs
    const changes: NonNullable<ProcessResult["changes"]> = [];
    for (let i = 0; i < pos.length; i++) {
      const po = pos[i];
      const exp = expected[i];
      const diffs: Record<string, { from: unknown; to: unknown }> = {};

      const checks: Array<[string, unknown, unknown]> = [
        ["productCode", po.productCode, exp.productCode],
        ["productName", po.productName, exp.productName],
        ["productId", po.productId, exp.productId],
        ["itemCategory", po.itemCategory, exp.itemCategory],
        ["sizeCode", po.sizeCode, exp.sizeCode],
        ["sizeLabel", po.sizeLabel, exp.sizeLabel],
        ["fabricCode", po.fabricCode, exp.fabricCode],
        ["divanHeightInches", po.divanHeightInches, exp.divanHeightInches],
        ["legHeightInches", po.legHeightInches, exp.legHeightInches],
        ["gapInches", po.gapInches, exp.gapInches],
        ["specialOrder", po.specialOrder, exp.specialOrder],
        ["quantity", po.quantity, exp.unitQty],
      ];
      for (const [field, from, to] of checks) {
        const normFrom =
          from === null || from === undefined || from === "" ? null : from;
        const normTo =
          to === null || to === undefined || to === "" ? null : to;
        if (normFrom !== normTo) {
          diffs[field] = { from, to };
        }
      }

      if (Object.keys(diffs).length > 0) {
        changes.push({ poId: po.id, poNo: po.poNo, diffs });
        // Build UPDATE statement (only changed fields)
        const setClauses: string[] = [];
        const binds: unknown[] = [];
        for (const field of Object.keys(diffs)) {
          setClauses.push(`${field} = ?`);
          const val = (diffs[field].to ?? null) as unknown;
          binds.push(val);
        }
        if (setClauses.length > 0) {
          setClauses.push("updated_at = ?");
          binds.push(new Date().toISOString());
          binds.push(po.id);
          allUpdateStatements.push(
            db
              .prepare(
                `UPDATE production_orders SET ${setClauses.join(", ")} WHERE id = ?`,
              )
              .bind(...binds),
          );
        }
      }
    }

    processed.push({
      soId,
      companySOId: soRow.companySOId,
      status: "ok",
      expectedPoCount: expected.length,
      actualPoCount: pos.length,
      isProjectOrder: isProject,
      changes,
    });
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      processed,
      totalUpdates: allUpdateStatements.length,
    });
  }

  // Live: execute UPDATEs in chunks of 50
  const CHUNK = 50;
  let updated = 0;
  const errors: Array<{ chunk: number; message: string }> = [];
  for (let i = 0; i < allUpdateStatements.length; i += CHUNK) {
    const slice = allUpdateStatements.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    try {
      await db.batch(slice);
      updated += slice.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ chunk: i, message });
    }
  }

  return c.json({
    success: errors.length === 0,
    dryRun: false,
    processed,
    updated,
    totalUpdates: allUpdateStatements.length,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/correct-so-line-qty-cascade
//
// Surgical "scale-down qty" cascade for an SO line whose quantity was
// originally over-stated relative to actual production. Surfaced by
// SO-2604-307: line entered as qty=10, only 1 sofa actually produced;
// PO + JCs were created with qty=10 multiplier, so wipQty + financials
// are 10× inflated.
//
// Scope (UPDATE only — no DELETE):
//   1. sales_order_items: quantity, lineTotalSen
//   2. sales_orders: subtotalSen, totalSen
//   3. production_orders: quantity (the FIRST PO matching this line by
//      productCode + qty, since salesOrderItemId is NULL on legacy POs)
//   4. job_cards: wipQty for every JC of that PO, scaled by
//      `newQuantity / oldQuantity`. Each JC's wipQty must divide
//      cleanly (oldWipQty % oldQty === 0) — otherwise the BOM
//      multiplier wasn't a clean integer of qty, abort.
//
// NOT touched (operator must handle separately if needed):
//   - wip_items (RM consumption tracking — would need to reverse 9
//     sofas worth of RM consume, complex and tied to FIFO batches)
//   - cost_ledger LABOR_POSTED / RM_CONSUMED entries
//   - fg_units / fg_batches (if any FG was generated)
//   - delivery_order_items (if PO was DO'd)
//   - invoices (if customer was invoiced)
//
// Body: { soLineItemId: string, newQuantity: number, dryRun: boolean }
// Returns: full diff list + warnings about untouched cascades.
//
// Permission: sales-orders:update.
// ---------------------------------------------------------------------------
app.post("/correct-so-line-qty-cascade", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  let body: {
    soLineItemId?: unknown;
    newQuantity?: unknown;
    dryRun?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const lineId =
    typeof body.soLineItemId === "string" ? body.soLineItemId : "";
  const newQty =
    typeof body.newQuantity === "number" ? body.newQuantity : NaN;
  const dryRun = body.dryRun === true;
  if (!lineId) {
    return c.json({ success: false, error: "soLineItemId required" }, 400);
  }
  if (!Number.isInteger(newQty) || newQty < 1) {
    return c.json(
      { success: false, error: "newQuantity must be a positive integer" },
      400,
    );
  }
  const db = c.var.DB;

  const line = await db
    .prepare(
      `SELECT id, salesOrderId, productCode, quantity, unitPriceSen,
              basePriceSen, lineTotalSen
         FROM sales_order_items WHERE id = ? LIMIT 1`,
    )
    .bind(lineId)
    .first<{
      id: string;
      salesOrderId: string;
      productCode: string | null;
      quantity: number;
      unitPriceSen: number;
      basePriceSen: number;
      lineTotalSen: number;
    }>();
  if (!line) {
    return c.json(
      { success: false, error: `SO line item not found: ${lineId}` },
      404,
    );
  }
  if (line.quantity === newQty) {
    return c.json({
      success: true,
      noOp: true,
      message: "newQuantity equals current quantity — no changes",
    });
  }
  const oldQty = line.quantity;
  const so = await db
    .prepare(
      "SELECT id, companySOId, subtotalSen, totalSen FROM sales_orders WHERE id = ? LIMIT 1",
    )
    .bind(line.salesOrderId)
    .first<{
      id: string;
      companySOId: string | null;
      subtotalSen: number;
      totalSen: number;
    }>();
  if (!so) {
    return c.json({ success: false, error: "Parent SO not found" }, 404);
  }

  const newLineTotal = (line.unitPriceSen ?? 0) * newQty;
  const lineTotalDelta = newLineTotal - line.lineTotalSen;
  const newSoSubtotal = so.subtotalSen + lineTotalDelta;
  const newSoTotal = so.totalSen + lineTotalDelta;

  const posRes = await db
    .prepare(
      `SELECT id, poNo, quantity, productCode FROM production_orders
         WHERE salesOrderId = ? AND productCode = ?
            AND status <> 'CANCELLED'
         ORDER BY id ASC`,
    )
    .bind(line.salesOrderId, line.productCode ?? "")
    .all<{
      id: string;
      poNo: string;
      quantity: number;
      productCode: string | null;
    }>();
  const candidatePos = posRes.results ?? [];
  const matchingPos = candidatePos.filter((p) => p.quantity === oldQty);
  if (matchingPos.length === 0) {
    return c.json(
      {
        success: false,
        error: `No PO found with salesOrderId=${line.salesOrderId} AND productCode=${line.productCode} AND quantity=${oldQty}.`,
      },
      404,
    );
  }
  if (matchingPos.length > 1) {
    return c.json(
      {
        success: false,
        error: `Multiple POs match (qty=${oldQty}): ${matchingPos.map((p) => p.id).join(", ")}. Ambiguous — refuse to auto-correct.`,
      },
      409,
    );
  }
  const targetPo = matchingPos[0];

  const jcsRes = await db
    .prepare(
      `SELECT id, departmentCode, wipKey, wipType, wipCode, wipLabel,
              wipQty, status
         FROM job_cards WHERE productionOrderId = ? ORDER BY id ASC`,
    )
    .bind(targetPo.id)
    .all<{
      id: string;
      departmentCode: string | null;
      wipKey: string | null;
      wipType: string | null;
      wipCode: string | null;
      wipLabel: string | null;
      wipQty: number;
      status: string | null;
    }>();
  const jcs = jcsRes.results ?? [];

  type JcDiff = {
    jcId: string;
    deptCode: string | null;
    wipType: string | null;
    oldWipQty: number;
    newWipQty: number;
    multiplier: number;
  };
  const jcDiffs: JcDiff[] = [];
  for (const jc of jcs) {
    if (jc.wipKey === "FG") continue;
    if (jc.wipQty == null) continue;
    if (jc.wipQty % oldQty !== 0) {
      return c.json(
        {
          success: false,
          error: `JC ${jc.id} wipQty=${jc.wipQty} is not divisible by oldQty=${oldQty}. BOM multiplier non-integer; refuse to auto-scale.`,
        },
        409,
      );
    }
    const multiplier = jc.wipQty / oldQty;
    const newWipQty = Math.max(1, multiplier * newQty);
    jcDiffs.push({
      jcId: jc.id,
      deptCode: jc.departmentCode,
      wipType: jc.wipType,
      oldWipQty: jc.wipQty,
      newWipQty,
      multiplier,
    });
  }

  // Surface untouched cascade tables as warnings. These tables use varying
  // column names (po_id, production_order_id, ref_id polymorphic) — wrap
  // each in try/catch so a column-name mismatch doesn't abort the whole
  // dry-run.
  const warnings: string[] = [];
  try {
    const fgRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM fg_units WHERE production_order_id = ?",
      )
      .bind(targetPo.id)
      .first<{ n: number }>();
    const n = Number(fgRow?.n ?? 0);
    if (n > 0) {
      warnings.push(
        `${n} fg_units exist for this PO — operator may need to DELETE over-counted units (expected ${newQty}).`,
      );
    }
  } catch {
    // alt column name; fall through
    try {
      const fgRow2 = await db
        .prepare("SELECT COUNT(*) AS n FROM fg_units WHERE po_id = ?")
        .bind(targetPo.id)
        .first<{ n: number }>();
      const n = Number(fgRow2?.n ?? 0);
      if (n > 0) {
        warnings.push(
          `${n} fg_units exist for this PO — operator may need to DELETE over-counted units (expected ${newQty}).`,
        );
      }
    } catch {
      // skip
    }
  }
  try {
    const doRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM delivery_order_items WHERE production_order_id = ?",
      )
      .bind(targetPo.id)
      .first<{ n: number }>();
    const n = Number(doRow?.n ?? 0);
    if (n > 0) {
      warnings.push(
        `${n} delivery_order_items reference this PO — DO line qty may need manual adjustment.`,
      );
    }
  } catch {
    // skip
  }
  try {
    const ledgerRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM cost_ledger WHERE ref_id = ? AND ref_type = 'PO'",
      )
      .bind(targetPo.id)
      .first<{ n: number }>();
    const n = Number(ledgerRow?.n ?? 0);
    if (n > 0) {
      warnings.push(
        `${n} cost_ledger rows reference this PO — labor + RM cost remain at oldQty=${oldQty} scale.`,
      );
    }
  } catch {
    // skip
  }
  // wip_items has no direct PO FK (only `code` field) — emit generic warning
  warnings.push(
    `wip_items has no direct PO link — RM consumption tracking via stock_qty was not adjusted. Operator must reverse-consume manually if inventory accuracy matters.`,
  );

  const result = {
    success: true,
    dryRun,
    line: {
      id: line.id,
      productCode: line.productCode,
      oldQty,
      newQty,
      oldLineTotalSen: line.lineTotalSen,
      newLineTotalSen: newLineTotal,
      lineTotalDeltaSen: lineTotalDelta,
    },
    so: {
      id: so.id,
      companySOId: so.companySOId,
      oldSubtotalSen: so.subtotalSen,
      newSubtotalSen: newSoSubtotal,
      oldTotalSen: so.totalSen,
      newTotalSen: newSoTotal,
    },
    po: {
      id: targetPo.id,
      poNo: targetPo.poNo,
      oldQty: targetPo.quantity,
      newQty,
    },
    jcCount: jcDiffs.length,
    jcDiffs,
    warnings,
  };

  if (dryRun) return c.json(result);

  // sales_order_items has no updated_at column (postgres schema 0001_init).
  // sales_orders + production_orders do — keep their timestamps fresh.
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE sales_order_items SET quantity = ?, lineTotalSen = ? WHERE id = ?",
      )
      .bind(newQty, newLineTotal, line.id),
    db
      .prepare(
        "UPDATE sales_orders SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?",
      )
      .bind(newSoSubtotal, newSoTotal, now, so.id),
    db
      .prepare(
        "UPDATE production_orders SET quantity = ?, updated_at = ? WHERE id = ?",
      )
      .bind(newQty, now, targetPo.id),
  ];
  for (const d of jcDiffs) {
    stmts.push(
      db
        .prepare("UPDATE job_cards SET wipQty = ? WHERE id = ?")
        .bind(d.newWipQty, d.jcId),
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    return c.json(
      {
        success: false,
        error: `Batch failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return c.json({ ...result, executedStatements: stmts.length });
});

// ---------------------------------------------------------------------------
// POST /api/import/delete-fg-units-by-ids
//
// Surgical fg_units cleanup — deletes only the explicit unit IDs passed in
// the body. Used after /correct-so-line-qty-cascade scaled a PO down: the
// FG cascade originally generated more units than actually exist, so we
// need to drop the over-counted ones.
//
// Body: { unitIds: string[], dryRun: boolean }
// Returns: { success, dryRun, deleted, errors }
//
// Permission: production-orders:update (FG mgmt is downstream of PO).
// ---------------------------------------------------------------------------
app.post("/delete-fg-units-by-ids", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { unitIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.unitIds)
    ? body.unitIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!ids || ids.length === 0) {
    return c.json(
      { success: false, error: "body.unitIds must be a non-empty array" },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  // Pre-flight: verify these units exist + check status (refuse to delete
  // anything beyond PACKED — DELIVERED/RETURNED/INVOICED are immutable
  // historical records).
  const placeholders = ids.map(() => "?").join(",");
  const existing = await db
    .prepare(
      `SELECT id, status, unit_serial AS unitSerial, po_id AS poId
         FROM fg_units WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ id: string; status: string; unitSerial: string; poId: string }>();
  const rows = existing.results ?? [];
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));
  const unsafeStatuses = ["DELIVERED", "RETURNED", "LOADED"];
  const unsafe = rows.filter((r) => unsafeStatuses.includes(r.status));
  if (unsafe.length > 0) {
    return c.json(
      {
        success: false,
        error: `Refuse to delete fg_units with status in ${unsafeStatuses.join("/")}: ${unsafe.map((u) => `${u.id}(${u.status})`).slice(0, 5).join(", ")}`,
      },
      409,
    );
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      requested: ids.length,
      found: rows.length,
      notFound,
      wouldDelete: rows.map((r) => ({
        id: r.id,
        unitSerial: r.unitSerial,
        status: r.status,
      })),
    });
  }

  // Live DELETE
  try {
    await db
      .prepare(`DELETE FROM fg_units WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
  } catch (err) {
    return c.json(
      {
        success: false,
        error: `DELETE failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return c.json({
    success: true,
    dryRun: false,
    requested: ids.length,
    found: rows.length,
    deleted: rows.length,
    notFound,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/append-missing-pos
//
// One-shot fill-in for SOs whose original generator run emitted FEWER POs
// than the SO's per-unit total (e.g. SO-2604-303: BF line qty=2 produced
// only 1 PO; the 2nd unit's PO was never created).
//
// Calls createProductionOrdersForSO with `appendOnly: true`. Generator
// skips the bail-on-existing-POs check and runs its full per-unit
// expansion loop, emitting INSERT statements for every expected PO + JC.
// INSERT OR IGNORE on production_orders + deterministic poId/jcId scheme
// means pre-existing rows no-op silently; only new rows land.
//
// Body: { soIds: string[], dryRun: boolean }
// Returns: { success, dryRun, processed: [{soId, companySOId, existingPosCount, newStatements, newPos}], updated?, errors? }
//
// Permission: purchase-orders:create.
// ---------------------------------------------------------------------------
app.post("/append-missing-pos", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: { soIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as { soIds?: unknown; dryRun?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const soIdsRaw = Array.isArray(body.soIds)
    ? body.soIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!soIdsRaw || soIdsRaw.length === 0) {
    return c.json(
      { success: false, error: "body.soIds must be a non-empty array" },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  type ProcessResult = {
    soId: string;
    companySOId?: string | null;
    status: "ok" | "error";
    existingPosCount?: number;
    newStatements?: number;
    newPos?: Array<{ poNo: string; poId: string; quantity: number }>;
    error?: string;
  };
  const processed: ProcessResult[] = [];
  const allStatements: D1PreparedStatement[] = [];

  for (const soIdRaw of soIdsRaw) {
    let so = await db
      .prepare("SELECT * FROM sales_orders WHERE id = ? LIMIT 1")
      .bind(soIdRaw)
      .first<SalesOrderRow>();
    if (!so) {
      so = await db
        .prepare("SELECT * FROM sales_orders WHERE companySOId = ? LIMIT 1")
        .bind(soIdRaw)
        .first<SalesOrderRow>();
    }
    if (!so) {
      processed.push({
        soId: soIdRaw,
        status: "error",
        error: "SO not found by id or companySOId",
      });
      continue;
    }
    const existing = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM production_orders WHERE salesOrderId = ? AND status <> 'CANCELLED'",
      )
      .bind(so.id)
      .first<{ n: number }>();
    const existingPosCount = Number(existing?.n ?? 0);

    const itemsRes = await db
      .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(so.id)
      .all<SalesOrderItemRow>();
    const items = itemsRes.results ?? [];

    const { statements, created } = await createProductionOrdersForSO(
      db,
      so,
      items,
      { appendOnly: true },
    );

    processed.push({
      soId: so.id,
      companySOId: so.companySOId,
      status: "ok",
      existingPosCount,
      newStatements: statements.length,
      newPos: created.map((p) => ({
        poNo: p.poNo,
        poId: p.id,
        quantity: p.quantity,
      })),
    });
    if (!dryRun) {
      allStatements.push(...statements);
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      processed,
      totalNewStatements: processed.reduce(
        (sum, p) => sum + (p.newStatements ?? 0),
        0,
      ),
    });
  }

  const CHUNK = 50;
  let executed = 0;
  const errors: Array<{ chunk: number; message: string }> = [];
  for (let i = 0; i < allStatements.length; i += CHUNK) {
    const slice = allStatements.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    try {
      await db.batch(slice);
      executed += slice.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ chunk: i, message });
    }
  }

  return c.json({
    success: errors.length === 0,
    dryRun: false,
    processed,
    executed,
    totalStatements: allStatements.length,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/delete-jcs-by-ids
//
// Surgical job_cards cleanup — deletes only the explicit JC IDs passed in
// the body. Used after /append-missing-pos when the appendOnly cascade
// emits a duplicate FAB_CUT JC for a PO that already had a per-piece
// FAB_CUT JC tracked under a different jcId convention (legacy long-form
// vs new aggregator short-form jc-fc-po-).
//
// Body: { jcIds: string[], dryRun: boolean }
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
app.post("/delete-jcs-by-ids", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { jcIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.jcIds)
    ? body.jcIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!ids || ids.length === 0) {
    return c.json(
      { success: false, error: "body.jcIds must be a non-empty array" },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  const placeholders = ids.map(() => "?").join(",");
  const existing = await db
    .prepare(
      `SELECT id, status, departmentCode, wipKey, productionOrderId
         FROM job_cards WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      id: string;
      status: string;
      departmentCode: string;
      wipKey: string;
      productionOrderId: string;
    }>();
  const rows = existing.results ?? [];
  const found = new Set(rows.map((r) => r.id));
  const notFound = ids.filter((id) => !found.has(id));

  // Refuse to delete COMPLETED / TRANSFERRED JCs (work credit + cost ledger
  // entries already posted; deleting would orphan those).
  const unsafe = rows.filter((r) =>
    ["COMPLETED", "TRANSFERRED"].includes(r.status),
  );
  if (unsafe.length > 0) {
    return c.json(
      {
        success: false,
        error: `Refuse to delete JCs with status COMPLETED/TRANSFERRED: ${unsafe.map((u) => `${u.id}(${u.status})`).slice(0, 5).join(", ")}`,
      },
      409,
    );
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      requested: ids.length,
      found: rows.length,
      notFound,
      wouldDelete: rows.map((r) => ({
        id: r.id,
        status: r.status,
        deptCode: r.departmentCode,
        wipKey: r.wipKey,
      })),
    });
  }

  try {
    await db
      .prepare(`DELETE FROM job_cards WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
  } catch (err) {
    return c.json(
      {
        success: false,
        error: `DELETE failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return c.json({
    success: true,
    dryRun: false,
    requested: ids.length,
    deleted: rows.length,
    notFound,
  });
});

// ---------------------------------------------------------------------------
// GET /api/import/audit-po-alignment?soId=XXX
//
// On-demand audit of an SO's production_orders against its
// sales_order_items. Returns alignment errors, attribute mismatches, and
// unlinked POs. Read-only — no writes.
//
// soId can be either internal id (e.g. "so-0f7cf47b") or companySOId
// (e.g. "SO-2605-027"). Falls back to companySOId lookup when direct id
// query returns nothing.
//
// Permission: sales-orders:read.
// ---------------------------------------------------------------------------
app.get("/audit-po-alignment", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;

  const soIdRaw = c.req.query("soId");
  if (!soIdRaw) {
    return c.json(
      { success: false, error: "soId query param required" },
      400,
    );
  }

  let soId: string | null = null;
  let companySOId: string | null = null;
  const direct = await c.var.DB.prepare(
    "SELECT id, companySOId FROM sales_orders WHERE id = ? LIMIT 1",
  )
    .bind(soIdRaw)
    .first<{ id: string; companySOId: string | null }>();
  if (direct) {
    soId = direct.id;
    companySOId = direct.companySOId;
  } else {
    const byCompany = await c.var.DB.prepare(
      "SELECT id, companySOId FROM sales_orders WHERE companySOId = ? LIMIT 1",
    )
      .bind(soIdRaw)
      .first<{ id: string; companySOId: string | null }>();
    if (byCompany) {
      soId = byCompany.id;
      companySOId = byCompany.companySOId;
    }
  }
  if (!soId) {
    return c.json(
      { success: false, error: `SO not found: ${soIdRaw}` },
      404,
    );
  }

  const result = await loadAndValidatePOAlignment(c.var.DB, soId);
  return c.json({
    success: true,
    soId,
    companySOId,
    ...result,
  });
});

// ---------------------------------------------------------------------------
// /backfill-po-line-no — one-shot rewrite of stale `production_orders.lineNo`.
//
// Background: Phase 2 audit on 2026-05-09 found 25 POs across 17 SOs whose
// `lineNo` field doesn't match the SO line they're actually for. The PO's
// product/size/fabric/divan/leg/gap attributes ARE correct for the unit
// they represent — only the `lineNo` column is stale because the legacy
// fan-out wrote sequential per-PO indices (1,2,3,4...) instead of the
// actual SO line number.
//
// Algorithm — cumulative-qty mapping:
//   1. Read SO's items sorted by lineNo.
//   2. Read SO's POs sorted by poNo's `-NN` suffix.
//   3. For each SO line, allocate `pieceCount` POs to it where:
//        SOFA → 1 PO carries the full qty (set semantics)
//        BF/ACC → N POs each qty=1 (per-piece)
//   4. Each PO's expected lineNo is the SO line it gets allocated to.
//   5. UPDATE if expected != current.
//
// Skip conditions:
//   * SOs where the cumulative-qty allocation can't cover all POs (model
//     break — e.g. duplicate poNo with different ids — surface as error).
//   * POs that already have correct lineNo (idempotent).
//
// Read-only safe in dry-run. No JC/wip/cost data is touched — only the
// scalar `production_orders.lineNo` column.
//
// Body: { dryRun?: boolean (default true), soIds?: string[] }
// ---------------------------------------------------------------------------
type LinenoFixRow = {
  poId: string;
  poNo: string;
  companySOId: string;
  currentLineNo: number;
  expectedLineNo: number;
};

app.post("/backfill-po-line-no", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  let body: { dryRun?: boolean; soIds?: string[] } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // Empty body OK — defaults below.
  }
  const dryRun = body.dryRun !== false; // default true
  const filterSoIds = Array.isArray(body.soIds) && body.soIds.length > 0
    ? new Set(body.soIds)
    : null;

  // Pull every non-cancelled SO with its items. We hit it as one query
  // joining items so we don't do N+1 round-trips.
  const itemsRes = await db
    .prepare(
      `SELECT soi.salesOrderId, soi.lineNo, soi.itemCategory, soi.quantity,
              so.companySOId, so.status
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE COALESCE(so.status, '') <> 'CANCELLED'
        ORDER BY soi.salesOrderId, soi.lineNo`,
    )
    .all<{
      salesOrderId: string;
      lineNo: number;
      itemCategory: string | null;
      quantity: number;
      companySOId: string | null;
      status: string;
    }>();
  const itemsBySo = new Map<string, typeof itemsRes.results>();
  const companySOIdBySo = new Map<string, string>();
  for (const it of itemsRes.results ?? []) {
    if (!itemsBySo.has(it.salesOrderId)) {
      itemsBySo.set(it.salesOrderId, [] as unknown as typeof itemsRes.results);
    }
    (itemsBySo.get(it.salesOrderId) as unknown as typeof itemsRes.results)!.push(it);
    if (it.companySOId) companySOIdBySo.set(it.salesOrderId, it.companySOId);
  }

  const posRes = await db
    .prepare(
      `SELECT id AS "poId", poNo, salesOrderId, lineNo
         FROM production_orders
        WHERE salesOrderId IS NOT NULL AND salesOrderId <> ''
          AND COALESCE(status, '') <> 'CANCELLED'
        ORDER BY salesOrderId, poNo`,
    )
    .all<{
      poId: string;
      poNo: string;
      salesOrderId: string;
      lineNo: number;
    }>();
  const posBySo = new Map<string, typeof posRes.results>();
  for (const p of posRes.results ?? []) {
    if (!posBySo.has(p.salesOrderId)) {
      posBySo.set(p.salesOrderId, [] as unknown as typeof posRes.results);
    }
    (posBySo.get(p.salesOrderId) as unknown as typeof posRes.results)!.push(p);
  }

  const fixes: LinenoFixRow[] = [];
  const skipped: { salesOrderId: string; companySOId: string | null; reason: string }[] = [];

  for (const [soId, items] of itemsBySo.entries()) {
    if (filterSoIds && !filterSoIds.has(soId)) continue;
    const pos = posBySo.get(soId) ?? [];
    if (pos.length === 0) continue;

    // Sort POs by poNo's `-NN` suffix (numeric, falls back to lex).
    const sortedPos = [...pos].sort((a, b) => {
      const ma = /-(\d+)$/.exec(a.poNo);
      const mb = /-(\d+)$/.exec(b.poNo);
      const na = ma ? parseInt(ma[1], 10) : 0;
      const nb = mb ? parseInt(mb[1], 10) : 0;
      return na - nb;
    });
    const sortedItems = [...items].sort((a, b) => a.lineNo - b.lineNo);

    // Allocate POs to lines via cumulative-qty.
    const expectedLineNoByPoId = new Map<string, number>();
    let poIdx = 0;
    for (const line of sortedItems) {
      const isSofa = (line.itemCategory ?? "BEDFRAME") === "SOFA";
      // SOFA = 1 PO per line (set semantics); BF/ACC = N POs per line.
      const pieceCount = isSofa ? 1 : Math.max(1, line.quantity || 1);
      for (let k = 0; k < pieceCount; k++) {
        if (poIdx >= sortedPos.length) break;
        expectedLineNoByPoId.set(sortedPos[poIdx].poId, line.lineNo);
        poIdx++;
      }
    }

    // If we couldn't cover every PO, the SO has duplicate poNos / model
    // break (Pattern 2). Skip — surface for separate cleanup.
    if (poIdx !== sortedPos.length) {
      skipped.push({
        salesOrderId: soId,
        companySOId: companySOIdBySo.get(soId) ?? null,
        reason: `${sortedPos.length} POs but cumulative-qty mapping covered ${poIdx} (model break — likely duplicate poNo)`,
      });
      continue;
    }

    for (const p of sortedPos) {
      const expected = expectedLineNoByPoId.get(p.poId);
      if (expected === undefined) continue;
      if (expected !== p.lineNo) {
        fixes.push({
          poId: p.poId,
          poNo: p.poNo,
          companySOId: companySOIdBySo.get(soId) ?? "",
          currentLineNo: p.lineNo,
          expectedLineNo: expected,
        });
      }
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatePoCount: fixes.length,
      affectedSoCount: new Set(fixes.map((f) => f.companySOId)).size,
      fixes,
      skipped,
    });
  }

  // Live: UPDATE each PO's lineNo. Sequential — small batch (~25 rows).
  const stmts = fixes.map((f) =>
    db
      .prepare(
        `UPDATE production_orders SET lineNo = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(f.expectedLineNo, new Date().toISOString(), f.poId),
  );
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
  return c.json({
    success: true,
    dryRun: false,
    updatedPoCount: fixes.length,
    affectedSoCount: new Set(fixes.map((f) => f.companySOId)).size,
    fixes,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/regen-fg-units
//
// One-shot regenerator for fg_units rows. Use case: pieces logic changed
// (e.g. bedframe size auto-derive landed 2026-05-09) and existing fg_units
// were generated under the old logic. This endpoint deletes the in-stock
// fg_units (status='PACKED') for the given PO/SO scope and re-runs
// generateFGUnitsForPO so the new pieces config takes effect.
//
// Safety:
//   - Only deletes status='PACKED' rows. LOADED / DELIVERED / RETURNED
//     fg_units are physical state and must not be regenerated — caller
//     gets a `skipped` entry per PO that had non-PACKED units.
//   - fg_unit_events is FK CASCADE → automatic cleanup when an fg_unit
//     row is deleted.
//   - dryRun mode lists what would be done without writing.
//
// Body: { poIds?: string[], soIds?: string[], dryRun?: boolean }
//   - At least one of poIds / soIds must be provided.
//   - soIds resolved into the matching production_orders' poIds.
//   - dryRun defaults true.
//
// Per project_migration_in_progress: this is a one-shot tool, will be
// removed post-migration. Don't generalize.
// ---------------------------------------------------------------------------
app.post("/regen-fg-units", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { poIds?: unknown; soIds?: unknown; dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const poIdsIn = Array.isArray(body.poIds)
    ? body.poIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const soIdsIn = Array.isArray(body.soIds)
    ? body.soIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (poIdsIn.length === 0 && soIdsIn.length === 0) {
    return c.json(
      { success: false, error: "Provide at least one of body.poIds or body.soIds" },
      400,
    );
  }

  const db = c.var.DB;

  // Resolve SO ids → PO ids. Accept both internal id and companySOId.
  const resolvedPoIds = new Set<string>(poIdsIn);
  for (const soIdRaw of soIdsIn) {
    let soId: string | null = null;
    const direct = await db
      .prepare("SELECT id FROM sales_orders WHERE id = ? LIMIT 1")
      .bind(soIdRaw)
      .first<{ id: string }>();
    if (direct) {
      soId = direct.id;
    } else {
      const byCompany = await db
        .prepare("SELECT id FROM sales_orders WHERE companySOId = ? LIMIT 1")
        .bind(soIdRaw)
        .first<{ id: string }>();
      if (byCompany) soId = byCompany.id;
    }
    if (!soId) continue;
    const posRes = await db
      .prepare("SELECT id FROM production_orders WHERE salesOrderId = ?")
      .bind(soId)
      .all<{ id: string }>();
    for (const r of posRes.results ?? []) resolvedPoIds.add(r.id);
  }

  type PoResult = {
    poId: string;
    poNo?: string;
    status: "regenerated" | "skipped" | "error";
    deletedCount?: number;
    createdCount?: number;
    blockedByStatuses?: string[];
    error?: string;
  };
  const results: PoResult[] = [];

  for (const poId of resolvedPoIds) {
    try {
      // Bail if any fg_unit on this PO is already physically out the
      // door. PENDING / PENDING_UPHOLSTERY / UPHOLSTERED / PACKED all
      // mean the unit is still in our control (not yet on a delivery)
      // — safe to regen. LOADED / DELIVERED / RETURNED are physical
      // state past the packing line — keep their serials stable.
      const REGEN_SAFE = new Set([
        "PENDING",
        "PENDING_UPHOLSTERY",
        "UPHOLSTERED",
        "PACKED",
      ]);
      const unitsRes = await db
        .prepare("SELECT id, status FROM fg_units WHERE poId = ?")
        .bind(poId)
        .all<{ id: string; status: string }>();
      const units = unitsRes.results ?? [];
      const blocked = units.filter((u) => !REGEN_SAFE.has(u.status));
      if (blocked.length > 0) {
        results.push({
          poId,
          status: "skipped",
          blockedByStatuses: Array.from(new Set(blocked.map((b) => b.status))),
        });
        continue;
      }

      const poRow = await db
        .prepare("SELECT poNo FROM production_orders WHERE id = ?")
        .bind(poId)
        .first<{ poNo: string }>();

      if (dryRun) {
        results.push({
          poId,
          poNo: poRow?.poNo,
          status: "regenerated",
          deletedCount: units.length,
          createdCount: -1, // unknown until live run
        });
        continue;
      }

      // Live: delete then regen.
      await db
        .prepare("DELETE FROM fg_units WHERE poId = ?")
        .bind(poId)
        .run();
      const gen = await generateFGUnitsForPO(db, poId);
      results.push({
        poId,
        poNo: poRow?.poNo,
        status: "regenerated",
        deletedCount: units.length,
        createdCount: gen.units.length,
      });
    } catch (err) {
      results.push({
        poId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned: resolvedPoIds.size,
    regenerated: results.filter((r) => r.status === "regenerated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-sofa-leg-heights
//
// Wei Siang's standard config (2026-05-09):
//   - Models 5535 / 5536 → 1" legs by default
//   - All other sofa models → 6" legs by default
//
// Historical SOs were created without legHeightInches consistently set.
// This one-shot scans sales_order_items + production_orders for SOFA
// rows where legHeightInches is NULL or 0 and applies the rule.
//
// Body: { dryRun?: boolean }     — defaults true
// Response: { scanned, updates: [{soNo, lineNo, productCode, from, to}] }
//
// Per project_migration_in_progress: one-shot, will be removed
// post-migration.
// ---------------------------------------------------------------------------
app.post("/backfill-sofa-leg-heights", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  // Default leg height by productCode prefix.
  const defaultLeg = (productCode: string | null): number => {
    if (!productCode) return 6;
    const p = productCode.trim().toUpperCase();
    if (p.startsWith("5535") || p.startsWith("5536")) return 1;
    return 6;
  };

  type ItemRow = {
    id: string;
    salesOrderId: string;
    companySOId: string | null;
    lineNo: number | null;
    lineSuffix: string | null;
    productCode: string | null;
    legHeightInches: number | null;
  };

  // sales_order_items first. sales_orders has companySOId (no salesOrderNo).
  const soItemsRes = await db
    .prepare(
      `SELECT soi.id, soi.salesOrderId,
              so.companySOId AS companySOId,
              soi.lineNo, soi.lineSuffix, soi.productCode, soi.legHeightInches
         FROM sales_order_items AS soi
         LEFT JOIN sales_orders AS so ON so.id = soi.salesOrderId
         WHERE soi.itemCategory = 'SOFA'
           AND (soi.legHeightInches IS NULL OR soi.legHeightInches = 0)`,
    )
    .all<ItemRow>();
  const soItems = soItemsRes.results ?? [];

  // production_orders — separate scan so PO-only-data also gets updated
  // (some POs were generated before the SO line was finalised, etc.).
  type PoRow = {
    id: string;
    poNo: string;
    salesOrderId: string | null;
    salesOrderNo: string | null;
    companySOId: string | null;
    lineNo: number | null;
    productCode: string | null;
    legHeightInches: number | null;
  };
  const posRes = await db
    .prepare(
      `SELECT po.id, po.poNo, po.salesOrderId, po.salesOrderNo, po.companySOId,
              po.lineNo, po.productCode, po.legHeightInches
         FROM production_orders AS po
         WHERE po.itemCategory = 'SOFA'
           AND (po.legHeightInches IS NULL OR po.legHeightInches = 0)`,
    )
    .all<PoRow>();
  const pos = posRes.results ?? [];

  type Update = {
    table: "sales_order_items" | "production_orders";
    rowId: string;
    soNo: string | null;
    lineNo: number | null;
    productCode: string | null;
    from: number | null;
    to: number;
  };
  const updates: Update[] = [];

  for (const r of soItems) {
    updates.push({
      table: "sales_order_items",
      rowId: r.id,
      soNo: r.companySOId,
      lineNo: r.lineNo,
      productCode: r.productCode,
      from: r.legHeightInches,
      to: defaultLeg(r.productCode),
    });
  }
  for (const r of pos) {
    updates.push({
      table: "production_orders",
      rowId: r.id,
      soNo: r.companySOId || r.salesOrderNo,
      lineNo: r.lineNo,
      productCode: r.productCode,
      from: r.legHeightInches,
      to: defaultLeg(r.productCode),
    });
  }

  // Distribution summary by suggested value.
  const dist: Record<string, number> = {};
  for (const u of updates) {
    const k = `${u.table}|${u.to}"`;
    dist[k] = (dist[k] || 0) + 1;
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      scanned: { soItems: soItems.length, pos: pos.length },
      updateCount: updates.length,
      distribution: dist,
      sampleUpdates: updates.slice(0, 30),
    });
  }

  // Live: apply updates in batches.
  const statements = updates.map((u) =>
    db
      .prepare(
        `UPDATE ${u.table} SET legHeightInches = ? WHERE id = ?`,
      )
      .bind(u.to, u.rowId),
  );
  if (statements.length > 0) {
    // d1 batch can take 50-100 statements at a time depending on engine —
    // chunk to be safe.
    const chunkSize = 50;
    for (let i = 0; i < statements.length; i += chunkSize) {
      await db.batch(statements.slice(i, i + chunkSize));
    }
  }

  return c.json({
    success: true,
    dryRun: false,
    scanned: { soItems: soItems.length, pos: pos.length },
    updated: updates.length,
    distribution: dist,
    sampleUpdates: updates.slice(0, 30),
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-pillow-packing-jc
//
// Wei Siang spec (2026-05-10): pillow PACKING JCs should aggregate at
// (salesOrderId, productCode, fabricCode) level — one operator scan
// completes all matching pieces. Currently per-PO fan-out produces N
// separate PACKING JCs (one per pillow piece); operators want ONE JC
// with combined qty.
//
// Pillow detection: itemCategory='ACCESSORY' AND
//   (productCode LIKE '%PILLOW%' OR productName LIKE '%PILLOW%').
//
// For each (soId, productCode, fabricCode) group of pillow POs:
//   1. Find any existing PACKING JCs on those POs.
//   2. If exactly one aggregated JC already exists on the anchor PO
//      (wipKey starts with "pillow-pack-") → skip, idempotent.
//   3. Else: DELETE all existing PACKING JCs in the group, INSERT one
//      aggregated JC on the FIRST (anchor) PO with wipQty = sum.
//
// Body: { dryRun: boolean (default true) }
//
// Per project_migration_in_progress: one-shot, will be removed
// post-migration.
// ---------------------------------------------------------------------------
app.post("/backfill-pillow-packing-jc", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  // 1. Find PACKING department metadata.
  const packingDept = await db
    .prepare("SELECT id, code, name FROM departments WHERE code = 'PACKING' LIMIT 1")
    .first<{ id: string; code: string; name: string }>();
  if (!packingDept) {
    return c.json({ success: false, error: "PACKING department not found" }, 500);
  }

  // 2. Find all pillow POs.
  type PillowPO = {
    id: string;
    poNo: string;
    salesOrderId: string | null;
    productCode: string | null;
    productName: string | null;
    fabricCode: string | null;
    quantity: number;
    targetEndDate: string | null;
  };
  const posRes = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, productCode, productName, fabricCode,
              quantity, targetEndDate
         FROM production_orders
         WHERE itemCategory = 'ACCESSORY'
           AND (UPPER(productCode) LIKE '%PILLOW%' OR UPPER(productName) LIKE '%PILLOW%')
           AND status <> 'CANCELLED'`,
    )
    .all<PillowPO>();
  const pillowPOs = posRes.results ?? [];

  // 3. Group by (salesOrderId, productCode, fabricCode).
  const groups = new Map<string, PillowPO[]>();
  for (const po of pillowPOs) {
    if (!po.salesOrderId) continue;
    const key = `${po.salesOrderId}::${po.productCode}::${po.fabricCode || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(po);
  }

  type GroupResult = {
    groupKey: string;
    soId: string;
    productCode: string | null;
    fabricCode: string | null;
    poCount: number;
    totalQty: number;
    status: "skipped" | "created" | "would-create" | "error";
    deletedJcCount?: number;
    aggregatedWipKey?: string;
    error?: string;
  };
  const results: GroupResult[] = [];

  for (const [groupKey, pos] of groups) {
    // Sort by id for deterministic anchor selection.
    pos.sort((a, b) => a.id.localeCompare(b.id));
    const anchor = pos[0];
    const totalQty = pos.reduce((s, p) => s + (p.quantity || 1), 0);
    const aggregatedWipKey =
      `pillow-pack-${anchor.salesOrderId}-${anchor.productCode}-${anchor.fabricCode || ""}`
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 200);

    // Find existing PACKING JCs on any PO in this group.
    const placeholders = pos.map(() => "?").join(",");
    const existingRes = await db
      .prepare(
        `SELECT id, productionOrderId, wipKey, wipQty
           FROM job_cards
           WHERE productionOrderId IN (${placeholders}) AND departmentCode = 'PACKING'`,
      )
      .bind(...pos.map((p) => p.id))
      .all<{ id: string; productionOrderId: string; wipKey: string; wipQty: number }>();
    const existing = existingRes.results ?? [];

    // Already correctly aggregated? (one JC on anchor with our wipKey)
    const hasAggregated =
      existing.length === 1 &&
      existing[0].productionOrderId === anchor.id &&
      existing[0].wipKey === aggregatedWipKey &&
      existing[0].wipQty === totalQty;
    if (hasAggregated) {
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "skipped",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "would-create",
        deletedJcCount: existing.length,
        aggregatedWipKey,
      });
      continue;
    }

    try {
      const stmts: D1PreparedStatement[] = [];
      // DELETE existing per-PO PACKING JCs.
      for (const jc of existing) {
        stmts.push(db.prepare("DELETE FROM job_cards WHERE id = ?").bind(jc.id));
      }
      // INSERT aggregated JC on anchor PO.
      const jcId = `jc-pilo-${anchor.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
      const wipLabel = `${anchor.productCode || ""} ${anchor.fabricCode || ""} x${totalQty}`.trim();
      stmts.push(
        db
          .prepare(
            `INSERT INTO job_cards (id, productionOrderId, departmentId, departmentCode,
                departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
                wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
                estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber, branchKey)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            jcId,
            anchor.id,
            packingDept.id,
            "PACKING",
            packingDept.name,
            99, // high sequence — same as l1Process default
            "WAITING",
            anchor.targetEndDate,
            aggregatedWipKey,
            anchor.productCode || "",
            "FG",
            wipLabel,
            totalQty,
            0,
            null,
            "",
            null,
            "",
            null,
            0,
            null,
            "",
            0,
            "PENDING",
            null,
            "",
          ),
      );
      await db.batch(stmts);
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "created",
        deletedJcCount: existing.length,
        aggregatedWipKey,
      });
    } catch (err) {
      results.push({
        groupKey,
        soId: anchor.salesOrderId!,
        productCode: anchor.productCode,
        fabricCode: anchor.fabricCode,
        poCount: pos.length,
        totalQty,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scannedPOs: pillowPOs.length,
    scannedGroups: groups.size,
    created: results.filter((r) => r.status === "created").length,
    wouldCreate: results.filter((r) => r.status === "would-create").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-supplier-sku-1to1
//
// Wei Siang spec (2026-05-10): 731 of 969 supplier_material_bindings have
// supplierSku != materialCode — caused by an import default that
// dumped the same value (e.g. "PC151-01" on 153 rows) across unrelated
// internal codes. Operators were about to open POs against the wrong
// supplier SKU.
//
// Fix: force supplierSku = materialCode for every mismatched row. If
// any supplier really does use a different SKU, operator can fix that
// row manually in Maintenance afterwards (the backfill is a safe
// reset since no supplierDescription was set on these rows anyway).
//
// Body: { dryRun: boolean (default true) }
//
// Per project_migration_in_progress: one-shot, will be removed
// post-migration.
// ---------------------------------------------------------------------------
app.post("/backfill-supplier-sku-1to1", async (c) => {
  const denied = await requirePermission(c, "suppliers", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  type Row = {
    id: string;
    materialCode: string | null;
    materialName: string | null;
    supplierSku: string | null;
  };

  const res = await db
    .prepare(
      `SELECT id, materialCode, materialName, supplierSku
         FROM supplier_material_bindings
         WHERE supplierSku IS NOT NULL
           AND materialCode IS NOT NULL
           AND supplierSku <> materialCode`,
    )
    .all<Row>();
  const rows = res.results ?? [];

  // Distribution of "wrong" supplierSku values for visibility
  const dist = new Map<string, number>();
  for (const r of rows) {
    const k = r.supplierSku || "";
    dist.set(k, (dist.get(k) || 0) + 1);
  }
  const topDist = [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([sku, count]) => ({ sku, count }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      mismatchCount: rows.length,
      topMismatchedSkus: topDist,
      sampleChanges: rows.slice(0, 20).map((r) => ({
        id: r.id,
        materialCode: r.materialCode,
        materialName: r.materialName,
        supplierSku_before: r.supplierSku,
        supplierSku_after: r.materialCode,
      })),
    });
  }

  // Live: batch update.
  const stmts: D1PreparedStatement[] = rows.map((r) =>
    db
      .prepare(
        `UPDATE supplier_material_bindings SET supplierSku = ? WHERE id = ?`,
      )
      .bind(r.materialCode, r.id),
  );
  // D1 batch limit ~100 per call — chunk.
  const chunkSize = 80;
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }

  return c.json({
    success: true,
    dryRun: false,
    updated: rows.length,
    topMismatchedSkus: topDist,
  });
});

// ---------------------------------------------------------------------------
// /cleanup-headboard-only-divans
//
// One-shot backfill: BEDFRAME SOs/COs with specialOrder "Headboard Only"
// were generating full HB+DIVAN job_cards and fg_units before the fix
// landed. Real customer order is HB only — DIVAN pieces should never have
// been created. Sweep existing data and delete the orphaned DIVAN rows.
//
// Production-lock guard (per memory feedback_protect_completed_work.md):
//   - DIVAN job_cards with status='COMPLETED' are NEVER deleted — that
//     represents real completed factory work and is inviolate.
//   - DIVAN fg_units with status != 'PENDING' are NEVER deleted — anything
//     UPHOLSTERED / PACKED / LOADED / DELIVERED / RETURNED / etc. has
//     downstream contracts and must be preserved.
//
// Idempotent: safe to call multiple times. Default ?dryRun=true.
// ---------------------------------------------------------------------------
app.post("/cleanup-headboard-only-divans", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK — defaults to dryRun=true
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  type Po = {
    id: string;
    poNo: string;
    salesOrderId: string | null;
    consignmentOrderId: string | null;
    productCode: string | null;
    specialOrder: string | null;
  };

  // Find every PO whose source line had specialOrder containing "Headboard
  // Only". We match on production_orders.specialOrder directly (the column
  // is denormalised from the SO/CO line at PO creation), so this works for
  // both SO-origin and CO-origin POs.
  const posRes = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, consignmentOrderId, productCode, specialOrder
         FROM production_orders
        WHERE itemCategory = 'BEDFRAME'
          AND LOWER(IFNULL(specialOrder, '')) LIKE '%headboard only%'`,
    )
    .all<Po>();
  const pos = posRes.results ?? [];

  type Jc = {
    id: string;
    productionOrderId: string;
    wipType: string | null;
    departmentCode: string | null;
    status: string;
  };
  type Fgu = {
    id: string;
    poId: string | null;
    pieceName: string | null;
    status: string;
  };

  let scanned = 0;
  let eligibleSOs = 0;
  let deletedJCs = 0;
  let deletedFgUnits = 0;
  let skippedJcs = 0;
  let skippedFgUnits = 0;
  const sample: Array<{
    soId: string | null;
    coId: string | null;
    poNo: string;
    productCode: string | null;
    deletedPieces: string[];
  }> = [];

  const deleteStmts: D1PreparedStatement[] = [];

  for (const po of pos) {
    scanned++;

    // DIVAN job_cards on this PO. wipType is the canonical signal — every
    // DIVAN-piece JC has wipType='DIVAN' (see bom-wip-breakdown.ts).
    const jcRes = await db
      .prepare(
        `SELECT id, productionOrderId, wipType, departmentCode, status
           FROM job_cards
          WHERE productionOrderId = ?
            AND UPPER(IFNULL(wipType, '')) = 'DIVAN'`,
      )
      .bind(po.id)
      .all<Jc>();
    const divanJcs = jcRes.results ?? [];

    // DIVAN fg_units on this PO. pieceName 'Divan' (case-insensitive) is
    // the marker the existing pieces config emits.
    const fguRes = await db
      .prepare(
        `SELECT id, poId, pieceName, status
           FROM fg_units
          WHERE poId = ?
            AND UPPER(IFNULL(pieceName, '')) LIKE '%DIVAN%'`,
      )
      .bind(po.id)
      .all<Fgu>();
    const divanFgus = fguRes.results ?? [];

    if (divanJcs.length === 0 && divanFgus.length === 0) {
      continue;
    }
    eligibleSOs++;

    const deletedPieces: string[] = [];

    for (const jc of divanJcs) {
      // Production-lock: COMPLETED is real factory work — never delete.
      if (jc.status === "COMPLETED") {
        skippedJcs++;
        continue;
      }
      deletedJCs++;
      deletedPieces.push(`JC:${jc.departmentCode ?? "?"}`);
      if (!dryRun) {
        deleteStmts.push(
          db.prepare(`DELETE FROM job_cards WHERE id = ?`).bind(jc.id),
        );
      }
    }

    for (const fg of divanFgus) {
      // Production-lock: anything past PENDING (UPHOLSTERED, PACKED,
      // LOADED, DELIVERED, RETURNED) has a downstream contract.
      if (fg.status !== "PENDING") {
        skippedFgUnits++;
        continue;
      }
      deletedFgUnits++;
      deletedPieces.push(`FG:${fg.pieceName ?? "?"}`);
      if (!dryRun) {
        deleteStmts.push(
          db.prepare(`DELETE FROM fg_units WHERE id = ?`).bind(fg.id),
        );
      }
    }

    if (sample.length < 5 && deletedPieces.length > 0) {
      sample.push({
        soId: po.salesOrderId,
        coId: po.consignmentOrderId,
        poNo: po.poNo,
        productCode: po.productCode,
        deletedPieces,
      });
    }
  }

  if (!dryRun && deleteStmts.length > 0) {
    const chunkSize = 80;
    for (let i = 0; i < deleteStmts.length; i += chunkSize) {
      await db.batch(deleteStmts.slice(i, i + chunkSize));
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned,
    eligibleSOs,
    deletedJCs,
    deletedFgUnits,
    skippedDueToLocks: { jcs: skippedJcs, fgUnits: skippedFgUnits },
    sample,
  });
});

export default app;

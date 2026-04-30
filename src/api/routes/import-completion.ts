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
// Anchor-relative cascade-fill, RESTRICTED to 3 explicit rules. Within each
// (productionOrderId, wipKey) group, find the most-downstream completed JC
// (the "anchor" — MAX(sequence) among rows where status IN ('COMPLETED',
// 'TRANSFERRED') AND completedDate IS NOT NULL). If the anchor's dept is one
// of the 3 listed below, plan completions for the listed target depts in
// that group. Any other anchor dept → entire group is skipped.
//
//   UPHOLSTERY → FAB_CUT, FAB_SEW, FOAM, WOOD_CUT, FRAMING, WEBBING
//   WEBBING    → FRAMING, WOOD_CUT
//   FAB_SEW    → FAB_CUT
//
// FOAM / FRAMING / WOOD_CUT / FAB_CUT / PACKING anchors → no cascade.
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
// Side-effect policy: metadata cleanup only — no applyWipInventoryChange,
// postJobCardLabor, or postProductionOrderCompletion. Downstream JCs
// already fired their cascades when they originally completed.
//
// Query params:
//   ?dryRun=true|false   default false
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
const CASCADE_DATE_CLAMP = "2026-04-30";

// The only 3 cascade rules. Anchor dept → list of target depts to plan.
// Anything not in this map is silently skipped (no rows planned).
const CASCADE_ALLOWED: Record<string, readonly string[]> = {
  UPHOLSTERY: ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING"],
  WEBBING: ["FRAMING", "WOOD_CUT"],
  FAB_SEW: ["FAB_CUT"],
};

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

    // Restricted cascade: only 3 anchor depts trigger fills, and each
    // anchor only cascades to a fixed allow-list of target depts. Any
    // other anchor dept (FOAM, FRAMING, WOOD_CUT, FAB_CUT, PACKING, ...)
    // → group skipped, nothing planned.
    const anchorDept = (anchor.anchor_dept || "").toUpperCase();
    const targetDept = (cand.departmentCode || "").toUpperCase();
    const allowedTargets = CASCADE_ALLOWED[anchorDept];
    if (!allowedTargets || !allowedTargets.includes(targetDept)) {
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

export default app;

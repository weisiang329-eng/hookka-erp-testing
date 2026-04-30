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
// Anchor-relative cascade-fill: within each (productionOrderId, wipKey)
// group, find the most-downstream completed JC (the "anchor" — MAX(sequence)
// among rows whose status IN ('COMPLETED','TRANSFERRED') AND completedDate
// IS NOT NULL). For every OTHER JC in the same group whose status is not
// already done, set:
//   newDate = anchor.completedDate + (jc.sequence - anchor.sequence) days
// Upstream JCs (sequence < anchor) get earlier dates; downstream JCs
// (sequence > anchor) get later dates. The latter is important — e.g. if
// UPHOLSTERY (mid-chain) is marked done on 26 Apr, PACKING (sequence after)
// should also be considered done, dated relative to the anchor.
//
// Clamp: if newDate > 2026-04-30, clamp to 2026-04-30. No early-side floor —
// historical-looking dates are intentional. The intent is "spread one day
// per dept, capped at today" so the date histogram doesn't pile every row
// on a single day.
//
// Side-effect policy: this endpoint is a metadata cleanup pass — NOT a
// workflow event. We deliberately skip applyWipInventoryChange,
// postJobCardLabor, and postProductionOrderCompletion. The downstream JCs
// already fired their cascades when they originally completed, and re-
// firing them now (out of order) would double-consume WIP / double-post
// labor. If a PO needs FG completion, run the dedicated importer or flip
// it manually after this pass.
//
// Query params:
//   ?dryRun=true|false   default false
//
// Response (dryRun): { count, sample, dateHistogram } — histogram is a map
// of { "YYYY-MM-DD": rowCount, ... } over the resulting newDates so the
// caller can sanity-check the spread before going live.
//
// Permission: production-orders:update.
// ---------------------------------------------------------------------------
const CASCADE_DATE_CLAMP = "2026-04-30";

type CandidateRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipType: string | null;
  sequence: number;
  estMinutes: number | null;
  productionTimeMinutes: number | null;
  status: string;
  completedDate: string | null;
  anchor_seq: number;
  anchor_date: string;
};

type CandidatePlan = {
  cand: CandidateRow;
  newDate: string;
  actualMinutes: number;
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

  // Two-CTE candidate query:
  //   anchor       — MAX(sequence) per group among completed/transferred rows
  //   anchor_dated — pull the actual completedDate of THAT row (single row,
  //                  not MAX(completedDate) globally).
  // Then join back to job_cards to grab every other (non-done) JC in the
  // same group along with the anchor's seq + date for offset math.
  const sel = await db
    .prepare(
      `WITH anchor AS (
         SELECT productionOrderId,
                COALESCE(wipKey,'') AS wk,
                MAX(sequence) AS anchor_seq
           FROM job_cards
          WHERE status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL
          GROUP BY productionOrderId, COALESCE(wipKey,'')
       ),
       anchor_dated AS (
         SELECT a.productionOrderId, a.wk, a.anchor_seq, j.completedDate AS anchor_date
           FROM anchor a
           JOIN job_cards j
             ON j.productionOrderId = a.productionOrderId
            AND COALESCE(j.wipKey,'') = a.wk
            AND j.sequence = a.anchor_seq
            AND j.status IN ('COMPLETED','TRANSFERRED')
            AND j.completedDate IS NOT NULL
       )
       SELECT j.id, j.productionOrderId, j.departmentCode, j.wipType, j.sequence,
              j.estMinutes, j.productionTimeMinutes, j.status, j.completedDate,
              a.anchor_seq, a.anchor_date
         FROM job_cards j
         JOIN anchor_dated a
           ON a.productionOrderId = j.productionOrderId
          AND a.wk = COALESCE(j.wipKey,'')
          AND j.sequence <> a.anchor_seq
        WHERE (j.status NOT IN ('COMPLETED','TRANSFERRED') OR j.completedDate IS NULL)`,
    )
    .all<CandidateRow>();

  const candidates = sel.results ?? [];

  // Compute per-row newDate + actualMinutes, build histogram alongside.
  const plans: CandidatePlan[] = [];
  const dateHistogram: Record<string, number> = {};
  for (const cand of candidates) {
    const offset = cand.sequence - cand.anchor_seq;
    let newDate = addDaysISO(cand.anchor_date, offset);
    if (newDate > CASCADE_DATE_CLAMP) newDate = CASCADE_DATE_CLAMP;
    const actualMinutes =
      cand.productionTimeMinutes != null
        ? cand.productionTimeMinutes
        : cand.estMinutes != null
          ? cand.estMinutes
          : 0;
    plans.push({ cand, newDate, actualMinutes });
    dateHistogram[newDate] = (dateHistogram[newDate] ?? 0) + 1;
  }

  // Stable, easy-to-read 5-row sample with the load-bearing fields.
  const sample = plans.slice(0, 5).map((p) => ({
    id: p.cand.id,
    productionOrderId: p.cand.productionOrderId,
    departmentCode: p.cand.departmentCode,
    wipType: p.cand.wipType,
    sequence: p.cand.sequence,
    anchor_seq: p.cand.anchor_seq,
    anchor_date: p.cand.anchor_date,
    newDate: p.newDate,
  }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      count: candidates.length,
      dateHistogram,
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
    count: candidates.length,
    updated,
    errors,
    dateHistogram,
    sample,
  });
});

export default app;

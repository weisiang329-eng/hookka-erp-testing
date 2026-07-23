import { applyWipInventoryChange, type JobCardRow, type ProductionOrderRow } from "../production-orders";
import { postJobCardLabor } from "../../lib/po-cost-cascade";
import { postProductionOrderCompletion } from "../../lib/fg-completion";
import { createProductionOrdersForOrder } from "../_shared/production-builder";


// ---------------------------------------------------------------------------
// Worker name map — Google Sheets short name → workers.name lookup value.
// Embedded in code (not DB) since this is a one-shot import.
//
// Ambiguous entries: the GS short matches multiple workers in the roster.
// We pick the documented first match per Wei Siang's note. The importer
// surfaces a picWarnings entry for each one so the caller knows which
// JCs were resolved on the ambiguous branch.
// ---------------------------------------------------------------------------
export const WORKER_NAME_MAP: Record<string, { name: string; ambiguous?: boolean }> = {
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
export type InputRow = {
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

export type RequestBody = {
  dryRun?: boolean;
  rows: InputRow[];
};

export type PicWarning = {
  row: number;
  name: string;
  reason: string;
};

export type ErrorEntry = {
  row: number;
  custPONo: string;
  message: string;
};

// In-memory worker name → row cache for one request, so the same short
// name doesn't re-hit the DB on every input row.
export type WorkerLookupRow = { id: string; name: string };
export type WorkerCache = Map<string, WorkerLookupRow | null>;

export async function lookupWorkerByName(
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
export async function resolvePic(
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
export type SalesOrderIdRow = { id: string };

export function splitMultiRef(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .split(/[+,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export async function findSalesOrderIdsByLookup(
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


export async function findProductionOrdersBySO(
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

export async function findJobCardsByPO(
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
export async function loadProductionOrderById(
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
export type RowResult = {
  matched: boolean;
  matchedVia?: string | null;
  noSoMatch: boolean;
  noJcMatch: boolean;
  jcUpdated: number;
  posCompleted: number;
  warnings: PicWarning[];
  errors: ErrorEntry[];
};

export async function processRow(
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
export const CASCADE_DATE_CLAMP = "2026-05-11";

// Default rules — fire regardless of wipType.
export const CASCADE_ALLOWED_DEFAULT: Record<string, readonly string[]> = {
  UPHOLSTERY: ["FAB_CUT", "FAB_SEW", "FOAM", "WOOD_CUT", "FRAMING", "WEBBING"],
  WEBBING: ["FRAMING", "WOOD_CUT"],
  FRAMING: ["WOOD_CUT"],
  FAB_SEW: ["FAB_CUT"],
};

// wipType-specific overrides. Only DIFFERENT entries from default.
export const CASCADE_ALLOWED_BY_WIPTYPE: Record<
  string,
  Record<string, readonly string[]>
> = {
  HEADBOARD: { FOAM: ["FAB_CUT", "FAB_SEW"] }, // HB foam consumes sewn fabric
};

export function cascadeAllowed(
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

export type CandidateRow = {
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

export type AnchorRow = {
  productionOrderId: string;
  wk: string;
  bk: string;
  anchor_seq: number;
  anchor_date: string;
  anchor_dept: string | null;
  anchorWt: string | null;
};

export type CandidatePlan = {
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

export function addDaysISO(iso: string, days: number): string {
  // iso assumed YYYY-MM-DD. Use UTC math to avoid TZ drift.
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

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
export const UPH_POFOLD_TARGET_DEPTS = new Set([
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
]);
export const UPH_POFOLD_DEPT_ORDER = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM",
  "FRAMING",
  "WEBBING",
] as const;

export type UphPofoldCandidate = {
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
export const PRICE_BASELINE_DATE = "2020-01-01";

export type BaselineCandidate = {
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
export type FcCandidate = {
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
export const FIX_DATE_TODAY_CLAMP = "2026-04-30";

export type SuspiciousDateRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  completedDate: string;
};

export type SwapPlan = {
  jcId: string;
  productionOrderId: string;
  departmentCode: string | null;
  wipKey: string | null;
  current: string;
  proposed: string;
  siblingMaxDate: string;
  siblingsInMarchAprWindow: number;
};

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
export type LeakAnchorRow = {
  productionOrderId: string;
  anchor_seq: number;
  anchor_date: string;
  anchor_dept: string | null;
};

export type LeakCandidatePlan = {
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
export type FixDatesCandidateRow = {
  id: string;
  productionOrderId: string;
  departmentCode: string | null;
  completedDate: string;
};

export type FixDatesPlan = {
  jcId: string;
  poId: string;
  departmentCode: string | null;
  current: string;
  proposed: string;
  siblingsInLateCluster: number;
};

// Type definitions used by /refund-backfill-overconsume below.
// These were originally co-located with the now-deleted
// /backfill-cascade-wip-producers route (removed 2026-05-20, PR 0 #2).
// Kept here because /refund-backfill-overconsume still references them.
export type RefundCandidateRow = {
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

export type RefundSiblingRow = {
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
export type RebuildJcRow = {
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

export type RebuildPoRow = {
  id: string;
  productCode: string | null;
  itemCategory: string | null;
  salesOrderId: string | null;
  consignmentOrderId: string | null;
  fabricCode: string | null;
  quantity: number | null;
};

export type RebuildWipRow = {
  id: string;
  code: string;
  type: string;
  relatedProduct: string | null;
  deptStatus: string | null;
  stockQty: number;
  status: string;
};

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
export type FcRow = {
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
export function joinModelLabel(productCodes: string[]): string {
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

export function buildFcWipLabel(
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
export type FcRefreshJcRow = {
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

export type PoRow = {
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
export type SplitCandidatePo = {
  poId: string;
  poNo: string;
  salesOrderId: string | null;
  consignmentOrderId: string | null;
  status: string;
  quantity: number;
  itemCategory: string | null;
};

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
export const SOFA_PRICESHEET = {
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
export type SheetCell = readonly [number, number]; // [BC_RM, A_RM]
export type SheetTbl = Record<string, Record<string, Record<number, readonly [number, number]>>>;

export const MODEL_MAP_HOUZS: Record<string, { dsl: "9028" | "9058" | "8030"; mult: number }> = {
  "5530": { dsl: "9028", mult: 1 },
  "5531": { dsl: "9028", mult: 0.945 },
  "5535": { dsl: "9028", mult: 1 },
  "5536": { dsl: "9058", mult: 1 },
  "5537": { dsl: "8030", mult: 1 },
  "5539": { dsl: "9028", mult: 0.945 },
  "5540": { dsl: "8030", mult: 1 },
};
export const BACKREST_COUNT: Record<string, number> = {
  "1S": 1, "1A": 1, "1R": 1, "1NA": 1,
  "2S": 2, "2A": 2, "2R": 2, "2NA": 2,
  "3S": 3,
  "L": 1, "CORNER": 1, "CNR": 1,
  "STOOL": 0,
};

export function ourVariantToSheetVariant(sizeCode: string): string {
  const v = sizeCode.trim().toUpperCase().replace(/\s*\(.*\)\s*/g, "");
  const map: Record<string, string> = {
    "1A": "1R", "2A": "2R",
    "1S": "1 SEATER", "2S": "2 SEATER", "3S": "3 SEATER",
    "CNR": "CORNER",
  };
  return map[v] ?? v;
}
export function backrestKeyOf(sizeCode: string): string {
  return sizeCode.trim().toUpperCase().replace(/\s*\(.*\)\s*/g, "");
}
export function lookupSheetCell(
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
export function priceFor(
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

export const HEIGHTS_TO_FILL = [24, 28, 30, 32, 35];

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
export const SOFA_TARGET_BASES = ["5530","5531","5535","5536","5537","5539","5540"];
export type SoiRow = {
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
export type SoRow = {
  id: string;
  companySOId: string | null;
  customerId: string | null;
  customerName: string | null;
  status: string | null;
  companySODate: string | null;
  createdAt: string | null;
};

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
export type SupplierFromHistory = { code?: string; name?: string };
export type SuppliersFromHistoryBody = { suppliers?: SupplierFromHistory[] };

// ---------------------------------------------------------------------------
// POST /api/import/supplier-bindings-from-history
//
// Body: { bindings: [{ materialCode, supplierCode, supplierSKU,
//                       unitPriceSen, isMainSupplier }, ...] }
// Look up supplier_id by code; UPSERT into supplier_material_bindings keyed
// on (materialCode, supplierId). leadTimeDays=0, moq=1 on insert; unitPrice
// + isMainSupplier are always updated.
// ---------------------------------------------------------------------------
export type BindingInput = {
  materialCode?: string;
  supplierCode?: string;
  supplierSKU?: string;
  unitPriceSen?: number;
  isMainSupplier?: number | boolean;
};
export type BindingsFromHistoryBody = { bindings?: BindingInput[] };

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
export type BackfillDocItem = {
  materialCode?: string | null;
  supplierSKU?: string | null;
  description?: string | null;
  qty?: number;
  unitPriceSen?: number;
};
export type BackfillDoc = {
  docNo?: string;
  docDate?: string;
  supplierCode?: string;
  items?: BackfillDocItem[];
};
export type BackfillPOItem = {
  description?: string;
  materialCode?: string | null;
  supplierSKU?: string;
  qty: number;
  unitPriceSen: number;
};
export type BackfillPODoc = {
  poNo: string;
  docDate: string;
  supplierCode: string;
  items: BackfillPOItem[];
};
export type BackfillBody = {
  documents?: BackfillDoc[];
  skipStock?: boolean;
  purchaseOrders?: BackfillPODoc[];
};

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
export type BackfillBindingsBody = { dryRun?: boolean };

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
export type BackfillBindingsMultiBody = {
  dryRun?: boolean;
  ensureMainOnExisting?: boolean;
  disableDescriptionFallback?: boolean;
};

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
export type BackfillPhantomGrnsBody = { dryRun?: boolean };

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
export type AuditCheck = {
  name: string;
  severity: "error" | "warning" | "info";
  count: number;
  sample: Record<string, unknown>[];
};

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
export type JcBackfillRow = {
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

export type DriftSample = {
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

export const ACTIVE_JC_STATUSES = ["WAITING", "IN_PROGRESS", "PAUSED", "BLOCKED"];
export const COMPLETED_JC_STATUSES = ["COMPLETED", "TRANSFERRED"];

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
export type RefreshJcRow = {
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
export type BackfillExpectedUnit = {
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
export type LinenoFixRow = {
  poId: string;
  poNo: string;
  companySOId: string;
  currentLineNo: number;
  expectedLineNo: number;
};

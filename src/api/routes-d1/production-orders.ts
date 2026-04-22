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
  created_at: string | null;
  updated_at: string | null;
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
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
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
// ---------------------------------------------------------------------------
async function applyWipInventoryChange(
  db: D1Database,
  poRow: ProductionOrderRow,
  jcRow: JobCardRow,
  newStatus: string,
  allJcRows: JobCardRow[],
): Promise<void> {
  const wipLabel = jcRow.wipLabel;
  const wipType = jcRow.wipType;
  const wipKey = jcRow.wipKey;
  const wipQty = jcRow.wipQty || poRow.quantity || 1;
  if (!wipLabel) return;

  const shortType = (() => {
    const t = (wipType || "").toUpperCase();
    if (t === "HEADBOARD") return "HB";
    if (t === "SOFA_BASE") return "BASE";
    if (t === "SOFA_CUSHION") return "CUSHION";
    if (t === "SOFA_ARMREST") return "ARMREST";
    return t || "WIP";
  })();

  if (newStatus === "COMPLETED" || newStatus === "TRANSFERRED") {
    // Upsert-by-code: find existing wip_items row, create if missing.
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
    // Find the immediate child (same wipKey, lower sequence) to consume from.
    const children = allJcRows
      .filter((j) => j.wipKey === wipKey && j.sequence < jcRow.sequence)
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

// TODO(phase-5): Port postProductionOrderCompletion() from the in-memory
// route — FIFO consume rm_batches, emit cost_ledger entries (RM_ISSUE +
// LABOR_POSTED), create an fg_batches row, emit FG_COMPLETED. Requires
// porting getRawMaterialStock()/fifoConsume()/laborRateForDate() helpers.

// ---------------------------------------------------------------------------
// Core PO-update logic shared between PUT and PATCH.
// ---------------------------------------------------------------------------
async function applyPoUpdate(
  c: Context<Env>,
  id: string,
): Promise<Response> {
  const db = c.env.DB;
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

    // Mutate a shallow copy — final UPDATE statement below writes it.
    const updated: JobCardRow = { ...jcRow };

    if (body.status) {
      updated.status = body.status;
      const isDone = body.status === "COMPLETED" || body.status === "TRANSFERRED";
      if (isDone) {
        if (!updated.completedDate) updated.completedDate = today;
        updated.overdue = "COMPLETED";
      } else if (body.completedDate === undefined) {
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

    // Update WIP inventory if status changed.
    if (body.status) {
      const refreshed = allJcRows.map((j) => (j.id === updated.id ? updated : j));
      await applyWipInventoryChange(db, existing, updated, body.status, refreshed);
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
      // TODO(phase-5): postProductionOrderCompletion (FIFO consume + FGBatch)
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

  // SO cascades.
  if (body.jobCardId && updatedPoStatus === "COMPLETED") {
    await cascadePoCompletionToSO(db, existing.salesOrderId);
  }
  await cascadeUpholsteryToSO(db, id);

  const fresh = await fetchPO(db, id);
  return c.json({ success: true, data: fresh });
}

// ---------------------------------------------------------------------------
// ROUTES
// Order matters: specific routes BEFORE /:id.
// ---------------------------------------------------------------------------

// GET /api/production-orders
app.get("/", async (c) => {
  const data = await fetchAllPOs(c.env.DB);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/production-orders/historical-wips
// Distinct WIPs that have appeared in any JobCard to date.
// ---------------------------------------------------------------------------
app.get("/historical-wips", async (c) => {
  const all = await fetchAllPOs(c.env.DB);
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
  const all = await fetchAllPOs(c.env.DB);
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
  const db = c.env.DB;
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
             productionTimeMinutes, overdue, rackingNumber)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const db = c.env.DB;
  const scannedId = c.req.param("id");
  const scannedPo = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(scannedId)
    .first<ProductionOrderRow>();
  if (!scannedPo) {
    return c.json({ success: false, error: "Production order not found" }, 404);
  }

  const body = await c.req.json();
  const { jobCardId, workerId } = body || {};
  const rawPiece = Number(body?.pieceNo);
  const pieceNo =
    Number.isFinite(rawPiece) && rawPiece >= 1 ? Math.floor(rawPiece) : 1;
  if (!jobCardId || !workerId) {
    return c.json(
      { success: false, error: "jobCardId and workerId are required" },
      400,
    );
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
      const aC = a.po.created_at || "";
      const bC = b.po.created_at || "";
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
    await applyWipInventoryChange(
      db,
      target.po,
      mergedJc,
      "COMPLETED",
      siblings.results ?? [],
    );
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
    // TODO(phase-5): postProductionOrderCompletion (FIFO consume + FGBatch)
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
  const po = await fetchPO(c.env.DB, c.req.param("id"));
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

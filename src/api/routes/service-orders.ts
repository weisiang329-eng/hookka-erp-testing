// ---------------------------------------------------------------------------
// Service Orders (换货服务) — Phase 3.
//
// A Service Order is a customer-reported defect on a SHIPPED unit. Source
// MUST be a SHIPPED Sales Order or SHIPPED Consignment Order (status IN
// ('SHIPPED','DELIVERED','INVOICED','CLOSED' for SO; equivalents for CO)).
// We validate that server-side on POST — never trust the client to filter.
//
// Three resolution modes (chosen at creation):
//   • REPRODUCE  — open a NEW production_order with service_order_id set
//                  and cost_category='REPAIR'. Mirrors the SO/CO PO shape
//                  but is its own cost bucket.
//   • STOCK_SWAP — pick an existing fg_batch and decrement its qty. The
//                  swapped FG ships immediately via the normal delivery
//                  flow (no new PO).
//   • REPAIR     — wait for the customer to return the defective unit;
//                  factory's REPAIR dept fixes it; reships.
//
// Lifecycle: OPEN → IN_PRODUCTION (A) | RESERVED (B) | IN_REPAIR (C)
//                 → READY_TO_SHIP → DELIVERED → CLOSED
//                 (CANCELLED only allowed from OPEN)
//
// We do NOT integrate with the shared production-builder for Mode A — that
// builder fans out into job_cards / WIP based on the BOM, which is the
// right thing for a fresh order but overkill for a single-unit replacement.
// Phase 3 keeps it simple: a 1-line production_orders row with the same
// shape as a normal PO, status PENDING, cost_category='REPAIR'. The user
// can manually create the job_cards through the existing scan flow if
// they want full WIP tracking — out of scope for v1.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

// SHIPPED-equivalent statuses on the source order. Server-side guard for
// "we don't open service orders for stuff that hasn't gone out yet".
// COs additionally have PARTIALLY_SOLD / FULLY_SOLD as post-ship states
// (see migration 0064 status CHECK) — both qualify, since the unit is
// already in the customer's possession when those flags fire.
const SHIPPED_STATUSES_SO = ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED"];
const SHIPPED_STATUSES_CO = [
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
  "PARTIALLY_SOLD",
  "FULLY_SOLD",
];

type Mode = "REPRODUCE" | "STOCK_SWAP" | "REPAIR";
type Status =
  | "OPEN"
  | "IN_PRODUCTION"
  | "RESERVED"
  | "IN_REPAIR"
  | "READY_TO_SHIP"
  | "DELIVERED"
  | "CLOSED"
  | "CANCELLED";

const VALID_MODES: Mode[] = ["REPRODUCE", "STOCK_SWAP", "REPAIR"];
const VALID_STATUSES: Status[] = [
  "OPEN",
  "IN_PRODUCTION",
  "RESERVED",
  "IN_REPAIR",
  "READY_TO_SHIP",
  "DELIVERED",
  "CLOSED",
  "CANCELLED",
];

// Adjacency-list of allowed status transitions. Drives the PUT /:id/status
// validator. Mode is checked at the call site — REPRODUCE goes to
// IN_PRODUCTION, STOCK_SWAP goes to RESERVED, REPAIR goes to IN_REPAIR;
// each mode has its own one-step path out of OPEN.
const STATUS_TRANSITIONS: Record<Status, Status[]> = {
  OPEN: ["IN_PRODUCTION", "RESERVED", "IN_REPAIR", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "CANCELLED"],
  RESERVED: ["READY_TO_SHIP", "CANCELLED"],
  IN_REPAIR: ["READY_TO_SHIP", "CANCELLED"],
  READY_TO_SHIP: ["DELIVERED"],
  DELIVERED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

type ServiceOrderRow = {
  id: string;
  serviceOrderNo: string;
  sourceType: "SO" | "CO";
  sourceId: string;
  sourceNo: string | null;
  customerId: string;
  customerName: string;
  mode: Mode;
  status: Status;
  issueDescription: string | null;
  issuePhotos: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  closedAt: string | null;
  notes: string | null;
};

type ServiceOrderLineRow = {
  id: string;
  serviceOrderId: string;
  sourceLineId: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  qty: number;
  issueSummary: string | null;
  resolutionProductionOrderId: string | null;
  resolutionFgBatchId: string | null;
};

type ServiceOrderReturnRow = {
  id: string;
  serviceOrderId: string;
  serviceOrderLineId: string | null;
  productId: string | null;
  productCode: string | null;
  receivedAt: string;
  receivedBy: string | null;
  receivedByName: string | null;
  condition: "PENDING_DECISION" | "REPAIRABLE" | "SCRAPPED";
  repairNotes: string | null;
  repairedAt: string | null;
  repairedBy: string | null;
  repairedByName: string | null;
  scrappedViaAdjustmentId: string | null;
  notes: string | null;
  createdAt: string | null;
};

function genSvcId(): string {
  return `svc-${crypto.randomUUID().slice(0, 8)}`;
}
function genLineId(): string {
  return `svcl-${crypto.randomUUID().slice(0, 8)}`;
}
function genReturnId(): string {
  return `svcr-${crypto.randomUUID().slice(0, 8)}`;
}

// SVC-YYMM-NNN. The MM segment helps the user spot recent ones at a glance
// (a year of service orders at the bottom of the list otherwise blends
// into a wall of identical-looking IDs).
async function nextServiceOrderNo(
  db: D1Database,
  now: Date,
): Promise<string> {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `SVC-${yy}${mm}`;
  const res = await db
    .prepare(
      "SELECT COUNT(*) as n FROM service_orders WHERE serviceOrderNo LIKE ?",
    )
    .bind(`${prefix}-%`)
    .first<{ n: number }>();
  const seq = (res?.n ?? 0) + 1;
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

function rowToApi(
  row: ServiceOrderRow,
  lines: ServiceOrderLineRow[],
  returns: ServiceOrderReturnRow[],
) {
  let photos: string[] = [];
  if (row.issuePhotos) {
    try {
      const parsed = JSON.parse(row.issuePhotos);
      if (Array.isArray(parsed)) photos = parsed.map(String);
    } catch {
      // malformed photos JSON — ignore silently, the form lets users fix
    }
  }
  return {
    id: row.id,
    serviceOrderNo: row.serviceOrderNo,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceNo: row.sourceNo ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    mode: row.mode,
    status: row.status,
    issueDescription: row.issueDescription ?? "",
    issuePhotos: photos,
    createdBy: row.createdBy ?? "",
    createdByName: row.createdByName ?? "",
    createdAt: row.createdAt ?? "",
    closedAt: row.closedAt ?? "",
    notes: row.notes ?? "",
    lines: lines
      .filter((l) => l.serviceOrderId === row.id)
      .map((l) => ({
        id: l.id,
        serviceOrderId: l.serviceOrderId,
        sourceLineId: l.sourceLineId ?? "",
        productId: l.productId ?? "",
        productCode: l.productCode ?? "",
        productName: l.productName ?? "",
        qty: l.qty,
        issueSummary: l.issueSummary ?? "",
        resolutionProductionOrderId: l.resolutionProductionOrderId ?? "",
        resolutionFgBatchId: l.resolutionFgBatchId ?? "",
      })),
    returns: returns
      .filter((r) => r.serviceOrderId === row.id)
      .map((r) => ({
        id: r.id,
        serviceOrderId: r.serviceOrderId,
        serviceOrderLineId: r.serviceOrderLineId ?? "",
        productId: r.productId ?? "",
        productCode: r.productCode ?? "",
        receivedAt: r.receivedAt,
        receivedBy: r.receivedBy ?? "",
        receivedByName: r.receivedByName ?? "",
        condition: r.condition,
        repairNotes: r.repairNotes ?? "",
        repairedAt: r.repairedAt ?? "",
        repairedBy: r.repairedBy ?? "",
        repairedByName: r.repairedByName ?? "",
        scrappedViaAdjustmentId: r.scrappedViaAdjustmentId ?? "",
        notes: r.notes ?? "",
        createdAt: r.createdAt ?? "",
      })),
  };
}

// ---------------------------------------------------------------------------
// Source-order lookup. Returns the validated SO/CO header (or 4xx info).
// ---------------------------------------------------------------------------
type SourceOrderSummary = {
  id: string;
  customerId: string;
  customerName: string;
  status: string;
  companyOrderId: string;
  customerState: string | null;
};

async function loadSourceOrder(
  db: D1Database,
  sourceType: "SO" | "CO",
  sourceId: string,
): Promise<SourceOrderSummary | null> {
  if (sourceType === "SO") {
    const row = await db
      .prepare(
        `SELECT id, customerId, customerName, status, companySOId, customerState
         FROM sales_orders WHERE id = ?`,
      )
      .bind(sourceId)
      .first<{
        id: string;
        customerId: string;
        customerName: string;
        status: string;
        companySOId: string | null;
        customerState: string | null;
      }>();
    if (!row) return null;
    return {
      id: row.id,
      customerId: row.customerId,
      customerName: row.customerName,
      status: row.status,
      companyOrderId: row.companySOId ?? "",
      customerState: row.customerState,
    };
  }
  const row = await db
    .prepare(
      `SELECT id, customerId, customerName, status, companyCOId, customerState
       FROM consignment_orders WHERE id = ?`,
    )
    .bind(sourceId)
    .first<{
      id: string;
      customerId: string;
      customerName: string;
      status: string;
      companyCOId: string | null;
      customerState: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customerName,
    status: row.status,
    companyOrderId: row.companyCOId ?? "",
    customerState: row.customerState,
  };
}

// ---------------------------------------------------------------------------
// GET /api/service-orders — list with optional filters.
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const status = c.req.query("status");
  const customerId = c.req.query("customerId");
  const sourceType = c.req.query("sourceType");
  const clauses: string[] = [];
  const params: string[] = [];
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

  const [orderRes, lineRes, returnRes] = await Promise.all([
    c.var.DB.prepare(
      `SELECT * FROM service_orders ${where} ORDER BY created_at DESC LIMIT 500`,
    )
      .bind(...params)
      .all<ServiceOrderRow>(),
    c.var.DB.prepare("SELECT * FROM service_order_lines").all<ServiceOrderLineRow>(),
    c.var.DB.prepare("SELECT * FROM service_order_returns").all<ServiceOrderReturnRow>(),
  ]);
  const lines = lineRes.results ?? [];
  const returns = returnRes.results ?? [];
  const data = (orderRes.results ?? []).map((r) => rowToApi(r, lines, returns));
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/service-orders/:id — one with lines + returns nested.
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, lineRes, returnRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM service_orders WHERE id = ?")
      .bind(id)
      .first<ServiceOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM service_order_lines WHERE serviceOrderId = ?",
    )
      .bind(id)
      .all<ServiceOrderLineRow>(),
    c.var.DB.prepare(
      "SELECT * FROM service_order_returns WHERE serviceOrderId = ? ORDER BY received_at DESC",
    )
      .bind(id)
      .all<ServiceOrderReturnRow>(),
  ]);
  if (!row) {
    return c.json({ success: false, error: "Service order not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToApi(row, lineRes.results ?? [], returnRes.results ?? []),
  });
});

// ---------------------------------------------------------------------------
// POST /api/service-orders — create.
//
// Body: {
//   sourceType: 'SO'|'CO',
//   sourceId: string,
//   mode: 'REPRODUCE'|'STOCK_SWAP'|'REPAIR',
//   issueDescription?: string,
//   issuePhotos?: string[],
//   notes?: string,
//   createdBy?: string, createdByName?: string,
//   lines: [{
//     sourceLineId?: string,        // sales_order_items.id / co item id
//     productId?: string, productCode?: string, productName?: string,
//     qty: number,
//     issueSummary?: string,
//     // Mode B only: which fg_batch to swap.
//     resolutionFgBatchId?: string,
//   }],
// }
//
// Side effects per mode:
//   REPRODUCE — for each line, INSERT a production_orders row with
//               service_order_id set + cost_category='REPAIR'. Status
//               flips to IN_PRODUCTION.
//   STOCK_SWAP — for each line, validate the fg_batch exists and has
//                remaining_qty >= line.qty, then UPDATE remaining_qty.
//                Status flips to RESERVED.
//   REPAIR     — no side effects beyond the SVC + lines rows. The user
//                will record returns via POST /:id/returns later.
//                Status stays OPEN until a return is logged, then the
//                user manually advances to IN_REPAIR.
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;

    // ---- validate mode/sourceType ----
    const sourceType = body.sourceType as string;
    if (sourceType !== "SO" && sourceType !== "CO") {
      return c.json(
        { success: false, error: "sourceType must be 'SO' or 'CO'" },
        400,
      );
    }
    const mode = body.mode as Mode;
    if (!VALID_MODES.includes(mode)) {
      return c.json(
        { success: false, error: "mode must be REPRODUCE, STOCK_SWAP, or REPAIR" },
        400,
      );
    }
    const sourceId = body.sourceId as string;
    if (!sourceId) {
      return c.json({ success: false, error: "sourceId is required" }, 400);
    }

    // ---- validate source order EXISTS and is SHIPPED ----
    const source = await loadSourceOrder(c.var.DB, sourceType, sourceId);
    if (!source) {
      return c.json(
        { success: false, error: `Source ${sourceType} ${sourceId} not found` },
        404,
      );
    }
    const shippedSet =
      sourceType === "SO" ? SHIPPED_STATUSES_SO : SHIPPED_STATUSES_CO;
    if (!shippedSet.includes(source.status)) {
      return c.json(
        {
          success: false,
          error: `Source order is in ${source.status} status. Only shipped orders (status in ${shippedSet.join(",")}) can have a Service Order created.`,
        },
        409,
      );
    }

    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (rawLines.length === 0) {
      return c.json(
        { success: false, error: "At least one line is required" },
        400,
      );
    }

    // ---- compose ----
    const now = new Date();
    const nowIso = now.toISOString();
    const serviceOrderNo = await nextServiceOrderNo(c.var.DB, now);
    const id = genSvcId();

    // Start status — OPEN for all modes. Side-effects below may bump it.
    let initialStatus: Status = "OPEN";
    if (mode === "REPRODUCE") initialStatus = "IN_PRODUCTION";
    else if (mode === "STOCK_SWAP") initialStatus = "RESERVED";
    // REPAIR stays OPEN until the user logs a return.

    // Build line rows + side-effects per mode.
    const lineRows: ServiceOrderLineRow[] = [];
    const sideEffectStmts: D1PreparedStatement[] = [];

    for (let idx = 0; idx < rawLines.length; idx++) {
      const ln = rawLines[idx] as Record<string, unknown>;
      const lineId = genLineId();
      const qty = Math.max(1, Number(ln.qty) || 1);
      const productId = (ln.productId as string) ?? null;
      const productCode = (ln.productCode as string) ?? null;
      const productName = (ln.productName as string) ?? null;

      let resolutionPoId: string | null = null;
      let resolutionFgBatchId: string | null = null;

      if (mode === "REPRODUCE") {
        // ---- spawn a production_orders row for this line ----
        const poId = `pord-svc-${crypto.randomUUID().slice(0, 8)}`;
        const poNo = `${serviceOrderNo}-${String(idx + 1).padStart(2, "0")}`;
        sideEffectStmts.push(
          c.var.DB
            .prepare(
              `INSERT INTO production_orders (id, poNo, salesOrderId, salesOrderNo,
                 consignmentOrderId, companyCOId, serviceOrderId, costCategory,
                 lineNo, customerName, customerState, productId, productCode,
                 productName, quantity, status, currentDepartment, progress,
                 startDate, stockedIn, created_at, updated_at)
               VALUES (?, ?, NULL, NULL, NULL, NULL, ?, 'REPAIR',
                 ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'FAB_CUT', 0, ?, 0, ?, ?)`,
            )
            .bind(
              poId,
              poNo,
              id,
              idx + 1,
              source.customerName,
              source.customerState ?? "",
              productId ?? "",
              productCode ?? "",
              productName ?? "",
              qty,
              nowIso.split("T")[0],
              nowIso,
              nowIso,
            ),
        );
        resolutionPoId = poId;
      } else if (mode === "STOCK_SWAP") {
        // ---- validate FG batch + decrement qty ----
        const fgBatchId = (ln.resolutionFgBatchId as string) ?? "";
        if (!fgBatchId) {
          return c.json(
            {
              success: false,
              error: `Line ${idx + 1}: STOCK_SWAP requires resolutionFgBatchId`,
            },
            400,
          );
        }
        const batch = await c.var.DB
          .prepare(
            "SELECT id, productId, remainingQty FROM fg_batches WHERE id = ?",
          )
          .bind(fgBatchId)
          .first<{ id: string; productId: string; remainingQty: number }>();
        if (!batch) {
          return c.json(
            {
              success: false,
              error: `Line ${idx + 1}: FG batch ${fgBatchId} not found`,
            },
            404,
          );
        }
        if (batch.remainingQty < qty) {
          return c.json(
            {
              success: false,
              error: `Line ${idx + 1}: FG batch only has ${batch.remainingQty} on hand (requested ${qty})`,
            },
            409,
          );
        }
        sideEffectStmts.push(
          c.var.DB
            .prepare(
              "UPDATE fg_batches SET remainingQty = remainingQty - ? WHERE id = ?",
            )
            .bind(qty, fgBatchId),
        );
        resolutionFgBatchId = fgBatchId;
      }
      // REPAIR has no per-line side effects.

      lineRows.push({
        id: lineId,
        serviceOrderId: id,
        sourceLineId: (ln.sourceLineId as string) ?? null,
        productId,
        productCode,
        productName,
        qty,
        issueSummary: (ln.issueSummary as string) ?? null,
        resolutionProductionOrderId: resolutionPoId,
        resolutionFgBatchId,
      });
    }

    // ---- assemble all writes ----
    const stmts: D1PreparedStatement[] = [];
    const photosJson = Array.isArray(body.issuePhotos)
      ? JSON.stringify((body.issuePhotos as unknown[]).map(String))
      : null;

    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO service_orders (id, serviceOrderNo, sourceType, sourceId,
           sourceNo, customerId, customerName, mode, status, issueDescription,
           issuePhotos, createdBy, createdByName, created_at, closedAt, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        id,
        serviceOrderNo,
        sourceType,
        sourceId,
        source.companyOrderId,
        source.customerId,
        source.customerName,
        mode,
        initialStatus,
        (body.issueDescription as string) ?? null,
        photosJson,
        (body.createdBy as string) ?? null,
        (body.createdByName as string) ?? null,
        nowIso,
        (body.notes as string) ?? null,
      ),
    );

    for (const l of lineRows) {
      stmts.push(
        c.var.DB.prepare(
          `INSERT INTO service_order_lines (id, serviceOrderId, sourceLineId,
             productId, productCode, productName, qty, issueSummary,
             resolutionProductionOrderId, resolutionFgBatchId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          l.id,
          l.serviceOrderId,
          l.sourceLineId,
          l.productId,
          l.productCode,
          l.productName,
          l.qty,
          l.issueSummary,
          l.resolutionProductionOrderId,
          l.resolutionFgBatchId,
        ),
      );
    }

    // Side-effects (PO inserts / FG decrements) AFTER the SVC + lines so
    // any FK they need (service_orders.id) is already inserted in the same
    // batch.
    stmts.push(...sideEffectStmts);

    await c.var.DB.batch(stmts);

    const [created, lines, returns] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM service_orders WHERE id = ?")
        .bind(id)
        .first<ServiceOrderRow>(),
      c.var.DB.prepare(
        "SELECT * FROM service_order_lines WHERE serviceOrderId = ?",
      )
        .bind(id)
        .all<ServiceOrderLineRow>(),
      c.var.DB.prepare(
        "SELECT * FROM service_order_returns WHERE serviceOrderId = ?",
      )
        .bind(id)
        .all<ServiceOrderReturnRow>(),
    ]);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to reload after insert" },
        500,
      );
    }
    return c.json(
      {
        success: true,
        data: rowToApi(created, lines.results ?? [], returns.results ?? []),
      },
      201,
    );
  } catch (err) {
    console.error("[POST /api/service-orders] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/service-orders/:id — edit metadata (issue_description, notes).
// Status changes go through the dedicated /:id/status endpoint to keep the
// transition validator in one place.
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM service_orders WHERE id = ?",
    )
      .bind(id)
      .first<ServiceOrderRow>();
    if (!existing) {
      return c.json({ success: false, error: "Service order not found" }, 404);
    }
    const body = (await c.req.json()) as Record<string, unknown>;

    const photosJson =
      body.issuePhotos === undefined
        ? existing.issuePhotos
        : Array.isArray(body.issuePhotos)
          ? JSON.stringify((body.issuePhotos as unknown[]).map(String))
          : null;

    await c.var.DB.prepare(
      `UPDATE service_orders SET
         issueDescription = ?, issuePhotos = ?, notes = ?
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
        id,
      )
      .run();

    const [updated, lines, returns] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM service_orders WHERE id = ?")
        .bind(id)
        .first<ServiceOrderRow>(),
      c.var.DB.prepare(
        "SELECT * FROM service_order_lines WHERE serviceOrderId = ?",
      )
        .bind(id)
        .all<ServiceOrderLineRow>(),
      c.var.DB.prepare(
        "SELECT * FROM service_order_returns WHERE serviceOrderId = ?",
      )
        .bind(id)
        .all<ServiceOrderReturnRow>(),
    ]);
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload after update" },
        500,
      );
    }
    return c.json({
      success: true,
      data: rowToApi(updated, lines.results ?? [], returns.results ?? []),
    });
  } catch (err) {
    console.error("[PUT /api/service-orders/:id] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/service-orders/:id/status — advance status with adjacency check.
// Body: { status: Status, notes?: string }
// ---------------------------------------------------------------------------
app.put("/:id/status", async (c) => {
  const id = c.req.param("id");
  try {
    const body = (await c.req.json()) as { status?: string; notes?: string };
    const next = body.status as Status;
    if (!next || !VALID_STATUSES.includes(next)) {
      return c.json(
        { success: false, error: "status must be a valid SVC status" },
        400,
      );
    }
    const existing = await c.var.DB.prepare(
      "SELECT * FROM service_orders WHERE id = ?",
    )
      .bind(id)
      .first<ServiceOrderRow>();
    if (!existing) {
      return c.json({ success: false, error: "Service order not found" }, 404);
    }
    const allowed = STATUS_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(next)) {
      return c.json(
        {
          success: false,
          error: `Cannot transition from ${existing.status} to ${next}. Allowed next states: ${allowed.join(", ") || "(none)"}`,
        },
        409,
      );
    }
    const closedAt = next === "CLOSED" ? new Date().toISOString() : null;
    await c.var.DB.prepare(
      `UPDATE service_orders SET status = ?, closedAt = COALESCE(?, closedAt),
         notes = COALESCE(?, notes) WHERE id = ?`,
    )
      .bind(next, closedAt, (body.notes as string) ?? null, id)
      .run();

    const updated = await c.var.DB
      .prepare("SELECT * FROM service_orders WHERE id = ?")
      .bind(id)
      .first<ServiceOrderRow>();
    return c.json({ success: true, data: { id, status: updated?.status } });
  } catch (err) {
    console.error("[PUT /api/service-orders/:id/status] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/service-orders/:id/returns — record defective unit returned to
// factory. Defaults condition to PENDING_DECISION; the user updates it
// later via PUT /:id/returns/:rid as the unit is inspected.
//
// Body: {
//   serviceOrderLineId?: string,
//   productId?: string, productCode?: string,
//   receivedAt?: string (ISO; defaults to now),
//   receivedBy?: string, receivedByName?: string,
//   condition?: 'PENDING_DECISION'|'REPAIRABLE'|'SCRAPPED',
//   notes?: string,
// }
// ---------------------------------------------------------------------------
app.post("/:id/returns", async (c) => {
  const id = c.req.param("id");
  try {
    const so = await c.var.DB.prepare(
      "SELECT id, mode, status FROM service_orders WHERE id = ?",
    )
      .bind(id)
      .first<{ id: string; mode: Mode; status: Status }>();
    if (!so) {
      return c.json({ success: false, error: "Service order not found" }, 404);
    }
    const body = (await c.req.json()) as Record<string, unknown>;
    const condition =
      (body.condition as ServiceOrderReturnRow["condition"]) ?? "PENDING_DECISION";
    if (!["PENDING_DECISION", "REPAIRABLE", "SCRAPPED"].includes(condition)) {
      return c.json({ success: false, error: "Invalid condition" }, 400);
    }
    const returnId = genReturnId();
    const nowIso = new Date().toISOString();

    await c.var.DB
      .prepare(
        `INSERT INTO service_order_returns (id, serviceOrderId, serviceOrderLineId,
           productId, productCode, receivedAt, receivedBy, receivedByName,
           condition, repairNotes, repairedAt, repairedBy, repairedByName,
           scrappedViaAdjustmentId, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(
        returnId,
        id,
        (body.serviceOrderLineId as string) ?? null,
        (body.productId as string) ?? null,
        (body.productCode as string) ?? null,
        (body.receivedAt as string) ?? nowIso,
        (body.receivedBy as string) ?? null,
        (body.receivedByName as string) ?? null,
        condition,
        (body.notes as string) ?? null,
        nowIso,
      )
      .run();

    // For REPAIR mode: first return moves the SVC out of OPEN into IN_REPAIR
    // automatically — the user shouldn't have to remember to flip the status.
    if (so.mode === "REPAIR" && so.status === "OPEN") {
      await c.var.DB
        .prepare("UPDATE service_orders SET status = 'IN_REPAIR' WHERE id = ?")
        .bind(id)
        .run();
    }

    const created = await c.var.DB
      .prepare("SELECT * FROM service_order_returns WHERE id = ?")
      .bind(returnId)
      .first<ServiceOrderReturnRow>();
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    console.error("[POST /api/service-orders/:id/returns] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/service-orders/:id/returns/:rid — update return status.
//
// Three valid transitions of `condition`:
//   PENDING_DECISION → REPAIRABLE  (queue for repair)
//   REPAIRABLE       → REPAIRABLE  (repaired_at + repaired_by set; the row
//                                   stays REPAIRABLE — the qty has been
//                                   restored to FG via the existing scan
//                                   flow at the user's discretion)
//   PENDING_DECISION → SCRAPPED    (must include scrappedViaAdjustmentId)
//
// Body: {
//   condition?: 'REPAIRABLE'|'SCRAPPED',
//   repairNotes?: string,
//   repairedAt?: string, repairedBy?: string, repairedByName?: string,
//   scrappedViaAdjustmentId?: string,
//   notes?: string,
// }
// ---------------------------------------------------------------------------
app.put("/:id/returns/:rid", async (c) => {
  const id = c.req.param("id");
  const rid = c.req.param("rid");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM service_order_returns WHERE id = ? AND serviceOrderId = ?",
    )
      .bind(rid, id)
      .first<ServiceOrderReturnRow>();
    if (!existing) {
      return c.json({ success: false, error: "Return not found" }, 404);
    }
    const body = (await c.req.json()) as Record<string, unknown>;
    const nextCondition =
      (body.condition as ServiceOrderReturnRow["condition"]) ?? existing.condition;
    if (!["PENDING_DECISION", "REPAIRABLE", "SCRAPPED"].includes(nextCondition)) {
      return c.json({ success: false, error: "Invalid condition" }, 400);
    }
    if (
      nextCondition === "SCRAPPED" &&
      !((body.scrappedViaAdjustmentId as string) ?? existing.scrappedViaAdjustmentId)
    ) {
      return c.json(
        {
          success: false,
          error: "SCRAPPED requires scrappedViaAdjustmentId (the linked stock_adjustments row)",
        },
        400,
      );
    }

    await c.var.DB
      .prepare(
        `UPDATE service_order_returns SET
           condition = ?,
           repairNotes = ?,
           repairedAt = ?,
           repairedBy = ?,
           repairedByName = ?,
           scrappedViaAdjustmentId = ?,
           notes = ?
         WHERE id = ?`,
      )
      .bind(
        nextCondition,
        body.repairNotes !== undefined
          ? ((body.repairNotes as string) ?? null)
          : existing.repairNotes,
        body.repairedAt !== undefined
          ? ((body.repairedAt as string) ?? null)
          : existing.repairedAt,
        body.repairedBy !== undefined
          ? ((body.repairedBy as string) ?? null)
          : existing.repairedBy,
        body.repairedByName !== undefined
          ? ((body.repairedByName as string) ?? null)
          : existing.repairedByName,
        body.scrappedViaAdjustmentId !== undefined
          ? ((body.scrappedViaAdjustmentId as string) ?? null)
          : existing.scrappedViaAdjustmentId,
        body.notes !== undefined
          ? ((body.notes as string) ?? null)
          : existing.notes,
        rid,
      )
      .run();

    const updated = await c.var.DB
      .prepare("SELECT * FROM service_order_returns WHERE id = ?")
      .bind(rid)
      .first<ServiceOrderReturnRow>();
    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error("[PUT /api/service-orders/:id/returns/:rid] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/service-orders/:id — cancel the order. Allowed only if it's
// still in OPEN. Once a PO has been spawned (REPRODUCE) or an FG batch
// reserved (STOCK_SWAP), the side-effects need their own undo path which
// is out of scope for v1 — the user goes through PUT /:id/status with
// CANCELLED for those, accepting the side-effect orphans for now.
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT status FROM service_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Service order not found" }, 404);
  }
  if (existing.status !== "OPEN") {
    return c.json(
      {
        success: false,
        error: `Only OPEN service orders can be deleted. Current status: ${existing.status}. Use PUT /:id/status with CANCELLED to cancel a started order.`,
      },
      400,
    );
  }
  await c.var.DB.prepare("DELETE FROM service_orders WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

export default app;

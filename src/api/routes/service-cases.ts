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

const app = new Hono<Env>();

type SourceType = "SO" | "CO" | "EXTERNAL";
type CaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
type RootCauseCategory =
  | "PRODUCTION" | "DESIGN" | "MATERIAL" | "PROCESS"
  | "CUSTOMER" | "TRANSPORT" | "OTHER";
type PreventionStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "NOT_NEEDED";

const VALID_SOURCE_TYPES: SourceType[] = ["SO", "CO", "EXTERNAL"];
const VALID_STATUSES: CaseStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED", "CANCELLED"];
const VALID_ROOT_CAUSE: RootCauseCategory[] = [
  "PRODUCTION", "DESIGN", "MATERIAL", "PROCESS", "CUSTOMER", "TRANSPORT", "OTHER",
];
const VALID_PREVENTION_STATUS: PreventionStatus[] = [
  "PENDING", "IN_PROGRESS", "DONE", "NOT_NEEDED",
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
  rootCauseCategory: RootCauseCategory | null;
  rootCauseNotes: string | null;
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

async function nextCaseNo(db: D1Database, now: Date): Promise<string> {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CASE-${yy}${mm}`;
  const res = await db
    .prepare("SELECT COUNT(*) as n FROM service_cases WHERE caseNo LIKE ?")
    .bind(`${prefix}-%`)
    .first<{ n: number }>();
  const seq = (res?.n ?? 0) + 1;
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

function rowToApi(row: ServiceCaseRow, orders: ServiceOrderRow[] = []) {
  let photos: string[] = [];
  if (row.issuePhotos) {
    try {
      const parsed = JSON.parse(row.issuePhotos);
      if (Array.isArray(parsed)) photos = parsed.map(String);
    } catch {
      // tolerate malformed JSON; surface the case anyway
    }
  }
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
    rootCauseCategory: row.rootCauseCategory,
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
    notes: row.notes ?? "",
    orders: orders
      .filter((o) => o.caseId === row.id)
      .map((o) => ({
        id: o.id,
        serviceOrderNo: o.serviceOrderNo,
        mode: o.mode,
        status: o.status,
        createdAt: o.createdAt ?? "",
      })),
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

  const [caseRes, orderRes] = await Promise.all([
    c.var.DB.prepare(`SELECT * FROM service_cases ${where} ORDER BY created_at DESC LIMIT 500`)
      .bind(...params)
      .all<ServiceCaseRow>(),
    c.var.DB.prepare("SELECT id, serviceOrderNo, caseId, sourceType, sourceId, sourceNo, customerId, customerName, mode, status, createdBy, createdByName, created_at as createdAt, closedAt, notes FROM service_orders").all<ServiceOrderRow>(),
  ]);
  const data = (caseRes.results ?? []).map((r) =>
    rowToApi(r, orderRes.results ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/service-cases/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [caseRow, orders] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM service_cases WHERE id = ?")
      .bind(id)
      .first<ServiceCaseRow>(),
    c.var.DB
      .prepare(
        "SELECT id, serviceOrderNo, caseId, sourceType, sourceId, sourceNo, customerId, customerName, mode, status, createdBy, createdByName, created_at as createdAt, closedAt, notes FROM service_orders WHERE caseId = ? ORDER BY created_at",
      )
      .bind(id)
      .all<ServiceOrderRow>(),
  ]);
  if (!caseRow) {
    return c.json({ success: false, error: "Service case not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToApi(caseRow, orders.results ?? []),
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
      const row = await c.var.DB
        .prepare(
          `SELECT customerId, customerName, customerState, ${noCol} AS companyOrderId FROM ${tableId} WHERE id = ?`,
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
      sourceNo = row.companyOrderId;
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

    await c.var.DB
      .prepare(
        `INSERT INTO service_cases (
           id, caseNo, sourceType, sourceId, sourceNo,
           customerId, customerName, customerState,
           issueDescription, issuePhotos,
           rootCauseCategory, rootCauseNotes,
           preventionAction, preventionStatus, preventionOwner,
           status, externalRef, createdBy, createdByName, created_at, closedAt, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL, ?)`,
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
  const id = c.req.param("id");
  try {
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

    const rcNext =
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

    await c.var.DB
      .prepare(
        `UPDATE service_cases SET
           issueDescription = ?, issuePhotos = ?, notes = ?,
           rootCauseCategory = ?, rootCauseNotes = ?,
           preventionAction = ?, preventionStatus = ?, preventionOwner = ?,
           externalRef = ?
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
        body.rootCauseNotes !== undefined
          ? ((body.rootCauseNotes as string) ?? null)
          : existing.rootCauseNotes,
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
        id,
      )
      .run();

    const [updated, orders] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM service_cases WHERE id = ?")
        .bind(id)
        .first<ServiceCaseRow>(),
      c.var.DB
        .prepare(
          "SELECT id, serviceOrderNo, caseId, sourceType, sourceId, sourceNo, customerId, customerName, mode, status, createdBy, createdByName, created_at as createdAt, closedAt, notes FROM service_orders WHERE caseId = ?",
        )
        .bind(id)
        .all<ServiceOrderRow>(),
    ]);
    if (!updated) {
      return c.json({ success: false, error: "Failed to reload after update" }, 500);
    }
    return c.json({ success: true, data: rowToApi(updated, orders.results ?? []) });
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
  const id = c.req.param("id");
  try {
    const body = (await c.req.json()) as { status?: string };
    const next = body.status as CaseStatus;
    if (!VALID_STATUSES.includes(next)) {
      return c.json({ success: false, error: "status invalid" }, 400);
    }
    const existing = await c.var.DB
      .prepare("SELECT status FROM service_cases WHERE id = ?")
      .bind(id)
      .first<{ status: CaseStatus }>();
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
    const closedAt = next === "CLOSED" || next === "CANCELLED" ? new Date().toISOString() : null;
    await c.var.DB
      .prepare(
        "UPDATE service_cases SET status = ?, closedAt = COALESCE(?, closedAt) WHERE id = ?",
      )
      .bind(next, closedAt, id)
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

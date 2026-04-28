// ---------------------------------------------------------------------------
// Shared row types + mappers for the consignment_notes / consignment_items
// tables.
//
// Two route files surface this data with slightly different APIs:
//   * src/api/routes/consignment-notes.ts (legacy /api/consignment-notes —
//     PATCH-by-body.id, no customer validation, used by the CN page)
//   * src/api/routes/consignments.ts      (legacy /api/consignments — full
//     CRUD by :id, validates customer)
//
// Both read/write the same underlying tables, so the row→object mapper and
// the driver/vehicle/hub resolution logic is factored here. Keeps the two
// files in lock-step instead of drifting (which is what happened before
// migration 0066 — see the linked-changes note in the migration file).
//
// Mirrors the patterns in src/api/routes/delivery-orders.ts 1:1: same
// 3PL-refactor lookup chain (provider company → driver person →
// vehicle), same column names where they overlap (driverId stores the
// PROVIDER company id per the legacy convention; the driver PERSON's
// name + phone get denormalized into driverName + driverPhone).
// ---------------------------------------------------------------------------

export type ConsignmentNoteRow = {
  id: string;
  noteNumber: string;
  type: string | null;
  customerId: string;
  customerName: string | null;
  branchName: string | null;
  sentDate: string | null;
  status: string | null;
  totalValue: number;
  notes: string | null;
  // Carrier metadata (migration 0066)
  driverId: string | null;
  driverName: string | null;
  driverContactPerson: string | null;
  driverPhone: string | null;
  vehicleId: string | null;
  vehicleNo: string | null;
  vehicleType: string | null;
  // Lifecycle timestamps (migration 0066)
  dispatchedAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  // CO + hub linkage (migration 0066)
  consignmentOrderId: string | null;
  hubId: string | null;
  // Invoice linkage (migration 0070). NULL until the CN is converted via
  // POST /api/consignment-notes/:id/convert-to-invoice. One-way link —
  // see migration header for why we don't add a reverse FK on invoices.
  convertedInvoiceId: string | null;
};

export type ConsignmentItemRow = {
  id: string;
  consignmentNoteId: string;
  productId: string | null;
  productName: string | null;
  productCode: string | null;
  quantity: number;
  unitPrice: number;
  status: string | null;
  soldDate: string | null;
  returnedDate: string | null;
  // PO linkage (migration 0066) — used by the Pending-CN dedup on the
  // CN page (per-PO dedup matching DO's pattern via
  // delivery_order_items.production_order_id).
  productionOrderId: string | null;
};

export function rowToConsignmentNote(
  row: ConsignmentNoteRow,
  items: ConsignmentItemRow[] = [],
) {
  return {
    id: row.id,
    noteNumber: row.noteNumber,
    type: row.type ?? "OUT",
    customerId: row.customerId,
    customerName: row.customerName ?? "",
    branchName: row.branchName ?? "",
    sentDate: row.sentDate ?? "",
    status: row.status ?? "ACTIVE",
    totalValue: row.totalValue,
    notes: row.notes ?? "",
    // Carrier metadata. Surfaced exactly the same way DO does — empty
    // string for missing values on display fields, raw null on id fields
    // so the FE can distinguish "not picked yet" from "blank string".
    driverId: row.driverId,
    driverName: row.driverName ?? "",
    driverContactPerson: row.driverContactPerson ?? "",
    driverPhone: row.driverPhone ?? "",
    vehicleId: row.vehicleId,
    vehicleNo: row.vehicleNo ?? "",
    vehicleType: row.vehicleType ?? "",
    // Lifecycle timestamps — null when not yet stamped, ISO string after.
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
    acknowledgedAt: row.acknowledgedAt,
    // CO + hub linkage
    consignmentOrderId: row.consignmentOrderId,
    hubId: row.hubId,
    // Invoice linkage (migration 0070). NULL until the operator converts
    // the CN via the convert-to-invoice endpoint.
    convertedInvoiceId: row.convertedInvoiceId,
    items: items
      .filter((it) => it.consignmentNoteId === row.id)
      .map((it) => ({
        id: it.id,
        productId: it.productId ?? "",
        productName: it.productName ?? "",
        productCode: it.productCode ?? "",
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        status: it.status ?? "AT_BRANCH",
        soldDate: it.soldDate,
        returnedDate: it.returnedDate,
        productionOrderId: it.productionOrderId,
      })),
  };
}

export function genNoteId(): string {
  return `con-${crypto.randomUUID().slice(0, 8)}`;
}

export function genItemId(): string {
  return `coni-${crypto.randomUUID().slice(0, 8)}`;
}

// CGN-YYMM-NNN. Per user 2026-04-28 numbering decision: Credit Note owns
// the CN- prefix (financial standard); Consignment Note moves to CGN- to
// avoid the collision. Existing CON-* numbers stay valid forever — the
// LIKE ? lookup is scoped to the new prefix so old + new co-exist.
export async function nextConsignmentNoteNumber(
  db: D1Database,
  now: Date,
): Promise<string> {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CGN-${yy}${mm}-`;
  const res = await db
    .prepare(
      "SELECT noteNumber FROM consignment_notes WHERE noteNumber LIKE ? ORDER BY noteNumber DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ noteNumber: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.noteNumber.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// 3PL refactor lookup chain — mirrors delivery-orders.ts POST.
//
// body.providerId — id of a row in the `drivers` table (the legacy
//   COMPANY table — see migration 0014's naming-misnomer note). Used to
//   denormalize the company's display name + dispatcher contact.
// body.vehicleId  — id of a row in `three_pl_vehicles`. Provides the plate
//   + vehicleType.
// body.driverId   — id of a row in `three_pl_drivers` (an actual PERSON).
//   Provides driverName + driverPhone.
//
// Backwards compat: pre-refactor callers passed body.driverId meaning
// "company id". If body.providerId is missing AND body.driverId doesn't
// resolve to a person but DOES resolve to a `drivers` row, we treat it as
// the legacy provider id.
// ---------------------------------------------------------------------------

export type ResolvedTransport = {
  providerId: string | null;
  driverId: string | null; // actual PERSON id when one was picked
  driverName: string;
  driverPhone: string;
  driverContactPerson: string;
  vehicleId: string | null;
  vehicleNo: string;
  vehicleType: string;
};

export async function resolveTransport(
  db: D1Database,
  body: Record<string, unknown>,
): Promise<ResolvedTransport> {
  let providerId = (body.providerId as string | undefined) ?? null;
  let driverId = (body.driverId as string | undefined) ?? null;
  let driverName = (body.driverName as string | undefined) ?? "";
  let driverPhone = (body.driverPhone as string | undefined) ?? "";
  let driverContactPerson =
    (body.driverContactPerson as string | undefined) ?? "";
  let vehicleId = (body.vehicleId as string | undefined) ?? null;
  let vehicleNo = (body.vehicleNo as string | undefined) ?? "";
  let vehicleType = (body.vehicleType as string | undefined) ?? "";

  // Driver person lookup first — and the legacy-id fallback path needs to
  // know whether driverId hit a person row or not.
  if (driverId) {
    const person = await db
      .prepare(
        "SELECT id, providerId, name, phone FROM three_pl_drivers WHERE id = ?",
      )
      .bind(driverId)
      .first<{
        id: string;
        providerId: string;
        name: string;
        phone: string | null;
      }>();
    if (person) {
      driverName = person.name;
      driverPhone = person.phone ?? "";
      if (!providerId) providerId = person.providerId;
    } else {
      // Backcompat: maybe driverId was a legacy COMPANY id. If so, treat
      // it as providerId and clear the resolved person id so downstream
      // doesn't store a non-person id in driverId.
      const legacyProvider = await db
        .prepare("SELECT id FROM drivers WHERE id = ?")
        .bind(driverId)
        .first<{ id: string }>();
      if (legacyProvider && !providerId) {
        providerId = legacyProvider.id;
        driverId = null;
      }
    }
  }

  // Provider (company) lookup — denormalize name + dispatcher contact.
  if (providerId) {
    const provider = await db
      .prepare(
        "SELECT id, name, vehicleNo, contactPerson FROM drivers WHERE id = ?",
      )
      .bind(providerId)
      .first<{
        id: string;
        name: string;
        vehicleNo: string | null;
        contactPerson: string | null;
      }>();
    if (provider) {
      // When a driver person was picked, prefer their name. Otherwise
      // fall back to the company name (legacy CN/DO read driverName as
      // "the 3PL").
      if (!driverName) driverName = provider.name;
      driverContactPerson = provider.contactPerson ?? "";
      if (!vehicleId && provider.vehicleNo && !vehicleNo) {
        vehicleNo = provider.vehicleNo;
      }
    }
  }

  // Vehicle lookup — plate + type.
  if (vehicleId) {
    const vehicle = await db
      .prepare(
        "SELECT id, plateNo, vehicleType FROM three_pl_vehicles WHERE id = ?",
      )
      .bind(vehicleId)
      .first<{
        id: string;
        plateNo: string;
        vehicleType: string | null;
      }>();
    if (vehicle) {
      vehicleNo = vehicle.plateNo;
      vehicleType = vehicle.vehicleType ?? "";
    } else {
      // Stored id no longer exists — null it out so the CN doesn't
      // dangle a stale FK.
      vehicleId = null;
    }
  }

  return {
    providerId,
    driverId,
    driverName,
    driverPhone,
    driverContactPerson,
    vehicleId,
    vehicleNo,
    vehicleType,
  };
}

// Resolve customerState from delivery_hubs for a given hubId. Mirrors
// DO's hubState lookup so the CN row stores the destination branch's
// state code without the operator typing it.
export async function resolveHubState(
  db: D1Database,
  hubId: string | null,
): Promise<string | null> {
  if (!hubId) return null;
  const hub = await db
    .prepare("SELECT id, state FROM delivery_hubs WHERE id = ?")
    .bind(hubId)
    .first<{ id: string; state: string | null }>();
  return hub?.state ?? null;
}

// ---------------------------------------------------------------------------
// Update CN by id — handles status transitions + lifecycle stamping +
// driver/vehicle/hub re-resolution. Used by both consignment-notes.ts
// (PATCH/PUT) and consignments.ts (PUT). Returns the updated row +
// items, or null if the CN doesn't exist.
//
// Lifecycle (mirrors DO's status transitions, mapped onto the legacy CN
// status enum the FE re-skins):
//
//   ACTIVE         → PARTIALLY_SOLD  (Mark Dispatched)   — stamps dispatchedAt
//   PARTIALLY_SOLD → FULLY_SOLD      (Mark Delivered)     — stamps deliveredAt
//   FULLY_SOLD     → CLOSED          (Mark Acknowledged)  — stamps acknowledgedAt
//
// Timestamps are auto-stamped server-side so the FE only needs to send
// `{ status }`. Existing timestamps are preserved (idempotent: writing the
// same status twice doesn't overwrite the first stamp). Callers can
// override explicitly via body.{dispatchedAt,deliveredAt,acknowledgedAt}.
// ---------------------------------------------------------------------------
export type UpdateCNResult =
  | { ok: true; note: ConsignmentNoteRow; items: ConsignmentItemRow[] }
  | { ok: false; reason: "not_found" };

export async function updateConsignmentNoteById(
  db: D1Database,
  id: string,
  body: Record<string, unknown>,
): Promise<UpdateCNResult> {
  const existing = await db
    .prepare("SELECT * FROM consignment_notes WHERE id = ?")
    .bind(id)
    .first<ConsignmentNoteRow>();
  if (!existing) return { ok: false, reason: "not_found" };

  const now = new Date().toISOString();
  const nextStatus =
    typeof body.status === "string" && body.status
      ? body.status
      : existing.status;

  // Auto-stamp lifecycle timestamps (idempotent).
  let dispatchedAt = existing.dispatchedAt;
  let deliveredAt = existing.deliveredAt;
  let acknowledgedAt = existing.acknowledgedAt;
  if (nextStatus === "PARTIALLY_SOLD" && !dispatchedAt) dispatchedAt = now;
  if (nextStatus === "FULLY_SOLD" && !deliveredAt) deliveredAt = now;
  if (nextStatus === "CLOSED" && !acknowledgedAt) acknowledgedAt = now;
  // Allow explicit override (backfill / correction).
  if (body.dispatchedAt !== undefined) {
    dispatchedAt = (body.dispatchedAt as string | null) ?? null;
  }
  if (body.deliveredAt !== undefined) {
    deliveredAt = (body.deliveredAt as string | null) ?? null;
  }
  if (body.acknowledgedAt !== undefined) {
    acknowledgedAt = (body.acknowledgedAt as string | null) ?? null;
  }

  // Carrier merge — only re-resolve when the caller actively touched any
  // of the three lookup keys. Otherwise leave the stored denormalized
  // values alone.
  const touchedTransport =
    body.providerId !== undefined ||
    body.driverId !== undefined ||
    body.vehicleId !== undefined;
  let driverId = existing.driverId;
  let driverName = existing.driverName ?? "";
  let driverContactPerson = existing.driverContactPerson ?? "";
  let driverPhone = existing.driverPhone ?? "";
  let vehicleId = existing.vehicleId;
  let vehicleNo = existing.vehicleNo ?? "";
  let vehicleType = existing.vehicleType ?? "";
  if (touchedTransport) {
    const transport = await resolveTransport(db, body);
    driverId = transport.providerId;
    driverName = transport.driverName;
    driverContactPerson = transport.driverContactPerson;
    driverPhone = transport.driverPhone;
    vehicleId = transport.vehicleId;
    vehicleNo = transport.vehicleNo;
    vehicleType = transport.vehicleType;
  } else {
    if (typeof body.driverName === "string") driverName = body.driverName;
    if (typeof body.driverPhone === "string") driverPhone = body.driverPhone;
    if (typeof body.driverContactPerson === "string") {
      driverContactPerson = body.driverContactPerson;
    }
    if (typeof body.vehicleNo === "string") vehicleNo = body.vehicleNo;
    if (typeof body.vehicleType === "string") vehicleType = body.vehicleType;
  }

  // Hub re-resolve.
  let hubId = existing.hubId;
  let branchName = existing.branchName ?? "";
  if (body.hubId !== undefined) {
    hubId = (body.hubId as string | null) ?? null;
    if (hubId) {
      const hub = await db
        .prepare("SELECT id, shortName FROM delivery_hubs WHERE id = ?")
        .bind(hubId)
        .first<{ id: string; shortName: string | null }>();
      if (hub) branchName = hub.shortName ?? branchName;
    }
  }
  if (typeof body.branchName === "string") branchName = body.branchName;

  const consignmentOrderId =
    body.consignmentOrderId === undefined
      ? existing.consignmentOrderId
      : ((body.consignmentOrderId as string | null) ?? null);

  const notes =
    typeof body.notes === "string" ? body.notes : (existing.notes ?? "");

  await db
    .prepare(
      `UPDATE consignment_notes SET
         status = ?, notes = ?, branchName = ?,
         driverId = ?, driverName = ?, driverContactPerson = ?, driverPhone = ?,
         vehicleId = ?, vehicleNo = ?, vehicleType = ?,
         dispatchedAt = ?, deliveredAt = ?, acknowledgedAt = ?,
         consignmentOrderId = ?, hubId = ?
       WHERE id = ?`,
    )
    .bind(
      nextStatus,
      notes,
      branchName,
      driverId,
      driverName,
      driverContactPerson,
      driverPhone,
      vehicleId,
      vehicleNo,
      vehicleType,
      dispatchedAt,
      deliveredAt,
      acknowledgedAt,
      consignmentOrderId,
      hubId,
      id,
    )
    .run();

  const [note, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM consignment_notes WHERE id = ?")
      .bind(id)
      .first<ConsignmentNoteRow>(),
    db
      .prepare("SELECT * FROM consignment_items WHERE consignmentNoteId = ?")
      .bind(id)
      .all<ConsignmentItemRow>(),
  ]);
  if (!note) return { ok: false, reason: "not_found" };
  return { ok: true, note, items: itemsRes.results ?? [] };
}

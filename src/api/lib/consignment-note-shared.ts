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
  // Lifecycle timestamps (migration 0066 + 0078).
  // inTransitAt was added by migration 0078 — stamped on the
  // PARTIALLY_SOLD → IN_TRANSIT transition ("Mark In Transit") to mirror
  // DO's 3-state shipping lane (LOADED → IN_TRANSIT → DELIVERED).
  dispatchedAt: string | null;
  inTransitAt: string | null;
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
    // inTransitAt (migration 0078) stamps on the LOADED → IN_TRANSIT
    // transition; the FE Tracking timeline + Detail dialog read it.
    dispatchedAt: row.dispatchedAt,
    inTransitAt: row.inTransitAt,
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
//   ACTIVE         → PARTIALLY_SOLD  (Mark Dispatched)    — stamps dispatchedAt
//   PARTIALLY_SOLD → IN_TRANSIT      (Mark In Transit)    — stamps inTransitAt   (migration 0078)
//   IN_TRANSIT     → FULLY_SOLD      (Mark Delivered)     — stamps deliveredAt
//   PARTIALLY_SOLD → FULLY_SOLD      (Mark Delivered direct, skipping IN_TRANSIT)
//   FULLY_SOLD     → CLOSED          (Mark Acknowledged)  — stamps acknowledgedAt
//
// Reverse transitions (added 2026-04-28 for the DO-parity reverse-action
// context menu items on the CN page):
//
//   IN_TRANSIT     → PARTIALLY_SOLD  (Reverse to Dispatched)         — nulls inTransitAt
//   PARTIALLY_SOLD → ACTIVE          (Reverse to Pending Dispatch)   — nulls dispatchedAt + inTransitAt
//   IN_TRANSIT     → ACTIVE          (Reverse to Pending Dispatch in one step from in-transit)
//   FULLY_SOLD     → PARTIALLY_SOLD  (Reverse to Dispatched)         — nulls deliveredAt
//   CLOSED         → FULLY_SOLD      (Reverse to Delivered)          — nulls acknowledgedAt
//
// Auto-null logic: when the new status is strictly EARLIER in the lifecycle
// than the existing one (per STATUS_RANK below), every timestamp at-or-after
// the new rank is cleared. Callers can also force a wipe by passing
// `clearTimestamps: true` on the body, which nulls all three timestamps
// regardless of rank — useful for backfill / corrections.
//
// Timestamps are auto-stamped server-side so the FE only needs to send
// `{ status }`. Existing timestamps are preserved on the FORWARD path
// (idempotent: writing the same status twice doesn't overwrite the first
// stamp). Callers can override explicitly via
// body.{dispatchedAt,deliveredAt,acknowledgedAt} to set a specific value.
// ---------------------------------------------------------------------------

// Lifecycle rank for the legacy CN status enum. Used to detect reverse
// transitions in updateConsignmentNoteById so the matching timestamp gets
// nulled instead of the stale value lingering. RETURNED is treated as
// PARTIALLY_SOLD's rank since it's reachable from PARTIALLY_SOLD/FULLY_SOLD
// via the return endpoint and shouldn't pin a forward timestamp.
//
// IN_TRANSIT (migration 0078) sits between PARTIALLY_SOLD (Dispatched) and
// FULLY_SOLD (Delivered) — same position DO assigns to its IN_TRANSIT
// state on the delivery_orders table. Existing ranks shift accordingly:
// FULLY_SOLD 2→3, CLOSED 3→4. RETURNED stays at PARTIALLY_SOLD's rank.
const STATUS_RANK: Record<string, number> = {
  ACTIVE: 0,
  PARTIALLY_SOLD: 1,
  RETURNED: 1,
  IN_TRANSIT: 2,
  FULLY_SOLD: 3,
  CLOSED: 4,
};
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

  // Auto-stamp lifecycle timestamps (idempotent on forward transitions).
  let dispatchedAt = existing.dispatchedAt;
  let inTransitAt = existing.inTransitAt;
  let deliveredAt = existing.deliveredAt;
  let acknowledgedAt = existing.acknowledgedAt;
  if (nextStatus === "PARTIALLY_SOLD" && !dispatchedAt) dispatchedAt = now;
  // IN_TRANSIT (migration 0078) — Mark In Transit. Also stamp dispatchedAt
  // if the operator skipped Mark Dispatched and went straight from ACTIVE
  // → IN_TRANSIT (defensive — the FE gates the action on DISPATCHED, but
  // an explicit override could still get here).
  if (nextStatus === "IN_TRANSIT") {
    if (!inTransitAt) inTransitAt = now;
    if (!dispatchedAt) dispatchedAt = now;
  }
  if (nextStatus === "FULLY_SOLD" && !deliveredAt) deliveredAt = now;
  if (nextStatus === "CLOSED" && !acknowledgedAt) acknowledgedAt = now;

  // Reverse-transition timestamp wipe. When the new status sits earlier in
  // the lifecycle than what's stored (e.g. user reverses CLOSED → FULLY_SOLD
  // or PARTIALLY_SOLD → ACTIVE), every timestamp whose stage is at-or-after
  // the new rank gets nulled out — otherwise the row keeps stale "delivered
  // 5 days ago" data after the operator already moved it back.
  const prevRank = STATUS_RANK[existing.status ?? ""] ?? 0;
  const nextRank = STATUS_RANK[nextStatus ?? ""] ?? 0;
  if (typeof body.status === "string" && nextRank < prevRank) {
    if (nextRank < STATUS_RANK.PARTIALLY_SOLD) dispatchedAt = null;
    if (nextRank < STATUS_RANK.IN_TRANSIT) inTransitAt = null;
    if (nextRank < STATUS_RANK.FULLY_SOLD) deliveredAt = null;
    if (nextRank < STATUS_RANK.CLOSED) acknowledgedAt = null;
  }

  // Force-wipe escape hatch: clearTimestamps:true on the body nulls all
  // four lifecycle timestamps regardless of rank. Used by the reverse
  // context-menu actions on the CN page when the FE wants the wipe to be
  // explicit rather than rely on rank inference.
  if (body.clearTimestamps === true) {
    dispatchedAt = null;
    inTransitAt = null;
    deliveredAt = null;
    acknowledgedAt = null;
  }

  // Allow explicit override (backfill / correction). Wins over both the
  // auto-stamp and the reverse-wipe paths above.
  if (body.dispatchedAt !== undefined) {
    dispatchedAt = (body.dispatchedAt as string | null) ?? null;
  }
  if (body.inTransitAt !== undefined) {
    inTransitAt = (body.inTransitAt as string | null) ?? null;
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

  // sentDate (the FE's "Delivery Date" field on the inline edit-mode dialog).
  // Optional — if omitted from the body, retain the existing value. Pass
  // null to explicitly clear, string to overwrite. Mirrors how DO's
  // deliveryDate persists. Without this column in the UPDATE the inline
  // edit-mode would silently no-op the date change.
  const sentDate =
    body.sentDate === undefined
      ? existing.sentDate
      : ((body.sentDate as string | null) ?? null);

  await db
    .prepare(
      `UPDATE consignment_notes SET
         status = ?, notes = ?, branchName = ?, sentDate = ?,
         driverId = ?, driverName = ?, driverContactPerson = ?, driverPhone = ?,
         vehicleId = ?, vehicleNo = ?, vehicleType = ?,
         dispatchedAt = ?, inTransitAt = ?, deliveredAt = ?, acknowledgedAt = ?,
         consignmentOrderId = ?, hubId = ?
       WHERE id = ?`,
    )
    .bind(
      nextStatus,
      notes,
      branchName,
      sentDate,
      driverId,
      driverName,
      driverContactPerson,
      driverPhone,
      vehicleId,
      vehicleNo,
      vehicleType,
      dispatchedAt,
      inTransitAt,
      deliveredAt,
      acknowledgedAt,
      consignmentOrderId,
      hubId,
      id,
    )
    .run();

  // -------------------------------------------------------------------
  // Phase-4 inventory cascade on dispatch (ACTIVE → PARTIALLY_SOLD,
  // added 2026-04-28). Mirrors delivery-orders.ts ~lines 1346-1469 — see
  // that block for the full rationale; the gist:
  //   - This is the inventory boundary for CN. Until now the goods sat
  //     in fg_units PENDING and showed Available in the Inventory page
  //     even though dispatch had already been performed.
  //   - Stamp fg_units with cnId + status='LOADED' + loadedAt so the
  //     Inventory read path drops the unit from Available.
  //   - Write a STOCK_OUT row per PO so the racking ledger reflects the
  //     physical out-movement.
  //   - Decrement wip_items.stockQty for any UPH job-card wipLabel on
  //     these POs (BUG-2026-04-27-021 — the residual UPH ledger entry
  //     stops being view-backed once the FG view drops the PO too).
  //
  // Idempotency guards:
  //   - Outer gate `existing.status === ACTIVE && nextStatus ===
  //     PARTIALLY_SOLD` means re-PATCHing PARTIALLY_SOLD with
  //     status=PARTIALLY_SOLD doesn't re-run the cascade.
  //   - WHERE clause requires `(cnId IS NULL OR cnId='')` so a CN that
  //     already cascaded won't double-stamp; also `(doId IS NULL OR
  //     doId='')` prevents stealing units that a DO already loaded.
  //
  // No db.batch() here — this helper has always run sequential
  // .prepare(...).run() calls (matches the rest of the file's style),
  // and introducing a batch would be a larger refactor.
  // -------------------------------------------------------------------
  const stampedOnDispatch =
    existing.status === "ACTIVE" && nextStatus === "PARTIALLY_SOLD";
  if (stampedOnDispatch) {
    const itemRowsRes = await db
      .prepare(
        `SELECT productionOrderId FROM consignment_items
           WHERE consignmentNoteId = ?`,
      )
      .bind(id)
      .all<{ productionOrderId: string | null }>();
    const itemPoIds = Array.from(
      new Set(
        (itemRowsRes.results ?? [])
          .map((r) => r.productionOrderId)
          .filter((s): s is string => !!s),
      ),
    );
    if (itemPoIds.length > 0) {
      const ph = itemPoIds.map(() => "?").join(",");
      const poRowsRes = await db
        .prepare(
          `SELECT id, productCode, productName, quantity, rackingNumber
             FROM production_orders WHERE id IN (${ph})`,
        )
        .bind(...itemPoIds)
        .all<{
          id: string;
          productCode: string | null;
          productName: string | null;
          quantity: number | null;
          rackingNumber: string | null;
        }>();
      const poRows = poRowsRes.results ?? [];
      for (const po of poRows) {
        await db
          .prepare(
            `UPDATE fg_units
                SET cnId = ?, status = 'LOADED', loadedAt = ?
              WHERE poId = ?
                AND (doId IS NULL OR doId = '')
                AND (cnId IS NULL OR cnId = '')`,
          )
          .bind(id, now, po.id)
          .run();
        await db
          .prepare(
            `INSERT INTO stock_movements (
               id, type, rackLocationId, rackLabel, productionOrderId,
               productCode, productName, quantity, reason, performedBy,
               created_at
             ) VALUES (?, 'STOCK_OUT', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
          )
          .bind(
            `mov-${crypto.randomUUID().slice(0, 8)}`,
            null,
            po.rackingNumber ?? "",
            po.id,
            po.productCode ?? "",
            po.productName ?? "",
            Number(po.quantity) || 0,
            `CN ${existing.noteNumber} dispatched`,
            now,
          )
          .run();
      }

      // BUG-2026-04-27-021 (CN side): decrement wip_items.stockQty for
      // every UPH wipLabel produced by these POs. Same reasoning as the
      // DO branch — once the CN dispatch flips fg_units LOADED, the FG
      // view drops the PO and the residual +qty on wip_items has no
      // backing view, so we balance the books here. Idempotent via the
      // stampedOnDispatch outer gate (ACTIVE → PARTIALLY_SOLD edge only).
      const uphRowsRes = await db
        .prepare(
          `SELECT productionOrderId, wipLabel, wipQty FROM job_cards
             WHERE productionOrderId IN (${ph})
               AND departmentCode = 'UPHOLSTERY'
               AND wipLabel IS NOT NULL
               AND wipLabel != ''`,
        )
        .bind(...itemPoIds)
        .all<{
          productionOrderId: string;
          wipLabel: string;
          wipQty: number | null;
        }>();
      const uphRows = uphRowsRes.results ?? [];
      const poById = new Map(poRows.map((p) => [p.id, p]));
      for (const u of uphRows) {
        const po = poById.get(u.productionOrderId);
        if (!po) continue;
        const dec = Number(u.wipQty) || Number(po.quantity) || 0;
        if (dec === 0) continue;
        await db
          .prepare(
            `UPDATE wip_items SET stockQty = stockQty - ? WHERE code = ?`,
          )
          .bind(dec, u.wipLabel)
          .run();
      }
    }
  }

  // -------------------------------------------------------------------
  // Reversal cascade on (PARTIALLY_SOLD | IN_TRANSIT) → ACTIVE ("Reverse
  // to Pending Dispatch" context-menu action). Mirrors delivery-orders.ts
  // ~lines 1471-1577 — unstamp fg_units that this CN claimed, write a
  // STOCK_IN counter-movement (audit history is append-only), and
  // re-credit wip_items.stockQty symmetrically. Without this, units
  // would stay wedged in 'LOADED' state with an obsolete cnId pointer
  // and the warehouse view would double-count them after a reversal.
  //
  // The widened IN_TRANSIT trigger (added with migration 0078) lets a CN
  // that's already crossed into IN_TRANSIT roll all the way back to
  // Pending Dispatch in one PUT — symmetric to the forward path which
  // does NOT add a cascade on PARTIALLY_SOLD → IN_TRANSIT (the goods
  // were already booked out at dispatch; IN_TRANSIT is just a tracking
  // sub-state of LOADED).
  //
  // Skipping FULLY_SOLD → DELIVERED parity from DO is intentional:
  // consignment lifecycle differs ("delivered to branch" ≠ "sold to end
  // customer"; the SOLD event is per-line via consignment_items.soldDate,
  // not header-level). Only the ACTIVE↔PARTIALLY_SOLD/IN_TRANSIT boundary
  // touches fg_units / stock_movements / wip_items.
  // -------------------------------------------------------------------
  const revertedToActive =
    (existing.status === "PARTIALLY_SOLD" || existing.status === "IN_TRANSIT") &&
    nextStatus === "ACTIVE";
  if (revertedToActive) {
    const stampedPosRes = await db
      .prepare(`SELECT DISTINCT poId FROM fg_units WHERE cnId = ?`)
      .bind(id)
      .all<{ poId: string }>();
    const stampedPoIds = (stampedPosRes.results ?? [])
      .map((r) => r.poId)
      .filter((s): s is string => !!s);
    await db
      .prepare(
        `UPDATE fg_units
            SET cnId = NULL, status = 'PENDING', loadedAt = NULL
          WHERE cnId = ?`,
      )
      .bind(id)
      .run();
    for (const poId of stampedPoIds) {
      const po = await db
        .prepare(
          `SELECT id, productCode, productName, quantity, rackingNumber
             FROM production_orders WHERE id = ?`,
        )
        .bind(poId)
        .first<{
          id: string;
          productCode: string | null;
          productName: string | null;
          quantity: number | null;
          rackingNumber: string | null;
        }>();
      if (!po) continue;
      await db
        .prepare(
          `INSERT INTO stock_movements (
             id, type, rackLocationId, rackLabel, productionOrderId,
             productCode, productName, quantity, reason, performedBy,
             created_at
           ) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
        )
        .bind(
          `mov-${crypto.randomUUID().slice(0, 8)}`,
          null,
          po.rackingNumber ?? "",
          po.id,
          po.productCode ?? "",
          po.productName ?? "",
          Number(po.quantity) || 0,
          `CN ${existing.noteNumber} reverted to Pending Dispatch`,
          now,
        )
        .run();
    }

    // BUG-2026-04-27-021 (CN reverse): re-credit wip_items.stockQty for
    // every UPH wipLabel produced by these POs. Symmetric inverse of the
    // dispatch decrement above — gated on PARTIALLY_SOLD → ACTIVE so a
    // CN that never reached PARTIALLY_SOLD never enters this branch.
    if (stampedPoIds.length > 0) {
      const ph = stampedPoIds.map(() => "?").join(",");
      const reverseRes = await db
        .prepare(
          `SELECT productionOrderId, wipLabel, wipQty FROM job_cards
             WHERE productionOrderId IN (${ph})
               AND departmentCode = 'UPHOLSTERY'
               AND wipLabel IS NOT NULL
               AND wipLabel != ''`,
        )
        .bind(...stampedPoIds)
        .all<{
          productionOrderId: string;
          wipLabel: string;
          wipQty: number | null;
        }>();
      const reverseRows = reverseRes.results ?? [];
      const poQtyByIdRes = await db
        .prepare(
          `SELECT id, quantity FROM production_orders WHERE id IN (${ph})`,
        )
        .bind(...stampedPoIds)
        .all<{ id: string; quantity: number | null }>();
      const poQtyById = new Map(
        (poQtyByIdRes.results ?? []).map((r) => [r.id, r.quantity]),
      );
      for (const u of reverseRows) {
        const inc =
          Number(u.wipQty) ||
          Number(poQtyById.get(u.productionOrderId)) ||
          0;
        if (inc === 0) continue;
        await db
          .prepare(
            `UPDATE wip_items SET stockQty = stockQty + ? WHERE code = ?`,
          )
          .bind(inc, u.wipLabel)
          .run();
      }
    }
  }

  // Items replace — if the caller sent items[], do a delete-and-reinsert
  // so add/remove/qty edits from the FE inline edit-mode persist. Mirrors
  // the simplest pattern used by DO's items refresh on PUT. Guarded to
  // ACTIVE status only — once a CN crosses into PARTIALLY_SOLD/RETURNED/
  // FULLY_SOLD the items table carries soldDate/returnedDate state per
  // line that we must NOT silently wipe. Edit-mode is FE-gated to PENDING
  // (=ACTIVE) so this guard normally won't fire, but it's a hard backstop
  // against a future status drift bug.
  if (Array.isArray(body.items) && existing.status === "ACTIVE" && nextStatus === "ACTIVE") {
    type ItemPayload = {
      id?: string;
      productionOrderId?: string | null;
      productCode?: string;
      productName?: string;
      productId?: string | null;
      quantity?: number;
      unitPrice?: number;
    };
    const incoming = body.items as ItemPayload[];
    await db
      .prepare("DELETE FROM consignment_items WHERE consignmentNoteId = ?")
      .bind(id)
      .run();
    for (const it of incoming) {
      await db
        .prepare(
          `INSERT INTO consignment_items (
             id, consignmentNoteId, productId, productName, productCode,
             quantity, unitPrice, status, soldDate, returnedDate,
             productionOrderId
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          // Reuse incoming id when it looks like one we minted (coni-*),
          // otherwise generate fresh — keeps stable ids for unchanged rows
          // so a subsequent re-edit doesn't churn coni-* keys.
          typeof it.id === "string" && it.id.startsWith("coni-")
            ? it.id
            : genItemId(),
          id,
          it.productId ?? null,
          it.productName ?? "",
          it.productCode ?? "",
          typeof it.quantity === "number" ? it.quantity : 0,
          typeof it.unitPrice === "number" ? it.unitPrice : 0,
          "AT_BRANCH",
          null,
          null,
          it.productionOrderId ?? null,
        )
        .run();
    }
  }

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

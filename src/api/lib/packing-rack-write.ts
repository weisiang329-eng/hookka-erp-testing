// ---------------------------------------------------------------------------
// packing-rack-write.ts — THE single source of truth for setting/clearing the
// warehouse rack number on a PACKING job card.
//
// Both the worker portal (POST /api/worker/packing-rack) and the PUBLIC
// packing-sticker scan (POST /api/public/rack-write/:token/rack) call this so
// the two paths can NEVER drift. Mirrors the office dashboard rack dropdown
// (PATCH /api/production-orders/:id { jobCardId, rackingNumber }) exactly:
//
//   • the card must exist (NOT_FOUND) and be a PACKING card (NOT_PACKING) —
//     "Rack number applies to Packing cards only.";
//   • the rack value is validated against the warehouse catalog
//     (rack_locations.rack) — REJECT, don't normalize (UNKNOWN_RACK);
//   • an empty string CLEARS the rack;
//   • on success: UPDATE job_cards.rackingNumber, then mirror onto the PO
//     (production_orders.rackingNumber + updated_at) so the Packing sheet,
//     packing list, and DO read the new rack.
//
// rackingNumber is the EXISTING camelCase column (established rename-map / dual-
// key history) — it is mirrored onto production_orders.rackingNumber, same as
// the office path. No NEW column here.
// ---------------------------------------------------------------------------

export type PackingRackWriteResult =
  | { ok: true; jobCardId: string; rackingNumber: string }
  | {
      ok: false;
      code: "BAD_INPUT" | "NOT_FOUND" | "NOT_PACKING" | "UNKNOWN_RACK";
      error: string;
    };

// Validate + write the rack number for ONE PACKING job card. The caller has
// already established trust (worker token, or an unguessable per-card qr_token)
// and resolved the jobCardId; this helper owns the validation + the writes so
// neither path can skip a guard. `rackingNumber` may be "" to clear.
export async function applyPackingRack(
  db: D1Database,
  jobCardId: string | null | undefined,
  rackingNumber: string | null | undefined,
): Promise<PackingRackWriteResult> {
  if (!jobCardId || rackingNumber == null) {
    return {
      ok: false,
      code: "BAD_INPUT",
      error: "jobCardId and rackingNumber are required",
    };
  }
  const jc = await db
    .prepare(
      "SELECT id, productionOrderId, departmentCode FROM job_cards WHERE id = ?",
    )
    .bind(jobCardId)
    .first<{
      id: string;
      productionOrderId: string;
      departmentCode: string | null;
    }>();
  if (!jc) {
    return { ok: false, code: "NOT_FOUND", error: "Job card not found" };
  }
  if ((jc.departmentCode || "").toUpperCase() !== "PACKING") {
    return {
      ok: false,
      code: "NOT_PACKING",
      error: "Rack number applies to Packing cards only.",
    };
  }
  const rack = String(rackingNumber).trim();
  // Reject anything not in the warehouse rack catalog (the dashboard dropdown
  // constrains this; the endpoints must too). Empty string clears the rack.
  if (rack) {
    const slot = await db
      .prepare("SELECT rack FROM rack_locations WHERE rack = ? LIMIT 1")
      .bind(rack)
      .first<{ rack: string }>();
    if (!slot) {
      return {
        ok: false,
        code: "UNKNOWN_RACK",
        error: `Rack "${rack}" is not a known warehouse location.`,
      };
    }
  }
  const nowIso = new Date().toISOString();
  await db
    .prepare("UPDATE job_cards SET rackingNumber = ? WHERE id = ?")
    .bind(rack || null, jobCardId)
    .run();
  await db
    .prepare(
      "UPDATE production_orders SET rackingNumber = ?, updated_at = ? WHERE id = ?",
    )
    .bind(rack || null, nowIso, jc.productionOrderId)
    .run();
  return { ok: true, jobCardId, rackingNumber: rack };
}

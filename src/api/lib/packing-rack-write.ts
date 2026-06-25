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
  let jc = await db
    .prepare(
      "SELECT id, productionOrderId, departmentCode FROM job_cards WHERE id = ?",
    )
    .bind(jobCardId)
    .first<{
      id: string;
      productionOrderId: string;
      departmentCode: string | null;
    }>();
  // FIX 1 — archive fallback for the guard lookup. An archived card (PO
  // completed → moved to job_cards_archive) is absent from the hot table, so the
  // hot SELECT misses and we'd 404 before the validated write. Look it up in the
  // archive so the PACKING / UNKNOWN_RACK guards still apply and the rack can
  // still be set. Best-effort (the archive table always exists in prod; tolerate
  // its absence in any stripped environment).
  if (!jc) {
    try {
      jc = await db
        .prepare(
          "SELECT id, productionOrderId, departmentCode FROM job_cards_archive WHERE id = ?",
        )
        .bind(jobCardId)
        .first<{
          id: string;
          productionOrderId: string;
          departmentCode: string | null;
        }>();
    } catch (e) {
      console.warn("[applyPackingRack] archive lookup skipped", e);
    }
  }
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
  const jcUpd = await db
    .prepare("UPDATE job_cards SET rackingNumber = ? WHERE id = ?")
    .bind(rack || null, jobCardId)
    .run();
  // FIX 1 — archive fallback. The card may have been moved to job_cards_archive
  // (its PO completed + archived) since the sticker was printed; the hot UPDATE
  // above then matches 0 rows. Mirror the write onto the archive sibling so an
  // archived card's rack can still be set/cleared. `rackingNumber` is the same
  // alias the hot write uses — the supabase-compat rewriter maps it to the real
  // stored column (`racking_number`) on the archive too (created via CREATE
  // TABLE … AS SELECT * from job_cards, so it carries that column). Best-effort:
  // wrapped so a missing/locked archive never breaks the hot path.
  const jcChanges =
    (jcUpd as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (jcChanges === 0) {
    try {
      await db
        .prepare("UPDATE job_cards_archive SET rackingNumber = ? WHERE id = ?")
        .bind(rack || null, jobCardId)
        .run();
    } catch (e) {
      console.warn("[applyPackingRack] archive rack write skipped", e);
    }
  }
  // Mirror onto the PO header (hot first; archive fallback when the PO was
  // archived too) so the Packing sheet / packing list / DO read the new rack.
  const poUpd = await db
    .prepare(
      "UPDATE production_orders SET rackingNumber = ?, updated_at = ? WHERE id = ?",
    )
    .bind(rack || null, nowIso, jc.productionOrderId)
    .run();
  const poChanges =
    (poUpd as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (poChanges === 0) {
    try {
      await db
        .prepare(
          "UPDATE production_orders_archive SET rackingNumber = ?, updated_at = ? WHERE id = ?",
        )
        .bind(rack || null, nowIso, jc.productionOrderId)
        .run();
    } catch (e) {
      console.warn("[applyPackingRack] archive PO rack write skipped", e);
    }
  }
  return { ok: true, jobCardId, rackingNumber: rack };
}

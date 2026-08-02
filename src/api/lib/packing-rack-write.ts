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

import { packingPieceIdentity } from "./packing-piece-identity";

// Runtime self-apply for the per-PIECE rack column (mig 0192). A migration file
// is INERT on prod (deploys do NOT replay migrations-postgres/*.sql) — the
// column reaches prod via this ADD COLUMN IF NOT EXISTS. ensurePiecePicsForJc
// (production-orders.ts) also self-applies it; this is the safety net for the
// public/worker rack-write path, which may not have gone through that helper.
// Memoised so the DDL runs at most once per worker isolate.
let piecePicsRackingColumnEnsured = false;
// Exported so the /r/ rack-scan stock-in (public-rack-qr.ts) self-applies the
// SAME per-piece rack column via this ONE memoised DDL — no second copy to drift.
export async function ensurePiecePicsRackingColumn(db: D1Database): Promise<void> {
  if (piecePicsRackingColumnEnsured) return;

  try {
    await db
      .prepare(
        "ALTER TABLE piece_pics ADD COLUMN IF NOT EXISTS racking_number TEXT",
      )
      .run();
  } catch {
    // ignore — column may already exist or DDL transiently rejected
  }
  piecePicsRackingColumnEnsured = true;
}

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
//
// `pieceNo` (optional, mig 0192) targets ONE physical piece of a multi-piece WIP:
// a DIVAN of 2 pieces can put piece 1 on Rack A and piece 2 on Rack B. When a
// pieceNo is supplied AND the WIP has more than one piece, the rack is written
// to that piece's piece_pics.racking_number row (NOT the card-level
// job_cards.rackingNumber) and the warehouse occupancy mirror keys a rack_items
// row PER PIECE (piece-distinct identity). When pieceNo is omitted / 0, or the
// WIP is genuinely a single piece, behavior is EXACTLY the legacy card-level
// path — old single-piece stickers and the office dropdown are unaffected.
export async function applyPackingRack(
  db: D1Database,
  jobCardId: string | null | undefined,
  rackingNumber: string | null | undefined,
  pieceNo?: number | null,
): Promise<PackingRackWriteResult> {
  if (!jobCardId || rackingNumber == null) {
    return {
      ok: false,
      code: "BAD_INPUT",
      error: "jobCardId and rackingNumber are required",
    };
  }
  // Widened lookup (JOIN the PO) so the occupancy mirror below can build the
  // SAME piece identity the /r/ rack-scan uses (description + SO). The occupancy
  // fields are optional so the archive fallback's 3-column shape still assigns.
  let jc = await db
    .prepare(
      `SELECT jc.id AS id, jc.productionOrderId AS productionOrderId,
              jc.departmentCode AS departmentCode, jc.wipLabel AS wipLabel,
              po.productName AS productName, po.productCode AS productCode,
              po.sizeLabel AS sizeLabel, po.salesOrderNo AS salesOrderNo,
              po.poNo AS poNo
         FROM job_cards jc
         LEFT JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE jc.id = ?`,
    )
    .bind(jobCardId)
    .first<{
      id: string;
      productionOrderId: string;
      departmentCode: string | null;
      wipLabel?: string | null;
      productName?: string | null;
      productCode?: string | null;
      sizeLabel?: string | null;
      salesOrderNo?: string | null;
      poNo?: string | null;
    }>();
  // Only the hot JOIN carries the PO fields needed for the occupancy mirror;
  // an archived card (fallback below) skips occupancy (a completed/archived PO
  // is past packing).
  const fromHotJoin = !!jc;
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

  // ---- Per-PIECE mode resolution (mig 0192) -------------------------------
  // A pieceNo only "wins" when the WIP genuinely has more than one physical
  // piece (a single-piece card is always card-level — keeps the legacy path).
  // We count piece_pics rows for this card; a 1-row / 0-row / unreadable count
  // falls back to card-level (back-compat, never throws the write).
  let totalPieces = 1;
  let perPiece = false;
  const wantPiece = pieceNo != null && pieceNo > 0;
  if (wantPiece && fromHotJoin) {
    try {
      const cnt = await db
        .prepare("SELECT COUNT(*) AS n FROM piece_pics WHERE jobCardId = ?")
        .bind(jobCardId)
        .first<{ n: number }>();
      totalPieces = Math.max(1, Number(cnt?.n ?? 0));
      // Confirm the targeted piece row exists before committing to per-piece.
      if (totalPieces > 1) {
        const pieceRow = await db
          .prepare(
            "SELECT id FROM piece_pics WHERE jobCardId = ? AND pieceNo = ? LIMIT 1",
          )
          .bind(jobCardId, pieceNo)
          .first<{ id: number }>();
        perPiece = !!pieceRow;
      }
    } catch (e) {
      console.warn("[applyPackingRack] piece-count lookup skipped", e);
      perPiece = false;
    }
  }

  if (perPiece) {
    // PER-PIECE write — set/clear THIS piece's rack on piece_pics; the card-level
    // job_cards.rackingNumber + PO mirror are deliberately left untouched so a
    // sibling piece's rack (and the card-level legacy value) are not clobbered.
    await ensurePiecePicsRackingColumn(db);
    await db
      .prepare(
        "UPDATE piece_pics SET racking_number = ? WHERE jobCardId = ? AND pieceNo = ?",
      )
      .bind(rack || null, jobCardId, pieceNo)
      .run();
    // Warehouse occupancy mirror — piece-distinct identity (notes carry the
    // piece marker) so two pieces of one WIP get two DISTINCT rack_items rows.
    if (jc) {
      try {
        const { description, notes } = packingPieceIdentity({
          ...jc,
          pieceNo,
          totalPieces,
        });
        const curRow = await db
          .prepare(
            `SELECT id, rackLocationId FROM rack_items
              WHERE productName = ? AND notes = ? ORDER BY id DESC LIMIT 1`,
          )
          .bind(description, notes)
          .first<{ id: number; rackLocationId: string }>();
        const stmts: D1PreparedStatement[] = [];
        const affected = new Set<string>();
        if (!rack) {
          if (curRow) {
            stmts.push(
              db.prepare("DELETE FROM rack_items WHERE id = ?").bind(curRow.id),
            );
            affected.add(curRow.rackLocationId);
          }
        } else {
          const loc = await db
            .prepare(
              "SELECT id FROM rack_locations WHERE rack = ? ORDER BY position LIMIT 1",
            )
            .bind(rack)
            .first<{ id: string }>();
          if (loc && !(curRow && curRow.rackLocationId === loc.id)) {
            if (curRow) {
              stmts.push(
                db
                  .prepare("DELETE FROM rack_items WHERE id = ?")
                  .bind(curRow.id),
              );
              affected.add(curRow.rackLocationId);
            }
            const today = new Date().toISOString().split("T")[0];
            stmts.push(
              db
                .prepare(
                  `INSERT INTO rack_items (rackLocationId, productionOrderId,
                     productCode, productName, sizeLabel, customerName, qty,
                     stockedInDate, notes)
                   VALUES (?, ?, '', ?, '', '', 1, ?, ?)`,
                )
                .bind(loc.id, jc.productionOrderId, description, today, notes),
            );
            affected.add(loc.id);
          }
        }
        for (const rid of affected) {
          stmts.push(
            db
              .prepare(
                `UPDATE rack_locations SET status = CASE
                   WHEN reserved = 1 THEN 'RESERVED'
                   WHEN (EXISTS(SELECT 1 FROM rack_items WHERE rackLocationId = ?)
                         OR productCode IS NOT NULL) THEN 'OCCUPIED'
                   ELSE 'EMPTY' END
                 WHERE id = ?`,
              )
              .bind(rid, rid),
          );
        }
        if (stmts.length > 0) await db.batch(stmts);
      } catch (e) {
        console.warn("[applyPackingRack] per-piece occupancy mirror skipped", e);
      }
    }
    return { ok: true, jobCardId, rackingNumber: rack };
  }

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

  // ---- Warehouse occupancy mirror (best-effort) ---------------------------
  // Before this, assigning a rack only wrote the TEXT label (above) — the
  // Warehouse grid reads rack_items, so a packed piece never showed under its
  // rack (owner 2026-06-25: set Rack 9 → not in Warehouse). Mirror ONE
  // rack_items row per piece, EXACTLY like the /r/ rack-scan stock-in
  // (public-rack-qr.ts): identity = productName(=description) + notes(=SO …),
  // the SAME key currentRackOfPiece matches, so the office dropdown, the /p/
  // piece scan, and the rack scan all converge on ONE row (no duplicates).
  // SET inserts, re-assign MOVES (old row removed), "" CLEARS; status recomputes
  // on both racks via the DO-dispatch CASE. Hot-card only (archived = past
  // packing); wrapped so an occupancy hiccup never blocks the text write above.
  if (fromHotJoin && jc) {
    try {
      // ONE shared formula with the /r/ rack-scan resolve (public-rack-qr.ts)
      // so the office dropdown, /p/ scan, and rack scan converge on one row.
      const { description, notes } = packingPieceIdentity(jc);
      // The piece's current rack_items row, by the shared identity.
      const curRow = await db
        .prepare(
          `SELECT id, rackLocationId FROM rack_items
            WHERE productName = ? AND notes = ? ORDER BY id DESC LIMIT 1`,
        )
        .bind(description, notes)
        .first<{ id: number; rackLocationId: string }>();
      const stmts: D1PreparedStatement[] = [];
      const affected = new Set<string>();
      if (!rack) {
        // CLEAR — remove the piece from the warehouse.
        if (curRow) {
          stmts.push(
            db.prepare("DELETE FROM rack_items WHERE id = ?").bind(curRow.id),
          );
          affected.add(curRow.rackLocationId);
        }
      } else {
        // Resolve the rack LABEL → a rack_locations.id (deterministic slot).
        const loc = await db
          .prepare(
            "SELECT id FROM rack_locations WHERE rack = ? ORDER BY position LIMIT 1",
          )
          .bind(rack)
          .first<{ id: string }>();
        // Idempotent: already in this rack → leave it. Otherwise MOVE/SET.
        if (loc && !(curRow && curRow.rackLocationId === loc.id)) {
          if (curRow) {
            stmts.push(
              db.prepare("DELETE FROM rack_items WHERE id = ?").bind(curRow.id),
            );
            affected.add(curRow.rackLocationId);
          }
          const today = new Date().toISOString().split("T")[0];
          stmts.push(
            db
              .prepare(
                `INSERT INTO rack_items (rackLocationId, productionOrderId,
                   productCode, productName, sizeLabel, customerName, qty,
                   stockedInDate, notes)
                 VALUES (?, ?, '', ?, '', '', 1, ?, ?)`,
              )
              .bind(loc.id, jc.productionOrderId, description, today, notes),
          );
          affected.add(loc.id);
        }
      }
      // Recompute each affected rack's status (mirror the DO-dispatch CASE so
      // an emptied rack flips EMPTY/RESERVED and the new rack flips OCCUPIED).
      for (const rid of affected) {
        stmts.push(
          db
            .prepare(
              `UPDATE rack_locations SET status = CASE
                 WHEN reserved = 1 THEN 'RESERVED'
                 WHEN (EXISTS(SELECT 1 FROM rack_items WHERE rackLocationId = ?)
                       OR productCode IS NOT NULL) THEN 'OCCUPIED'
                 ELSE 'EMPTY' END
               WHERE id = ?`,
            )
            .bind(rid, rid),
        );
      }
      if (stmts.length > 0) await db.batch(stmts);
    } catch (e) {
      console.warn("[applyPackingRack] occupancy mirror skipped", e);
    }
  }

  return { ok: true, jobCardId, rackingNumber: rack };
}

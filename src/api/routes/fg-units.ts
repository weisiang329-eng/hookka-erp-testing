// ---------------------------------------------------------------------------
// D1-backed FG Unit tracking route.
//
// Mirrors src/api/routes/fg-units.ts shape. One FGUnit = one physical box
// (specific piece of a specific unit in a production order). Stickers print
// per FGUnit. This route handles listing, generating (per PO — idempotent)
// and status transitions driven by QR scans (PACK, LOAD, DELIVER, RETURN).
//
// Schema-note: The `fg_units` table exposes most FGUnit fields natively.
// `pieces` metadata comes from the related Product row (JSON column). We
// use the same unitSerial / shortCode format as the in-memory helper so
// existing stickers keep scanning correctly.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  actorFromUserId,
  buildFgStockEventStatements,
  docForScannedUnit,
  ensureFgStockEventsSchema,
  isOnHandStatus,
  SYSTEM_ACTOR,
} from "../lib/fg-stock-events";
import { reconcileFgStock } from "../lib/fg-ledger-reconcile";

const app = new Hono<Env>();

type FGUnitRow = {
  id: string;
  unitSerial: string;
  shortCode: string | null;
  soId: string | null;
  soNo: string | null;
  soLineNo: number | null;
  poId: string | null;
  poNo: string | null;
  productCode: string | null;
  productName: string | null;
  unitNo: number | null;
  totalUnits: number | null;
  pieceNo: number | null;
  totalPieces: number | null;
  pieceName: string | null;
  customerName: string | null;
  customerHub: string | null;
  mfdDate: string | null;
  status: string;
  packerId: string | null;
  packerName: string | null;
  packedAt: string | null;
  loadedAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  batchId: string | null;
  sourcePieceIndex: number | null;
  sourceSlotIndex: number | null;
  upholsteredBy: string | null;
  upholsteredByName: string | null;
  upholsteredAt: string | null;
  doId: string | null;
};

type ProductionOrderRow = {
  id: string;
  poNo: string;
  salesOrderId: string | null;
  salesOrderNo: string | null;
  // CO-origin POs leave SO ids NULL and carry these instead. unitSerial
  // and customerHub resolution fall back to CO when SO is empty.
  consignmentOrderId: string | null;
  consignmentOrderNo?: string | null;
  companySOId: string | null;
  companyCOId: string | null;
  lineNo: number;
  customerName: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  quantity: number;
  // specialOrder mirrors the SO/CO line — drives the HB-only piece override
  // (parsePieces below). Stored on production_orders by the production
  // builder so the fg_units pipeline doesn't need to re-resolve back to SO.
  specialOrder: string | null;
  startDate: string | null;
  completedDate: string | null;
};

type ProductRow = {
  id: string;
  code: string;
  pieces: string | null;
  category: string | null;
  sizeCode: string | null;
};

type WorkerRow = {
  id: string;
  name: string;
};

type SalesOrderMini = {
  id: string;
  customerId: string;
};

type DeliveryHubMini = {
  shortName: string | null;
};

function rowToFGUnit(r: FGUnitRow) {
  // Build the object with optional fields only when set — matches the
  // in-memory FGUnit shape (undefined vs empty string).
  const out: Record<string, unknown> = {
    id: r.id,
    unitSerial: r.unitSerial,
    shortCode: r.shortCode ?? "",
    soId: r.soId ?? "",
    soNo: r.soNo ?? "",
    soLineNo: r.soLineNo ?? 0,
    poId: r.poId ?? "",
    poNo: r.poNo ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    unitNo: r.unitNo ?? 1,
    totalUnits: r.totalUnits ?? 1,
    pieceNo: r.pieceNo ?? 1,
    totalPieces: r.totalPieces ?? 1,
    pieceName: r.pieceName ?? "",
    customerName: r.customerName ?? "",
    mfdDate: r.mfdDate,
    status: r.status,
  };
  // Prefer the live-resolved hub (the list query JOINs the order and supplies
  // it); fall back to the value stored on the unit for the other read paths
  // that don't resolve it.
  const liveHub = (r as { resolvedHub?: string | null }).resolvedHub;
  if (liveHub || r.customerHub) out.customerHub = liveHub || r.customerHub;
  if (r.packerId) out.packerId = r.packerId;
  if (r.packerName) out.packerName = r.packerName;
  if (r.packedAt) out.packedAt = r.packedAt;
  if (r.loadedAt) out.loadedAt = r.loadedAt;
  if (r.deliveredAt) out.deliveredAt = r.deliveredAt;
  if (r.returnedAt) out.returnedAt = r.returnedAt;
  if (r.batchId) out.batchId = r.batchId;
  if (r.sourcePieceIndex !== null) out.sourcePieceIndex = r.sourcePieceIndex;
  if (r.sourceSlotIndex !== null) out.sourceSlotIndex = r.sourceSlotIndex;
  if (r.upholsteredBy) out.upholsteredBy = r.upholsteredBy;
  if (r.upholsteredByName) out.upholsteredByName = r.upholsteredByName;
  if (r.upholsteredAt) out.upholsteredAt = r.upholsteredAt;
  if (r.doId) out.doId = r.doId;
  return out;
}

// Public-safe shape for the QR /track page. Strips customer name/hub,
// packer/upholsterer identity, and any field that could be used to harvest
// PII by enumerating unit IDs. Keeps just the operational facts that a
// customer scanning their own sticker needs to see: identity, product,
// status, and the date stamps that show progress through the pipeline.
function rowToFGUnitPublic(r: FGUnitRow) {
  const out: Record<string, unknown> = {
    id: r.id,
    unitSerial: r.unitSerial,
    shortCode: r.shortCode ?? "",
    soNo: r.soNo ?? "",
    soLineNo: r.soLineNo ?? 0,
    poNo: r.poNo ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    unitNo: r.unitNo ?? 1,
    totalUnits: r.totalUnits ?? 1,
    pieceNo: r.pieceNo ?? 1,
    totalPieces: r.totalPieces ?? 1,
    pieceName: r.pieceName ?? "",
    mfdDate: r.mfdDate,
    status: r.status,
  };
  // Date stamps are operational, not PII — they show the customer where the
  // unit is in the pipeline. Worker IDs/names that did the work are PII.
  if (r.packedAt) out.packedAt = r.packedAt;
  if (r.loadedAt) out.loadedAt = r.loadedAt;
  if (r.deliveredAt) out.deliveredAt = r.deliveredAt;
  if (r.upholsteredAt) out.upholsteredAt = r.upholsteredAt;
  return out;
}

// Deterministic id per (poId, unitNo, pieceNo). Previously this appended a
// random `crypto.randomUUID().slice(0,8)` suffix, so the same physical box
// got a DIFFERENT id every time generateFGUnitsForPO ran. Combined with the
// read-then-insert idempotency check (no DB-level uniqueness), a repeat or
// concurrent generate inserted a SECOND full set of stickers for the same
// slot — the source of the duplicate-sticker inflation (14 POs / 150 phantom
// rows, audit 2026-06-02). With a deterministic id the primary key now
// rejects the second insert (paired with ON CONFLICT (id) DO NOTHING on the
// INSERT below), so a box can never be stickered twice.
function genFGUnitId(poId: string, unitNo: number, pieceNo: number): string {
  return `fgu-${poId}-${unitNo}-${pieceNo}`;
}

/**
 * Detect "Headboard Only" special-order flag.
 *
 * Customer ordered just the headboard, no divans. Substring match on the
 * lowercased specialOrder text — matches "Headboard Only", "★ Headboard
 * Only", "OTHER: Headboard Only x", and any other future variant that
 * contains the canonical phrase. Centralised here so SO confirm,
 * production-builder, and the cleanup importer all use the same rule.
 */
export function isHeadboardOnlySpecial(
  specialOrder: string | null | undefined,
): boolean {
  if (!specialOrder) return false;
  return specialOrder.toLowerCase().includes("headboard only");
}

/**
 * Default piece configuration for bedframes when product.pieces JSON is
 * empty. Wei Siang's spec:
 *   Full bedframe (HB + Divan):
 *     K, Q   → 3 packs (1 Headboard + 2 Divan halves)
 *     S, SS  → 2 packs (1 Headboard + 1 Divan)
 *   Divan-only (productCode starts with "DIVAN"):
 *     K, Q   → 2 packs (2 Divan halves, no HB)
 *     S, SS  → 1 pack (1 Divan, no HB)
 *
 * Headboard-only (specialOrder "Headboard Only") is handled by the caller
 * at parsePieces() level — it short-circuits to {count:1, names:["Headboard"]}
 * before reaching this function. Don't add the flag here.
 *
 * sizeCode normalisation: case-insensitive; trims whitespace; ignores
 * variants like "K-S" (king with storage) → still K family.
 */
function bedframeSizeDefault(
  sizeCode: string | null,
  isDivanOnly: boolean,
): { count: number; names: string[] } | null {
  if (!sizeCode) return null;
  const norm = sizeCode.trim().toUpperCase();
  // Strip storage / option suffixes (e.g. "K-S", "Q (HF)") — first word wins
  const base = norm.split(/[\s\-_(]/)[0];
  const twoDivan = isDivanOnly
    ? { count: 2, names: ["Divan", "Divan"] }
    : { count: 3, names: ["Headboard", "Divan", "Divan"] };
  const oneDivan = isDivanOnly
    ? { count: 1, names: ["Divan"] }
    : { count: 2, names: ["Headboard", "Divan"] };
  // King / Queen / Super-King → 2 divan bases.
  if (base === "K" || base === "Q" || base === "SK") return twoDivan;
  // Single / Super-single → 1 divan base.
  if (base === "S" || base === "SS") return oneDivan;
  // Dimension-coded sizes (e.g. "152X200", "200X200") that aren't K/Q/S/SS:
  // decide by WIDTH (the first number) — >=150cm → 2 divan bases, narrower → 1.
  // Owner ruling 2026-06-22; stops the 1007/2008/2009 dimension SKUs falling
  // through to a single "Full Product" piece (BUG-2026-06-22-008).
  const dim = norm.match(/^(\d+)\s*X/);
  if (dim) {
    const width = parseInt(dim[1], 10);
    if (width >= 150) return twoDivan;
    if (width > 0) return oneDivan;
  }
  return null;
}

function parsePieces(
  raw: string | null,
  product?: { category?: string | null; sizeCode?: string | null; code?: string | null } | null,
  specialOrder?: string | null,
): { count: number; names: string[] } {
  const isHeadboardOnly = isHeadboardOnlySpecial(specialOrder);

  // HB-only override: ignore catalog pieces JSON entirely and ship 1 HB piece.
  // The catalog's pieces config (e.g. {count: 3, ...}) is the SKU's default,
  // but specialOrder is per-line and "Headboard Only" means the customer is
  // ordering just the HB regardless of what the full-BF SKU's pieces config
  // says. Mutually exclusive with divan-only — a DIVAN-* SKU can't also be
  // HB-only; throw so the caller surfaces the bad data.
  if (isHeadboardOnly) {
    if (product?.category === "BEDFRAME") {
      const code = (product.code ?? "").toUpperCase();
      const isDivanOnly = code.startsWith("DIVAN");
      if (isDivanOnly) {
        throw new Error(
          `parsePieces: contradictory flags — productCode "${product.code}" is divan-only but specialOrder requests Headboard Only`,
        );
      }
    }
    return { count: 1, names: ["Headboard"] };
  }

  // Operator-set pieces config wins. Empty → category-aware fallback.
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { count?: number; names?: string[] };
      if (parsed?.count && parsed.count > 0) {
        return {
          count: parsed.count,
          names: Array.isArray(parsed.names) ? parsed.names : ["Full Product"],
        };
      }
    } catch {
      // fall through
    }
  }
  // BEDFRAME size-based default — covers 99% of bedframe SKUs without
  // requiring per-SKU pieces JSON config in the catalog.
  if (product?.category === "BEDFRAME") {
    const code = (product.code ?? "").toUpperCase();
    const isDivanOnly = code.startsWith("DIVAN");
    const def = bedframeSizeDefault(product.sizeCode ?? null, isDivanOnly);
    if (def) return def;
  }
  return { count: 1, names: ["Full Product"] };
}

// ---------------------------------------------------------------------------
// generateFGUnitsForPO — pure helper, used by both the HTTP route below and
// the internal PO-completion cascade in production-orders.ts.
//
// Idempotent: if any fg_units already exist for the given poId, returns them
// untouched with `generated: false`. Otherwise creates one FGUnit per
// (unit, piece) combination derived from PO quantity and product pieces
// metadata, then returns the freshly created rows with `generated: true`.
// ---------------------------------------------------------------------------
export async function generateFGUnitsForPO(
  db: D1Database,
  poId: string,
): Promise<{
  status: "not-found" | "ok";
  generated: boolean;
  units: ReturnType<typeof rowToFGUnit>[];
  po?: ProductionOrderRow;
}> {
  const po = await db
    .prepare(
      `SELECT id, poNo, salesOrderId, salesOrderNo, companySOId,
         consignmentOrderId, companyCOId, lineNo, customerName,
         productId, productCode, productName, quantity, specialOrder,
         startDate, completedDate
       FROM production_orders WHERE id = ?`,
    )
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po) {
    return { status: "not-found", generated: false, units: [] };
  }

  // Idempotency check — return existing set untouched
  const existingRes = await db
    .prepare("SELECT * FROM fg_units WHERE poId = ? ORDER BY id ASC")
    .bind(poId)
    .all<FGUnitRow>();
  const existing = existingRes.results ?? [];
  if (existing.length > 0) {
    return {
      status: "ok",
      generated: false,
      units: existing.map(rowToFGUnit),
      po,
    };
  }

  // Resolve Product (by id, then by code) to get pieces metadata
  let product: ProductRow | null = null;
  if (po.productId) {
    product = await db
      .prepare("SELECT id, code, pieces, category, sizeCode FROM products WHERE id = ? LIMIT 1")
      .bind(po.productId)
      .first<ProductRow>();
  }
  if (!product && po.productCode) {
    product = await db
      .prepare("SELECT id, code, pieces, category, sizeCode FROM products WHERE code = ? LIMIT 1")
      .bind(po.productCode)
      .first<ProductRow>();
  }

  const pieces = parsePieces(
    product?.pieces ?? null,
    product ?? null,
    po.specialOrder ?? null,
  );
  const totalUnits = Math.max(1, po.quantity || 1);
  const totalPieces = pieces.count;

  // Pick a customer hub — best-effort, matches in-memory helper. POs from
  // a CO have salesOrderId NULL and live under consignmentOrderId; resolve
  // the customer through the CO instead so CO-origin FG units still get a
  // hub stamped.
  let hubShort: string | null = null;
  let parentCustomerId: string | null = null;
  if (po.salesOrderId) {
    const so = await db
      .prepare("SELECT id, customerId, hubName FROM sales_orders WHERE id = ?")
      .bind(po.salesOrderId)
      .first<SalesOrderMini & { hubName?: string | null }>();
    parentCustomerId = so?.customerId ?? null;
    if (so?.hubName) hubShort = so.hubName;
  } else if (po.consignmentOrderId) {
    const co = await db
      .prepare("SELECT id, customerId, hubName FROM consignment_orders WHERE id = ?")
      .bind(po.consignmentOrderId)
      .first<{ id: string; customerId: string | null; hubName?: string | null }>();
    parentCustomerId = co?.customerId ?? null;
    if (co?.hubName) hubShort = co.hubName;
  }
  // Stamp the ORDER's own hub (sales_orders.hubName / consignment_orders.hubName).
  // Fall back to the customer's DEFAULT delivery hub ONLY when the order itself
  // carries no hub. Previously this ALWAYS used the default hub, so every unit got
  // the customer's KL default regardless of where the order actually ships —
  // BUG-2026-06-05: Houzs SBH / SRW / PG stickers all printed "Houzs KL".
  if (!hubShort && parentCustomerId) {
    // Only auto-fill the customer's default hub when they have EXACTLY ONE hub.
    // A multi-hub customer (Houzs = KL/PG/SRW/SBH) must NEVER be guessed:
    // blind-defaulting stamped every unset-hub order's sticker as "Houzs KL"
    // (BUG-2026-06-05, root-caused 2026-07-19 to the SO-create blind default —
    // fixed there too). With 2+ hubs and no order hub, leave it null so the
    // sticker shows the customer NAME rather than a wrong branch.
    const hubs = await db
      .prepare(
        "SELECT shortName FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC, id ASC LIMIT 2",
      )
      .bind(parentCustomerId)
      .all<DeliveryHubMini>();
    const hubRows = hubs.results ?? [];
    if (hubRows.length === 1) hubShort = hubRows[0].shortName ?? null;
  }

  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const unitWidth = Math.max(2, String(totalUnits).length);
  const baseBatch = String(100000 + Math.floor(Math.random() * 900000));
  const mfdDate = po.completedDate || po.startDate || null;
  const newUnits: Array<{
    id: string;
    unitSerial: string;
    shortCode: string;
    unitNo: number;
    pieceNo: number;
    pieceName: string;
  }> = [];

  for (let u = 1; u <= totalUnits; u++) {
    for (let p = 1; p <= totalPieces; p++) {
      const pieceName = pieces.names[p - 1] ?? `Piece ${p}`;
      // CO-aware: empty salesOrderNo on a CO PO produced malformed
      // `-R1-U01-P1/2` serials with no parent prefix. Fall back to
      // companyCOId / companySOId so the parent doc id always anchors
      // the serial.
      const parentDocNo =
        po.salesOrderNo ||
        (po as unknown as { consignmentOrderNo?: string | null }).consignmentOrderNo ||
        po.companySOId ||
        po.companyCOId ||
        "";
      const unitSerial = `${parentDocNo}-R${po.lineNo}-U${pad(u, unitWidth)}-P${p}/${totalPieces}`;
      const unitBatch = String(Number(baseBatch) + (u - 1))
        .slice(-6)
        .padStart(6, "0");
      const shortCode = `${unitBatch}-${p}`;
      newUnits.push({
        id: genFGUnitId(po.id, u, p),
        unitSerial,
        shortCode,
        unitNo: u,
        pieceNo: p,
        pieceName,
      });
    }
  }

  // BUG-2026-04-27-008: initial status was 'PENDING', which read as "not yet
  // built / awaiting something". Misleading: generateFGUnitsForPO is invoked
  // from postProductionOrderCompletion, which only fires on the PO's PENDING
  // → COMPLETED transition (i.e. ALL job_cards including PACKING are done).
  // By the time these rows land, the unit IS upholstered AND racked — it's
  // physically in stock, sitting on the shelf, ready to be loaded onto a
  // delivery_order. The schema CHECK constraint (migrations/0001_init.sql)
  // allows: PENDING, PENDING_UPHOLSTERY, UPHOLSTERED, PACKED, LOADED,
  // DELIVERED, RETURNED — there is no IN_STOCK / READY / AVAILABLE value.
  // 'PACKED' is the closest semantic match: it means "boxed and racked,
  // awaiting LOAD onto a DO", which is exactly the post-PACKING-JC reality.
  // The downstream lifecycle (PACKED → LOADED → DELIVERED → RETURNED) stays
  // unchanged in the scan handlers below.
  //
  // STOCK LEDGER (2026-08-08). This INSERT is the moment a finished piece comes
  // INTO stock, so it is also the ledger's IN event — the row that answers
  // "which production order did this piece come in on, and when was it made".
  // Awaited here, before the batch, because the migration file is inert on
  // deploy; the event rows ride the SAME batch as the unit INSERTs so a piece
  // can never exist without its arrival, or vice versa. `onceKey` makes the
  // event id deterministic per unit for the same reason `genFGUnitId` is: a
  // replayed completion cascade must not book the same box into stock twice.
  await ensureFgStockEventsSchema(db);
  const statements = newUnits.map((unit) =>
    db
      .prepare(
        `INSERT INTO fg_units (id, unitSerial, shortCode, soId, soNo, soLineNo,
           poId, poNo, productCode, productName, unitNo, totalUnits,
           pieceNo, totalPieces, pieceName, customerName, customerHub,
           mfdDate, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PACKED')
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        unit.id,
        unit.unitSerial,
        unit.shortCode,
        po.salesOrderId ?? null,
        po.salesOrderNo ?? null,
        po.lineNo,
        po.id,
        po.poNo,
        po.productCode ?? null,
        po.productName ?? null,
        unit.unitNo,
        totalUnits,
        unit.pieceNo,
        totalPieces,
        unit.pieceName,
        po.customerName ?? null,
        hubShort,
        mfdDate,
      ),
  );
  if (statements.length > 0) {
    statements.push(
      ...buildFgStockEventStatements(
        db,
        newUnits.map((u) => ({
          id: u.id,
          status: null, // the piece did not exist before this batch
          productCode: po.productCode ?? null,
          batchId: null, // fg_batches is written by the caller, just after
        })),
        {
          toStatus: "PACKED",
          doc: { docType: "PRODUCTION_ORDER", docId: po.id, docNo: po.poNo },
          actor: SYSTEM_ACTOR,
          occurredAt: new Date().toISOString(),
          note: `Produced on ${po.poNo}`,
          onceKey: "po",
        },
      ),
    );
    await db.batch(statements);
  }

  const createdRes = await db
    .prepare("SELECT * FROM fg_units WHERE poId = ? ORDER BY id ASC")
    .bind(poId)
    .all<FGUnitRow>();
  const created = createdRes.results ?? [];
  return {
    status: "ok",
    generated: true,
    units: created.map(rowToFGUnit),
    po,
  };
}

// GET /api/fg-units?poId=&soId=&status=&serial=
app.get("/", async (c) => {
  const poId = c.req.query("poId");
  const soId = c.req.query("soId");
  const status = c.req.query("status");
  const serial = c.req.query("serial");

  // Sprint 4: org scope is the leading WHERE predicate.
  const orgId = getOrgId(c);
  const clauses: string[] = ["fg.orgId = ?"];
  const binds: unknown[] = [orgId];
  if (poId) {
    clauses.push("fg.poId = ?");
    binds.push(poId);
  }
  if (soId) {
    clauses.push("fg.soId = ?");
    binds.push(soId);
  }
  if (status) {
    clauses.push("fg.status = ?");
    binds.push(status);
  }
  if (serial) {
    clauses.push("(fg.unitSerial = ? OR fg.shortCode = ?)");
    binds.push(serial, serial);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  // Resolve the customer hub LIVE from the order, not the value stamped at
  // FG-unit creation. The stamp (generateFGUnitsForPO) used the customer's
  // DEFAULT delivery hub, so SBH/SRW/PG orders all showed "Houzs KL". Pull the
  // SO's chosen hub (or the CO's for consignment-origin units); fall back to the
  // stored value only when the order carries no hub. Makes every sticker reflect
  // the real branch AND follow Sales Order edits, no backfill. (2026-06-05)
  const sql = `SELECT fg.*, COALESCE(so.hubName, co.hubName) AS "resolvedHub"
         FROM fg_units fg
         LEFT JOIN sales_orders so ON so.id = fg.soId
         LEFT JOIN production_orders po ON po.id = fg.poId
         LEFT JOIN consignment_orders co ON co.id = po.consignmentOrderId
        ${where} ORDER BY fg.id ASC`;

  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<FGUnitRow>();
  const rows = (res.results ?? []).map(rowToFGUnit);
  return c.json({ success: true, data: rows, total: rows.length });
});

// GET /api/fg-units/ledger-reconciliation — read-only; the same three totals
// scripts/check-fg-ledger.mjs compares, exposed so the check can be run without
// a database shell. Never writes.
//
// Registered BEFORE /:id — Hono picks in insertion order and a literal path
// that lands after a param route of the same method is unreachable.
app.get("/ledger-reconciliation", async (c) => {
  const denied = await requirePermission(c, "fg-units", "read");
  if (denied) return denied;
  await ensureFgStockEventsSchema(c.var.DB);
  const result = await reconcileFgStock(c.var.DB, getOrgId(c));
  return c.json({ success: true, data: result });
});

// GET /api/fg-units/:id — single unit
// (must be registered AFTER /generate/:poId and /scan so more specific
// routes match first — Hono picks in insertion order)
//
// Public-allowlisted for QR /track page. authMiddleware does soft-auth on
// public routes: if a valid Bearer token is present, c.get('userId') is set;
// otherwise it's undefined. We use that to decide between a stripped public
// shape (no PII) and the full operational shape.
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const unit = await c.var.DB.prepare("SELECT * FROM fg_units WHERE id = ?")
    .bind(id)
    .first<FGUnitRow>();
  if (!unit) {
    return c.json({ success: false, error: "Unit not found" }, 404);
  }
  const userId = (c as unknown as { get: (k: string) => unknown }).get("userId");
  if (!userId) {
    return c.json({ success: true, data: rowToFGUnitPublic(unit) });
  }
  return c.json({ success: true, data: rowToFGUnit(unit) });
});

// ---------------------------------------------------------------------------
// POST /api/fg-units/backfill-dedupe-fg-units — one-shot cleanup (2026-06-02)
//
// Removes the historical DUPLICATE fg_units rows. Root cause (now fixed for
// new units by the deterministic id + ON CONFLICT above): the same physical
// box (poId, unitNo, pieceNo slot) ended up with >1 fg_unit row — each with
// a different random id + shortCode — so the PACKING sticker preview printed
// 2+ boxes where there is one. Audit found 14 POs / 150 phantom rows.
//
// Owner rule (Wei Siang 2026-06-02): ALREADY-SHIPPED units are left alone —
// status LOADED/DELIVERED/RETURNED, or attached to a delivery order (doId set).
// Those are out the door; the extra sticker is harmless and we must NOT
// disturb delivery records. So the cleanup only collapses NOT-yet-shipped
// duplicates, always keeping one row per slot:
//   - slot has a shipped row  → keep the shipped one(s) as-is, delete every
//                               not-shipped duplicate in that slot
//   - slot all not-shipped    → keep the lowest-id row, delete the rest
// Never deletes a shipped row, so delivery_orders.fgUnitIds is never touched.
//
//   ?dry=1 → preview only, no writes. Idempotent (re-run after clean → 0).
// Registered BEFORE /generate/:poId (static-before-param). Temporary; delete
// once the book is clean.
// ---------------------------------------------------------------------------
app.post("/backfill-dedupe-fg-units", async (c) => {
  const denied = await requirePermission(c, "fg-units", "update");
  if (denied) return denied;

  const orgId = getOrgId(c);
  const dry = c.req.query("dry") === "1" || c.req.query("dry") === "true";

  const res = await c.var.DB.prepare(
    `SELECT id, poId, poNo, unitNo, pieceNo, status, doId
       FROM fg_units WHERE orgId = ?`,
  )
    .bind(orgId)
    .all<{
      id: string;
      poId: string | null;
      poNo: string | null;
      unitNo: number | null;
      pieceNo: number | null;
      status: string | null;
      doId: string | null;
    }>();
  const rows = res.results ?? [];

  const SHIPPED = new Set(["LOADED", "DELIVERED", "RETURNED"]);
  const isShipped = (r: { status: string | null; doId: string | null }) =>
    (r.status != null && SHIPPED.has(r.status)) || !!r.doId;

  // Group by physical-box slot.
  const slots = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.poId}|${r.unitNo}|${r.pieceNo}`;
    const list = slots.get(k) ?? [];
    list.push(r);
    slots.set(k, list);
  }

  const deleteIds: string[] = [];
  const perPo = new Map<string, { poNo: string; removed: number }>();
  let slotsCleaned = 0;
  let shippedRowsLeftAlone = 0;

  for (const [, list] of slots) {
    if (list.length <= 1) continue; // no duplicate in this slot
    const shipped = list.filter(isShipped);
    const notShipped = list.filter((r) => !isShipped(r));
    let toDelete: typeof rows;
    if (shipped.length > 0) {
      // Keep every shipped row untouched; drop the not-shipped phantoms.
      toDelete = notShipped;
      shippedRowsLeftAlone += shipped.length - 1; // extra shipped dups we deliberately keep
    } else {
      // All not-shipped — keep the lowest id, delete the others.
      const ordered = [...notShipped].sort((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      );
      toDelete = ordered.slice(1);
    }
    if (toDelete.length === 0) continue;
    slotsCleaned++;
    for (const r of toDelete) {
      deleteIds.push(r.id);
      const po = r.poId ?? "";
      const e = perPo.get(po) ?? { poNo: r.poNo ?? po, removed: 0 };
      e.removed++;
      perPo.set(po, e);
    }
  }

  if (!dry && deleteIds.length > 0) {
    for (let i = 0; i < deleteIds.length; i += 100) {
      const chunk = deleteIds.slice(i, i + 100);
      const ph = chunk.map(() => "?").join(",");
      await c.var.DB.prepare(
        `DELETE FROM fg_units WHERE id IN (${ph})`,
      )
        .bind(...chunk)
        .run();
    }
  }

  const perPoList = [...perPo.entries()]
    .map(([poId, e]) => ({ poId, poNo: e.poNo, phantomRowsRemoved: e.removed }))
    .sort((a, b) => b.phantomRowsRemoved - a.phantomRowsRemoved);

  return c.json({
    success: true,
    mode: dry ? "dry-run" : "executed",
    slotsCleaned,
    phantomRowsRemoved: deleteIds.length,
    affectedPOs: perPoList.length,
    shippedDuplicatesLeftUntouched: shippedRowsLeftAlone,
    perPo: perPoList,
  });
});

// POST /api/fg-units/generate/:poId — idempotent
// Thin HTTP wrapper around generateFGUnitsForPO(). Returns existing units
// untouched if already generated; otherwise creates one FGUnit per
// (unit, piece) combination derived from PO quantity and product pieces.
app.post("/generate/:poId", async (c) => {
  const denied = await requirePermission(c, "fg-units", "create");
  if (denied) return denied;
  const poId = c.req.param("poId");
  const result = await generateFGUnitsForPO(c.var.DB, poId);
  if (result.status === "not-found") {
    return c.json(
      { success: false, error: "Production order not found" },
      404,
    );
  }
  const body = {
    success: true,
    data: result.units,
    total: result.units.length,
    generated: result.generated,
  };
  return result.generated ? c.json(body, 201) : c.json(body);
});

// POST /api/fg-units/backfill-hub?execute=1
// One-shot data fix (BUG-2026-06-05): existing FG units were stamped with the
// customer's DEFAULT delivery hub instead of the order's hub, so SBH / SRW / PG
// orders printed "Houzs KL". Re-resolve each in-stock unit's hub from its order
// (sales_orders.hubName / consignment_orders.hubName) and rewrite the stored
// customerHub. DRY-RUN by default (reports counts only); pass ?execute=1 to
// write. Idempotent + safe to re-run; shipped/delivered units are left alone.
app.post("/backfill-hub", async (c) => {
  const denied = await requirePermission(c, "fg-units", "create");
  if (denied) return denied;
  const execute = c.req.query("execute") === "1";
  const orgId = getOrgId(c);

  const rows =
    (
      await c.var.DB.prepare(
        `SELECT fg.id, fg.customerHub, fg.status,
                COALESCE(so.hubName, co.hubName) AS "resolvedHub"
           FROM fg_units fg
           LEFT JOIN sales_orders so ON so.id = fg.soId
           LEFT JOIN production_orders po ON po.id = fg.poId
           LEFT JOIN consignment_orders co ON co.id = po.consignmentOrderId
          WHERE fg.orgId = ?
            AND fg.status NOT IN ('LOADED', 'DELIVERED', 'RETURNED')`,
      )
        .bind(orgId)
        .all<{
          id: string;
          customerHub: string | null;
          status: string | null;
          resolvedHub: string | null;
        }>()
    ).results ?? [];

  // Only rewrite rows whose order carries a hub that differs from the stored one.
  const stale = rows.filter(
    (r) => r.resolvedHub && r.resolvedHub !== (r.customerHub ?? ""),
  );

  // old -> new breakdown so the operator can sanity-check before executing.
  const moves: Record<string, number> = {};
  for (const r of stale) {
    const key = `${r.customerHub || "(empty)"} -> ${r.resolvedHub}`;
    moves[key] = (moves[key] ?? 0) + 1;
  }

  if (execute && stale.length > 0) {
    const stmts = stale.map((r) =>
      c.var.DB
        .prepare("UPDATE fg_units SET customerHub = ? WHERE id = ?")
        .bind(r.resolvedHub, r.id),
    );
    for (let i = 0; i < stmts.length; i += 50) {
      await c.var.DB.batch(stmts.slice(i, i + 50));
    }
  }

  return c.json({
    success: true,
    mode: execute ? "executed" : "dry-run",
    scanned: rows.length,
    wouldUpdate: stale.length,
    moves,
    // Full per-unit before/after so a dry-run can be saved as a restore point
    // (id -> from) BEFORE executing. ~190 rows, small payload.
    units: stale.map((r) => ({ id: r.id, from: r.customerHub ?? "", to: r.resolvedHub })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/fg-units/seed-stock-events?execute=1 — the ledger's opening balance.
//
// An event ledger that starts today cannot explain the 4,866 pieces that were
// already in the book yesterday. Without an opening balance, Σ events would
// read 0 against a real on-hand count for months and the reconciliation would
// be permanently red for a reason that is not a problem — which is how a check
// gets ignored, and an ignored check is worse than none.
//
// So: exactly ONE row per fg_unit that has no events yet, from_status NULL →
// its CURRENT status, doc_type OPENING_BALANCE pointing at the unit's own
// production order (a real id). It does NOT invent history. It does not claim
// the piece was packed on a date we do not know, and it does not manufacture
// the dispatch/delivery rows the ledger never witnessed — it states the
// position the ledger inherits, once, and lets every later transition be real.
//
// direction falls out of balanceDelta as it does everywhere else: +1 for a
// piece that is on hand, 0 for one already delivered or in transit. So after
// seeding, Σ events == the on-hand unit count exactly, and identity (A) of the
// reconciliation holds from the first minute.
//
// occurred_at uses the best stamp the row actually carries (delivered → loaded
// → packed → mfd), so the trail sorts sensibly; there is no invented "now" on a
// piece that shipped in May. DRY-RUN by default; idempotent (a second run finds
// every unit already seeded and reports 0).
// ---------------------------------------------------------------------------
app.post("/seed-stock-events", async (c) => {
  const denied = await requirePermission(c, "fg-units", "update");
  if (denied) return denied;
  const execute = c.req.query("execute") === "1";
  const orgId = getOrgId(c);
  await ensureFgStockEventsSchema(c.var.DB);

  const rows =
    (
      await c.var.DB.prepare(
        `SELECT u.id, u.status, u.productCode, u.batchId, u.poId, u.poNo,
                u.deliveredAt, u.loadedAt, u.packedAt, u.mfdDate
           FROM fg_units u
          WHERE u.orgId = ?
            AND NOT EXISTS (
              SELECT 1 FROM fg_stock_events e WHERE e.fg_unit_id = u.id
            )`,
      )
        .bind(orgId)
        .all<{
          id: string;
          status: string | null;
          productCode: string | null;
          batchId: string | null;
          poId: string | null;
          poNo: string | null;
          deliveredAt: string | null;
          loadedAt: string | null;
          packedAt: string | null;
          mfdDate: string | null;
        }>()
    ).results ?? [];

  const byStatus: Record<string, number> = {};
  let onHandSeeded = 0;
  for (const r of rows) {
    const k = r.status ?? "(null)";
    byStatus[k] = (byStatus[k] ?? 0) + 1;
    if (isOnHandStatus(r.status)) onHandSeeded++;
  }

  if (execute && rows.length > 0) {
    const nowIso = new Date().toISOString();
    const stmts = rows.flatMap((r) =>
      buildFgStockEventStatements(
        c.var.DB,
        [
          {
            id: r.id,
            status: null, // the ledger had no prior position on this piece
            productCode: r.productCode,
            batchId: r.batchId,
          },
        ],
        {
          toStatus: r.status ?? "PACKED",
          doc: {
            docType: "OPENING_BALANCE",
            docId: r.poId ?? r.id,
            docNo: r.poNo ?? null,
          },
          actor: SYSTEM_ACTOR,
          occurredAt:
            r.deliveredAt || r.loadedAt || r.packedAt || r.mfdDate || nowIso,
          note: "Opening balance — position carried into the stock ledger",
          onceKey: "open",
        },
      ),
    );
    for (let i = 0; i < stmts.length; i += 50) {
      await c.var.DB.batch(stmts.slice(i, i + 50));
    }
  }

  return c.json({
    success: true,
    mode: execute ? "executed" : "dry-run",
    unitsWithoutEvents: rows.length,
    onHandUnitsSeeded: onHandSeeded,
    byStatus,
  });
});

// POST /api/fg-units/scan
// Body: { serial: string, action: "PACK"|"LOAD"|"DELIVER"|"RETURN", workerId?: string }
type ScanAction = "PACK" | "LOAD" | "DELIVER" | "RETURN";
app.post("/scan", async (c) => {
  const denied = await requirePermission(c, "fg-units", "create");
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const { serial, action, workerId } = body as {
    serial?: string;
    action?: ScanAction;
    workerId?: string;
  };

  if (!serial || !action) {
    return c.json(
      { success: false, error: "serial and action are required" },
      400,
    );
  }

  const unit = await c.var.DB.prepare(
    "SELECT * FROM fg_units WHERE unitSerial = ? OR shortCode = ? LIMIT 1",
  )
    .bind(serial, serial)
    .first<FGUnitRow>();
  if (!unit) {
    return c.json(
      { success: false, error: `Unit not found for serial "${serial}"` },
      404,
    );
  }

  const now = new Date().toISOString();
  let updateSql = "";
  let binds: unknown[] = [];
  // The status this scan is moving the unit TO — captured per branch so the one
  // ledger write below can sit after the switch instead of being repeated (and
  // forgotten) in four places.
  let toStatus = "";
  let scanActor = SYSTEM_ACTOR;

  switch (action) {
    case "PACK": {
      if (unit.status !== "PENDING") {
        return c.json(
          {
            success: false,
            error: `Cannot PACK — unit already ${unit.status}`,
          },
          400,
        );
      }
      if (!workerId) {
        return c.json(
          { success: false, error: "workerId required for PACK action" },
          400,
        );
      }
      const worker = await c.var.DB.prepare(
        "SELECT id, name FROM workers WHERE id = ?",
      )
        .bind(workerId)
        .first<WorkerRow>();
      if (!worker) {
        return c.json({ success: false, error: "Worker not found" }, 400);
      }
      updateSql =
        "UPDATE fg_units SET status = 'PACKED', packerId = ?, packerName = ?, packedAt = ? WHERE id = ?";
      binds = [worker.id, worker.name, now, unit.id];
      toStatus = "PACKED";
      scanActor = { type: "WORKER", id: worker.id, name: worker.name };
      break;
    }
    case "LOAD": {
      if (unit.status !== "PACKED") {
        return c.json(
          {
            success: false,
            error: `Cannot LOAD — unit is ${unit.status}, must be PACKED first`,
          },
          400,
        );
      }
      updateSql =
        "UPDATE fg_units SET status = 'LOADED', loadedAt = ? WHERE id = ?";
      binds = [now, unit.id];
      toStatus = "LOADED";
      break;
    }
    case "DELIVER": {
      if (unit.status !== "LOADED") {
        return c.json(
          {
            success: false,
            error: `Cannot DELIVER — unit is ${unit.status}, must be LOADED first`,
          },
          400,
        );
      }
      updateSql =
        "UPDATE fg_units SET status = 'DELIVERED', deliveredAt = ? WHERE id = ?";
      binds = [now, unit.id];
      toStatus = "DELIVERED";
      break;
    }
    case "RETURN": {
      // Returns can come from any state (customer rejection, damage, etc.)
      updateSql =
        "UPDATE fg_units SET status = 'RETURNED', returnedAt = ? WHERE id = ?";
      binds = [now, unit.id];
      toStatus = "RETURNED";
      break;
    }
    default:
      return c.json(
        { success: false, error: `Unknown action "${action}"` },
        400,
      );
  }

  // Ledger + status flip in ONE batch. `unit` was read before the switch, so it
  // still carries the FROM status; the four guards above already refused every
  // transition that is not a real state change, so this is always one event.
  // A PACK is credited to the WORKER who scanned; the other three carry the
  // authenticated user, because the scan endpoint is permission-gated.
  await ensureFgStockEventsSchema(c.var.DB);
  const userId = (c as unknown as { get: (k: string) => unknown }).get("userId");
  await c.var.DB.batch([
    c.var.DB.prepare(updateSql).bind(...binds),
    ...buildFgStockEventStatements(
      c.var.DB,
      [
        {
          id: unit.id,
          status: unit.status,
          productCode: unit.productCode,
          batchId: unit.batchId,
          poId: unit.poId,
          poNo: unit.poNo,
          doId: unit.doId,
          cnId: (unit as unknown as { cnId?: string | null }).cnId ?? null,
        },
      ],
      {
        toStatus,
        doc: docForScannedUnit(
          {
            id: unit.id,
            status: unit.status,
            poId: unit.poId,
            poNo: unit.poNo,
            doId: unit.doId,
            cnId: (unit as unknown as { cnId?: string | null }).cnId ?? null,
          },
          action,
        ),
        actor:
          scanActor.type === "WORKER"
            ? scanActor
            : actorFromUserId(typeof userId === "string" ? userId : null),
        occurredAt: now,
        note: `FG scan ${action}`,
      },
    ),
  ]);

  const updated = await c.var.DB.prepare("SELECT * FROM fg_units WHERE id = ?")
    .bind(unit.id)
    .first<FGUnitRow>();
  return c.json({ success: true, data: updated ? rowToFGUnit(updated) : null });
});

export default app;

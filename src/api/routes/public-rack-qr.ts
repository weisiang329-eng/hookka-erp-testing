// ---------------------------------------------------------------------------
// public-rack-qr.ts — PUBLIC (no-login) rack STOCK-IN flow for the warehouse.
//
// A worker scans a printed rack QR (HKRACK:<rack_locations.id>) with a normal
// phone camera — no login — then scans each finished/loose item to stock it
// into that rack. Mirrors the Public DO QR flow (routes/public-do-qr.ts):
// the token IS the credential, there is no session, and only a minimal,
// price-free view is exposed.
//
//   GET  /api/public/rack-qr/:rackId             → { rackId, rackLabel, itemCount }
//   GET  /api/public/rack-qr/:rackId/item?code=… → resolve a scanned sticker to a PO
//   POST /api/public/rack-qr/:rackId/stock-in    → write the batch (move-aware, idempotent)
//
// Security model (the token IS the credential):
//   • The token is the plain rack_locations.id. Stock-in is additive / low-risk
//     and the existing worker endpoint (POST /api/worker/rack-bulk-stock-in)
//     already accepts a bare rackLocationId, so a plain id is the same trust
//     level — there is nothing price/customer-sensitive to leak via a rack.
//   • Exposure is limited to the rack LABEL + a current item COUNT, and (for a
//     resolved item) the production order's number + product name. No prices,
//     no customers, no addresses.
//   • Auth bypass is via PUBLIC_PREFIXES ("/api/public/rack-qr/") in
//     lib/auth-middleware.ts; the shared apiRateLimit middleware still applies
//     (keyed by client IP) so the endpoint can't be hammered.
//
// Write reuse: the INSERT block (rack_items + STOCK_IN stock_movements + flip
// rack OCCUPIED) is the SHARED helper buildRackStockInStatements below — the
// EXACT same statements the worker route builds — so the two paths can never
// drift. performedBy is "Public scan" here (no worker identity on this route).
//
// SCHEMA NOTE (deviation from the original spec — see the agent report): the
// rack tables (rack_locations / rack_items / stock_movements) are NOT org-
// scoped in this codebase. Migration 0049 only added orgId to 6 core tables;
// rack_* are global/single-org, and neither the worker stock-in nor the admin
// warehouse route filters rack rows by org. So:
//   • the item current-rack lookup is keyed by productionOrderId ONLY (the
//     spec's `AND ri.orgId = ?` predicate would reference a non-existent
//     column and throw at runtime);
//   • the helper keeps the documented `orgId` parameter for signature
//     stability (so the worker route can adopt it verbatim later), but does
//     NOT write it into the INSERTs — rack_items / stock_movements have no
//     orgId column, and adding one to the bind list would break the writes.
// The orgId-into-context stash the DO flow needs (its cascade calls getOrgId
// for invoice ledger legs) is unnecessary here: the rack writes are plain
// INSERT/UPDATE statements with no getOrgId() call anywhere in the path.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { parseItemQr, parseStickerData } from "../../lib/qr-utils";
import {
  deriveBarcodeToken,
  deptOfBarcodeToken,
  isBarcodeToken,
} from "../../lib/job-card-id";

const app = new Hono<Env>();

// genId mirrors the worker route's helper — `<prefix>-<8 hex>`. stock_movements
// ids are minted as genId("sm"), exactly like POST /api/worker/rack-bulk-stock-in.
function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// Item shape posted to /stock-in and built by the helper. productionOrderId is
// null for a manual (HKITEM) loose item — those always insert, never "move".
//
// PER-PIECE MODEL (owner's spec): every FG/WIP/packing QR is a UNIQUE physical
// piece, so the page sends ONE entry per scanned sticker (qty always 1) and the
// helper writes ONE rack_items row each — never an aggregated ×N line. Each
// piece carries its Sales Order number (`salesOrderNo`, resolved PO→SO) and a
// human `description` (productName + size, e.g. "1013 King Size Headboard").
export type RackStockInItem = {
  productionOrderId: string | null;
  productName: string;
  poNo: string | null;
  // The piece's Sales Order number (resolved from its PO). null for a manual
  // HKITEM loose piece with no system PO. Stored in rack_items.notes as
  // "SO <no>" so it surfaces in the warehouse rack grid / detail (that route
  // maps rack_items.notes straight through).
  salesOrderNo: string | null;
  qty: number;
  // The EXACT job_card this scanned piece resolved to (from the /item response).
  // When present, stock-in stamps THIS card's rackingNumber by id — the only way
  // to hit the right one of a bedframe PO's many PACKING cards (Divan vs
  // Headboard). Optional: the worker route reuses buildRackStockInStatements
  // without it, and a manual/PO-level piece carries none → falls back to the
  // productionOrderId + wipLabel match. NOT used by the rack_items / movements
  // writes below (those are unchanged); only the rackingNumber stamp reads it.
  jobCardId?: string | null;
};

// ---------------------------------------------------------------------------
// buildRackStockInStatements — THE single source of truth for a rack stock-in
// write. Returns the statement array (rack_items INSERT + STOCK_IN
// stock_movements INSERT per item, then UPDATE rack_locations OCCUPIED) so the
// caller can append move-deletes and run ONE atomic db.batch(). Character-for-
// character identical to the worker route's write block (routes/worker.ts
// POST /rack-bulk-stock-in), so both the worker portal and the public scan
// write rack stock-in the same way.
//
// `orgId` is accepted for signature stability (the worker route can call this
// verbatim) but is intentionally NOT bound into the INSERTs — the rack tables
// have no orgId column in this schema (see the SCHEMA NOTE above). `performedBy`
// is the human who scanned: the worker's name on the portal, "Public scan" here.
//
// rack_items.id is BIGSERIAL — NOT supplied. production_order_id is stored NULL
// (not "") when absent so the movements-view PO JOIN reads "no document".
//
// ONE ROW PER PIECE: each `items` entry is one unique scanned sticker, so this
// writes one rack_items row per entry and never sums quantities. qty defaults
// to 1 (a piece is a piece). The piece's Sales Order number is stored in the
// `notes` column as "SO <no>" — rack_items has no dedicated SO column, and the
// admin warehouse route maps rack_items.notes straight through to the rack
// grid / detail, so the SO surfaces there with no change to that (un-owned)
// route. `salesOrderNo` is optional on the item (the worker route reuses this
// helper without it) → treated as absent when missing.
// ---------------------------------------------------------------------------
export function buildRackStockInStatements(
  db: D1Database,
  orgId: string | null,
  rackLocationId: string,
  items: RackStockInItem[],
  performedBy: string,
): D1PreparedStatement[] {
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    const qty = item.qty ?? 1;
    const poId = item.productionOrderId || null;
    // SO number → "SO <no>" in notes (the only spare text column on rack_items
    // that the warehouse list/detail route already surfaces). Optional field,
    // so guard for the worker route which calls this helper without it.
    const soNo = (item.salesOrderNo ?? "").trim();
    const notes = soNo ? `SO ${soNo}` : "";
    statements.push(
      db
        .prepare(
          `INSERT INTO rack_items (rackLocationId, productionOrderId,
             productCode, productName, sizeLabel, customerName, qty,
             stockedInDate, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          rackLocationId,
          poId,
          "",
          item.productName ?? "",
          "",
          "",
          qty,
          today,
          notes,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO stock_movements (id, type, rackLocationId, rackLabel,
             productionOrderId, productCode, productName, quantity, reason,
             performedBy, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          genId("sm"),
          "STOCK_IN",
          rackLocationId,
          rackLocationId,
          poId,
          "",
          item.productName ?? "",
          qty,
          "Bulk stock-in (scan)",
          performedBy,
          now,
        ),
    );
  }
  statements.push(
    db
      .prepare("UPDATE rack_locations SET status = 'OCCUPIED' WHERE id = ?")
      .bind(rackLocationId),
  );
  return statements;
}

type RackRow = { id: string; rack: string };

// Resolve a rack by its id (the scanned token). Returns null → caller 404s.
async function findRack(
  db: D1Database,
  rackId: string,
): Promise<RackRow | null> {
  return db
    .prepare("SELECT id, rack FROM rack_locations WHERE id = ? LIMIT 1")
    .bind(rackId)
    .first<RackRow>();
}

type PoMatch = {
  productionOrderId: string;
  productName: string;
  poNo: string | null;
  // The Sales Order number this PO traces back to (production_orders.salesOrderNo),
  // and a human description (productName + size). Both flow to the scan page so a
  // piece shows e.g. "1013 King Size Headboard" + "SO 250114".
  salesOrderNo: string | null;
  description: string;
  // The id of the SPECIFIC job_card this scan resolved to, when it was resolved
  // through a card (the PACKING-sentinel path below, or a job-card-id sticker).
  // null for a PO-level match that carries no single card. The scan page threads
  // this back into stock-in so the stamp hits EXACTLY that card's rackingNumber
  // (a bedframe PO has one PACKING card per compartment — Divan vs Headboard —
  // and only the resolved id picks the right one).
  jobCardId: string | null;
};

// Columns selected for every PoMatch lookup — id + the human + document fields
// the per-piece scan card needs (description = productName + size, plus the SO).
type PoRow = {
  id: string;
  poNo: string | null;
  productName: string | null;
  productCode: string | null;
  sizeLabel: string | null;
  salesOrderNo: string | null;
  // Only present when resolved through a job_card (paths 2 & 3). This is the
  // exact WIP label the production / packing sheet prints, e.g. "5530-2A(RHF)"
  // or '8" Divan- 6FT Frame'.
  wipLabel?: string | null;
};
const PO_COLS = "id, poNo, productName, productCode, sizeLabel, salesOrderNo";

// Resolve a scanned/typed term to its production order, mirroring the worker
// scan-lookup chain (routes/worker.ts GET /scan-lookup): exact poNo / PO id
// first, then a job-card id, then a SHORT Code 128 schedule token re-derived
// across that department's cards. Returns null when nothing matches.
async function resolvePo(
  db: D1Database,
  term: string,
  // The job_card this match was resolved through (paths 2 & 3 below carry one).
  // Threaded into the response as `jobCardId` so stock-in can stamp the EXACT
  // card. null for a bare PO-level match (path 1).
  jobCardId: string | null = null,
): Promise<PoMatch | null> {
  const toMatch = (r: PoRow): PoMatch => {
    const name = (r.productName || r.productCode || r.poNo || "").trim();
    const size = (r.sizeLabel || "").trim();
    const wip = (r.wipLabel || "").trim();
    // Prefer the job_card's WIP label — exactly what the production / packing
    // sheet prints (e.g. "5530-2A(RHF)", '8" Divan- 6FT Frame'), because the
    // rack holds WIP heading into packing, so a racked piece must read as its
    // WIP, not a spelled-out product name (owner 2026-06-17). Falls back to
    // productName + size for a PO-level match that carries no specific piece.
    const description = wip || (size ? `${name} ${size}`.trim() : name);
    return {
      productionOrderId: r.id,
      productName: name,
      poNo: r.poNo ?? null,
      salesOrderNo: (r.salesOrderNo || "").trim() || null,
      description,
      jobCardId,
    };
  };

  // 1) PO number / PO id (exact — the sticker encodes the stored poNo verbatim).
  let row = await db
    .prepare(
      `SELECT ${PO_COLS}
         FROM production_orders WHERE poNo = ? OR id = ? LIMIT 1`,
    )
    .bind(term, term)
    .first<PoRow>();
  if (row) return toMatch(row);

  // 2) Job-card id (other-dept per-piece stickers encode the jc id in op=).
  // Pull the card's wipLabel so the racked piece reads as its WIP.
  row = await db
    .prepare(
      `SELECT po.id AS id, po.poNo AS poNo, po.productName AS productName,
              po.productCode AS productCode, po.sizeLabel AS sizeLabel,
              po.salesOrderNo AS salesOrderNo, jc.wipLabel AS wipLabel
         FROM production_orders po
         JOIN job_cards jc ON jc.productionOrderId = po.id
        WHERE jc.id = ? LIMIT 1`,
    )
    .bind(term)
    .first<PoRow>();
  // The job-card-id sticker IS this card, so stamp it by id: term is the jc id.
  if (row) return { ...toMatch(row), jobCardId: term };

  // 3) SHORT schedule Code 128 token (b<deptNN><hash>) — not a stored id;
  // re-derive deriveBarcodeToken across EVERY card in the token's department
  // (the leading 2 digits) and match. Bounded by one dept's cards; works for
  // new + old cards with no id rewrite. try/catch keeps any hiccup graceful.
  if (isBarcodeToken(term)) {
    const deptCode = deptOfBarcodeToken(term);
    if (deptCode) {
      try {
        const cand =
          (
            await db
              .prepare(
                `SELECT id, productionOrderId, departmentCode, wipLabel
                   FROM job_cards WHERE departmentCode = ?`,
              )
              .bind(deptCode)
              .all<{
                id: string;
                productionOrderId: string;
                departmentCode: string | null;
                wipLabel: string | null;
              }>()
          ).results ?? [];
        const hit = cand.find(
          (j) =>
            deriveBarcodeToken(j.id, j.departmentCode ?? deptCode) === term,
        );
        if (hit) {
          row = await db
            .prepare(
              `SELECT ${PO_COLS}
                 FROM production_orders WHERE id = ? LIMIT 1`,
            )
            .bind(hit.productionOrderId)
            .first<PoRow>();
          // Carry the matched card's WIP label so the piece reads as its WIP,
          // and its id so stock-in stamps that exact card.
          if (row)
            return { ...toMatch({ ...row, wipLabel: hit.wipLabel }), jobCardId: hit.id };
        }
      } catch (e) {
        console.warn("[public-rack-qr] barcode-token resolve failed:", e);
      }
    }
  }
  return null;
}

// Resolve a PACKING-sentinel sticker (op=FG-PACKING&po=<poNo>&pn=<label>) to the
// ONE PACKING job_card it belongs to — so the rack reads that card's WIP label
// (what the Packing sheet prints, e.g. '8" Divan- 6FT') and stock-in can stamp
// that exact card's rackingNumber, NOT the whole FG.
//
// A bedframe PO has MULTIPLE PACKING cards (one per compartment: Divan,
// Headboard, …), each with its own wipLabel; only po + pieceLabel identifies the
// right one. This mirrors the worker scanner's narrowing EXACTLY (pages/worker/
// scan.tsx ~L946: `matches.filter(m => m.wipLabel.toUpperCase().includes(
// pieceLabel.trim().toUpperCase()))`, kept only if it lands on exactly one). The
// `pn` value is the SHORT box label ("HB" / "Divan" / a fabric name — production/
// index.tsx ~L8189 sets pn=<pieceName>), a SUBSTRING of the longer wipLabel, so
// the match is `includes`, never equality. Falls back to the sole PACKING card
// when the PO has exactly one (single-compartment), and to null otherwise (the
// caller then drops through to resolvePo's PO-level match — safe + unchanged).
async function resolvePackingCard(
  db: D1Database,
  poNo: string,
  pieceLabel: string | undefined,
): Promise<PoMatch | null> {
  // PO header (for SO + product fallback) plus its PACKING cards (id + wipLabel).
  const po = await db
    .prepare(
      `SELECT ${PO_COLS} FROM production_orders WHERE poNo = ? OR id = ? LIMIT 1`,
    )
    .bind(poNo, poNo)
    .first<PoRow>();
  if (!po) return null;

  const cards =
    (
      await db
        .prepare(
          `SELECT id, wipLabel FROM job_cards
            WHERE productionOrderId = ? AND departmentCode = 'PACKING'`,
        )
        .bind(po.id)
        .all<{ id: string; wipLabel: string | null }>()
    ).results ?? [];
  if (cards.length === 0) return null;

  // Narrow to the ONE card whose wipLabel contains the box label (mirrors the
  // worker scanner). Only accept an unambiguous single match; otherwise fall
  // back to the lone PACKING card (single-compartment PO).
  let pick: { id: string; wipLabel: string | null } | null = null;
  const want = (pieceLabel || "").trim().toUpperCase();
  if (want) {
    const narrowed = cards.filter((cd) =>
      (cd.wipLabel ?? "").toUpperCase().includes(want),
    );
    if (narrowed.length === 1) pick = narrowed[0];
  }
  if (!pick && cards.length === 1) pick = cards[0];
  if (!pick) return null;

  const name = (po.productName || po.productCode || po.poNo || "").trim();
  const size = (po.sizeLabel || "").trim();
  const wip = (pick.wipLabel || "").trim();
  // description = the resolved PACKING card's WIP label (what the Packing sheet
  // prints); fall back to productName + size only when the card has no wipLabel.
  const description = wip || (size ? `${name} ${size}`.trim() : name);
  return {
    productionOrderId: po.id,
    productName: name,
    poNo: po.poNo ?? null,
    salesOrderNo: (po.salesOrderNo || "").trim() || null,
    description,
    jobCardId: pick.id,
  };
}

type CurrentRack = { currentRackId: string | null; currentRackLabel: string | null };

// Where (if anywhere) a production order's pieces currently sit. Most-recent
// rack_items row for the PO. Manual HKITEM items have productionOrderId NULL →
// never resolved here, so they are never reported as "already racked". NOT
// org-scoped (rack_items has no orgId column — see the SCHEMA NOTE).
async function currentRackOfPo(
  db: D1Database,
  productionOrderId: string,
): Promise<CurrentRack> {
  const row = await db
    .prepare(
      `SELECT ri.rackLocationId AS rackLocationId, rl.rack AS rack
         FROM rack_items ri
         JOIN rack_locations rl ON rl.id = ri.rackLocationId
        WHERE ri.productionOrderId = ?
        ORDER BY ri.id DESC LIMIT 1`,
    )
    .bind(productionOrderId)
    .first<{ rackLocationId: string | null; rack: string | null }>();
  return {
    currentRackId: row?.rackLocationId ?? null,
    currentRackLabel: row?.rack ?? null,
  };
}

// GET /api/public/rack-qr/:rackId — minimal rack summary for the scan page.
app.get("/:rackId", async (c: Context<Env>) => {
  const rackId = (c.req.param("rackId") || "").trim();
  if (!rackId) return c.json({ error: "rack not found" }, 404);
  try {
    const rack = await findRack(c.var.DB, rackId);
    if (!rack) return c.json({ error: "rack not found" }, 404);
    const countRow = await c.var.DB.prepare(
      "SELECT COUNT(*) AS n FROM rack_items WHERE rackLocationId = ?",
    )
      .bind(rackId)
      .first<{ n: number }>();
    return c.json({
      rackId: rack.id,
      rackLabel: rack.rack,
      itemCount: Number(countRow?.n) || 0,
    });
  } catch (err) {
    console.error("[GET /api/public/rack-qr/:rackId] failed:", err);
    return c.json({ error: "rack not found" }, 404);
  }
});

// GET /api/public/rack-qr/:rackId/item?code=<encoded raw scanned string>
// Resolves a scanned sticker (manual HKITEM, FG/production QR URL, bare poNo /
// PO id / job-card id, or a Code 128 schedule token) to its production order +
// where it currently sits, so the page can show the item and warn on a move.
app.get("/:rackId/item", async (c: Context<Env>) => {
  const rackId = (c.req.param("rackId") || "").trim();
  const notFound = {
    found: false,
    productionOrderId: null,
    productName: "",
    poNo: null,
    salesOrderNo: null,
    description: "",
    jobCardId: null,
    currentRackId: null,
    currentRackLabel: null,
  };
  try {
    const rack = await findRack(c.var.DB, rackId);
    if (!rack) return c.json({ error: "rack not found" }, 404);

    const code = (c.req.query("code") || "").trim();
    if (!code) return c.json(notFound);

    // Manual loose item (HKITEM:<name>[|<code>]) — no system PO. Always "found",
    // never resolved to a rack (productionOrderId null), so the caller just adds
    // it. Mirrors the worker scanner's manual-item branch.
    const manual = parseItemQr(code);
    if (manual) {
      return c.json({
        found: true,
        productionOrderId: null,
        productName: manual.name,
        poNo: null,
        // A loose HKITEM piece has no system PO, hence no Sales Order; its
        // description is just the encoded name.
        salesOrderNo: null,
        description: manual.name,
        // No system PO → no job_card to stamp.
        jobCardId: null,
        currentRackId: null,
        currentRackLabel: null,
      });
    }

    // Production/FG sticker QR URL encodes po=<poNo>; pull it out. Otherwise the
    // raw string is itself the term (a bare poNo / PO id / job-card id / Code 128
    // token typed or linear-scanned). parseStickerData returns null for non-URLs.
    const sticker = parseStickerData(code);
    const term = (sticker?.poNo || code).trim();
    if (!term) return c.json(notFound);

    // PACKING-sentinel sticker (op=FG-PACKING&po=…&pn=<label>): resolve to the
    // ONE PACKING job_card for this PO+label, so the rack reads that card's WIP
    // label and stock-in stamps that exact card — NOT the whole FG (the bug:
    // the old PO-level resolvePo returned the spelled-out product name with no
    // wipLabel, and ignored pn / the compartment). Only the FG-PACKING shape
    // takes this branch; every other scan keeps the resolvePo chain unchanged.
    const isPackingSticker =
      sticker?.deptCode === "PACKING" || /^FG-PACKING$/.test(sticker?.opId ?? "");
    const po =
      (isPackingSticker
        ? await resolvePackingCard(c.var.DB, term, sticker?.pieceLabel)
        : null) ?? (await resolvePo(c.var.DB, term));
    if (!po) return c.json(notFound);

    const cur = await currentRackOfPo(c.var.DB, po.productionOrderId);
    return c.json({
      found: true,
      productionOrderId: po.productionOrderId,
      productName: po.productName,
      poNo: po.poNo,
      // Per-piece: the SO this piece belongs to + a clear description, so the
      // scan list shows "1013 King Size Headboard" alongside its SO number.
      salesOrderNo: po.salesOrderNo,
      description: po.description,
      // The exact job_card this piece resolved to (PACKING-sentinel or job-card
      // sticker). The scan page threads it back into stock-in so the rack stamp
      // hits this card's rackingNumber precisely. null for a PO-level match.
      jobCardId: po.jobCardId,
      currentRackId: cur.currentRackId,
      currentRackLabel: cur.currentRackLabel,
    });
  } catch (err) {
    console.error("[GET /api/public/rack-qr/:rackId/item] failed:", err);
    return c.json(notFound);
  }
});

// POST /api/public/rack-qr/:rackId/stock-in
// body { items: [{ productionOrderId, productName, description, poNo, salesOrderNo, qty }] }
// PER-PIECE: every entry is one UNIQUE scanned sticker, so this writes ONE
// rack_items row per entry (qty forced to 1) — never an aggregated ×N line. Each
// row stores its description (as productName) + its SO number (in notes, "SO …").
// Writes via buildRackStockInStatements (performedBy="Public scan", flips the
// rack OCCUPIED). An item whose productionOrderId is already in a DIFFERENT
// rack is MOVED — the old rack_items row(s) are deleted first, in the SAME
// atomic batch. Manual items (productionOrderId null) always add. The page
// already de-dups a re-scanned sticker, so each posted piece is distinct.
app.post("/:rackId/stock-in", async (c: Context<Env>) => {
  const rackId = (c.req.param("rackId") || "").trim();
  try {
    const rack = await findRack(c.var.DB, rackId);
    if (!rack) return c.json({ error: "rack not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      items?: Array<{
        productionOrderId?: string | null;
        productName?: string;
        poNo?: string | null;
        salesOrderNo?: string | null;
        description?: string;
        jobCardId?: string | null;
        qty?: number;
      }>;
    };
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      return c.json({ error: "items array is required" }, 400);
    }

    // PER-PIECE: each posted entry is one unique scanned sticker → one row,
    // qty forced to 1 (a sticker is a single physical piece; we never trust /
    // sum a client qty here). The row's productName stores the human
    // `description` (productName + size) so the rack grid reads "1013 King Size
    // Headboard"; the SO number rides along to be written into notes.
    const items: RackStockInItem[] = rawItems.map((it) => ({
      productionOrderId: it.productionOrderId || null,
      productName: (it.description || it.productName || "").toString(),
      poNo: it.poNo || null,
      salesOrderNo: (it.salesOrderNo ?? "").toString().trim() || null,
      jobCardId: it.jobCardId || null,
      qty: 1,
    }));

    // Move-aware: for any item already racked in a DIFFERENT rack, delete its
    // existing rack_items row(s) first so the piece is MOVED, not duplicated.
    // Manual items (no PO) skip this. De-dup the PO ids so we issue one delete
    // each. All deletes go into the SAME batch as the inserts → one atomic op.
    const moveDeletes: D1PreparedStatement[] = [];
    const poIds = [
      ...new Set(
        items
          .map((i) => i.productionOrderId)
          .filter((x): x is string => !!x),
      ),
    ];
    for (const poId of poIds) {
      const cur = await currentRackOfPo(c.var.DB, poId);
      if (cur.currentRackId && cur.currentRackId !== rackId) {
        moveDeletes.push(
          c.var.DB
            .prepare(
              "DELETE FROM rack_items WHERE productionOrderId = ? AND rackLocationId = ?",
            )
            .bind(poId, cur.currentRackId),
        );
      }
    }

    // orgId stays null — rack tables are not org-scoped (see the SCHEMA NOTE);
    // the helper keeps the param for signature parity with the worker route.
    const writes = buildRackStockInStatements(
      c.var.DB,
      null,
      rackId,
      items,
      "Public scan",
    );

    // Auto-stamp each scanned piece's Rack onto its job card so the Packing
    // sheet, packing list, and DO show the rack WITHOUT anyone picking it from
    // the dropdown — and a re-scan into a different rack auto-changes it (owner
    // 2026-06-17: "我 record 了进什么 Rack，packing 那边的 Rack Number 就自动显
    // 示并更换"). `updated_at = NOW()` bumps the JC so the production_orders
    // snapshot cache invalidates and the sheet re-reads (same reason the JC
    // PATCH stamps it). Same atomic batch as the rack writes.
    //
    // PREFER the exact jobCardId from the /item resolution: a bedframe PO has
    // many PACKING cards (Divan, Headboard, …) and only the resolved id picks
    // the one that was scanned — the DO/packing Rack column reads THAT card's
    // rackingNumber. Stamping by productionOrderId + wipLabel can't identify it
    // (and was the bug: the FG-level description was the product name, not a
    // wipLabel, so it matched no card). Fall back to that signature match only
    // for a legacy/PO-level piece that carries no jobCardId (here `productName`
    // IS the wipLabel-derived description from resolvePo).
    const rackLabel = rack.rack ?? "";
    const rackingUpdates: D1PreparedStatement[] = [];
    for (const it of items) {
      if (!rackLabel) continue;
      if (it.jobCardId) {
        rackingUpdates.push(
          c.var.DB
            .prepare(
              `UPDATE job_cards SET rackingNumber = ?, updated_at = NOW()
                 WHERE id = ?`,
            )
            .bind(rackLabel, it.jobCardId),
        );
        continue;
      }
      const wip = (it.productName || "").trim();
      if (!it.productionOrderId || !wip) continue;
      rackingUpdates.push(
        c.var.DB
          .prepare(
            `UPDATE job_cards SET rackingNumber = ?, updated_at = NOW()
               WHERE productionOrderId = ? AND wipLabel = ?`,
          )
          .bind(rackLabel, it.productionOrderId, wip),
      );
    }
    await c.var.DB.batch([...moveDeletes, ...writes, ...rackingUpdates]);

    return c.json({ ok: true, count: items.length });
  } catch (err) {
    console.error("[POST /api/public/rack-qr/:rackId/stock-in] failed:", err);
    return c.json({ error: "Could not stock in. Please try again." }, 500);
  }
});

export default app;

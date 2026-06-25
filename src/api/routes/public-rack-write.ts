// ---------------------------------------------------------------------------
// public-rack-write.ts — PUBLIC (no-login) packing-sticker → RACK assignment.
//
// A storekeeper scans the QR printed on a Packing (FG) sticker with a normal
// phone camera. The QR encodes /p/<token>; that page calls:
//
//   GET  /api/public/rack-write/:token        → minimal piece summary + racks
//   POST /api/public/rack-write/:token/rack    → { rackingNumber }  (set/clear)
//
// This is the ITEM→RACK direction (assign a rack to THE scanned piece). It is
// the mirror image of the existing public /r/:rackId rack-qr flow (which scans
// a RACK then scans items INTO it). It exists because the Packing-sticker QR
// used to deep-link into /worker/scan — a logged-in Worker-Portal page — so a
// storekeeper without a PIN hit the worker login screen and was blocked.
//
// Security model (the token IS the credential — mirrors public-do-qr.ts):
//   • qr_token is 64 random hex chars (two UUIDs), minted lazily by the AUTHED
//     mint endpoint only (POST /api/production-orders/packing-rack-tokens, at
//     sticker-print time) — this route never creates tokens. We do NOT use the
//     bare (short, enumerable) job_card id in the URL: a guessed id would let
//     anyone rewrite the rack on any card.
//   • Scope-limited: the ONLY write is set/clear the rackingNumber on the one
//     token-resolved PACKING job card (via the SHARED applyPackingRack helper —
//     PACKING-only, rack must exist in rack_locations, reject-don't-normalize,
//     empty clears). The POST reads EXACTLY one body field (rackingNumber);
//     every other field is ignored. No prices/customers/addresses anywhere.
//   • Tenant safety: org is resolved from the token's own job_card → PO row, not
//     from the request (no cross-tenant reach). The rack catalog + writes are
//     plain reads/writes; no getOrgId() call is in this path.
//   • Auth bypass is via PUBLIC_PREFIXES ("/api/public/rack-write/") in
//     lib/auth-middleware.ts; the shared apiRateLimit middleware still applies
//     (keyed by client IP) with a tightened override of { perMinute: 30,
//     perHour: 300 } in lib/api-rate-limit-config.ts (it is reachable without
//     login).
//   • The token is NEVER logged (it is the credential).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { ensureJobCardQrTokenColumn } from "../lib/jobcard-qr-token";
import { applyPackingRack } from "../lib/packing-rack-write";
import { archiveUnionSource } from "../lib/archive-union";

const app = new Hono<Env>();

// Tokens are 64 hex chars. Reject anything else before touching the DB — fast
// 404 for junk paths and no way to probe with empty/odd values.
const TOKEN_RE = /^[0-9a-f]{64}$/i;

const unknownToken = (c: Context<Env>) =>
  c.json(
    {
      success: false,
      error:
        "Unknown or expired QR code. Please ask the Hookka office for a freshly printed sticker.",
    },
    404,
  );

export type PackingCardRow = {
  id: string;
  productionOrderId: string | null;
  departmentCode: string | null;
  rackingNumber: string | null;
  wipLabel: string | null;
  // PO header — minimal, no-price fields only.
  poNo: string | null;
  productName: string | null;
  productCode: string | null;
  sizeLabel: string | null;
  salesOrderNo: string | null;
};

// Resolve the token to its PACKING job card + the minimal PO header fields the
// scan page needs. Reads qr_token (snake_case) — the only credential. Returns
// null when nothing matches.
// Exported so the /r/ rack-scan item lookup (public-rack-qr.ts) can resolve a
// scanned /p/<token> packing sticker to the SAME exact card — one definition,
// archive-aware, no drift between the two public scan surfaces.
export async function resolveCard(
  db: D1Database,
  token: string,
): Promise<PackingCardRow | null> {
  await ensureJobCardQrTokenColumn(db);
  // FIX 1 — archive-aware resolve. An old printed sticker may belong to a card
  // whose PO has since been COMPLETED + archived (job_cards → job_cards_archive,
  // production_orders → production_orders_archive). archiveUnionSource self-heals
  // the archive's drifted columns (adds the missing qr_token, backfills org_id)
  // and returns a UNION derived-table SQL string spanning hot + archive; it
  // falls back to the hot table literal on any introspection failure (no
  // regression vs the old hot-only resolve). The aliases/columns are unchanged.
  const jcSrc =
    (await archiveUnionSource(db, "job_cards", "job_cards_archive")) ??
    "job_cards";
  const poSrc =
    (await archiveUnionSource(
      db,
      "production_orders",
      "production_orders_archive",
    )) ?? "production_orders";
  return db
    .prepare(
      `SELECT jc.id AS id, jc.productionOrderId AS productionOrderId,
              jc.departmentCode AS departmentCode, jc.rackingNumber AS rackingNumber,
              jc.wipLabel AS wipLabel,
              po.poNo AS poNo, po.productName AS productName,
              po.productCode AS productCode, po.sizeLabel AS sizeLabel,
              po.salesOrderNo AS salesOrderNo
         FROM ${jcSrc} jc
         LEFT JOIN ${poSrc} po ON po.id = jc.productionOrderId
        WHERE jc.qr_token = ? LIMIT 1`,
    )
    .bind(token)
    .first<PackingCardRow>();
}

// The clear human description for the piece — prefer the PACKING card's WIP
// label (what the Packing sheet prints, e.g. '8" Divan- 6FT Frame'); fall back
// to productName + size (then productName / code) so it is never blank.
function pieceDescription(card: PackingCardRow): string {
  const wip = (card.wipLabel || "").trim();
  if (wip) return wip;
  const name = (card.productName || card.productCode || card.poNo || "").trim();
  const size = (card.sizeLabel || "").trim();
  return size ? `${name} ${size}`.trim() : name;
}

// The warehouse rack catalog for the picker. Same source as the worker scan
// page's /api/worker/racks — natural-sorted on the client. No prices.
async function loadRackCatalog(
  db: D1Database,
): Promise<Array<{ rack: string; occupied: boolean }>> {
  const res = await db
    .prepare("SELECT rack, status FROM rack_locations ORDER BY rack")
    .all<{ rack: string; status: string }>();
  return (res.results ?? []).map((r) => ({
    rack: r.rack,
    occupied: r.status === "OCCUPIED",
  }));
}

// GET /api/public/rack-write/:token — minimal piece summary + rack picker list.
// NO prices / customers / addresses: only enough to know what is being racked
// (poNo, SO no., piece/WIP description, current rack) + the rack catalog.
app.get("/:token", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);
  try {
    const card = await resolveCard(c.var.DB, token);
    if (!card) return unknownToken(c);
    // The token is minted on a PACKING card, but guard anyway — the only
    // write this route allows is PACKING-only.
    if ((card.departmentCode || "").toUpperCase() !== "PACKING") {
      return unknownToken(c);
    }
    const racks = await loadRackCatalog(c.var.DB);
    return c.json({
      success: true,
      data: {
        poNo: card.poNo ?? "",
        salesOrderNo: (card.salesOrderNo || "").trim(),
        description: pieceDescription(card),
        rackingNumber: (card.rackingNumber || "").trim(),
        racks,
      },
    });
  } catch (err) {
    console.error("[GET /api/public/rack-write/:token] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not load this sticker. Please try again.",
      },
      500,
    );
  }
});

// POST /api/public/rack-write/:token/rack — set/clear the rack on THIS card.
// The ONLY mutation reachable via the public token. Reads EXACTLY ONE body
// field (rackingNumber); any other field is ignored. The validation + writes
// are the SHARED applyPackingRack helper (PACKING-only, rack must exist in
// rack_locations, reject-don't-normalize, empty clears; UPDATE job_cards then
// mirror production_orders) — the same path the worker /packing-rack uses, so
// the two can't drift.
app.post("/:token/rack", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);

  // Pull ONLY the one allowed field off the body. Everything else (jobCardId,
  // status, prices, …) is deliberately ignored — the token alone identifies
  // the card, and rack is the sole writable property.
  const body = (await c.req.json().catch(() => ({}))) as {
    rackingNumber?: unknown;
  };
  const rackingNumber =
    typeof body.rackingNumber === "string" ? body.rackingNumber : null;
  if (rackingNumber == null) {
    return c.json(
      { success: false, error: "rackingNumber is required" },
      400,
    );
  }

  try {
    const card = await resolveCard(c.var.DB, token);
    if (!card) return unknownToken(c);
    // The jobCardId is taken from the TOKEN'S resolved row only — never from the
    // request — so a tampered payload cannot point the write at another card.
    const res = await applyPackingRack(c.var.DB, card.id, rackingNumber);
    if (!res.ok) {
      // NOT_PACKING / UNKNOWN_RACK / BAD_INPUT → 400 (validation); NOT_FOUND →
      // 404 (the token's card vanished between GET and POST).
      const status = res.code === "NOT_FOUND" ? 404 : 400;
      return c.json({ success: false, error: res.error }, status);
    }
    return c.json({
      success: true,
      data: { rackingNumber: res.rackingNumber },
    });
  } catch (err) {
    console.error("[POST /api/public/rack-write/:token/rack] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not save the rack number. Please try again.",
      },
      500,
    );
  }
});

export default app;

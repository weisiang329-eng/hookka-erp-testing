// ---------------------------------------------------------------------------
// CN Packing Lists route — the CONSIGNMENT twin of routes/packing-lists.ts.
//
// A "CN packing list" groups several consignment notes (one truck run,
// possibly many branches) into one saved document. CNs stay where they are
// (Pending Dispatch etc.) — the packing list only references them so the
// warehouse can print one consolidated loading sheet (the existing
// printCnPackingList consolidated print). Business rule: a CN may belong to at
// most ONE packing list (enforced in POST by scanning existing lists), exactly
// like a DO on the delivery side.
//
// cn_ids is stored as a JSON array of consignment_notes.id. Summary columns
// are snapshotted on create for the list view; the printed PDF (frontend)
// re-reads the live CN line items.
//
// Differences from the DO packing-lists route, all CN-specific:
//   • Table cn_packing_lists / cn_ids (migration 0170) instead of
//     packing_lists / do_ids.
//   • REVENUE comes from loadCnValueMap (CN value is priced off the parent
//     CONSIGNMENT ORDER line, not an SO) instead of loadDoValueMap.
//   • Units / M³ are summed from consignment_items (the CN header has no
//     totalItems / totalM3 columns the way delivery_orders does) — unit count
//     = Σ item.quantity, M³ = Σ products.unitM3 × item.quantity.
//   • NO 3PL transport COST column. The 3PL cost model is DO-side only
//     (project ruling "3PL stays DO-side"); a CN packing list surfaces
//     revenue + units + M³ + stops + states, never a cost. distinct-address
//     STOPS are still computed (from each CN's destination hub address) so the
//     run-sheet reads the same as the DO one minus the Cost column.
//   • STATE / stop ADDRESS resolve via each CN's hubId → delivery_hubs
//     (consignment_notes carries no customerState / deliveryAddress columns;
//     it denormalises neither, unlike the DO row).
//
// Shared with the DO side via lib/packing-list-shared.ts: parseIds,
// genNextPackingNo (CPL- prefix), normAddr. rowToCnPackingList stays local
// because the CN money shape omits cost.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";
import { loadCnValueMap } from "../lib/cn-value";
import { parseIds, genNextPackingNo, normAddr } from "../lib/packing-list-shared";

const app = new Hono<Env>();

// cn_packing_lists is created at runtime on first use (same self-apply pattern
// as ensureQrTokenColumns in lib/do-qr-token.ts) so deploy ordering can't
// break these endpoints before migration 0170 lands. Cached per module load.
let cnPlTableEnsured: Promise<void> | null = null;
function ensureCnPackingListsTable(db: D1Database): Promise<void> {
  if (cnPlTableEnsured) return cnPlTableEnsured;
  cnPlTableEnsured = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS cn_packing_lists (
         id          text PRIMARY KEY,
         packing_no  text NOT NULL,
         status      text NOT NULL DEFAULT 'OPEN',
         cn_ids      text NOT NULL DEFAULT '[]',
         stop_count  integer NOT NULL DEFAULT 0,
         total_units integer NOT NULL DEFAULT 0,
         total_m3    numeric NOT NULL DEFAULT 0,
         remarks     text,
         created_at  timestamptz NOT NULL DEFAULT now(),
         created_by  text,
         org_id      text NOT NULL DEFAULT 'hookka'
       )`,
      "CREATE INDEX IF NOT EXISTS idx_cn_packing_lists_org ON cn_packing_lists (org_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_cn_packing_lists_no ON cn_packing_lists (org_id, packing_no)",
    ];
    await runSelfApply(db, "cn-packing-lists", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    cnPlTableEnsured = null;
    throw err;
  });
  return cnPlTableEnsured;
}

// Columns are snake_case in the SQL strings (the adapter rewrites identifiers
// IN), but every result row is read with camelCase keys (the postgres client
// camelCases result keys OUT) — same convention as the DO packing-lists route.
type CnPackingListRow = {
  id: string;
  packingNo: string;
  status: string;
  cnIds: string;
  stopCount: number;
  totalUnits: number;
  totalM3: number | string;
  remarks: string | null;
  createdAt: string | null;
  createdBy: string | null;
  orgId: string;
};

function rowToCnPackingList(
  r: CnPackingListRow,
  // Live fields computed by the list endpoint (see computeCnPackingListMoney).
  // revenueSen = Σ goods value of the PL's CNs (priced off the parent CO line);
  // cnCount = how many CNs the PL carries; stops = DISTINCT destination hub
  // addresses (several CNs to one branch are ONE stop); states = distinct
  // destination states; totalUnits / totalM3 = live Σ over the member CNs'
  // current line items. Omitted (undefined) by the single-record GET /:id,
  // which doesn't surface these.
  //
  // NOTE: there is no costSen field — the CN packing list never carries a 3PL
  // transport cost (DO-side only). This is the one shape difference from the
  // DO rowToPackingList.
  money?: {
    revenueSen: number;
    cnCount: number;
    stops: number;
    states: string[];
    totalUnits: number;
    totalM3: number;
    cnStatusCounts: { pending: number; dispatched: number; delivered: number };
  },
) {
  return {
    id: r.id,
    packingNo: r.packingNo,
    status: r.status,
    cnIds: parseIds(r.cnIds),
    stopCount: r.stopCount ?? 0,
    // Units / M³ prefer the LIVE sums over the create-time snapshot columns —
    // a CN edited after the PL was created otherwise leaves the list showing
    // stale totals while the print (live) shows the new ones. Snapshot remains
    // the fallback for the single-record GET /:id.
    totalUnits: money?.totalUnits ?? r.totalUnits ?? 0,
    totalM3: money !== undefined ? money.totalM3 : Number(r.totalM3 ?? 0),
    remarks: r.remarks ?? "",
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    revenueSen: money?.revenueSen ?? 0,
    // Live CN count + distinct-address stop count. null when not computed
    // (single-record GET) — the FE falls back to the stored snapshot.
    cnCount: money?.cnCount ?? null,
    stops: money?.stops ?? null,
    // Distinct destination states across the PL's CNs. null when not computed.
    states: money?.states ?? null,
    // Live per-status CN tally (see CnPlLiveFields). null when not computed.
    cnStatusCounts: money?.cnStatusCounts ?? null,
  };
}

function isMissingTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /relation .*cn_packing_lists.* does not exist|no such table/i.test(msg);
}

const SELECT_COLS =
  "id, packing_no, status, cn_ids, stop_count, total_units, total_m3, remarks, created_at, created_by, org_id";

// ---------------------------------------------------------------------------
// Live Revenue + Units + M³ + Stops + States for the CN Packing List view.
//
// REVENUE per PL = Σ over the PL's CNs of the CN's goods value — the SAME
// per-CN resolver (loadCnValueMap) that feeds the CN list row's valueSen, so
// the PL figure reconciles to the cent against the member CNs.
//
// UNITS / M³ per PL = Σ over the PL's CNs of (Σ item.quantity) and
// (Σ products.unitM3 × item.quantity). consignment_notes has no header total
// columns, so both are summed from consignment_items joined to products for
// the per-unit m³ (same join the CN PDF / CN list row use).
//
// STOPS per PL = number of DISTINCT destination addresses across the PL's CNs.
// A CN's destination address comes from its hubId → delivery_hubs.address
// (the CN row stores no deliveryAddress). 4 CNs to the SAME branch = 1 stop.
//
// NO COST is computed — the CN packing list has no 3PL transport-cost column
// (DO-side only, per the project ruling). All bulk: one CN read, one items
// read, one products read, one hubs read, one loadCnValueMap — no N+1.
// ---------------------------------------------------------------------------
type CnPlNoteRow = {
  id: string;
  hubId: string | null;
  status: string | null;
};

type CnPlLiveFields = {
  revenueSen: number;
  cnCount: number;
  stops: number;
  // Distinct destination states across the PL's CNs, first-seen CN order
  // (raw stored codes: KL / PG / SBH …) from each CN's hub state. Multiple
  // states on one truck run all show.
  states: string[];
  // Live Σ of the CNs' CURRENT line items. The cn_packing_lists row stores
  // create-time snapshots of these, which go stale the moment a CN is edited;
  // the list view always prefers these live sums (mirrors the DO PL fix).
  totalUnits: number;
  totalM3: number;
  // Live per-status CN tally so the PL row shows how far the truck run has
  // progressed. pending = ACTIVE, dispatched = PARTIALLY_SOLD + IN_TRANSIT,
  // delivered = FULLY_SOLD + CLOSED. RETURNED counts toward none.
  cnStatusCounts: { pending: number; dispatched: number; delivered: number };
};

export async function computeCnPackingListMoney(
  db: D1Database,
  orgId: string,
  lists: { id: string; cnIds: string[] }[],
): Promise<Map<string, CnPlLiveFields>> {
  const out = new Map<string, CnPlLiveFields>();
  // Pre-seed every PL so the caller always gets an entry.
  for (const l of lists)
    out.set(l.id, {
      revenueSen: 0,
      cnCount: 0,
      stops: 0,
      states: [],
      totalUnits: 0,
      totalM3: 0,
      cnStatusCounts: { pending: 0, dispatched: 0, delivered: 0 },
    });

  const allCnIds = [...new Set(lists.flatMap((l) => l.cnIds))];
  // Always load the value map (org-scoped). If there are no CNs at all,
  // revenue stays 0.
  const valueMap = await loadCnValueMap(db, orgId);
  if (allCnIds.length === 0) {
    return out;
  }

  // One bulk read of every CN referenced by any PL (header → hub + status).
  const ph = allCnIds.map(() => "?").join(",");
  const cnRes = await db
    .prepare(
      `SELECT id, hubId, status FROM consignment_notes WHERE orgId = ? AND id IN (${ph})`,
    )
    .bind(orgId, ...allCnIds)
    .all<CnPlNoteRow>();
  const cnById = new Map<string, CnPlNoteRow>();
  for (const c of cnRes.results ?? []) cnById.set(c.id, c);

  // Line items for every referenced CN, in one read — unit count + (with the
  // products join below) m³.
  const itemsByCn = new Map<
    string,
    { productCode: string; quantity: number }[]
  >();
  const productCodes = new Set<string>();
  {
    const itemsRes = await db
      .prepare(
        `SELECT consignmentNoteId, productCode, quantity
           FROM consignment_items WHERE orgId = ? AND consignmentNoteId IN (${ph})`,
      )
      .bind(orgId, ...allCnIds)
      .all<{
        consignmentNoteId: string;
        productCode: string | null;
        quantity: number | null;
      }>();
    for (const it of itemsRes.results ?? []) {
      const code = (it.productCode || "").trim();
      const arr = itemsByCn.get(it.consignmentNoteId) ?? [];
      arr.push({ productCode: code, quantity: Number(it.quantity) || 0 });
      itemsByCn.set(it.consignmentNoteId, arr);
      if (code) productCodes.add(code);
    }
  }

  // Per-unit m³ by product code (products.unitM3) — one bulk read. Missing /
  // zero m³ products contribute 0, exactly like the CN PDF's line m³.
  const unitM3ByCode = new Map<string, number>();
  if (productCodes.size > 0) {
    const codes = [...productCodes];
    const cph = codes.map(() => "?").join(",");
    try {
      // products keys on `code` (NOT productCode); unitM3 folds to unit_m3.
      const prodRes = await db
        .prepare(
          `SELECT code, unitM3 FROM products WHERE orgId = ? AND code IN (${cph})`,
        )
        .bind(orgId, ...codes)
        .all<{ code: string; unitM3: number | string | null }>();
      for (const p of prodRes.results ?? []) {
        const code = (p.code || "").trim();
        if (code) unitM3ByCode.set(code, Number(p.unitM3) || 0);
      }
    } catch {
      // degrade: m³ falls back to 0 if the products read fails
    }
  }

  // Destination hub address + state per CN — drives DISTINCT-address stops and
  // the states list. consignment_notes stores neither directly.
  const hubAddr = new Map<string, string>();
  const hubState = new Map<string, string>();
  {
    const hubIds = [
      ...new Set(
        (cnRes.results ?? [])
          .map((c) => (c.hubId || "").trim())
          .filter((x) => x.length > 0),
      ),
    ];
    if (hubIds.length > 0) {
      try {
        const hph = hubIds.map(() => "?").join(",");
        const hRes = await db
          .prepare(
            `SELECT id, address, state FROM delivery_hubs WHERE id IN (${hph})`,
          )
          .bind(...hubIds)
          .all<{
            id: string;
            address: string | null;
            state: string | null;
          }>();
        for (const h of hRes.results ?? []) {
          if ((h.address || "").trim()) hubAddr.set(h.id, h.address!.trim());
          if ((h.state || "").trim()) hubState.set(h.id, h.state!.trim());
        }
      } catch {
        // degrade: stops fall back to per-CN identity, states empty
      }
    }
  }

  for (const l of lists) {
    let revenueSen = 0;
    const addrSet = new Set<string>();
    let foundCns = 0;
    const states: string[] = [];
    let totalUnits = 0;
    let totalM3 = 0;
    const cnStatusCounts = { pending: 0, dispatched: 0, delivered: 0 };

    for (const cid of l.cnIds) {
      const cn = cnById.get(cid);
      if (!cn) continue; // cn_id missing — skip gracefully
      foundCns += 1;
      revenueSen += valueMap.get(cid) ?? 0;

      const items = itemsByCn.get(cid) ?? [];
      for (const it of items) {
        totalUnits += it.quantity;
        totalM3 += (unitM3ByCode.get(it.productCode) ?? 0) * it.quantity;
      }

      const hub = (cn.hubId || "").trim();
      // Stop key: the hub's address when known, else the hubId itself, else
      // the CN id (so an address-less CN still counts as its own stop rather
      // than collapsing every address-less CN into one).
      const addrKey = hub
        ? normAddr(hubAddr.get(hub)) || `hub:${hub}`
        : `cn:${cid}`;
      addrSet.add(addrKey);

      const st = (hub ? hubState.get(hub) || "" : "").toUpperCase();
      if (st && !states.includes(st)) states.push(st);

      const cnStatus = (cn.status || "").toUpperCase();
      if (cnStatus === "ACTIVE") cnStatusCounts.pending += 1;
      else if (cnStatus === "PARTIALLY_SOLD" || cnStatus === "IN_TRANSIT")
        cnStatusCounts.dispatched += 1;
      else if (cnStatus === "FULLY_SOLD" || cnStatus === "CLOSED")
        cnStatusCounts.delivered += 1;
    }

    out.set(l.id, {
      revenueSen,
      cnCount: foundCns,
      stops: addrSet.size,
      states,
      totalUnits,
      totalM3: Math.round(totalM3 * 100) / 100,
      cnStatusCounts,
    });
  }
  return out;
}

// GET / — list all CN packing lists for the org (newest first).
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  try {
    await ensureCnPackingListsTable(c.var.DB);
    const res = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cn_packing_lists WHERE org_id = ? ORDER BY packing_no DESC`,
    )
      .bind(orgId)
      .all<CnPackingListRow>();
    const rows = res.results ?? [];
    // Compute Revenue + Units + M³ + Stops + States LIVE so existing PLs also
    // show values.
    const money = await computeCnPackingListMoney(
      c.var.DB,
      orgId,
      rows.map((r) => ({ id: r.id, cnIds: parseIds(r.cnIds) })),
    );
    const data = rows.map((r) =>
      rowToCnPackingList(
        r,
        money.get(r.id) ?? {
          revenueSen: 0,
          cnCount: 0,
          stops: 0,
          states: [],
          totalUnits: 0,
          totalM3: 0,
          cnStatusCounts: { pending: 0, dispatched: 0, delivered: 0 },
        },
      ),
    );
    return c.json({ success: true, data, total: data.length });
  } catch (e) {
    // Table not migrated yet — don't break the CN page; return empty.
    if (isMissingTable(e)) return c.json({ success: true, data: [], total: 0 });
    throw e;
  }
});

// GET /:id — one CN packing list WITH its CNs + items assembled, ready for the
// consolidated CN packing-list PDF. Reads the LIVE consignment notes (not the
// snapshot), so the printed sheet reflects current line items. The frontend
// re-builds each CN's full branded document from this payload via
// buildCnPdfData + printCnPackingList.
app.get("/:id", async (c) => {
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  try {
    await ensureCnPackingListsTable(c.var.DB);
    const pl = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cn_packing_lists WHERE id = ? AND org_id = ?`,
    )
      .bind(id, orgId)
      .first<CnPackingListRow>();
    if (!pl)
      return c.json({ success: false, error: "Packing list not found." }, 404);

    const cnIds = parseIds(pl.cnIds);
    // Return the member CN ids in the operator's selection order. The frontend
    // already holds the full CN rows in cnList (it builds each CN's PDF via the
    // shared buildCnPdfData from the row it already has), so the saved record
    // only needs to tell it WHICH CNs and in WHAT order — mirroring how the DO
    // packing-list print re-hydrates each member from the saved id list.
    return c.json({
      success: true,
      data: { ...rowToCnPackingList(pl), cnIds },
    });
  } catch (e) {
    if (isMissingTable(e))
      return c.json(
        { success: false, error: "CN packing list storage is not set up yet." },
        503,
      );
    throw e;
  }
});

// ---------------------------------------------------------------------------
// CN packing-list creation core — extracted (like createPackingListCore on the
// DO side) so the POST route maps its result 1:1 onto HTTP responses and a
// future caller can reuse the exact validation + insert + audit path.
// ---------------------------------------------------------------------------
export type CnPackingListCreateOutcome =
  | {
      ok: true;
      data: ReturnType<typeof rowToCnPackingList> | null;
      id: string;
      packingNo: string;
    }
  | {
      ok: false;
      status: 400 | 503;
      body: { success: false; error: string };
    };

export async function createCnPackingListCore(
  c: Context<Env>,
  orgId: string,
  input: { cnIds?: string[]; remarks?: string },
): Promise<CnPackingListCreateOutcome> {
  try {
    await ensureCnPackingListsTable(c.var.DB);
    const cnIds = Array.isArray(input.cnIds)
      ? [...new Set(input.cnIds.filter((x) => typeof x === "string" && x))]
      : [];
    if (cnIds.length === 0) {
      return {
        ok: false,
        status: 400,
        body: { success: false, error: "Select at least one consignment note." },
      };
    }

    // Validate the CNs exist (in this org). The CN header has no totalItems /
    // totalM3 columns, so the create-time unit/volume snapshot is summed from
    // the line items below.
    const ph = cnIds.map(() => "?").join(",");
    const cnRes = await c.var.DB.prepare(
      `SELECT id, noteNumber FROM consignment_notes WHERE id IN (${ph}) AND orgId = ?`,
    )
      .bind(...cnIds, orgId)
      .all<{ id: string; noteNumber: string }>();
    const found = cnRes.results ?? [];
    if (found.length !== cnIds.length) {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          error: "Some selected consignment notes no longer exist.",
        },
      };
    }

    // Business rule: a CN can belong to only ONE packing list. Scan existing.
    const existing = await c.var.DB.prepare(
      "SELECT packing_no, cn_ids FROM cn_packing_lists WHERE org_id = ?",
    )
      .bind(orgId)
      .all<{ packingNo: string; cnIds: string }>();
    const usedBy = new Map<string, string>(); // cnId -> packingNo
    for (const row of existing.results ?? []) {
      for (const cid of parseIds(row.cnIds)) usedBy.set(cid, row.packingNo);
    }
    const conflictIds = cnIds.filter((d) => usedBy.has(d));
    if (conflictIds.length > 0) {
      const labels = found
        .filter((f) => conflictIds.includes(f.id))
        .map((f) => `${f.noteNumber} (already in ${usedBy.get(f.id)})`);
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          error: `These consignment notes are already in another packing list: ${labels.join(
            ", ",
          )}. Remove them from that list first.`,
        },
      };
    }

    // Create-time unit/volume snapshot, summed from the member CNs' line items
    // (header has no totals). The list view recomputes these live anyway; the
    // snapshot is the single-record GET fallback.
    let totalUnits = 0;
    let totalM3 = 0;
    {
      const itemsRes = await c.var.DB.prepare(
        `SELECT consignmentNoteId, productCode, quantity
           FROM consignment_items WHERE orgId = ? AND consignmentNoteId IN (${ph})`,
      )
        .bind(orgId, ...cnIds)
        .all<{
          consignmentNoteId: string;
          productCode: string | null;
          quantity: number | null;
        }>();
      const codes = [
        ...new Set(
          (itemsRes.results ?? [])
            .map((it) => (it.productCode || "").trim())
            .filter((x) => x.length > 0),
        ),
      ];
      const unitM3ByCode = new Map<string, number>();
      if (codes.length > 0) {
        const cph = codes.map(() => "?").join(",");
        try {
          // products keys on `code` (NOT productCode); unitM3 folds to unit_m3.
          const prodRes = await c.var.DB.prepare(
            `SELECT code, unitM3 FROM products WHERE orgId = ? AND code IN (${cph})`,
          )
            .bind(orgId, ...codes)
            .all<{ code: string; unitM3: number | string | null }>();
          for (const p of prodRes.results ?? []) {
            const code = (p.code || "").trim();
            if (code) unitM3ByCode.set(code, Number(p.unitM3) || 0);
          }
        } catch {
          // degrade: snapshot m³ stays 0; live recompute fills it on the list
        }
      }
      for (const it of itemsRes.results ?? []) {
        const qty = Number(it.quantity) || 0;
        totalUnits += qty;
        totalM3 += (unitM3ByCode.get((it.productCode || "").trim()) ?? 0) * qty;
      }
    }
    totalM3 = Math.round(totalM3 * 100) / 100;

    const stopCount = cnIds.length;
    const id = `cpl-${crypto.randomUUID().slice(0, 8)}`;
    const packingNo = await genNextPackingNo(
      c.var.DB,
      "cn_packing_lists",
      "CPL",
      orgId,
    );
    const now = new Date().toISOString();
    const remarks = (input.remarks || "").trim() || null;

    await c.var.DB.prepare(
      `INSERT INTO cn_packing_lists (id, packing_no, status, cn_ids, stop_count, total_units, total_m3, remarks, created_at, created_by, org_id)
       VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        packingNo,
        JSON.stringify(cnIds),
        stopCount,
        totalUnits,
        totalM3,
        remarks,
        now,
        null,
        orgId,
      )
      .run();

    await emitAudit(c, {
      resource: "cn-packing-lists",
      resourceId: id,
      action: "create",
      after: { packingNo, cnIds, stopCount, totalUnits, totalM3 },
    });

    const created = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM cn_packing_lists WHERE id = ?`,
    )
      .bind(id)
      .first<CnPackingListRow>();
    return {
      ok: true,
      data: created ? rowToCnPackingList(created) : null,
      id,
      packingNo,
    };
  } catch (e) {
    if (isMissingTable(e)) {
      return {
        ok: false,
        status: 503,
        body: {
          success: false,
          error:
            "CN packing list storage is not set up yet. Apply migration 0170.",
        },
      };
    }
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: e instanceof Error ? e.message : "Invalid request body",
      },
    };
  }
}

// POST / — create a CN packing list from selected consignment notes.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "create");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const body = await c.req.json<{ cnIds?: string[]; remarks?: string }>();
    const result = await createCnPackingListCore(c, orgId, body);
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ success: true, data: result.data }, 201);
  } catch (e) {
    // createCnPackingListCore handles its own DB errors; this catch now only
    // sees body-parse failures.
    if (isMissingTable(e)) {
      return c.json(
        {
          success: false,
          error:
            "CN packing list storage is not set up yet. Apply migration 0170.",
        },
        503,
      );
    }
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid request body",
      },
      400,
    );
  }
});

// DELETE /:id — remove a CN packing list (frees its CNs to be re-grouped).
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "delete");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  try {
    await ensureCnPackingListsTable(c.var.DB);
    const existing = await c.var.DB.prepare(
      "SELECT id FROM cn_packing_lists WHERE id = ? AND org_id = ?",
    )
      .bind(id, orgId)
      .first<{ id: string }>();
    if (!existing)
      return c.json({ success: false, error: "Packing list not found." }, 404);
    await c.var.DB.prepare(
      "DELETE FROM cn_packing_lists WHERE id = ? AND org_id = ?",
    )
      .bind(id, orgId)
      .run();
    await emitAudit(c, {
      resource: "cn-packing-lists",
      resourceId: id,
      action: "delete",
    });
    return c.json({ success: true });
  } catch (e) {
    if (isMissingTable(e))
      return c.json(
        { success: false, error: "CN packing list storage is not set up yet." },
        503,
      );
    throw e;
  }
});

export default app;

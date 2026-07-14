// ---------------------------------------------------------------------------
// D1-backed Consignment Notes route.
//
// Shares consignment_notes + consignment_items tables with routes/consignments.ts.
// This surface exposes a slightly different API:
//   - GET   /     — list
//   - POST  /     — create (no customer validation)
//   - PATCH /     — update status/notes/branchName + dispatch lifecycle by body.id
//   - PUT   /:id  — same as PATCH but addressed by URL param (FE alias)
//
// Row mapping + carrier resolution lives in api/lib/consignment-note-shared.ts
// so this file and consignments.ts stay in lock-step.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  type ConsignmentNoteRow,
  type ConsignmentItemRow,
  rowToConsignmentNote,
  genNoteId,
  genItemId,
  nextConsignmentNoteNumber,
  resolveTransport,
  updateConsignmentNoteById,
  validatePOMutex,
  CN_VALID_TRANSITIONS,
} from "../lib/consignment-note-shared";
import { cascadeCNCompletionToCO, cascadeCNReversalToCO } from "./production-orders";
import { fetchFilteredPOs } from "./production-orders";
import {
  buildCnReadyPlanning,
  isHbOnlySpecial,
  type CnReadyPlanningPO,
} from "../../lib/delivery-pipeline";
import { aggregateRacksFromPackingCards } from "../../lib/rack-format";
import { nextInvoiceNo } from "./invoices";
import { getOrgId } from "../lib/tenant";
import { loadCnValueMap, loadCnCustomerRefMap } from "../lib/cn-value";
import { emitAudit } from "../lib/audit";
import { requirePermission } from "../lib/rbac";
import { enqueueEmail } from "../lib/email-outbox";
import {
  cnDispatchNoticeTemplate,
  resolveDispatchRecipient,
} from "../lib/customer-notify";
import {
  selectBestBomByCode,
  piecesFor,
  deriveComponentRacks,
  type BomForCode,
  type PackingJcRow,
} from "../lib/print-extras-shared";

const app = new Hono<Env>();

// GET /api/consignment-notes
//
// Pagination: ?page=1&limit=200. FE list (consignment/note.tsx:540) sends
// these and expects {data, page, limit, total}. Without honoring them this
// route returned the whole CN table on every list-render — fine while CN
// count was small, but it's a scaling cliff once volume crosses a few
// hundred (mirrors /api/delivery-orders/list).
//
// items still loads the full table — N+1 join would defeat the page win,
// and the FE only consumes items for visible CN rows. Keep parity with
// DO list behaviour.
app.get("/", async (c) => {
  const status = c.req.query("status");
  const customerId = c.req.query("customerId");
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  // Optional index-backed search (global Ctrl+K palette, ?search=). Partial
  // match on note number / customer / branch; fires ONLY when present, so
  // the CN list page (no search param) keeps the exact legacy query. The
  // linked CO numbers are deliberately NOT searched: this endpoint never
  // joins consignment_orders (the FE resolves CO numbers client-side via
  // production_orders), and adding a join just for search would change the
  // list query shape. Mirrors the ?search pattern on /api/delivery-orders.
  const q = (c.req.query("search") || c.req.query("q") || "").trim();
  const clauses: string[] = [];
  const params: string[] = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (customerId) {
    clauses.push("customerId = ?");
    params.push(customerId);
  }
  if (q) {
    clauses.push("(noteNumber ILIKE ? OR customerName ILIKE ? OR branchName ILIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Pagination defaults: no params → return everything (legacy callers).
  let page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : null;
  const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : null;
  // The palette sends ?search=&limit=5 with no ?page. Under the legacy
  // contract (page AND limit both required) the limit would silently not
  // apply and a search would return every match. Default the page only
  // when a search is active so no-search callers keep the exact legacy
  // limit-ignored behavior.
  if (q && limit !== null && page === null) page = 1;

  const totalRes = await c.var.DB
    .prepare(`SELECT COUNT(*) AS n FROM consignment_notes ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const total = Number(totalRes?.n ?? 0);

  let listSql = `SELECT * FROM consignment_notes ${where} ORDER BY noteNumber DESC`;
  const listParams: string[] = [...params];
  if (page !== null && limit !== null) {
    const offset = (page - 1) * limit;
    listSql += ` LIMIT ${limit} OFFSET ${offset}`;
  }

  // valueSen + parent-CO customer refs bring the CN list row to parity with
  // the DO list row (delivery-orders.ts wires loadDoValueMap the same way).
  // Both are whole-org bulk loads (no N+1) resolved per CN below — see
  // api/lib/cn-value.ts. These ADD fields only; existing columns
  // (status / M³ / carrier / items) are untouched.
  const orgId = getOrgId(c);
  const notesRes = await c.var.DB
    .prepare(listSql)
    .bind(...listParams)
    .all<ConsignmentNoteRow>();
  const noteRows = notesRes.results ?? [];
  // Scope items to the page's notes — the old `SELECT * FROM consignment_items`
  // loaded the whole table and defeated the notes pagination above.
  // valueMap/custRefMap stay parallel with the (now scoped) items read.
  const noteIds = noteRows.map((r) => r.id);
  const [itemsRes, valueMap, custRefMap] = await Promise.all([
    noteIds.length
      ? c.var.DB
          .prepare(
            `SELECT * FROM consignment_items WHERE consignmentNoteId IN (${noteIds.map(() => "?").join(", ")})`,
          )
          .bind(...noteIds)
          .all<ConsignmentItemRow>()
      : Promise.resolve({ results: [] as ConsignmentItemRow[] }),
    loadCnValueMap(c.var.DB, orgId),
    loadCnCustomerRefMap(c.var.DB, orgId),
  ]);
  const data = noteRows.map((r) => {
    const ref = custRefMap.get(r.id);
    return {
      ...rowToConsignmentNote(r, itemsRes.results ?? []),
      valueSen: valueMap.get(r.id) ?? 0,
      customerPOId: ref?.customerPOId ?? "",
      customerCO: ref?.customerCO ?? "",
      reference: ref?.reference ?? "",
    };
  });
  return c.json({
    success: true,
    data,
    total,
    ...(page !== null && limit !== null ? { page, limit } : {}),
  });
});

// COMPLETE set of production-order ids already on a non-cancelled Consignment
// Note — the authoritative "already consigned" set, NOT capped by the CN list
// page. note.tsx's "ready" list MUST use this to exclude POs already on a CN;
// a capped CN fetch under-excluded once CN volume passed one page (the CN twin
// of the DO BUG-2026-06-27). One cheap DISTINCT.
app.get("/linked-po-ids", async (c) => {
  const res = await c.var.DB
    .prepare(
      `SELECT DISTINCT ci.productionOrderId AS poId
         FROM consignment_items ci
         JOIN consignment_notes cn ON cn.id = ci.consignmentNoteId
        WHERE ci.productionOrderId IS NOT NULL
          AND ci.productionOrderId <> ''
          AND cn.status <> 'CANCELLED'`,
    )
    .all<{ poId?: string | null }>();
  const poIds = (res.results ?? [])
    .map((r) => r.poId)
    .filter((x): x is string => !!x);
  return c.json({ success: true, poIds });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-notes/ready-planning — server-side Planning / Pending-CN.
//
// Perf 2026-07-14: the CN Note page used to pull the whole ~1.2MB
// /api/production-orders?fields=minimal&include=jobCards (plus /consignment-orders
// and /linked-po-ids) ONLY to derive its Planning + Pending-CN PO lists
// client-side. This assembles the SAME inputs server-side and runs the SHARED
// buildCnReadyPlanning (src/lib/delivery-pipeline.ts, extracted verbatim from the
// page's mapPO + filters) → the rows are byte-identical by construction. These
// rows carry NO money (CN amounts live on the CN records), so this is a pure
// PO-listing derivation. Snapshot-cached + serve-stale so the page's cold paint
// never blocks on the ~8s whole-org compute (BUG-2026-07-13-001). Freshness tracks
// production_orders / job_cards / consignment_items / consignment_notes /
// consignment_orders. Registered BEFORE /:id (Hono static-first).
// ---------------------------------------------------------------------------
app.get("/ready-planning", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "read");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const db = c.var.DB;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS consignment_ready_planning_snapshot (
         org_id        TEXT NOT NULL,
         cache_key     TEXT NOT NULL DEFAULT '',
         data          JSONB NOT NULL,
         built_from    TIMESTAMP NOT NULL,
         built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
         refresh_count INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (org_id, cache_key)
       )`,
    )
    .run();

  const { withSnapshot } = await import("../lib/snapshot");
  const data = await withSnapshot(
    db,
    {
      tableName: "consignment_ready_planning_snapshot",
      sourceTables: [
        "production_orders",
        "job_cards",
        "consignment_items",
        "consignment_notes",
        "consignment_orders",
      ],
    },
    orgId,
    async () => {
      const [pos, coRes, linkedRes, legacyRes, cnRefRes] = await Promise.all([
        fetchFilteredPOs(db, orgId, null, true, false, true),
        db
          .prepare(
            "SELECT id, hookkaExpectedDD, companyCOId, customerId FROM consignment_orders WHERE orgId = ?",
          )
          .bind(orgId)
          .all<{
            id: string;
            hookkaExpectedDD?: string;
            companyCOId?: string;
            customerId?: string;
          }>(),
        // PO ids already on a non-cancelled CN — the dedup set (mirrors
        // GET /linked-po-ids above). NOT capped by any browse page.
        db
          .prepare(
            `SELECT DISTINCT ci.productionOrderId AS poId
               FROM consignment_items ci
               JOIN consignment_notes cn ON cn.id = ci.consignmentNoteId
              WHERE ci.orgId = ?
                AND ci.productionOrderId IS NOT NULL
                AND ci.productionOrderId <> ''
                AND cn.status <> 'CANCELLED'`,
          )
          .bind(orgId)
          .all<{ poId?: string | null }>(),
        // Legacy fallback: customers with an ACTIVE/PARTIALLY_SOLD CN whose items
        // carry NO productionOrderId (pre-0066). Computed over ALL CNs (the page
        // walked only its loaded 200-CN window — this is the same set, uncapped).
        db
          .prepare(
            `SELECT DISTINCT cn.customerId AS customerId
               FROM consignment_notes cn
              WHERE cn.orgId = ?
                AND cn.status IN ('ACTIVE', 'PARTIALLY_SOLD')
                AND NOT EXISTS (
                  SELECT 1 FROM consignment_items ci
                   WHERE ci.consignmentNoteId = cn.id
                     AND ci.productionOrderId IS NOT NULL
                     AND ci.productionOrderId <> ''
                )`,
          )
          .bind(orgId)
          .all<{ customerId?: string | null }>(),
        // Every PO id referenced by a CN item (any status) — the FE builds
        // poToCoNoMap / poToFabricMap / poToRackMap from these to enrich the CN
        // Detail/browse item rows with companyCOId / fabricCode / rack. Scoping
        // the lookups to this set keeps the payload tiny (vs the whole PO list).
        db
          .prepare(
            `SELECT DISTINCT productionOrderId AS poId
               FROM consignment_items
              WHERE orgId = ?
                AND productionOrderId IS NOT NULL
                AND productionOrderId <> ''`,
          )
          .bind(orgId)
          .all<{ poId?: string | null }>(),
      ]);

      const coMap = new Map<
        string,
        { hookkaExpectedDD: string; companyCOId: string; customerId: string }
      >();
      for (const co of coRes.results ?? []) {
        coMap.set(co.id, {
          hookkaExpectedDD: co.hookkaExpectedDD || "",
          companyCOId: co.companyCOId || "",
          customerId: co.customerId || "",
        });
      }

      const cnLinkedPOIds = new Set(
        (linkedRes.results ?? [])
          .map((r) => r.poId)
          .filter((x): x is string => !!x),
      );
      const cnLinkedCustomersLegacy = new Set(
        (legacyRes.results ?? [])
          .map((r) => r.customerId)
          .filter((x): x is string => !!x),
      );

      // productCode → unitM3 (mirrors loadProductM3Map; small SELECT).
      const codes = Array.from(
        new Set(
          (pos as Array<{ productCode?: string }>)
            .map((p) => p.productCode)
            .filter((x): x is string => !!x),
        ),
      );
      const productM3Map = new Map<string, number>();
      if (codes.length > 0) {
        const ph = codes.map(() => "?").join(",");
        const m3Res = await db
          .prepare(`SELECT code, unitM3 FROM products WHERE code IN (${ph})`)
          .bind(...codes)
          .all<{ code: string; unitM3: number }>();
        for (const r of m3Res.results ?? []) {
          productM3Map.set(r.code, Number(r.unitM3) || 0);
        }
      }

      const { planning, ready } = buildCnReadyPlanning({
        allPOs: pos as unknown as CnReadyPlanningPO[],
        coMap,
        cnLinkedPOIds,
        cnLinkedCustomersLegacy,
        productM3Map,
      });

      // poLookups: companyCOId / fabricCode / rack for every CN-referenced PO,
      // built from the SAME `pos` the FE's poToCoNoMap / poToFabricMap /
      // poToRackMap read (rack aggregated per-piece from the PACKING cards with
      // the HB-only DIVAN drop — byte-identical to the page's inline maps).
      const posById = new Map(
        (pos as unknown as CnReadyPlanningPO[]).map((p) => [p.id, p]),
      );
      const refIds = new Set(
        (cnRefRes.results ?? [])
          .map((r) => r.poId)
          .filter((x): x is string => !!x),
      );
      const poLookups: Array<{
        id: string;
        companyCOId: string;
        fabricCode: string;
        rack: string;
      }> = [];
      for (const id of refIds) {
        const po = posById.get(id);
        if (!po) continue;
        const hbOnly =
          (po.itemCategory || "").toUpperCase() === "BEDFRAME" &&
          isHbOnlySpecial(po.specialOrder);
        const packingCards = (po.jobCards ?? []).filter(
          (j) => j.departmentCode === "PACKING",
        );
        poLookups.push({
          id,
          companyCOId: po.companyCOId || "",
          fabricCode: po.fabricCode || "",
          rack: aggregateRacksFromPackingCards(packingCards, {
            dropDivan: hbOnly,
          }),
        });
      }

      return { planning, ready, poLookups };
    },
    // cache_key carries the payload-SHAPE version — bump it whenever the compute
    // output shape changes (added poLookups → v2), else withSnapshot keeps
    // serving the old cached blob as "fresh" until a source table happens to
    // change (it tracks source-table mtimes, not code). v1 → v2 = +poLookups.
    "v2",
    c,
    { staleWhileRevalidate: true },
  );

  return c.json({ success: true, ...data });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-notes/stats — whole-dataset KPI / tab counts.
//
// Mirrors the rationale behind /api/delivery-orders/stats: the CN list is
// paginated to PAGE_SIZE on the FE, but the KPI strip + tab badges need
// to reflect the FULL dataset, not just the current page. Once production
// CN volume goes past a single page, computing counts client-side from
// `cnList` undercounts every metric.
//
// Bucket → status mapping (legacy CN status enum, the FE re-skins):
//   pendingDispatch  ← status='ACTIVE'           (Pending Dispatch tab)
//   dispatched       ← status='PARTIALLY_SOLD'   (Dispatched tab — the goods left
//                                                  the warehouse but haven't
//                                                  reached the branch yet)
//   inTransit        ← status='IN_TRANSIT'       (In Transit tab — added with
//                                                  migration 0078; mirrors DO's
//                                                  3-state shipping lane)
//   delivered        ← status='FULLY_SOLD'       (Delivered tab)
//   acknowledged     ← status='CLOSED'           (Acknowledged tab)
//   deliveredMTD     ← FULLY_SOLD AND deliveredAt ≥ start-of-current-month UTC
//                                                (KPI: deliveries booked
//                                                 month-to-date)
//
// pendingCN intentionally NOT computed server-side — the derivation is
// the multi-step JOIN-and-filter "CO-origin POs that are fully UPHOLSTERY-
// complete AND not on any consignment_note", which is a rewrite of the FE's
// readyPOs computation in note.tsx (~lines 933-947). Doing it correctly
// requires loading production_orders + their job_cards + the linked CN
// items just for a count, which is more work than the rest of /stats put
// together. The FE keeps its current readyPOs-based pendingCNCount for
// now; follow-up if it ever shows undercount on a production dataset.
//
// Registered BEFORE the PUT /:id wildcard per the project memory note
// about Hono route ordering (static routes before /:id wildcards or they
// get swallowed). The two GET routes (this one + GET /) live above the
// POST/PATCH/PUT routes; static path "/stats" + parameterless GET means
// no collision with the PUT /:id route registered later in the file.
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const orgId = getOrgId(c);
  const { withSnapshot } = await import("../lib/snapshot");
  // PR 7 — cache-aside snapshot.
  const data = await withSnapshot(
    c.var.DB,
    {
      tableName: "consignment_notes_stats_snapshot",
      sourceTables: ["consignment_notes"],
    },
    orgId,
    async () => {
      const aggRes = await c.var.DB
        .prepare(
          "SELECT status, COUNT(*) AS n FROM consignment_notes GROUP BY status",
        )
        .all<{ status: string; n: number }>();
      const byStatus: Record<string, number> = {};
      for (const row of aggRes.results ?? []) {
        byStatus[row.status] = Number(row.n) || 0;
      }
      const now = new Date();
      const startOfMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      ).toISOString();
      const mtdRes = await c.var.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM consignment_notes
             WHERE status = 'FULLY_SOLD' AND deliveredAt >= ?`,
        )
        .bind(startOfMonth)
        .first<{ n: number }>();
      const deliveredMTD = Number(mtdRes?.n) || 0;
      return {
        data: {
          pendingDispatch: byStatus.ACTIVE ?? 0,
          dispatched: byStatus.PARTIALLY_SOLD ?? 0,
          inTransit: byStatus.IN_TRANSIT ?? 0,
          delivered: byStatus.FULLY_SOLD ?? 0,
          deliveredMTD,
          acknowledged: byStatus.CLOSED ?? 0,
        },
      };
    },
  );
  return c.json({ success: true, ...data });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-notes/:id/print-extras
//
// CN twin of GET /api/delivery-orders/:id/print-extras (CN/DO FE parity P3,
// 2026-06-12). Returns the per-CN-item rich detail the CN PDF prints exactly
// like the DO PDF: itemCategory + the bedframe build spec (gap / divan / leg
// height, total derived as their sum), specialOrder, the BOM `pieces`
// breakdown ("1 HB + 2 DIVAN"), and per-component warehouse racks
// (componentRacks) + packedDate from the line's PACKING job cards.
//
// `items` is keyed by consignment_items.id (the same id the FE row carries),
// mirroring how the DO endpoint keys by delivery_order_items.id, so the print
// page can merge this into its CNPdfData payload per line.
//
// Config source per line (first hit wins, identical precedence to DO):
//   1. production_orders (via consignment_items.productionOrderId)
//   2. the parent CO line  (consignment_order_items matched by the CN's
//      consignmentOrderId + productCode) — fallback for POs that never had
//      itemCategory / divan / leg / gap / special copied onto them.
// pieces + componentRacks come from the SAME shared helpers the DO endpoint
// uses (src/api/lib/print-extras-shared.ts), so the two documents can't drift.
//
// Registered as a GET, so it never collides with the PUT /:id mutation below
// (Hono matches on method + path). Reuses the consignment-notes:read scope.
app.get("/:id/print-extras", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const cnRow = await c.var.DB.prepare(
    "SELECT id, consignmentOrderId FROM consignment_notes WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; consignmentOrderId: string | null }>();
  if (!cnRow) {
    return c.json({ success: false, error: "Consignment note not found" }, 404);
  }

  // CN line items + their production order (config + BOM + racking join key).
  const itRes = await c.var.DB.prepare(
    `SELECT ci.id,
            ci.productCode,
            ci.quantity,
            ci.productionOrderId,
            po.itemCategory AS itemCategory,
            po.specialOrder AS specialOrder,
            po.gapInches AS gapInches,
            po.divanHeightInches AS divanHeightInches,
            po.legHeightInches AS legHeightInches,
            po.fabricCode AS fabricCode,
            po.sizeLabel AS sizeLabel
       FROM consignment_items ci
       LEFT JOIN production_orders po ON po.id = ci.productionOrderId
      WHERE ci.consignmentNoteId = ?`,
  )
    .bind(id)
    .all<{
      id: string;
      productCode: string | null;
      quantity: number | null;
      productionOrderId: string | null;
      itemCategory: string | null;
      specialOrder: string | null;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      fabricCode: string | null;
      sizeLabel: string | null;
    }>();

  // Config fallback from the parent CO line, keyed by productCode (the CN's
  // consignmentOrderId is the parent CO). Mirrors DO's sales_order_items
  // fallback: prefer the production order, fill every blank from the CO line.
  // consignment_order_items has no totalHeightInches column (same as the SO
  // table) — total height is derived as gap + divan + leg below.
  type CoSpec = {
    itemCategory: string | null;
    gapInches: number | null;
    divanHeightInches: number | null;
    legHeightInches: number | null;
    specialOrder: string | null;
  };
  const coSpecByCode = new Map<string, CoSpec>();
  if (cnRow.consignmentOrderId) {
    const coiRes = await c.var.DB.prepare(
      `SELECT productCode, itemCategory, gapInches, divanHeightInches,
              legHeightInches, specialOrder
         FROM consignment_order_items
        WHERE consignmentOrderId = ?`,
    )
      .bind(cnRow.consignmentOrderId)
      .all<{
        productCode: string | null;
        itemCategory: string | null;
        gapInches: number | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        specialOrder: string | null;
      }>();
    for (const s of coiRes.results ?? []) {
      const pc = (s.productCode || "").trim();
      if (!pc) continue;
      // First line per product code wins; fill any blank from later lines.
      const prev = coSpecByCode.get(pc);
      coSpecByCode.set(pc, {
        itemCategory: prev?.itemCategory ?? s.itemCategory ?? null,
        gapInches: prev?.gapInches ?? s.gapInches ?? null,
        divanHeightInches: prev?.divanHeightInches ?? s.divanHeightInches ?? null,
        legHeightInches: prev?.legHeightInches ?? s.legHeightInches ?? null,
        specialOrder: prev?.specialOrder ?? s.specialOrder ?? null,
      });
    }
  }

  // Piece breakdown straight from the product BOM — same source production
  // uses (bom_templates.wipComponents → breakBomIntoWips), shared with DO.
  const codes = Array.from(
    new Set(
      (itRes.results ?? [])
        .map((r) => (r.productCode || "").trim())
        .filter(Boolean),
    ),
  );
  const bomByCode = new Map<string, BomForCode>();
  if (codes.length > 0) {
    const ph = codes.map(() => "?").join(",");
    const bomRes = await c.var.DB.prepare(
      `SELECT productCode, baseModel, wipComponents, versionStatus, effectiveFrom
         FROM bom_templates WHERE productCode IN (${ph})`,
    )
      .bind(...codes)
      .all<{
        productCode: string | null;
        baseModel: string | null;
        wipComponents: string | null;
        versionStatus: string | null;
        effectiveFrom: string | null;
      }>();
    for (const [pc, v] of selectBestBomByCode(bomRes.results ?? []))
      bomByCode.set(pc, v);
  }

  // Per-component PACKING job cards for the CN's production orders — the ONLY
  // place the per-component rack + packing completion live (one PACKING JC per
  // top-level component). Same bulk read + grouping as the DO endpoint.
  const diPoById = new Map<string, string>();
  for (const r of itRes.results ?? []) {
    if (r.id && r.productionOrderId) diPoById.set(r.id, r.productionOrderId);
  }
  const packingJcsByPo = new Map<string, PackingJcRow[]>();
  {
    const poIds = Array.from(new Set(diPoById.values()));
    if (poIds.length > 0) {
      const ph = poIds.map(() => "?").join(",");
      const jcRes = await c.var.DB.prepare(
        `SELECT productionOrderId, wipType, wipLabel, rackingNumber,
                completedDate, status
           FROM job_cards
          WHERE departmentCode = 'PACKING' AND productionOrderId IN (${ph})`,
      )
        .bind(...poIds)
        .all<PackingJcRow>();
      for (const jc of jcRes.results ?? []) {
        const pid = jc.productionOrderId || "";
        if (!pid) continue;
        const list = packingJcsByPo.get(pid);
        if (list) list.push(jc);
        else packingJcsByPo.set(pid, [jc]);
      }
    }
  }

  const items: Record<
    string,
    {
      itemCategory: string | null;
      specialOrder: string | null;
      pieces: string | null;
      gapInches: number | null;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      totalHeightInches: number | null;
      packedDate: string | null;
      componentRacks: { label: string; racks: string[] }[];
    }
  > = {};
  for (const r of itRes.results ?? []) {
    const pc = (r.productCode || "").trim();
    const fb = coSpecByCode.get(pc);
    // production order first; CO line fills every blank.
    const g = r.gapInches ?? fb?.gapInches ?? null;
    const d = r.divanHeightInches ?? fb?.divanHeightInches ?? null;
    const l = r.legHeightInches ?? fb?.legHeightInches ?? null;
    const itemCategory = r.itemCategory ?? fb?.itemCategory ?? null;
    const specialOrder = r.specialOrder ?? fb?.specialOrder ?? null;
    const total =
      g == null && d == null && l == null
        ? null
        : (Number(g) || 0) + (Number(d) || 0) + (Number(l) || 0);
    const bom = bomByCode.get(pc);
    const pieces = bom
      ? piecesFor({
          code: r.productCode || "",
          baseModel: bom.baseModel,
          wipComponents: bom.wipComponents,
          cat: itemCategory,
          special: specialOrder,
          sizeLabel: r.sizeLabel || "",
          fabricCode: r.fabricCode || "",
          gapInches: g,
          divanHeightInches: d,
          legHeightInches: l,
          qty: Number(r.quantity) || 1,
        })
      : null;
    const { packedDate, componentRacks } = deriveComponentRacks(
      packingJcsByPo.get(diPoById.get(r.id) || "") ?? [],
      itemCategory,
      specialOrder,
    );
    items[r.id] = {
      itemCategory,
      specialOrder,
      pieces,
      gapInches: g,
      divanHeightInches: d,
      legHeightInches: l,
      totalHeightInches: total,
      packedDate,
      componentRacks,
    };
  }

  return c.json({ success: true, data: { items } });
});

// POST /api/consignment-notes
//
// Body shape (all fields optional unless noted):
//   customerId?, customerName?, branchName?, type?, sentDate?, notes?
//   hubId?                       — delivery_hubs row, drives branchName fallback
//   consignmentOrderId?          — parent CO id (FK to consignment_orders)
//   providerId? / driverId? / vehicleId?
//                                — 3PL refactor lookup (see resolveTransport)
//   driverName? driverPhone? driverContactPerson? vehicleNo? vehicleType?
//                                — explicit overrides for the resolved values
//   productionOrderIds?: string[]
//                                — when provided, INSERT one consignment_items
//                                  row per PO with production_order_id set.
//                                  Mirrors DO's "create from Pending Delivery"
//                                  flow. Each item picks productCode +
//                                  productName + quantity from production_orders.
//   items?: Array<{...}>         — explicit items array (legacy callers).
//                                  Used as a fallback when productionOrderIds
//                                  isn't passed.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const now = new Date();
    const noteNumber = await nextConsignmentNoteNumber(c.var.DB, now);
    const id = genNoteId();

    // Resolve hub → branchName + state. Mirrors how DO denormalizes
    // hubName/customerState from delivery_hubs at insert time.
    let resolvedBranchName = (body.branchName as string | undefined) ?? "";
    const hubId = (body.hubId as string | undefined) ?? null;
    if (hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT id, shortName FROM delivery_hubs WHERE id = ?",
      )
        .bind(hubId)
        .first<{ id: string; shortName: string | null }>();
      if (hub && !resolvedBranchName) {
        resolvedBranchName = hub.shortName ?? "";
      }
    }
    // No customer_state column on consignment_notes (unlike delivery_orders),
    // so we don't denormalize the hub's state here. The hub_id FK is enough
    // for downstream reads to JOIN delivery_hubs when state is needed.

    // Carrier resolution (provider/driver/vehicle).
    const transport = await resolveTransport(c.var.DB, body);

    // Items source preference:
    //   1. body.productionOrderIds (DO-style "create from Pending CN")
    //   2. body.items (legacy explicit array)
    // Either way produces consignment_items rows; productionOrderIds path
    // sets production_order_id, items-array path may set it too if the
    // caller passed it.
    const productionOrderIds: string[] = Array.isArray(body.productionOrderIds)
      ? (body.productionOrderIds as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];

    // PO mutex check (latent gap 1, 2026-04-29). Reject if any incoming
    // PO is already on a non-terminal DO — the dispatch race would
    // silently no-op the second one to fire, leaking inventory. Symmetric
    // DO-side check is intentionally skipped per task spec (DO is
    // reference-only); a future DO refactor should mirror this guard.
    if (productionOrderIds.length > 0) {
      const mutex = await validatePOMutex(c.var.DB, productionOrderIds, "CN");
      if (!mutex.ok) {
        return c.json(
          {
            success: false,
            error: `Cannot create consignment note — ${mutex.conflicts.length} PO${mutex.conflicts.length === 1 ? "" : "s"} already on an active delivery order: ${mutex.conflicts.join(", ")}`,
            conflicts: mutex.conflicts,
            reason: mutex.reason,
          },
          409,
        );
      }
    }
    // Also check legacy items[] path for productionOrderId fields.
    if (productionOrderIds.length === 0 && Array.isArray(body.items)) {
      const itemPoIds = (body.items as Array<Record<string, unknown>>)
        .map((it) => it.productionOrderId)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      if (itemPoIds.length > 0) {
        const mutex = await validatePOMutex(c.var.DB, itemPoIds, "CN");
        if (!mutex.ok) {
          return c.json(
            {
              success: false,
              error: `Cannot create consignment note — ${mutex.conflicts.length} PO${mutex.conflicts.length === 1 ? "" : "s"} already on an active delivery order: ${mutex.conflicts.join(", ")}`,
              conflicts: mutex.conflicts,
              reason: mutex.reason,
            },
            409,
          );
        }
      }
    }

    type ItemSeed = {
      id: string;
      productId: string;
      productName: string;
      productCode: string;
      quantity: number;
      unitPrice: number;
      productionOrderId: string | null;
    };
    let itemSeeds: ItemSeed[] = [];

    if (productionOrderIds.length > 0) {
      const ph = productionOrderIds.map(() => "?").join(",");
      const poRes = await c.var.DB.prepare(
        `SELECT id, productCode, productName, quantity
           FROM production_orders WHERE id IN (${ph})`,
      )
        .bind(...productionOrderIds)
        .all<{
          id: string;
          productCode: string | null;
          productName: string | null;
          quantity: number | null;
        }>();
      itemSeeds = (poRes.results ?? []).map((po) => ({
        id: genItemId(),
        productId: "",
        productName: po.productName ?? "",
        productCode: po.productCode ?? "",
        quantity: Number(po.quantity) || 1,
        unitPrice: 0, // CN pricing is set on the parent CO; line items
        // copy 0 by default and the user can edit later via PUT.
        productionOrderId: po.id,
      }));
    } else {
      const rawItems = Array.isArray(body.items) ? body.items : [];
      itemSeeds = rawItems.map((it: Record<string, unknown>) => ({
        id: genItemId(),
        productId: (it.productId as string) ?? "",
        productName: (it.productName as string) ?? "",
        productCode: (it.productCode as string) ?? "",
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
        productionOrderId: (it.productionOrderId as string | null) ?? null,
      }));
    }

    const totalValue = itemSeeds.reduce(
      (sum, it) => sum + it.unitPrice * it.quantity,
      0,
    );

    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO consignment_notes (
           id, noteNumber, type, customerId, customerName, branchName,
           sentDate, status, totalValue, notes,
           driverId, driverName, driverContactPerson, driverPhone,
           vehicleId, vehicleNo, vehicleType,
           dispatchedAt, inTransitAt, deliveredAt, acknowledgedAt,
           consignmentOrderId, hubId
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?)`,
      ).bind(
        id,
        noteNumber,
        body.type ?? "OUT",
        body.customerId ?? "",
        body.customerName ?? "",
        resolvedBranchName,
        body.sentDate ?? now.toISOString().split("T")[0],
        "ACTIVE",
        totalValue,
        body.notes ?? "",
        // Carrier metadata. driverId on consignment_notes mirrors the DO
        // convention — stores the PROVIDER company id, not the person.
        // The actual person id (when picked) lives in the request body
        // and is denormalized into driverName + driverPhone here.
        transport.providerId,
        transport.driverName,
        transport.driverContactPerson,
        transport.driverPhone,
        transport.vehicleId,
        transport.vehicleNo,
        transport.vehicleType,
        // Lifecycle timestamps — null on create. Get stamped by PATCH/PUT
        // when status flips PARTIALLY_SOLD / IN_TRANSIT / FULLY_SOLD /
        // CLOSED. inTransitAt added by migration 0078.
        null,
        null,
        null,
        null,
        // Linkage
        (body.consignmentOrderId as string | null) ?? null,
        hubId,
      ),
    );
    for (const it of itemSeeds) {
      stmts.push(
        c.var.DB.prepare(
          `INSERT INTO consignment_items (
             id, consignmentNoteId, productId, productName, productCode,
             quantity, unitPrice, status, soldDate, returnedDate,
             productionOrderId
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          it.id,
          id,
          it.productId,
          it.productName,
          it.productCode,
          it.quantity,
          it.unitPrice,
          "AT_BRANCH",
          null,
          null,
          it.productionOrderId,
        ),
      );
    }
    await c.var.DB.batch(stmts);

    const [created, items] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create consignment note" },
        500,
      );
    }
    return c.json(
      { success: true, data: rowToConsignmentNote(created, items.results ?? []) },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignment-notes] failed:", msg);
    return c.json({ success: false, error: msg || "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/consignment-notes/:id/return — process a Consignment Return.
//
// Body: { items: [{ id: string, quantity: number }] }
//   - id          consignment_items.id of the line being returned
//   - quantity    number of units to return (must be ≤ item.quantity)
//
// Side effects (everything in a single c.var.DB.batch so a partial failure
// rolls back):
//   1. consignment_items: rows where returnQty fully covers item.quantity
//      flip status='RETURNED' + returnedDate=now. Partial returns reduce
//      item.quantity by returnQty (item stays AT_BRANCH for the remaining
//      units — the legacy schema has no per-item returnedQty column, and
//      adding one would force a wider migration; reducing quantity keeps
//      the totalValue recompute trivial).
//   2. consignment_notes: stamp dispatchedAt fallback if not yet set
//      (a return implies the goods physically left); recompute totalValue;
//      flip status to RETURNED if every item is fully returned, otherwise
//      PARTIALLY_SOLD (the legacy enum value the FE re-skins as DISPATCHED;
//      see note.tsx cnStatusFromBackend()).
//   3. fg_units: for every item with a productionOrderId, find DELIVERED
//      units tied to that PO (limit returnQty) and flip them to 'RETURNED'
//      with returnedAt=now. Why we update FG stock: the goods are coming
//      back into our warehouse, so the fg_units ledger that the Inventory
//      page reads has to reflect that. Mirrors the LOADED→DRAFT reversal
//      pattern in delivery-orders.ts (the inverse of the dispatch-time
//      stamping).
//   4. stock_movements: write one STOCK_IN audit row per item with
//      reason='CONSIGNMENT_RETURN' and rackLabel=PO.rackingNumber so the
//      racking ledger shows the round-trip. Schema CHECK on
//      stock_movements.type only allows STOCK_IN/STOCK_OUT/TRANSFER, so
//      we use STOCK_IN (positive qty back into stock); the reason field
//      carries the business-event tag.
//
// SAFETY: if a CN item has no productionOrderId or the PO has been
// deleted, we DO NOT crash. The CN status update + consignment_items
// update still apply; we just skip the fg_units flip + stock_movements
// row for that item and log a warning. The user's task spec calls this
// out explicitly ("legacy CN whose source PO is deleted").
// ---------------------------------------------------------------------------
app.post("/:id/return", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "create");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      items?: Array<{ id?: unknown; quantity?: unknown }>;
    };
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    if (requestedItems.length === 0) {
      return c.json(
        { success: false, error: "items array is required and must be non-empty" },
        400,
      );
    }

    // Read source CN + items.
    const [cn, itemsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!cn) {
      return c.json({ success: false, error: "Consignment note not found" }, 404);
    }
    const cnItems = itemsRes.results ?? [];
    const itemById = new Map(cnItems.map((it) => [it.id, it]));

    // Validate every requested item exists on the CN and the requested
    // returnQty is ≤ item.quantity. We do all validation up-front so a
    // bad payload doesn't half-apply.
    type ValidatedReturn = {
      item: ConsignmentItemRow;
      returnQty: number;
      isFull: boolean;
    };
    const validated: ValidatedReturn[] = [];
    for (const r of requestedItems) {
      const itemId = typeof r.id === "string" ? r.id : "";
      const returnQty = Number(r.quantity);
      if (!itemId || !Number.isFinite(returnQty) || returnQty <= 0) {
        return c.json(
          { success: false, error: "Each item needs id (string) and quantity (positive number)" },
          400,
        );
      }
      const item = itemById.get(itemId);
      if (!item) {
        return c.json(
          { success: false, error: `CN item ${itemId} not found on consignment note ${id}` },
          400,
        );
      }
      if (returnQty > item.quantity) {
        return c.json(
          {
            success: false,
            error: `Return quantity ${returnQty} exceeds item quantity ${item.quantity} for ${itemId}`,
          },
          400,
        );
      }
      validated.push({ item, returnQty, isFull: returnQty === item.quantity });
    }

    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];

    // ----------- consignment_items updates -----------
    // Track post-update qty for each touched item so we can recompute
    // totalValue + decide the parent CN's next status without re-reading.
    const postUpdateQtyByItemId = new Map<string, number>();
    for (const { item, returnQty, isFull } of validated) {
      if (isFull) {
        statements.push(
          c.var.DB.prepare(
            `UPDATE consignment_items
                SET status = 'RETURNED', returnedDate = ?
              WHERE id = ?`,
          ).bind(now, item.id),
        );
        postUpdateQtyByItemId.set(item.id, 0);
      } else {
        const remaining = item.quantity - returnQty;
        statements.push(
          c.var.DB.prepare(
            `UPDATE consignment_items
                SET quantity = ?
              WHERE id = ?`,
          ).bind(remaining, item.id),
        );
        postUpdateQtyByItemId.set(item.id, remaining);
      }
    }

    // ----------- fg_units flip + stock_movements audit -----------
    // For each validated item, look up the linked PO, find DELIVERED
    // fg_units we can flag RETURNED, and write a STOCK_IN audit row.
    // Skip items with no PO link or whose PO has been deleted (legacy
    // CN safety per task spec).
    for (const { item, returnQty } of validated) {
      const poId = item.productionOrderId;
      if (!poId) {
        console.warn(
          `[CN return] item ${item.id} has no productionOrderId — skipping fg_units + stock_movements (legacy row)`,
        );
        continue;
      }
      const po = await c.var.DB.prepare(
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
      if (!po) {
        console.warn(
          `[CN return] productionOrder ${poId} not found — skipping fg_units + stock_movements for item ${item.id}`,
        );
        continue;
      }

      // Pick up to returnQty DELIVERED units for this PO and flip them
      // RETURNED. We use a sub-SELECT with LIMIT to keep the operation
      // bounded (a PO with 10 units shouldn't flip all 10 if only 3 are
      // being returned). If fewer than returnQty units exist (mismatched
      // ledgers), we flip what's there and let the stock_movements audit
      // record the requested qty — operations can reconcile later.
      //
      // CN-scoped filter (latent gap 2, 2026-04-29): the WHERE clause
      // requires cnId=? in addition to poId=?, otherwise a DO-delivered
      // unit with the same poId could be flipped to RETURNED here.
      // CN-dispatched units carry cnId set + (post-FULLY_SOLD)
      // status='DELIVERED'; DO-delivered units carry doId set + cnId
      // NULL. Filtering on cnId ensures we only ever touch units that
      // THIS CN claimed.
      statements.push(
        c.var.DB.prepare(
          `UPDATE fg_units
              SET status = 'RETURNED', returnedAt = ?
            WHERE id IN (
              SELECT id FROM fg_units
                WHERE poId = ? AND cnId = ? AND status = 'DELIVERED'
                ORDER BY deliveredAt DESC
                LIMIT ?
            )`,
        ).bind(now, po.id, id, returnQty),
      );

      statements.push(
        c.var.DB.prepare(
          `INSERT INTO stock_movements (
             id, type, rackLocationId, rackLabel, productionOrderId,
             productCode, productName, quantity, reason, performedBy,
             created_at
           ) VALUES (?, 'STOCK_IN', ?, ?, ?, ?, ?, ?, ?, 'System', ?)`,
        ).bind(
          `mov-${crypto.randomUUID().slice(0, 8)}`,
          null,
          po.rackingNumber ?? "",
          po.id,
          po.productCode ?? "",
          po.productName ?? "",
          returnQty,
          "CONSIGNMENT_RETURN",
          now,
        ),
      );
    }

    // ----------- consignment_notes status + totalValue -----------
    // Recompute totalValue from the post-update quantities. Items not
    // touched keep their original quantity.
    let nextTotalValue = 0;
    for (const it of cnItems) {
      const q =
        postUpdateQtyByItemId.has(it.id)
          ? postUpdateQtyByItemId.get(it.id)!
          : it.quantity;
      nextTotalValue += q * it.unitPrice;
    }

    // All-returned check: every original item must end up with qty=0 +
    // status='RETURNED'. Iterate cnItems (the source of truth pre-update)
    // and consult our post-update map.
    const allReturned = cnItems.every((it) => {
      const post = postUpdateQtyByItemId.get(it.id);
      return post !== undefined && post === 0;
    });

    // Pick next status per task spec:
    //   * fully returned → RETURNED
    //   * partial         → PARTIALLY_SOLD (the legacy "some items left
    //                       the warehouse" state; FE re-skins as DISPATCHED)
    const nextStatus = allReturned ? "RETURNED" : "PARTIALLY_SOLD";

    // Stamp dispatchedAt if not yet set (a return implies the goods
    // physically left at some prior point even if the operator skipped
    // the Mark Dispatched click).
    const dispatchedAt = cn.dispatchedAt ?? now;

    statements.push(
      c.var.DB.prepare(
        `UPDATE consignment_notes
            SET status = ?, totalValue = ?, dispatchedAt = ?
          WHERE id = ?`,
      ).bind(nextStatus, nextTotalValue, dispatchedAt, id),
    );

    // CO-parity gap (2026-05-04): if the CN had previously been
    // converted to an invoice (convertedInvoiceId set), the
    // outstandingSen bump from /convert-to-invoice needs to be reversed
    // by the difference between the original totalValue and the post-
    // return totalValue. Otherwise A/R stays inflated by the value of
    // returned items.
    if (cn.convertedInvoiceId && cn.totalValue > nextTotalValue) {
      const refundSen = cn.totalValue - nextTotalValue;
      statements.push(
        c.var.DB.prepare(
          `UPDATE customers
              SET outstandingSen = GREATEST(0, COALESCE(outstandingSen, 0) - ?),
                  updated_at = ?
            WHERE id = ?`,
        ).bind(refundSen, now, cn.customerId),
      );
    }

    await c.var.DB.batch(statements);

    // CO cascade — /return bypasses updateConsignmentNoteById (which
    // would have fired this) so we have to invoke it explicitly. Without
    // this, the parent CO stays at DELIVERED even after every CN under
    // it goes RETURNED, blocking re-dispatch + leaving CO status stale.
    if (cn.consignmentOrderId) {
      try {
        await cascadeCNReversalToCO(c.var.DB, cn.consignmentOrderId);
      } catch (err) {
        console.error(
          "[POST /api/consignment-notes/:id/return] CO reversal cascade failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Audit (best-effort — never blocks the mutation per audit.ts contract).
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: id,
      action: "return",
      after: {
        id,
        status: nextStatus,
        returnedItems: validated.map((v) => ({ id: v.item.id, quantity: v.returnQty })),
      },
    });

    // Read back the canonical row + items so the FE can refresh without a
    // second fetch.
    const [updatedNote, updatedItemsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!updatedNote) {
      return c.json(
        { success: false, error: "Consignment note disappeared mid-update" },
        500,
      );
    }
    return c.json({
      success: true,
      data: rowToConsignmentNote(updatedNote, updatedItemsRes.results ?? []),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignment-notes/:id/return] failed:", msg);
    return c.json({ success: false, error: msg || "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/consignment-notes/:id/convert-to-invoice — convert a CN into a
// Sales Invoice.
//
// Body (all optional):
//   notes?: string   — passed through to the invoice's notes column
//
// What it does:
//   1. Reads the source CN + items.
//   2. Pulls unit prices from the parent Consignment Order's items
//      (consignment_order_items) where productCode matches, falling back
//      to the unitPrice already on consignment_items, then 0.
//   3. Generates a sequential invoice number via nextInvoiceNo() (shared
//      INV-YYMM-NNN sequence, fixed 2026-04-28).
//   4. INSERTs a DRAFT invoice with delivery_order_id=NULL +
//      sales_order_id=NULL — this is a CN-origin invoice. See migration
//      0070 header for why we chose CN→Invoice as one-way (no reverse
//      FK on invoices). Customer + hub fields denormalized from the CN.
//   5. INSERTs invoice_items mirroring CN items.
//   6. UPDATEs consignment_notes.status='FULLY_SOLD' (the legacy enum
//      value the FE re-skins as DELIVERED) and stamps deliveredAt if not
//      yet set. Writes converted_invoice_id pointing at the new invoice.
//   7. Marks every consignment_items row status='SOLD' + soldDate=now.
// ---------------------------------------------------------------------------
app.post("/:id/convert-to-invoice", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "create");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      notes?: string;
    };

    // Read source CN + items.
    const [cn, itemsRes] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_notes WHERE id = ?")
        .bind(id)
        .first<ConsignmentNoteRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_items WHERE consignmentNoteId = ?",
      )
        .bind(id)
        .all<ConsignmentItemRow>(),
    ]);
    if (!cn) {
      return c.json({ success: false, error: "Consignment note not found" }, 404);
    }
    const cnItems = itemsRes.results ?? [];

    // Idempotency guard — if the CN already converted, return the existing
    // invoice id rather than creating a duplicate. (Stops a double-click
    // from generating two invoices for the same CN.)
    if (cn.convertedInvoiceId) {
      return c.json(
        {
          success: false,
          error: `Consignment note already converted to invoice ${cn.convertedInvoiceId}`,
          invoiceId: cn.convertedInvoiceId,
        },
        409,
      );
    }

    // Pull unit prices from the parent CO's items (best-effort fallback).
    // CN items often store unitPrice=0 because pricing lives on the CO line.
    let priceByCode = new Map<string, number>();
    if (cn.consignmentOrderId) {
      const coItemsRes = await c.var.DB.prepare(
        "SELECT productCode, unitPriceSen FROM consignment_order_items WHERE consignmentOrderId = ?",
      )
        .bind(cn.consignmentOrderId)
        .all<{ productCode: string | null; unitPriceSen: number | null }>();
      priceByCode = new Map(
        (coItemsRes.results ?? [])
          .filter((r) => r.productCode)
          .map((r) => [r.productCode as string, Number(r.unitPriceSen) || 0]),
      );
    }

    const invoiceItems = cnItems.map((it) => {
      // Price preference: CO item > CN item > 0.
      const fromCo = it.productCode ? priceByCode.get(it.productCode) : undefined;
      const unitPriceSen =
        fromCo !== undefined ? fromCo : Number(it.unitPrice) || 0;
      return {
        id: `invi-${crypto.randomUUID().slice(0, 8)}`,
        productCode: it.productCode ?? "",
        productName: it.productName ?? "",
        sizeLabel: "",
        fabricCode: "",
        quantity: it.quantity,
        unitPriceSen,
        totalSen: unitPriceSen * it.quantity,
      };
    });

    const subtotalSen = invoiceItems.reduce((s, i) => s + i.totalSen, 0);
    const totalSen = subtotalSen;

    // CO-parity gap (2026-05-04): credit-limit gate. CN unit prices are
    // 0 at CN POST time so the gate has to live here at convert time
    // (where we resolved real prices from CO items). Mirrors DO's
    // pre-POST gate at delivery-orders.ts:728-737.
    if (cn.customerId) {
      const customerRow = await c.var.DB
        .prepare(
          "SELECT id, outstandingSen, creditLimitSen FROM customers WHERE id = ?",
        )
        .bind(cn.customerId)
        .first<{
          id: string;
          outstandingSen: number | null;
          creditLimitSen: number | null;
        }>();
      if (
        customerRow &&
        typeof customerRow.creditLimitSen === "number" &&
        customerRow.creditLimitSen > 0
      ) {
        const outstanding = Number(customerRow.outstandingSen) || 0;
        const projected = outstanding + totalSen;
        if (projected > customerRow.creditLimitSen) {
          return c.json(
            {
              success: false,
              error: "Credit limit exceeded",
              code: "CREDIT_LIMIT_EXCEEDED",
              details: {
                limit: customerRow.creditLimitSen,
                outstanding,
                invoiceTotal: totalSen,
                projected,
              },
            },
            409,
          );
        }
      }
    }

    const now = new Date().toISOString();
    const invoiceDate = now.split("T")[0];
    const due = new Date();
    due.setDate(due.getDate() + 30);
    const dueDate = due.toISOString().split("T")[0];
    const invoiceId = `inv-${crypto.randomUUID().slice(0, 8)}`;
    const invoiceNo = await nextInvoiceNo(c.var.DB);

    // Resolve hub name for denormalization (matches the DO→invoice path).
    let hubName: string | null = null;
    if (cn.hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT shortName FROM delivery_hubs WHERE id = ?",
      )
        .bind(cn.hubId)
        .first<{ shortName: string | null }>();
      hubName = hub?.shortName ?? null;
    }

    const statements: D1PreparedStatement[] = [
      c.var.DB.prepare(
        `INSERT INTO invoices (
           id, invoiceNo, deliveryOrderId, doNo, salesOrderId, companySOId,
           customerId, customerName, customerState, hubId, hubName,
           subtotalSen, totalSen, status, invoiceDate, dueDate, paidAmount,
           paymentDate, paymentMethod, notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        invoiceId,
        invoiceNo,
        // CN-origin invoice: deliveryOrderId + doNo + salesOrderId stay
        // null. The CN linkage is held one-way on consignment_notes
        // .convertedInvoiceId (migration 0070).
        null,
        null,
        null,
        null,
        cn.customerId,
        cn.customerName ?? "",
        null,
        cn.hubId,
        hubName,
        subtotalSen,
        totalSen,
        "DRAFT",
        invoiceDate,
        dueDate,
        0,
        null,
        "",
        body.notes ?? `Converted from consignment note ${cn.noteNumber}`,
        now,
        now,
      ),
      ...invoiceItems.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO invoice_items (
             id, invoiceId, productCode, productName, sizeLabel, fabricCode,
             quantity, unitPriceSen, totalSen
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          invoiceId,
          item.productCode,
          item.productName,
          item.sizeLabel,
          item.fabricCode,
          item.quantity,
          item.unitPriceSen,
          item.totalSen,
        ),
      ),
      // Flip CN to FULLY_SOLD + link the new invoice id back. Stamp
      // deliveredAt if not already (a sale-conversion implies the goods
      // reached the customer's hands).
      c.var.DB.prepare(
        `UPDATE consignment_notes
            SET status = 'FULLY_SOLD',
                deliveredAt = COALESCE(deliveredAt, ?),
                convertedInvoiceId = ?
          WHERE id = ?`,
      ).bind(now, invoiceId, id),
      // Mark every CN item SOLD with soldDate=now. The legacy enum allows
      // AT_BRANCH / SOLD / RETURNED / DAMAGED — SOLD is the right tag for
      // the convert-to-invoice action.
      c.var.DB.prepare(
        `UPDATE consignment_items
            SET status = 'SOLD', soldDate = ?
          WHERE consignmentNoteId = ? AND status = 'AT_BRANCH'`,
      ).bind(now, id),
      // gap 2 (2026-04-29): flip fg_units LOADED → DELIVERED to mirror
      // DO's DELIVERED transition. updateConsignmentNoteById has the same
      // flip on the FULLY_SOLD edge, but this route bypasses that helper
      // and does a direct UPDATE on consignment_notes — so the flip has
      // to be repeated here. Without this, units stay LOADED forever and
      // /return matches zero rows.
      c.var.DB.prepare(
        `UPDATE fg_units
            SET status = 'DELIVERED', deliveredAt = ?
          WHERE cnId = ? AND status = 'LOADED'`,
      ).bind(now, id),
      // CO-parity gap (2026-05-04): bump customers.outstandingSen by the
      // invoice total, mirroring DO's DELIVERED → invoice flow
      // (delivery-orders.ts:1857-1861). Without this, every CN-origin
      // invoice was off-ledger from the customer's A/R balance.
      c.var.DB.prepare(
        `UPDATE customers
            SET outstandingSen = COALESCE(outstandingSen, 0) + ?,
                updated_at = ?
          WHERE id = ?`,
      ).bind(totalSen, now, cn.customerId),
    ];

    await c.var.DB.batch(statements);

    // gap 1 (2026-04-29): cascade to parent CO if every sibling CN is
    // FULLY_SOLD/CLOSED. Best-effort — never blocks the conversion.
    if (cn.consignmentOrderId) {
      try {
        await cascadeCNCompletionToCO(c.var.DB, cn.consignmentOrderId);
      } catch (err) {
        console.error(
          "[POST /api/consignment-notes/:id/convert-to-invoice] CO cascade failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Audit (best-effort).
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: id,
      action: "convert-to-invoice",
      after: {
        id,
        invoiceId,
        invoiceNo,
        totalSen,
      },
    });

    return c.json(
      {
        success: true,
        data: {
          invoiceId,
          invoiceNo,
          totalSen,
          consignmentNoteId: id,
        },
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/consignment-notes/:id/convert-to-invoice] failed:", msg);
    return c.json({ success: false, error: msg || "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/consignment-notes/:id/notify-customer — customer dispatch notice
// (2026-06-11, the CN twin of delivery-orders' notify-customer endpoint).
//
// kind "dispatch" ONLY: dispatch notice with the branded CN PDF attached.
// Owner ruling: consignment notes NEVER have invoices, so there is no
// delivered/FULLY_SOLD email and no invoice notice here — any other kind is
// rejected with 400.
//
// The frontend (src/pages/consignment/note.tsx) calls this fire-and-forget
// AFTER a successful "Mark Dispatched" transition (ACTIVE → PARTIALLY_SOLD);
// an email failure must NEVER block, slow, or roll back the transition, so
// this endpoint only ever enqueues into the durable outbox (outbox_emails —
// drained by the cron at /api/internal/process-email-outbox) and answers
// 200 for every skip case.
//
// Recipient chain (same owner rule as the DO dispatch notice): the CN's
// delivery hub email first, blank → the customer's email, both blank →
// silent skip (console.log only, nothing recorded).
//
// Numbers come from the DB row (noteNumber, dispatchedAt, carrier fields,
// items) — the caller supplies only the client-rendered CN PDF, the same
// buildCnPdfData payload the Print buttons use.
//
// Idempotency: a dispatchemailat stamp on consignment_notes, claimed
// atomically (UPDATE … WHERE dispatchemailat IS NULL) so a double-click or
// a re-dispatch can't spam the customer. The column is runtime self-applied
// below AND shipped as migration 0163; the name is deliberately
// folded-lowercase (unquoted camelCase DDL folds to lowercase anyway —
// BUG-2026-06-11-007), so reads are dual-key.
// ---------------------------------------------------------------------------
let cnNotifyEmailColumn: Promise<void> | null = null;
function ensureCnNotifyEmailColumn(db: D1Database): Promise<void> {
  if (cnNotifyEmailColumn) return cnNotifyEmailColumn;
  cnNotifyEmailColumn = (async () => {
    try {
      await db
        .prepare(
          "ALTER TABLE consignment_notes ADD COLUMN IF NOT EXISTS dispatchemailat TEXT",
        )
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
  })();
  return cnNotifyEmailColumn;
}

app.post("/:id/notify-customer", async (c) => {
  // Same RBAC gate as the status transition that triggers it (PUT /:id).
  const denied = await requirePermission(c, "consignment-notes", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  try {
    await ensureCnNotifyEmailColumn(c.var.DB);
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      pdfBase64?: string;
      pdfFilename?: string;
    };
    if (body.kind !== "dispatch") {
      return c.json(
        {
          success: false,
          error:
            'kind must be "dispatch" — consignment notes have no invoice emails, only the dispatch notice',
        },
        400,
      );
    }

    // SELECT * so the runtime-added stamp column comes back too (it lives
    // folded-lowercase; never use an explicit camelCase projection for it).
    const cn = await c.var.DB.prepare(
      "SELECT * FROM consignment_notes WHERE id = ?",
    )
      .bind(id)
      .first<
        ConsignmentNoteRow & {
          dispatchEmailAt?: string | null;
          dispatchemailat?: string | null;
        }
      >();
    if (!cn) {
      return c.json(
        { success: false, error: "Consignment note not found" },
        404,
      );
    }

    // Status guard — a dispatch notice for a CN that isn't dispatched is a
    // stray call. PARTIALLY_SOLD/IN_TRANSIT are CN's "goods left the
    // warehouse" states (mirrors the DO guard on LOADED/IN_TRANSIT).
    if (cn.status !== "PARTIALLY_SOLD" && cn.status !== "IN_TRANSIT") {
      return c.json(
        {
          success: false,
          error: `Dispatch notice requires a dispatched CN (PARTIALLY_SOLD/IN_TRANSIT); ${cn.noteNumber} is ${cn.status}`,
        },
        409,
      );
    }

    // Idempotency pre-check (dual-key read — runtime column is folded).
    const alreadySentAt = cn.dispatchEmailAt ?? cn.dispatchemailat ?? null;
    if (alreadySentAt) {
      return c.json({ success: true, skipped: true, reason: "already sent" });
    }

    // Recipient chain — hub email + customer email straight from the DB.
    let hubEmail: string | null = null;
    let hubShortName = "";
    let hubAddress = "";
    if (cn.hubId) {
      const hub = await c.var.DB.prepare(
        "SELECT shortName, address, email FROM delivery_hubs WHERE id = ?",
      )
        .bind(cn.hubId)
        .first<{
          shortName: string | null;
          address: string | null;
          email: string | null;
        }>();
      if (hub) {
        hubEmail = hub.email;
        hubShortName = hub.shortName ?? "";
        hubAddress = hub.address ?? "";
      }
    }
    const customer = await c.var.DB.prepare(
      "SELECT email FROM customers WHERE id = ?",
    )
      .bind(cn.customerId)
      .first<{ email: string | null }>();
    const to = resolveDispatchRecipient(hubEmail, customer?.email);
    if (!to) {
      // Owner rule: both blank → don't send, don't record anything.
      console.log(
        `[consignment-notes] ${cn.noteNumber}: dispatch notice skipped — no hub or customer email on file`,
      );
      return c.json({ success: true, skipped: true, reason: "no recipient" });
    }

    // Items summary — server-owned per-product tally from consignment_items
    // (the CN equivalent of the DO's component breakdown; CN lines carry no
    // BOM pieces, so the summary is qty × product, aggregated by product).
    const itemsRes = await c.var.DB.prepare(
      "SELECT productCode, productName, quantity FROM consignment_items WHERE consignmentNoteId = ?",
    )
      .bind(id)
      .all<{
        productCode: string | null;
        productName: string | null;
        quantity: number;
      }>();
    const tally = new Map<string, number>();
    for (const it of itemsRes.results ?? []) {
      const label =
        (it.productName || it.productCode || "").trim() || "Item";
      const qty = Number(it.quantity) || 0;
      if (qty <= 0) continue;
      tally.set(label, (tally.get(label) || 0) + qty);
    }
    const itemsSummary = Array.from(tally.entries())
      .map(([label, qty]) => `${qty} × ${label}`)
      .join(", ");

    const pdfBase64 =
      typeof body.pdfBase64 === "string" && body.pdfBase64.trim()
        ? body.pdfBase64.trim()
        : null;

    // Honesty guard — same rule as the DO endpoint: the outbox drops
    // attachments over its 5 MB decoded cap AFTER templating, so decide
    // "attached or not" with the SAME size rule up front, or the email
    // claims an attachment it doesn't carry.
    const PDF_ATTACH_CAP_BYTES = 5 * 1024 * 1024;
    const pdfTooBig =
      !!pdfBase64 && Math.floor(pdfBase64.length * 0.75) > PDF_ATTACH_CAP_BYTES;
    if (pdfTooBig) {
      console.warn(
        `[consignment-notes] ${cn.noteNumber}: CN PDF exceeds the 5 MB attachment cap — sending the notice without it`,
      );
    }
    const attachablePdf = pdfTooBig ? null : pdfBase64;
    let attachments:
      | Array<{ filename: string; contentBase64: string }>
      | undefined;
    if (attachablePdf) {
      attachments = [
        {
          filename:
            String(body.pdfFilename ?? "").trim() || `${cn.noteNumber}.pdf`,
          contentBase64: attachablePdf,
        },
      ];
    }

    const deliverTo =
      [hubShortName, hubAddress].filter(Boolean).join(", ") ||
      cn.branchName ||
      "";
    const tpl = cnDispatchNoticeTemplate({
      cnNo: cn.noteNumber,
      customerName: (cn.customerName ?? "").trim() || "Customer",
      dispatchedAt: cn.dispatchedAt ?? null,
      deliverTo,
      itemsSummary,
      hasAttachment: !!attachments,
      // Carrier rows from the CN's own fields — each one is omitted by the
      // template when blank (CNs often have no 3PL on file).
      driverName: cn.driverName ?? null,
      driverContact: cn.driverPhone ?? null,
      lorryPlate: cn.vehicleNo ?? null,
    });

    // Atomic idempotency claim BEFORE the enqueue — two racing calls both
    // pass the pre-check above, but only one wins this UPDATE.
    const nowIso = new Date().toISOString();
    const claim = await c.var.DB.prepare(
      "UPDATE consignment_notes SET dispatchemailat = ? WHERE id = ? AND dispatchemailat IS NULL",
    )
      .bind(nowIso, id)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) {
      return c.json({ success: true, skipped: true, reason: "already sent" });
    }

    try {
      await enqueueEmail(c, {
        to,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        attachments,
      });
    } catch (enqErr) {
      // Release the claim so the operator can retry; the transition itself
      // is long done and stays untouched.
      try {
        await c.var.DB.prepare(
          "UPDATE consignment_notes SET dispatchemailat = NULL WHERE id = ?",
        )
          .bind(id)
          .run();
      } catch {
        /* best-effort release */
      }
      throw enqErr;
    }

    return c.json({ success: true, queued: true, to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[POST /api/consignment-notes/${id}/notify-customer] failed:`,
      msg,
    );
    return c.json(
      { success: false, error: msg || "Failed to queue customer notice" },
      500,
    );
  }
});

// ----------------------------------------------------------------------------
// Helper: map an UpdateCNResult error reason to an HTTP response. Shared
// between PATCH / PUT so the two paths surface identical errors.
//
// Gaps 5 + audit (2026-04-29):
//   - not_found            → 404
//   - invalid_transition   → 400 with descriptive message (gap 5)
//   - items_locked         → 403 with descriptive message (latent gap 3)
// ----------------------------------------------------------------------------
function mapUpdateCNError(
  res: Extract<
    Awaited<ReturnType<typeof updateConsignmentNoteById>>,
    { ok: false }
  >,
): { status: 400 | 403 | 404; body: Record<string, unknown> } {
  if (res.reason === "not_found") {
    return {
      status: 404,
      body: { success: false, error: "Consignment note not found" },
    };
  }
  if (res.reason === "invalid_transition") {
    const allowed = CN_VALID_TRANSITIONS[res.from ?? ""] ?? [];
    return {
      status: 400,
      body: {
        success: false,
        error: `Invalid status transition: ${res.from ?? "(none)"} → ${res.to}. Allowed transitions from ${res.from ?? "(none)"}: ${allowed.length > 0 ? allowed.join(", ") : "none"}`,
        reason: "invalid_transition",
        from: res.from,
        to: res.to,
      },
    };
  }
  if (res.reason === "items_locked") {
    return {
      status: 403,
      body: {
        success: false,
        error: `Cannot edit items — consignment note is in status ${res.currentStatus ?? "(unknown)"}. Items can only be edited while the CN is in Pending Dispatch (ACTIVE).`,
        reason: "items_locked",
        currentStatus: res.currentStatus,
      },
    };
  }
  // Exhaustiveness guard.
  return {
    status: 400,
    body: { success: false, error: "Update rejected" },
  };
}

// PATCH /api/consignment-notes — partial update by body.id (legacy shape).
//
// See updateConsignmentNoteById for the lifecycle / driver / vehicle /
// hub merge semantics. Both this PATCH and the PUT /:id alias delegate
// to that helper so the two paths stay identical.
//
// Audit (gap 6, 2026-04-29): emits an audit_events row on every successful
// update. Mirrors DO's emit (delivery-orders.ts ~lines 1831-1839). Always
// fired (not just status changes) so carrier/hub/items edits leave a trail
// too — DO does the same. Snapshot of before/after status + the four
// lifecycle timestamps + carrier so the journal stays compact.
app.patch("/", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "update");
  if (denied) return denied;
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!body.id || typeof body.id !== "string") {
      return c.json({ success: false, error: "id required in body" }, 400);
    }
    // Snapshot existing status BEFORE the helper runs so we can include it
    // in the audit emit's `before` payload.
    const beforeRow = await c.var.DB
      .prepare("SELECT status FROM consignment_notes WHERE id = ?")
      .bind(body.id)
      .first<{ status: string | null }>();
    const res = await updateConsignmentNoteById(c.var.DB, body.id, body);
    if (!res.ok) {
      const mapped = mapUpdateCNError(res);
      return c.json(mapped.body, mapped.status);
    }
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: body.id,
      action:
        beforeRow && beforeRow.status !== res.note.status
          ? "status-change"
          : "update",
      before: { status: beforeRow?.status ?? null },
      after: {
        status: res.note.status,
        dispatchedAt: res.note.dispatchedAt,
        inTransitAt: res.note.inTransitAt,
        deliveredAt: res.note.deliveredAt,
        acknowledgedAt: res.note.acknowledgedAt,
        driverId: res.note.driverId,
        vehicleId: res.note.vehicleId,
        hubId: res.note.hubId,
      },
    });
    return c.json({
      success: true,
      data: rowToConsignmentNote(res.note, res.items),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// PUT /api/consignment-notes/:id — same as PATCH but addressed by URL
// param. FE alias so the CN page's row-action menu can use REST-style
// `/api/consignment-notes/{id}` instead of the body-id PATCH. Same audit
// + error mapping as PATCH /.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "consignment-notes", "update");
  if (denied) return denied;
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as Record<string, unknown>;
    const beforeRow = await c.var.DB
      .prepare("SELECT status FROM consignment_notes WHERE id = ?")
      .bind(id)
      .first<{ status: string | null }>();
    const res = await updateConsignmentNoteById(c.var.DB, id, body);
    if (!res.ok) {
      const mapped = mapUpdateCNError(res);
      return c.json(mapped.body, mapped.status);
    }
    await emitAudit(c, {
      resource: "consignment-notes",
      resourceId: id,
      action:
        beforeRow && beforeRow.status !== res.note.status
          ? "status-change"
          : "update",
      before: { status: beforeRow?.status ?? null },
      after: {
        status: res.note.status,
        dispatchedAt: res.note.dispatchedAt,
        inTransitAt: res.note.inTransitAt,
        deliveredAt: res.note.deliveredAt,
        acknowledgedAt: res.note.acknowledgedAt,
        driverId: res.note.driverId,
        vehicleId: res.note.vehicleId,
        hubId: res.note.hubId,
      },
    });
    return c.json({
      success: true,
      data: rowToConsignmentNote(res.note, res.items),
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;

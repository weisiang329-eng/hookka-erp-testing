import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { recomputePoStatusAndProgress } from "../production-orders";
import { loadHookkaDDBuffer, hookkaDDBufferFor, addDays } from "../../lib/lead-times";
import { createProductionOrdersForOrder } from "../_shared/production-builder";
import { getOrgId } from "../../lib/tenant";
import { ensureJobCardCompletedAt } from "../../lib/job-card-completed-at";

const app = new Hono<Env>();


// ---------------------------------------------------------------------------
// POST /api/import/migrate-do-from-excel?dryRun=true|false
//
// Bulk DO migration. Body: { entries: [{ custPO, doNo }, ...], deliveryDate?: "YYYY-MM-DD" }
//
// For each Cust_PO with a known DO number from the legacy Excel sheet:
//   1. Find the matching sales_order by customerPOId
//   2. Stamp ALL its production_orders' PACKING JCs as COMPLETED 2026-05-05
//   3. Insert a delivery_orders row with do_no = the legacy DO number,
//      status = LOADED (= "Dispatched" UI label per
//      src/pages/delivery/index.tsx:170-178)
//   4. Insert delivery_order_items rows mirroring each PO
//   5. Update the SO's status to DISPATCHED-equivalent (depends on enum)
//
// Idempotent: if a delivery_orders row already exists with that do_no, skip.
// ---------------------------------------------------------------------------
app.post("/migrate-do-from-excel", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "create");
  if (denied) return denied;

  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the job-card
  // stamps below mention completed_at.
  await ensureJobCardCompletedAt(db);
  const dryRun = c.req.query("dryRun") === "true";
  const today = new Date().toISOString().slice(0, 10);
  let body: { entries?: Array<{ custPO: string; doNo: string; dispatchDate?: string }>; deliveryDate?: string };
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: "Invalid JSON" }, 400); }
  const entries = (body?.entries ?? []).filter(e => typeof e?.custPO === "string" && typeof e?.doNo === "string" && e.custPO && e.doNo);
  if (entries.length === 0) {
    return c.json({ success: false, error: "Provide entries: [{custPO, doNo}, ...]" }, 400);
  }
  const defaultDeliveryDate = (body.deliveryDate ?? today).slice(0, 10);
  // Per-entry dispatchDate (from Aut/aiy DO Date column) is used for the DO's
  // dispatchedAt timestamp + JC completedDate. Fallback to body.deliveryDate
  // when not supplied.
  const dispatchDateByEntry = new Map<string, string>();
  for (const e of entries) {
    const k = `${e.custPO}|${e.doNo}`;
    if (e.dispatchDate) dispatchDateByEntry.set(k, String(e.dispatchDate).slice(0, 10));
  }

  // 1. Get every existing DO's (doNo, id) so we can append line items to
  //    an existing DO when the legacy Excel has multiple custPOs sharing
  //    one DO number (multi-SO-per-DO is common in the old system).
  const existingDoRes = await db
    .prepare(`SELECT id, doNo FROM delivery_orders`)
    .all<{ id: string; doNo: string }>();
  const existingDoMap = new Map<string, string>(
    (existingDoRes.results ?? []).map(r => [r.doNo, r.id]),
  );

  // 2. Pre-fetch all SOs (with customerPOId) + production_orders (with PACKING JCs) in 2 passes.
  const soRes = await db
    .prepare(
      `SELECT id, customerPOId, customerId, customerName, customerState,
              companySO, companySOId, hubId
         FROM sales_orders
        WHERE customerPOId IS NOT NULL AND customerPOId <> ''`,
    )
    .all<{
      id: string; customerPOId: string; customerId: string;
      customerName: string; customerState: string | null;
      companySO: string | null; companySOId: string | null; hubId: string | null;
    }>();
  const soByCustPo = new Map<string, typeof soRes.results[number]>();
  for (const s of (soRes.results ?? [])) {
    soByCustPo.set(s.customerPOId, s);
  }

  // 2b. Pre-fetch every PO that is already in some delivery_order_items row
  //     so we can skip custPOs already migrated (idempotency).
  const alreadyMigratedRes = await db
    .prepare(`SELECT DISTINCT productionOrderId FROM delivery_order_items WHERE productionOrderId IS NOT NULL`)
    .all<{ productionOrderId: string }>();
  const migratedPoIds = new Set<string>(
    (alreadyMigratedRes.results ?? []).map(r => r.productionOrderId),
  );

  type Plan = {
    custPO: string; doNo: string; soId?: string;
    customerId?: string; companySOId?: string;
    poIds: string[];
    packingJcsToStamp: Array<{ poId: string; jcId: string }>;
    upstreamJcsToStamp: Array<{ poId: string; jcId: string; departmentCode: string }>;
    skipReason?: string;
  };
  // When ?stampUpstream=true, also stamp non-PACKING JCs (FAB_CUT, FAB_SEW,
  // WOOD_CUT, FOAM, FRAMING, WEBBING, BONDING, UPHOLSTERY) as COMPLETED. Used
  // when the legacy system already shipped the goods but our digital twin's
  // upstream JCs are still WIP.
  const stampUpstream = c.req.query("stampUpstream") === "true";

  const plans: Plan[] = [];
  for (const e of entries) {
    const plan: Plan = { custPO: e.custPO, doNo: e.doNo, poIds: [], packingJcsToStamp: [], upstreamJcsToStamp: [] };
    const so = soByCustPo.get(e.custPO);
    if (!so) { plan.skipReason = "No matching SO"; plans.push(plan); continue; }
    plan.soId = so.id;
    plan.customerId = so.customerId;
    plan.companySOId = so.companySOId ?? undefined;
    // Find production_orders for this SO + their PACKING JCs.
    const poRes = await db
      .prepare(
        `SELECT id, poNo FROM production_orders
          WHERE salesOrderId = ?
            AND status NOT IN ('CANCELLED')`,
      )
      .bind(so.id)
      .all<{ id: string; poNo: string | null }>();
    const poIds = (poRes.results ?? []).map(p => p.id);
    // Idempotency: if every PO of this SO is already in delivery_order_items,
    // skip — this custPO was already migrated.
    if (poIds.length > 0 && poIds.every(id => migratedPoIds.has(id))) {
      plan.skipReason = "Already migrated";
      plans.push(plan);
      continue;
    }
    plan.poIds = poIds;
    if (poIds.length > 0) {
      const placeholders = poIds.map(() => "?").join(",");
      const jcRes = await db
        .prepare(
          `SELECT id, productionOrderId, status, completedDate, departmentCode
             FROM job_cards
            WHERE productionOrderId IN (${placeholders})`,
        )
        .bind(...poIds)
        .all<{ id: string; productionOrderId: string; status: string; completedDate: string | null; departmentCode: string }>();
      for (const jc of (jcRes.results ?? [])) {
        if (["COMPLETED","TRANSFERRED","CANCELLED"].includes(jc.status)) continue;
        if (jc.departmentCode === "PACKING") {
          plan.packingJcsToStamp.push({ poId: jc.productionOrderId, jcId: jc.id });
        } else if (stampUpstream) {
          plan.upstreamJcsToStamp.push({ poId: jc.productionOrderId, jcId: jc.id, departmentCode: jc.departmentCode });
        }
      }
    }
    plans.push(plan);
  }

  const usable = plans.filter(p => !p.skipReason);
  const skipped = plans.filter(p => p.skipReason);
  const summary = {
    entries: entries.length,
    noSoMatch: skipped.filter(p => p.skipReason === "No matching SO").length,
    alreadyMigrated: skipped.filter(p => p.skipReason === "Already migrated").length,
    usableCount: usable.length,
    totalPackingJcsToStamp: usable.reduce((s, p) => s + p.packingJcsToStamp.length, 0),
    totalUpstreamJcsToStamp: usable.reduce((s, p) => s + p.upstreamJcsToStamp.length, 0),
    totalPOsToBundle: usable.reduce((s, p) => s + p.poIds.length, 0),
  };

  if (dryRun) {
    return c.json({
      success: true, dryRun: true, summary,
      sample: usable.slice(0, 5).map(p => ({
        custPO: p.custPO, doNo: p.doNo,
        soId: p.soId, poIds: p.poIds, packingJcsCount: p.packingJcsToStamp.length,
      })),
    });
  }

  // Live execute. Per-plan: stamp PACKING JCs + INSERT or APPEND delivery_orders + items.
  // Multiple legacy custPOs commonly share one DO number (multi-SO-per-DO).
  // First entry with a given doNo creates the header; subsequent entries with
  // the same doNo append their items to the existing DO and update totals.
  let dosCreated = 0, dosAppendedTo = 0, packingStamped = 0, upstreamStamped = 0;
  const errors: Array<{ custPO: string; error: string }> = [];
  for (const plan of usable) {
    try {
      const stmts: ReturnType<D1Database["prepare"]>[] = [];
      const planKey = `${plan.custPO}|${plan.doNo}`;
      const planDispatchDate = dispatchDateByEntry.get(planKey) ?? defaultDeliveryDate;
      const planDispatchedAt = `${planDispatchDate}T00:00:00.000Z`;
      // Stamp upstream JCs (when stampUpstream=true) — use dispatch date so the
      // historical timeline is preserved (legacy DO date = when it was actually done).
      for (const j of plan.upstreamJcsToStamp) {
        stmts.push(
          db.prepare(
            // completedAt travels with completedDate. BACKFILL — the date is
            // the legacy DO's dispatch date, not an observed instant, so NULL.
            `UPDATE job_cards SET status = 'COMPLETED', completedDate = ?, completedAt = NULL, overdue = 'COMPLETED'
              WHERE id = ?`,
          ).bind(planDispatchDate, j.jcId),
        );
      }
      // Stamp PACKING JCs
      for (const j of plan.packingJcsToStamp) {
        stmts.push(
          db.prepare(
            // completedAt travels with completedDate. BACKFILL — the date is
            // the legacy DO's dispatch date, not an observed instant, so NULL.
            `UPDATE job_cards SET status = 'COMPLETED', completedDate = ?, completedAt = NULL, overdue = 'COMPLETED'
              WHERE id = ?`,
          ).bind(planDispatchDate, j.jcId),
        );
      }
      const so = soByCustPo.get(plan.custPO)!;
      const placeholders = plan.poIds.map(() => "?").join(",");
      const totalsRes = plan.poIds.length > 0
        ? await db.prepare(
            `SELECT COALESCE(SUM(po.quantity * COALESCE(p.unitM3, 0)), 0) AS totalM3,
                    COALESCE(SUM(po.quantity), 0) AS totalItems
               FROM production_orders po
               LEFT JOIN products p ON p.code = po.productCode
              WHERE po.id IN (${placeholders})`,
          ).bind(...plan.poIds).first<{ totalM3: number; totalItems: number }>()
        : { totalM3: 0, totalItems: 0 };

      let doId = existingDoMap.get(plan.doNo);
      const isAppend = !!doId;
      if (!doId) {
        doId = `do-${crypto.randomUUID().slice(0, 8)}`;
        stmts.push(
          db.prepare(
            `INSERT INTO delivery_orders
               (id, doNo, salesOrderId, companySO, companySOId, customerId,
                customerPOId, customerName, customerState, hubId,
                deliveryDate, totalM3, totalItems, status, dispatchedAt,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOADED', ?, ?, ?)`,
          ).bind(
            doId, plan.doNo, plan.soId ?? null, so.companySO, so.companySOId,
            so.customerId, plan.custPO, so.customerName, so.customerState ?? null,
            so.hubId ?? null, planDispatchDate, totalsRes?.totalM3 ?? 0,
            totalsRes?.totalItems ?? 0,
            planDispatchedAt,
            new Date().toISOString(), new Date().toISOString(),
          ),
        );
        existingDoMap.set(plan.doNo, doId);
      } else {
        // Append: increment totals on the existing DO header AND back-fill the
        // dispatchedAt/deliveryDate with the legacy DO date when the entry
        // carries one. Earlier runs without per-entry dispatchDate stamped
        // dispatchedAt = run-time, which the user wants overwritten with the
        // real legacy DO date.
        stmts.push(
          db.prepare(
            `UPDATE delivery_orders
                SET totalM3 = totalM3 + ?,
                    totalItems = totalItems + ?,
                    dispatchedAt = COALESCE(?, dispatchedAt),
                    deliveryDate = COALESCE(?, deliveryDate),
                    updated_at = ?
              WHERE id = ?`,
          ).bind(
            totalsRes?.totalM3 ?? 0,
            totalsRes?.totalItems ?? 0,
            dispatchDateByEntry.has(planKey) ? planDispatchedAt : null,
            dispatchDateByEntry.has(planKey) ? planDispatchDate : null,
            new Date().toISOString(),
            doId,
          ),
        );
      }
      // INSERT delivery_order_items — one per production_order
      if (plan.poIds.length > 0) {
        const poItemsRes = await db.prepare(
          `SELECT po.id, po.poNo, po.productCode, po.productName, po.sizeLabel,
                  po.fabricCode, po.quantity, po.rackingNumber, po.salesOrderNo,
                  COALESCE(p.unitM3, 0) AS unitM3
             FROM production_orders po
             LEFT JOIN products p ON p.code = po.productCode
            WHERE po.id IN (${placeholders})`,
        ).bind(...plan.poIds).all<{
          id: string; poNo: string | null; productCode: string | null;
          productName: string | null; sizeLabel: string | null;
          fabricCode: string | null; quantity: number;
          rackingNumber: string | null; salesOrderNo: string | null;
          unitM3: number;
        }>();
        for (const r of (poItemsRes.results ?? [])) {
          const itemId = `doi-${crypto.randomUUID().slice(0, 8)}`;
          stmts.push(
            db.prepare(
              `INSERT INTO delivery_order_items
                 (id, deliveryOrderId, productionOrderId, poNo, productCode,
                  productName, sizeLabel, fabricCode, quantity, itemM3,
                  rackingNumber, packingStatus, salesOrderNo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`,
            ).bind(
              itemId, doId, r.id, r.poNo ?? "", r.productCode ?? "",
              r.productName ?? "", r.sizeLabel ?? "", r.fabricCode ?? "",
              r.quantity, r.quantity * r.unitM3,
              r.rackingNumber ?? "", r.salesOrderNo ?? "",
            ),
          );
        }
      }
      // Update SO status to READY_TO_SHIP if not already past
      stmts.push(
        db.prepare(
          `UPDATE sales_orders SET status = 'READY_TO_SHIP', updated_at = ?
            WHERE id = ?
              AND status IN ('IN_PRODUCTION','CONFIRMED','DRAFT')`,
        ).bind(new Date().toISOString(), plan.soId ?? ""),
      );
      // Batch in groups of 50
      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50));
      }
      if (isAppend) dosAppendedTo++; else dosCreated++;
      packingStamped += plan.packingJcsToStamp.length;
      upstreamStamped += plan.upstreamJcsToStamp.length;
    } catch (err) {
      errors.push({ custPO: plan.custPO, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({
    success: true, dryRun: false, summary,
    dosCreated, dosAppendedTo, packingStamped, upstreamStamped,
    errorCount: errors.length, errors: errors.slice(0, 10),
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/revert-dos-to-draft
//
// One-shot test helper. Flips every LOADED DO back to DRAFT (= "Pending
// Dispatch" in the UI) so the user can re-test the dispatch flow on the
// previously-migrated DOs. Optionally back-fills dispatchedAt / deliveryDate
// from the legacy Aut/aiy DO Date map (body.dateMap = { doNo: "YYYY-MM-DD" }).
//
// Bypasses the regular PUT /api/delivery-orders/:id reversal logic — does NOT
// unstamp PACKING JCs (they stay COMPLETED, since the items physically ARE
// packed).
// ---------------------------------------------------------------------------
app.post("/revert-dos-to-draft", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  let body: { dateMap?: Record<string, string> } = {};
  try { body = await c.req.json(); } catch { /* allow empty body */ }
  const dateMap = body.dateMap ?? {};

  // Pull every LOADED DO
  const res = await db
    .prepare(`SELECT id, doNo, status, dispatchedAt FROM delivery_orders WHERE status = 'LOADED'`)
    .all<{ id: string; doNo: string; status: string; dispatchedAt: string | null }>();
  const loadedDOs = res.results ?? [];

  let reverted = 0;
  let datesBackfilled = 0;
  const stmts: ReturnType<D1Database["prepare"]>[] = [];
  for (const d of loadedDOs) {
    const legacyDate = dateMap[d.doNo];
    if (legacyDate) {
      stmts.push(
        db.prepare(
          `UPDATE delivery_orders
              SET status = 'DRAFT',
                  dispatchedAt = ?,
                  deliveryDate = ?,
                  updated_at = ?
            WHERE id = ?`,
        ).bind(`${legacyDate}T00:00:00.000Z`, legacyDate, new Date().toISOString(), d.id),
      );
      datesBackfilled++;
    } else {
      stmts.push(
        db.prepare(
          `UPDATE delivery_orders
              SET status = 'DRAFT', updated_at = ?
            WHERE id = ?`,
        ).bind(new Date().toISOString(), d.id),
      );
    }
    reverted++;
  }
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50));
  }
  return c.json({
    success: true,
    loadedDOsFound: loadedDOs.length,
    reverted,
    datesBackfilled,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-so-reference
//
// One-shot fix for SOs created via the Scan PO modal before the
// `reference` field was wired up. The customer's Ref No was extracted by
// Claude into po_scan_samples but never landed on sales_orders. Walks
// every PO_SCAN_CLAUDE-source SO and copies yourRefNo from the matching
// po_scan_samples row (joined by customerPOId / poIdentifier) into
// sales_orders.reference. Idempotent: only fills when reference is empty.
//
// Will be deleted once the OCR migration window closes.
// ---------------------------------------------------------------------------
// One-shot backfill of sales_orders.hookkaExpectedDD = customerDeliveryDate - per-category buffer.
// Picks up SOs where the column was left empty (early OCR-flow deploys before
// the auto-derive fix landed, or any other path that skipped the calc).
// Idempotent: only fills empty values.
app.post("/backfill-so-expected-dd", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const buf = await loadHookkaDDBuffer(db);

  const targetsRes = await db
    .prepare(
      `SELECT so.id, so.customerDeliveryDate,
              (SELECT itemCategory FROM sales_order_items
                WHERE salesOrderId = so.id ORDER BY lineNo LIMIT 1) AS "firstCat"
         FROM sales_orders so
        WHERE so.orgId = ?
          AND (so.hookkaExpectedDD IS NULL OR so.hookkaExpectedDD = '')
          AND so.customerDeliveryDate IS NOT NULL
          AND so.customerDeliveryDate <> ''`,
    )
    .bind(orgId)
    .all<{ id: string; customerDeliveryDate: string; firstCat: string | null }>();
  const targets = targetsRes.results ?? [];

  let updated = 0;
  for (const t of targets) {
    const cat = t.firstCat || "BEDFRAME";
    const days = hookkaDDBufferFor(buf, cat);
    const expected = addDays(t.customerDeliveryDate.slice(0, 10), -days);
    await db
      .prepare("UPDATE sales_orders SET hookkaExpectedDD = ? WHERE id = ?")
      .bind(expected, t.id)
      .run();
    updated++;
  }

  return c.json({ success: true, targetsFound: targets.length, updated });
});

// Backfill sales_order_items.productName from product master where the
// stored name looks like the OCR's PDF description (contains common PDF
// markers like "HK", "COL:", or matches the productCode).
app.post("/backfill-so-item-product-name", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  // Note: Postgres lowercases unquoted identifiers, so aliases must be
  // double-quoted to round-trip as camelCase ("canonName" not "canonname").
  // Without the quotes, .all<{ canonName: string }>() returns undefined
  // for r.canonName and silently skips every row.
  const targetsRes = await db
    .prepare(
      `SELECT soi.id, soi.productCode, soi.productName, p.name AS "canonName"
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
         LEFT JOIN products p ON p.code = soi.productCode AND p.orgId = so.orgId
        WHERE so.orgId = ?
          AND soi.productCode IS NOT NULL AND soi.productCode <> ''
          AND p.name IS NOT NULL`,
    )
    .bind(orgId)
    .all<{ id: string; productCode: string; productName: string; canonName: string }>();
  const all = targetsRes.results ?? [];

  let updated = 0;
  for (const r of all) {
    // Only overwrite when current name looks like PDF junk:
    // - contains "HK" or "COL:" or "COLOUR:" (PDF description tokens)
    // - or matches productCode literally (which would mean no real name)
    // - or contains a slash (PDFs love slashes; product names don't)
    const looksJunk =
      /(?:^HK\d|COL:|COLOUR:|\/)/i.test(r.productName) ||
      r.productName === r.productCode ||
      r.productName === "";
    if (!looksJunk) continue;
    if (r.productName === r.canonName) continue;
    await db
      .prepare("UPDATE sales_order_items SET productName = ? WHERE id = ?")
      .bind(r.canonName, r.id)
      .run();
    updated++;
  }
  return c.json({ success: true, candidates: all.length, updated });
});

// ---------------------------------------------------------------------------
// POST /backfill-5543-co2606002 — ONE-SHOT (owner 2026-07-02). A phantom
// product code "5543-1C(LHF)" (never in the catalog) got onto consignment
// order CO-2606-002 and cascaded into its production order, finished units,
// CN lines and stock movements. The owner corrected the 5543 BOM in the
// catalog and wants the existing chain relabelled to the real "5543-1B(LHF)".
//
// Only the DENORMALISED product_code / product_name snapshots are touched, in
// the 5 tables that carry them. job_cards / wip_items key off wip_code (NOT the
// product code) so they are deliberately untouched, and the pieces breakdown is
// derived LIVE from the (now-fixed) BOM at print time — so nothing is
// re-exploded and no completed production is destroyed.
//
// AUDIT-FIRST: with no body it only REPORTS what it would change (read-only).
// To apply, POST { "apply": true, "confirm": "5543-1B" }. Idempotent — a second
// run finds zero phantom rows.
app.post("/backfill-5543-co2606002", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;

  const OLD = "5543-1C(LHF)";
  const NEW = "5543-1B(LHF)";
  const CO_NO = "CO-2606-002";

  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const doApply = body.apply === true && body.confirm === "5543-1B";

  // Resolve the consignment order by its Hookka number.
  const co = await db
    .prepare('SELECT id AS "id" FROM consignment_orders WHERE company_co_id = ?')
    .bind(CO_NO)
    .first<{ id: string }>();
  if (!co?.id)
    return c.json({ success: false, error: `Consignment order ${CO_NO} not found` }, 404);
  const coId = co.id;

  // Canonical new name + guard that the replacement code EXISTS in the catalog
  // (else the live BOM/pieces lookup by code breaks after relabelling).
  const prod = await db
    .prepare('SELECT name AS "name" FROM products WHERE code = ?')
    .bind(NEW)
    .first<{ name: string }>();
  const newName = prod?.name ?? null;
  const newCodeInCatalog = !!prod;

  // POs + CNs under this CO (ids only) to scope the downstream snapshot tables.
  const posRes = await db
    .prepare('SELECT id AS "id" FROM production_orders WHERE consignment_order_id = ?')
    .bind(coId)
    .all<{ id: string }>();
  const poIds = (posRes.results ?? []).map((p) => p.id);
  const cnsRes = await db
    .prepare('SELECT id AS "id" FROM consignment_notes WHERE consignment_order_id = ?')
    .bind(coId)
    .all<{ id: string }>();
  const cnIds = (cnsRes.results ?? []).map((r) => r.id);

  const inList = (arr: string[]) => arr.map(() => "?").join(",");

  // Each snapshot table + how to scope it to THIS CO's chain.
  type Target = { table: string; scopeSql: string; scopeBind: string[] };
  const targets: Target[] = [
    { table: "consignment_order_items", scopeSql: "consignment_order_id = ?", scopeBind: [coId] },
    { table: "production_orders", scopeSql: "consignment_order_id = ?", scopeBind: [coId] },
  ];
  if (poIds.length) {
    targets.push({ table: "fg_units", scopeSql: `po_id IN (${inList(poIds)})`, scopeBind: poIds });
    targets.push({ table: "stock_movements", scopeSql: `production_order_id IN (${inList(poIds)})`, scopeBind: poIds });
  }
  // CN lines link either by PO id or by CN id — cover both.
  if (poIds.length || cnIds.length) {
    const parts: string[] = [];
    const binds: string[] = [];
    if (poIds.length) { parts.push(`production_order_id IN (${inList(poIds)})`); binds.push(...poIds); }
    if (cnIds.length) { parts.push(`consignment_note_id IN (${inList(cnIds)})`); binds.push(...cnIds); }
    targets.push({ table: "consignment_items", scopeSql: `(${parts.join(" OR ")})`, scopeBind: binds });
  }

  // AUDIT every target (read-only): the exact rows carrying the phantom code,
  // plus the DISTINCT codes present so OLD can be confirmed to match precisely.
  type RowVM = { id: string; productCode: string | null; productName: string | null };
  const report: Array<{
    table: string;
    distinctCodesInChain: string[];
    phantomRows: RowVM[];
    updated?: number;
  }> = [];
  let totalPhantom = 0;
  for (const t of targets) {
    const distinctRes = await db
      .prepare(`SELECT DISTINCT product_code AS "productCode" FROM ${t.table} WHERE ${t.scopeSql}`)
      .bind(...t.scopeBind)
      .all<{ productCode: string | null }>();
    const rowsRes = await db
      .prepare(`SELECT id AS "id", product_code AS "productCode", product_name AS "productName" FROM ${t.table} WHERE ${t.scopeSql} AND product_code = ?`)
      .bind(...t.scopeBind, OLD)
      .all<RowVM>();
    const phantomRows = rowsRes.results ?? [];
    totalPhantom += phantomRows.length;
    report.push({
      table: t.table,
      distinctCodesInChain: (distinctRes.results ?? [])
        .map((r) => r.productCode ?? "")
        .filter(Boolean),
      phantomRows,
    });
  }

  if (!doApply) {
    return c.json({
      success: true,
      mode: "audit",
      co: { number: CO_NO, id: coId },
      old: OLD,
      new: NEW,
      newName,
      newCodeInCatalog,
      poCount: poIds.length,
      cnCount: cnIds.length,
      totalPhantomRows: totalPhantom,
      report,
      note: newCodeInCatalog
        ? 'Review phantomRows. To apply, POST { "apply": true, "confirm": "5543-1B" }.'
        : `REFUSING to apply: replacement code ${NEW} is NOT in the products catalog — fix the catalog/BOM first or the live pieces lookup will break.`,
    });
  }

  // APPLY — refuse if the replacement code isn't a real catalog product.
  if (!newCodeInCatalog || !newName) {
    return c.json(
      { success: false, error: `Replacement code ${NEW} not found in products catalog; aborting.` },
      400,
    );
  }
  for (const t of targets) {
    await db
      .prepare(`UPDATE ${t.table} SET product_code = ?, product_name = ? WHERE ${t.scopeSql} AND product_code = ?`)
      .bind(NEW, newName, ...t.scopeBind, OLD)
      .run();
    const entry = report.find((r) => r.table === t.table);
    if (entry) entry.updated = entry.phantomRows.length;
  }
  return c.json({
    success: true,
    mode: "apply",
    co: { number: CO_NO, id: coId },
    old: OLD,
    new: NEW,
    newName,
    totalPhantomRows: totalPhantom,
    report,
  });
});

// POST /backfill-complete-stray-jc-co2606002 — ONE-SHOT (owner 2026-07-03).
// The 5543 production order pord-co-72dcea0a-01 is stuck PENDING because ONE
// junk job card is WAITING: a leftover from the OLD broken 5543 BOM whose
// wip_key still reads "5543-1C(LHF)::…::Base {MODULE}" with the unexpanded
// {MODULE} template placeholder. The physical sofa is done (the other 12 cards
// are COMPLETED). This marks that ONE stray card COMPLETED and recomputes so
// the PO flips to COMPLETED. It touches ONLY that card, creates no inventory
// (the finished unit already exists), and refuses to run unless the target is
// genuinely the WAITING {MODULE} junk card. AUDIT-FIRST — apply with
// { "apply": true, "confirm": "complete-jc" }.
app.post("/backfill-complete-stray-jc-co2606002", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the UPDATE
  // below mentions completed_at.
  await ensureJobCardCompletedAt(db);

  const PO_ID = "pord-co-72dcea0a-01";
  const JC_ID = "jc-1vxvn3i011nbi7-05";

  const body = (await c.req.json().catch(() => ({}))) as {
    apply?: boolean;
    confirm?: string;
  };
  const doApply = body.apply === true && body.confirm === "complete-jc";

  const jc = await db
    .prepare(
      'SELECT id AS "id", status AS "status", wip_key AS "wipKey", wip_label AS "wipLabel", completed_date AS "completedDate" FROM job_cards WHERE id = ? AND production_order_id = ?',
    )
    .bind(JC_ID, PO_ID)
    .first<{
      id: string;
      status: string;
      wipKey: string | null;
      wipLabel: string | null;
      completedDate: string | null;
    }>();
  const poBefore = await db
    .prepare('SELECT status AS "status", completed_date AS "completedDate" FROM production_orders WHERE id = ?')
    .bind(PO_ID)
    .first<{ status: string; completedDate: string | null }>();
  if (!jc || !poBefore)
    return c.json({ success: false, error: "job card or PO not found" }, 404);

  // Only ever touch the genuine junk card: WAITING + the {MODULE} placeholder.
  const isJunk =
    jc.status === "WAITING" && String(jc.wipKey ?? "").includes("{MODULE}");

  if (!doApply) {
    return c.json({
      success: true,
      mode: "audit",
      po: { id: PO_ID, status: poBefore.status },
      strayCard: jc,
      isJunkWaitingCard: isJunk,
      note: isJunk
        ? 'Target is the junk WAITING {MODULE} card. To apply, POST { "apply": true, "confirm": "complete-jc" }.'
        : "Target is NOT a junk WAITING {MODULE} card — refusing to change it.",
    });
  }

  if (!isJunk)
    return c.json(
      { success: false, error: "Target is not the expected junk WAITING {MODULE} card; aborting." },
      400,
    );

  // Stamp with the latest real sibling completion date so it reads sensibly.
  const maxRow = await db
    .prepare('SELECT MAX(completed_date) AS "maxDate" FROM job_cards WHERE production_order_id = ? AND completed_date IS NOT NULL')
    .bind(PO_ID)
    .first<{ maxDate: string | null }>();
  const doneDate = maxRow?.maxDate || new Date().toISOString().slice(0, 10);

  await db
    // completed_at travels with completed_date. The date is borrowed from a
    // sibling card, so nothing was observed here — NULL, never a made-up time.
    .prepare(
      "UPDATE job_cards SET status = 'COMPLETED', completed_date = ?, completed_at = NULL WHERE id = ? AND status = 'WAITING'",
    )
    .bind(doneDate, JC_ID)
    .run();
  const recompute = await recomputePoStatusAndProgress(db, PO_ID);

  const poAfter = await db
    .prepare('SELECT status AS "status", completed_date AS "completedDate", progress AS "progress" FROM production_orders WHERE id = ?')
    .bind(PO_ID)
    .first<{ status: string; completedDate: string | null; progress: number }>();
  return c.json({
    success: true,
    mode: "apply",
    jcId: JC_ID,
    completedDate: doneDate,
    poBefore: poBefore.status,
    poAfter,
    recompute,
  });
});

// Cascade-backfill productName/sizeLabel/sizeCode/fabricCode to downstream
// snapshot tables (production_orders, delivery_order_items, invoice_items)
// from the canonical sales_order_items values. Run AFTER
// /backfill-ocr-so-fields so SO items are clean first.
app.post("/backfill-downstream-product-names", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  const cleanItems = await db
    .prepare(
      `SELECT soi.salesOrderId, soi.lineNo, soi.productCode, soi.productName,
              soi.sizeLabel, soi.sizeCode, soi.fabricCode
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE so.orgId = ?`,
    )
    .bind(orgId)
    .all<{
      salesOrderId: string;
      lineNo: number;
      productCode: string | null;
      productName: string | null;
      sizeLabel: string | null;
      sizeCode: string | null;
      fabricCode: string | null;
    }>();

  let poUpdated = 0;
  let doUpdated = 0;
  let invUpdated = 0;

  for (const item of cleanItems.results ?? []) {
    if (!item.productName) continue;
    const poRes = await db
      .prepare(
        `UPDATE production_orders SET productName = ?, sizeLabel = ?, sizeCode = ?, fabricCode = ?
           WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(
        item.productName,
        item.sizeLabel ?? "",
        item.sizeCode ?? "",
        item.fabricCode ?? "",
        item.salesOrderId,
        item.lineNo,
      )
      .run()
      .catch(() => ({ meta: { changes: 0 } }));
    poUpdated += poRes.meta?.changes ?? 0;

    const doRes = await db
      .prepare(
        `UPDATE delivery_order_items SET productName = ?, sizeLabel = ?, sizeCode = ?, fabricCode = ?
           WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(
        item.productName,
        item.sizeLabel ?? "",
        item.sizeCode ?? "",
        item.fabricCode ?? "",
        item.salesOrderId,
        item.lineNo,
      )
      .run()
      .catch(() => ({ meta: { changes: 0 } }));
    doUpdated += doRes.meta?.changes ?? 0;

    const invRes = await db
      .prepare(
        `UPDATE invoice_items SET productName = ?
           WHERE salesOrderId = ? AND lineNo = ?`,
      )
      .bind(item.productName, item.salesOrderId, item.lineNo)
      .run()
      .catch(() => ({ meta: { changes: 0 } }));
    invUpdated += invRes.meta?.changes ?? 0;
  }

  return c.json({
    success: true,
    cleanItemsScanned: cleanItems.results?.length ?? 0,
    productionOrdersUpdated: poUpdated,
    deliveryOrderItemsUpdated: doUpdated,
    invoiceItemsUpdated: invUpdated,
  });
});

app.post("/backfill-so-reference", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const orgId = getOrgId(c);

  // SOs that need either reference OR customerSOId. Match any with
  // empty value so re-runs don't clobber operator-edited values.
  const targetsRes = await db
    .prepare(
      `SELECT id, customerPOId, reference, customerSOId
         FROM sales_orders
        WHERE orgId = ?
          AND ((reference IS NULL OR reference = '')
               OR (customerSOId IS NULL OR customerSOId = ''))
          AND customerPOId IS NOT NULL
          AND customerPOId <> ''`,
    )
    .bind(orgId)
    .all<{ id: string; customerPOId: string; reference: string | null; customerSOId: string | null }>();
  const targets = targetsRes.results ?? [];

  let updatedReference = 0;
  let updatedCustomerSO = 0;
  const skipped: { soId: string; customerPO: string; reason: string }[] = [];

  for (const t of targets) {
    const sampleRes = await db
      .prepare(
        `SELECT correctedJson, rawExtracted
           FROM po_scan_samples
          WHERE poIdentifier = ?
          ORDER BY createdAt DESC
          LIMIT 1`,
      )
      .bind(t.customerPOId)
      .first<{ correctedJson: string | null; rawExtracted: string | null }>();
    if (!sampleRes) {
      skipped.push({ soId: t.id, customerPO: t.customerPOId, reason: "no sample" });
      continue;
    }

    const blob = sampleRes.correctedJson || sampleRes.rawExtracted || "";
    let parsed: { yourRefNo?: unknown; customerSO?: unknown };
    try {
      parsed = JSON.parse(blob) as { yourRefNo?: unknown; customerSO?: unknown };
    } catch {
      skipped.push({ soId: t.id, customerPO: t.customerPOId, reason: "bad JSON" });
      continue;
    }

    const newRef =
      typeof parsed.yourRefNo === "string" && parsed.yourRefNo
        ? parsed.yourRefNo
        : null;
    const newCustSO =
      typeof parsed.customerSO === "string" && parsed.customerSO
        ? parsed.customerSO
        : null;

    if (!newRef && !newCustSO) {
      skipped.push({ soId: t.id, customerPO: t.customerPOId, reason: "no fields" });
      continue;
    }

    if (newRef && (!t.reference || t.reference === "")) {
      await db
        .prepare("UPDATE sales_orders SET reference = ? WHERE id = ?")
        .bind(newRef, t.id)
        .run();
      updatedReference++;
    }
    if (newCustSO && (!t.customerSOId || t.customerSOId === "")) {
      await db
        .prepare("UPDATE sales_orders SET customerSOId = ? WHERE id = ?")
        .bind(newCustSO, t.id)
        .run();
      updatedCustomerSO++;
    }
  }

  return c.json({
    success: true,
    targetsFound: targets.length,
    updatedReference,
    updatedCustomerSO,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-ocr-so-fields
//
// One-shot cleanup for SOs created via the Scan PO modal before the
// catalog-bound rule was enforced (commits ea7f08b, 83a699a, and the
// follow-up scan-po-modal cleanup). The earlier OCR path persisted PDF
// text directly into category-A fields (productName, sizeLabel, sizeCode,
// fabricId, specialOrder), which now diverge from the catalog values
// after a maintenance edit.
//
// What it does (idempotent — only rewrites obvious wrongs):
//   1. Targets sales_order_items belonging to SOs that look OCR-created:
//        - parent SO has customerPOImageB64 NOT NULL (proxy for
//          PO_SCAN_CLAUDE source — added in migration 0108), OR
//        - productName matches one of the junk patterns (literal
//          productCode, contains "/", "HK", "COL:", "COLOUR:").
//   2. Re-resolves productName / sizeCode / sizeLabel from products.code.
//   3. For SOFA items: snaps sizeLabel to the quoted '28"' shape the
//      Edit dropdown keys against; fills sizeCode from sizeLabel if blank.
//   4. Cleans specialOrder: drops any comma-token that doesn't appear in
//      the variants-config catalog (Specials list, scoped per category).
//      Tokens are matched case-insensitively but stored with the catalog
//      casing. Empty result becomes "".
//
// Returns: { candidates, productNameUpdated, sizeUpdated,
//            specialOrderCleaned }.
//
// 2026-05-09: fabricId backfill step removed — picker now keys on
// fabricCode directly; sales_order_items.fabricId column is being dropped.
//
// Permission: sales-orders:update (same gate as the PATCH handler).
// ---------------------------------------------------------------------------
app.post("/backfill-ocr-so-fields", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  const orgId = getOrgId(c);

  // ----- 1. Load variants-config Specials lists (per category) -----------
  // Same shape the scan-po catalog endpoint reads. Tolerant of both string
  // entries and {value:...} priced-option entries.
  const cfgRow = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("variants-config")
    .first<{ value: string }>();

  const extractValues = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x: unknown) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object" && "value" in x) {
          const v = (x as { value?: unknown }).value;
          return typeof v === "string" ? v : "";
        }
        return "";
      })
      .filter(Boolean);
  };
  let bedframeSpecials: string[] = [];
  let sofaSpecials: string[] = [];
  if (cfgRow?.value) {
    try {
      const cfg = JSON.parse(cfgRow.value) as Record<string, unknown>;
      bedframeSpecials = extractValues(cfg.specials);
      sofaSpecials = extractValues(cfg.sofaSpecials);
    } catch {
      // Bad JSON — leave catalogs empty. We'll skip specialOrder cleaning
      // entirely (safer than dropping all tokens).
    }
  }

  // ----- 2. Find candidate items ----------------------------------------
  // Two-track match:
  //   a) parent SO has a PO image (definitive OCR signal)
  //   b) productName looks like PDF junk (catches old rows from before
  //      the image column existed in migration 0108)
  // Diagnostic: drop the p.orgId = so.orgId condition so we can see if the
  // join was failing only because of that (single-tenant deploys still
  // resolve correctly; cross-tenant collisions on identical productCode
  // are vanishingly unlikely in this codebase).
  const targetsRes = await db
    .prepare(
      `SELECT soi.id,
              soi.productCode,
              soi.productName,
              soi.itemCategory,
              soi.sizeCode,
              soi.sizeLabel,
              soi.fabricCode,
              soi.specialOrder,
              p.id   AS "canonProductId",
              p.name AS "canonName",
              p.sizeCode  AS "canonSizeCode",
              p.sizeLabel AS "canonSizeLabel",
              p.category  AS "canonCategory"
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
         LEFT JOIN products p ON p.code = soi.productCode
        WHERE so.orgId = ?
          AND (so.customerPOImageB64 IS NOT NULL
               OR soi.productName = soi.productCode
               OR soi.productName LIKE '%/%'
               OR soi.productName LIKE 'HK%'
               OR soi.productName LIKE '%COL:%'
               OR soi.productName LIKE '%COLOUR:%')`,
    )
    .bind(orgId)
    .all<{
      id: string;
      productCode: string | null;
      productName: string | null;
      itemCategory: string | null;
      sizeCode: string | null;
      sizeLabel: string | null;
      fabricCode: string | null;
      specialOrder: string | null;
      canonProductId: string | null;
      canonName: string | null;
      canonSizeCode: string | null;
      canonSizeLabel: string | null;
      canonCategory: string | null;
    }>();
  const candidates = targetsRes.results ?? [];

  let productNameUpdated = 0;
  let sizeUpdated = 0;
  let specialOrderCleaned = 0;
  let nullCanonName = 0;
  let alreadyMatches = 0;
  const notUpdatedSamples: { code: string; name: string; canonName: string | null }[] = [];

  // 2026-05-09: fabricId resolve removed. Picker now keys on fabricCode
  // directly so no client-side namespace translation is needed; the
  // sales_order_items.fabricId column is being dropped.

  for (const r of candidates) {
    // -- productName -----------------------------------------------------
    const looksJunk =
      r.productName === "" ||
      r.productName === null ||
      (r.productCode && r.productName === r.productCode) ||
      (r.productName != null &&
        /(?:^HK\d|COL:|COLOUR:|\/)/i.test(r.productName));
    if (looksJunk && r.canonName && r.productName !== r.canonName) {
      await db
        .prepare("UPDATE sales_order_items SET productName = ? WHERE id = ?")
        .bind(r.canonName, r.id)
        .run();
      productNameUpdated++;
    } else if (looksJunk) {
      // Diagnostic: this row should have been updated but wasn't.
      if (!r.canonName) {
        nullCanonName++;
        if (notUpdatedSamples.length < 5) {
          notUpdatedSamples.push({
            code: r.productCode ?? "",
            name: r.productName ?? "",
            canonName: r.canonName,
          });
        }
      } else {
        alreadyMatches++;
      }
    }

    // -- size (sizeCode / sizeLabel) ------------------------------------
    // Only rewrite when the stored value is empty OR clearly wrong (sofa
    // stored as bare number "28" → snap to '28"'; or junky bedframe size
    // like "5FT/QUEEN" mismatched against the catalog).
    const isSofa =
      (r.itemCategory ?? r.canonCategory) === "SOFA";
    let newSizeLabel = r.sizeLabel ?? "";
    let newSizeCode = r.sizeCode ?? "";

    if (!newSizeLabel && r.canonSizeLabel) newSizeLabel = r.canonSizeLabel;
    if (!newSizeCode && r.canonSizeCode) newSizeCode = r.canonSizeCode;

    if (isSofa && newSizeLabel && /^\d+(\.\d+)?$/.test(newSizeLabel.trim())) {
      newSizeLabel = `${newSizeLabel.trim()}"`;
    }
    if (isSofa && !newSizeCode && newSizeLabel) {
      newSizeCode = newSizeLabel.replace(/"/g, "").trim();
    }
    // SOFA sizeCode should be the numeric seat height ("24"), NOT the
    // catalog variant tag ("1A(LHF)"). The old POST path fell back to
    // resolvedProduct.sizeCode (which IS the variant tag for SOFA
    // products) whenever the client didn't send sizeCode. Heal those:
    // when sizeCode contains letters/parens but sizeLabel is a clean
    // numeric value, derive numeric sizeCode from sizeLabel.
    if (isSofa && newSizeCode && newSizeLabel) {
      const looksVariantTag = /[A-Za-z()]/.test(newSizeCode);
      const labelStripped = newSizeLabel.replace(/"/g, "").trim();
      const labelLooksNumeric = /^\d+(\.\d+)?$/.test(labelStripped);
      if (looksVariantTag && labelLooksNumeric) {
        newSizeCode = labelStripped;
      }
    }

    // BEDFRAME junk fix — when sizeLabel got back-doored as the productCode
    // suffix (e.g. "(K)" instead of catalog's "6FT"), snap it to canon.
    // Triggers when sizeLabel is wrapped in parens AND its inner content
    // matches sizeCode — that's the OCR-suffix-copy signature.
    if (!isSofa && newSizeLabel && r.canonSizeLabel) {
      const inner = newSizeLabel.replace(/^\(|\)$/g, "").trim();
      const looksLikeSuffix =
        /^\(.+\)$/.test(newSizeLabel) &&
        (inner === (r.sizeCode ?? "") ||
          inner === (r.canonSizeCode ?? "") ||
          inner.toUpperCase() === (r.canonSizeCode ?? "").toUpperCase());
      if (looksLikeSuffix) {
        newSizeLabel = r.canonSizeLabel;
      }
    }
    const sizeChanged =
      newSizeLabel !== (r.sizeLabel ?? "") ||
      newSizeCode !== (r.sizeCode ?? "");
    if (sizeChanged) {
      await db
        .prepare(
          "UPDATE sales_order_items SET sizeLabel = ?, sizeCode = ? WHERE id = ?",
        )
        .bind(newSizeLabel, newSizeCode, r.id)
        .run();
      sizeUpdated++;
    }

    // 2026-05-09: fabricId backfill removed — column being dropped.

    // -- specialOrder cleaning ------------------------------------------
    // Only when we have a catalog loaded — otherwise we'd risk wiping
    // valid values just because the kv_config row is unreadable.
    if (r.specialOrder && r.specialOrder.trim() !== "") {
      const specialList = isSofa ? sofaSpecials : bedframeSpecials;
      if (specialList.length > 0) {
        const tokens = r.specialOrder
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const cleaned: string[] = [];
        for (const t of tokens) {
          const match = specialList.find(
            (c) => c.toLowerCase() === t.toLowerCase(),
          );
          if (match) cleaned.push(match);
        }
        const cleanedStr = cleaned.join(", ");
        if (cleanedStr !== r.specialOrder) {
          await db
            .prepare(
              "UPDATE sales_order_items SET specialOrder = ? WHERE id = ?",
            )
            .bind(cleanedStr, r.id)
            .run();
          specialOrderCleaned++;
        }
      }
    }
  }

  return c.json({
    success: true,
    candidates: candidates.length,
    productNameUpdated,
    sizeUpdated,
    specialOrderCleaned,
    nullCanonName,
    alreadyMatches,
    notUpdatedSamples,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/rebuild-production-orders-from-soi
//
// Option D one-shot fixer (2026-05-06). Finds every SO whose
// SUM(non-cancelled items.quantity) doesn't match
// SUM(non-cancelled production_orders.quantity) — meaning the items table
// (the new single source of truth) has drifted from the cached PO fan-out
// (e.g. an SO was edited via the legacy PUT path that didn't rebuild POs).
// For each affected SO, if every JC is still WAITING/CANCELLED (the same
// gate the PUT handler enforces), teardown all POs/JCs/fg_units and rebuild
// from sales_order_items via createProductionOrdersForOrder. Locked SOs are
// reported but skipped.
//
// Auth: sales-orders:update (same as the audit endpoints in this file).
// Tenant: getOrgId(c) is invoked for parity with the other admin endpoints,
// even though sales_orders + production_orders aren't tenant-scoped on this
// schema (single-tenant deployment for the migration window).
// ---------------------------------------------------------------------------
app.post("/rebuild-production-orders-from-soi", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  void getOrgId(c); // parity with sibling admin endpoints
  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";

  // 1. Find every SO with a SUM(items.quantity) vs SUM(po.quantity) mismatch
  //    over non-cancelled rows. NULL SUMs (no items / no POs) coalesce to 0.
  const candRes = await db
    .prepare(
      `SELECT so.id AS soId,
              so.companySOId AS companySOId,
              so.status AS status,
              COALESCE(soi.qty, 0) AS expected,
              COALESCE(po.qty, 0) AS actual
         FROM sales_orders so
         LEFT JOIN (
           SELECT salesOrderId, SUM(quantity) AS qty
             FROM sales_order_items
            GROUP BY salesOrderId
         ) soi ON soi.salesOrderId = so.id
         LEFT JOIN (
           SELECT salesOrderId, SUM(quantity) AS qty
             FROM production_orders
            WHERE status <> 'CANCELLED'
            GROUP BY salesOrderId
         ) po ON po.salesOrderId = so.id
        WHERE so.status IN ('CONFIRMED', 'IN_PRODUCTION')
          AND COALESCE(soi.qty, 0) <> COALESCE(po.qty, 0)`,
    )
    .all<{
      soId: string;
      companySOId: string | null;
      status: string;
      expected: number;
      actual: number;
    }>();
  const candidates = candRes.results ?? [];

  type CandidateReport = {
    soId: string;
    companySOId: string | null;
    status: string;
    expected: number;
    actual: number;
  };
  type LockedReport = CandidateReport & {
    reason: string;
    jcStatus: string;
    deptCode: string;
  };
  type RebuiltReport = CandidateReport & {
    deletedPoCount: number;
    createdPoNos: string[];
  };
  type ErrorReport = CandidateReport & { error: string };

  const candidateReports: CandidateReport[] = candidates.map((r) => ({
    soId: r.soId,
    companySOId: r.companySOId,
    status: r.status,
    expected: r.expected,
    actual: r.actual,
  }));
  const locked: LockedReport[] = [];
  const rebuilt: RebuiltReport[] = [];
  const errors: ErrorReport[] = [];

  for (const cand of candidates) {
    const cr: CandidateReport = {
      soId: cand.soId,
      companySOId: cand.companySOId,
      status: cand.status,
      expected: cand.expected,
      actual: cand.actual,
    };

    // 2. JC lock — same Option D gate as PUT /:id. Any JC past WAITING/CANCELLED
    //    means production has started and we can't safely rebuild.
    const startedRes = await db
      .prepare(
        `SELECT jc.status, jc.departmentCode
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.salesOrderId = ?
            AND jc.status NOT IN ('WAITING', 'CANCELLED')
          ORDER BY jc.sequence ASC, jc.id ASC
          LIMIT 1`,
      )
      .bind(cand.soId)
      .first<{ status: string | null; departmentCode: string | null }>();
    if (startedRes && startedRes.status) {
      locked.push({
        ...cr,
        reason: "production_started",
        jcStatus: startedRes.status,
        deptCode: startedRes.departmentCode || "",
      });
      continue;
    }

    if (dryRun) {
      // Dry-run still reports as a rebuild candidate (no writes).
      rebuilt.push({ ...cr, deletedPoCount: 0, createdPoNos: [] });
      continue;
    }

    // 3. Teardown + rebuild — same shape as PUT /:id (fg_units → job_cards
    //    → production_orders; rebuild via createProductionOrdersForOrder).
    try {
      const so = await db
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(cand.soId)
        .first<{
          id: string;
          companySOId: string | null;
          companySODate: string | null;
          customerPOId: string | null;
          reference: string | null;
          customerName: string;
          customerState: string | null;
          hookkaExpectedDD: string | null;
          customerDeliveryDate: string | null;
        }>();
      if (!so) {
        errors.push({ ...cr, error: "Sales order disappeared mid-run" });
        continue;
      }
      const itemsRes = await db
        .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
        .bind(cand.soId)
        .all<{
          lineNo: number;
          productId: string | null;
          productCode: string | null;
          productName: string | null;
          itemCategory: string | null;
          sizeCode: string | null;
          sizeLabel: string | null;
          fabricCode: string | null;
          quantity: number;
          gapInches: number | null;
          divanHeightInches: number | null;
          legHeightInches: number | null;
          specialOrder: string | null;
          notes: string | null;
        }>();
      const items = itemsRes.results ?? [];
      if (items.length === 0) {
        errors.push({ ...cr, error: "Sales order has no items" });
        continue;
      }

      const built = await createProductionOrdersForOrder(
        db,
        {
          id: so.id,
          sourceType: "SO",
          companyOrderId: so.companySOId ?? "",
          companyOrderDate: so.companySODate,
          customerPOId: so.customerPOId,
          reference: so.reference,
          customerName: so.customerName,
          customerState: so.customerState,
          hookkaExpectedDD: so.hookkaExpectedDD,
          customerDeliveryDate: so.customerDeliveryDate,
        },
        items.map((it) => ({
          lineNo: it.lineNo,
          productId: it.productId,
          productCode: it.productCode,
          productName: it.productName,
          itemCategory: it.itemCategory,
          sizeCode: it.sizeCode,
          sizeLabel: it.sizeLabel,
          fabricCode: it.fabricCode,
          quantity: it.quantity,
          gapInches: it.gapInches,
          divanHeightInches: it.divanHeightInches,
          legHeightInches: it.legHeightInches,
          specialOrder: it.specialOrder,
          notes: it.notes,
        })),
        { forceRebuild: true },
      );

      // Count existing POs before delete so the report shows what was wiped.
      const existingPosRes = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM production_orders WHERE salesOrderId = ?",
        )
        .bind(cand.soId)
        .first<{ n: number }>();
      const deletedPoCount = existingPosRes?.n ?? 0;

      const deleteFgUnitsStmt = db
        .prepare(
          `DELETE FROM fg_units WHERE po_id IN (
             SELECT id FROM production_orders WHERE salesOrderId = ?)`,
        )
        .bind(cand.soId);
      const deleteJcsStmt = db
        .prepare(
          `DELETE FROM job_cards WHERE productionOrderId IN (
             SELECT id FROM production_orders WHERE salesOrderId = ?)`,
        )
        .bind(cand.soId);
      const deletePosStmt = db
        .prepare("DELETE FROM production_orders WHERE salesOrderId = ?")
        .bind(cand.soId);

      await db.batch([
        deleteFgUnitsStmt,
        deleteJcsStmt,
        deletePosStmt,
        ...built.statements,
      ]);

      rebuilt.push({
        ...cr,
        deletedPoCount,
        createdPoNos: built.created.map((p) => p.poNo),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ ...cr, error: msg });
    }
  }

  return c.json({
    success: true,
    dryRun,
    candidateCount: candidateReports.length,
    rebuiltCount: rebuilt.length,
    lockedCount: locked.length,
    errorCount: errors.length,
    candidates: candidateReports,
    rebuilt,
    locked,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/correct-so-line-qty-cascade
//
// Surgical "scale-down qty" cascade for an SO line whose quantity was
// originally over-stated relative to actual production. Surfaced by
// SO-2604-307: line entered as qty=10, only 1 sofa actually produced;
// PO + JCs were created with qty=10 multiplier, so wipQty + financials
// are 10× inflated.
//
// Scope (UPDATE only — no DELETE):
//   1. sales_order_items: quantity, lineTotalSen
//   2. sales_orders: subtotalSen, totalSen
//   3. production_orders: quantity (the FIRST PO matching this line by
//      productCode + qty, since salesOrderItemId is NULL on legacy POs)
//   4. job_cards: wipQty for every JC of that PO, scaled by
//      `newQuantity / oldQuantity`. Each JC's wipQty must divide
//      cleanly (oldWipQty % oldQty === 0) — otherwise the BOM
//      multiplier wasn't a clean integer of qty, abort.
//
// NOT touched (operator must handle separately if needed):
//   - wip_items (RM consumption tracking — would need to reverse 9
//     sofas worth of RM consume, complex and tied to FIFO batches)
//   - cost_ledger LABOR_POSTED / RM_CONSUMED entries
//   - fg_units / fg_batches (if any FG was generated)
//   - delivery_order_items (if PO was DO'd)
//   - invoices (if customer was invoiced)
//
// Body: { soLineItemId: string, newQuantity: number, dryRun: boolean }
// Returns: full diff list + warnings about untouched cascades.
//
// Permission: sales-orders:update.
// ---------------------------------------------------------------------------
app.post("/correct-so-line-qty-cascade", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;

  let body: {
    soLineItemId?: unknown;
    newQuantity?: unknown;
    dryRun?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const lineId =
    typeof body.soLineItemId === "string" ? body.soLineItemId : "";
  const newQty =
    typeof body.newQuantity === "number" ? body.newQuantity : NaN;
  const dryRun = body.dryRun === true;
  if (!lineId) {
    return c.json({ success: false, error: "soLineItemId required" }, 400);
  }
  if (!Number.isInteger(newQty) || newQty < 1) {
    return c.json(
      { success: false, error: "newQuantity must be a positive integer" },
      400,
    );
  }
  const db = c.var.DB;

  const line = await db
    .prepare(
      `SELECT id, salesOrderId, productCode, quantity, unitPriceSen,
              basePriceSen, lineTotalSen
         FROM sales_order_items WHERE id = ? LIMIT 1`,
    )
    .bind(lineId)
    .first<{
      id: string;
      salesOrderId: string;
      productCode: string | null;
      quantity: number;
      unitPriceSen: number;
      basePriceSen: number;
      lineTotalSen: number;
    }>();
  if (!line) {
    return c.json(
      { success: false, error: `SO line item not found: ${lineId}` },
      404,
    );
  }
  if (line.quantity === newQty) {
    return c.json({
      success: true,
      noOp: true,
      message: "newQuantity equals current quantity — no changes",
    });
  }
  const oldQty = line.quantity;
  const so = await db
    .prepare(
      "SELECT id, companySOId, subtotalSen, totalSen FROM sales_orders WHERE id = ? LIMIT 1",
    )
    .bind(line.salesOrderId)
    .first<{
      id: string;
      companySOId: string | null;
      subtotalSen: number;
      totalSen: number;
    }>();
  if (!so) {
    return c.json({ success: false, error: "Parent SO not found" }, 404);
  }

  const newLineTotal = (line.unitPriceSen ?? 0) * newQty;
  const lineTotalDelta = newLineTotal - line.lineTotalSen;
  const newSoSubtotal = so.subtotalSen + lineTotalDelta;
  const newSoTotal = so.totalSen + lineTotalDelta;

  const posRes = await db
    .prepare(
      `SELECT id, poNo, quantity, productCode FROM production_orders
         WHERE salesOrderId = ? AND productCode = ?
            AND status <> 'CANCELLED'
         ORDER BY id ASC`,
    )
    .bind(line.salesOrderId, line.productCode ?? "")
    .all<{
      id: string;
      poNo: string;
      quantity: number;
      productCode: string | null;
    }>();
  const candidatePos = posRes.results ?? [];
  const matchingPos = candidatePos.filter((p) => p.quantity === oldQty);
  if (matchingPos.length === 0) {
    return c.json(
      {
        success: false,
        error: `No PO found with salesOrderId=${line.salesOrderId} AND productCode=${line.productCode} AND quantity=${oldQty}.`,
      },
      404,
    );
  }
  if (matchingPos.length > 1) {
    return c.json(
      {
        success: false,
        error: `Multiple POs match (qty=${oldQty}): ${matchingPos.map((p) => p.id).join(", ")}. Ambiguous — refuse to auto-correct.`,
      },
      409,
    );
  }
  const targetPo = matchingPos[0];

  const jcsRes = await db
    .prepare(
      `SELECT id, departmentCode, wipKey, wipType, wipCode, wipLabel,
              wipQty, status
         FROM job_cards WHERE productionOrderId = ? ORDER BY id ASC`,
    )
    .bind(targetPo.id)
    .all<{
      id: string;
      departmentCode: string | null;
      wipKey: string | null;
      wipType: string | null;
      wipCode: string | null;
      wipLabel: string | null;
      wipQty: number;
      status: string | null;
    }>();
  const jcs = jcsRes.results ?? [];

  type JcDiff = {
    jcId: string;
    deptCode: string | null;
    wipType: string | null;
    oldWipQty: number;
    newWipQty: number;
    multiplier: number;
  };
  const jcDiffs: JcDiff[] = [];
  for (const jc of jcs) {
    if (jc.wipKey === "FG") continue;
    if (jc.wipQty == null) continue;
    if (jc.wipQty % oldQty !== 0) {
      return c.json(
        {
          success: false,
          error: `JC ${jc.id} wipQty=${jc.wipQty} is not divisible by oldQty=${oldQty}. BOM multiplier non-integer; refuse to auto-scale.`,
        },
        409,
      );
    }
    const multiplier = jc.wipQty / oldQty;
    const newWipQty = Math.max(1, multiplier * newQty);
    jcDiffs.push({
      jcId: jc.id,
      deptCode: jc.departmentCode,
      wipType: jc.wipType,
      oldWipQty: jc.wipQty,
      newWipQty,
      multiplier,
    });
  }

  // Surface untouched cascade tables as warnings. These tables use varying
  // column names (po_id, production_order_id, ref_id polymorphic) — wrap
  // each in try/catch so a column-name mismatch doesn't abort the whole
  // dry-run.
  const warnings: string[] = [];
  try {
    const fgRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM fg_units WHERE production_order_id = ?",
      )
      .bind(targetPo.id)
      .first<{ n: number }>();
    const n = Number(fgRow?.n ?? 0);
    if (n > 0) {
      warnings.push(
        `${n} fg_units exist for this PO — operator may need to DELETE over-counted units (expected ${newQty}).`,
      );
    }
  } catch {
    // alt column name; fall through
    try {
      const fgRow2 = await db
        .prepare("SELECT COUNT(*) AS n FROM fg_units WHERE po_id = ?")
        .bind(targetPo.id)
        .first<{ n: number }>();
      const n = Number(fgRow2?.n ?? 0);
      if (n > 0) {
        warnings.push(
          `${n} fg_units exist for this PO — operator may need to DELETE over-counted units (expected ${newQty}).`,
        );
      }
    } catch {
      // skip
    }
  }
  try {
    const doRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM delivery_order_items WHERE production_order_id = ?",
      )
      .bind(targetPo.id)
      .first<{ n: number }>();
    const n = Number(doRow?.n ?? 0);
    if (n > 0) {
      warnings.push(
        `${n} delivery_order_items reference this PO — DO line qty may need manual adjustment.`,
      );
    }
  } catch {
    // skip
  }
  try {
    const ledgerRow = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM cost_ledger WHERE ref_id = ? AND ref_type = 'PO'",
      )
      .bind(targetPo.id)
      .first<{ n: number }>();
    const n = Number(ledgerRow?.n ?? 0);
    if (n > 0) {
      warnings.push(
        `${n} cost_ledger rows reference this PO — labor + RM cost remain at oldQty=${oldQty} scale.`,
      );
    }
  } catch {
    // skip
  }
  // wip_items has no direct PO FK (only `code` field) — emit generic warning
  warnings.push(
    `wip_items has no direct PO link — RM consumption tracking via stock_qty was not adjusted. Operator must reverse-consume manually if inventory accuracy matters.`,
  );

  const result = {
    success: true,
    dryRun,
    line: {
      id: line.id,
      productCode: line.productCode,
      oldQty,
      newQty,
      oldLineTotalSen: line.lineTotalSen,
      newLineTotalSen: newLineTotal,
      lineTotalDeltaSen: lineTotalDelta,
    },
    so: {
      id: so.id,
      companySOId: so.companySOId,
      oldSubtotalSen: so.subtotalSen,
      newSubtotalSen: newSoSubtotal,
      oldTotalSen: so.totalSen,
      newTotalSen: newSoTotal,
    },
    po: {
      id: targetPo.id,
      poNo: targetPo.poNo,
      oldQty: targetPo.quantity,
      newQty,
    },
    jcCount: jcDiffs.length,
    jcDiffs,
    warnings,
  };

  if (dryRun) return c.json(result);

  // sales_order_items has no updated_at column (postgres schema 0001_init).
  // sales_orders + production_orders do — keep their timestamps fresh.
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE sales_order_items SET quantity = ?, lineTotalSen = ? WHERE id = ?",
      )
      .bind(newQty, newLineTotal, line.id),
    db
      .prepare(
        "UPDATE sales_orders SET subtotalSen = ?, totalSen = ?, updated_at = ? WHERE id = ?",
      )
      .bind(newSoSubtotal, newSoTotal, now, so.id),
    db
      .prepare(
        "UPDATE production_orders SET quantity = ?, updated_at = ? WHERE id = ?",
      )
      .bind(newQty, now, targetPo.id),
  ];
  for (const d of jcDiffs) {
    stmts.push(
      db
        .prepare("UPDATE job_cards SET wipQty = ? WHERE id = ?")
        .bind(d.newWipQty, d.jcId),
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    return c.json(
      {
        success: false,
        error: `Batch failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  return c.json({ ...result, executedStatements: stmts.length });
});

export default app;

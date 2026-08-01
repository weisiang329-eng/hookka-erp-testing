import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { recomputePoStatusAndProgress } from "../production-orders";
import { createProductionOrdersForSO, type SalesOrderRow, type SalesOrderItemRow } from "../sales-orders";
import { getOrgId } from "../../lib/tenant";
import { type SuppliersFromHistoryBody, type BindingsFromHistoryBody, type BackfillBody, type BackfillBindingsBody, type BackfillBindingsMultiBody, type BackfillPhantomGrnsBody, type BackfillExpectedUnit, type LinenoFixRow } from "./_shared";

const app = new Hono<Env>();


// ---------------------------------------------------------------------------
// POST /api/import/cancel-leaked-co-pos?dryRun=true|false
//
// Backfill for the CO-cancel cascade gap (Wei Siang, 2026-05-05): every
// production_order whose parent consignment_order is CANCELLED but whose
// own status is still active (anything other than COMPLETED / CANCELLED)
// gets flipped to CANCELLED. Non-terminal job_cards under those POs also
// flip to CANCELLED so the production page stops surfacing them.
//
// Idempotent — re-running it after the first pass returns 0/0.
// Migration-temp. Safe to delete once the leak is verified clean.
// ---------------------------------------------------------------------------
app.post("/cancel-leaked-co-pos", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;

  const db = c.var.DB;
  const dryRun = c.req.query("dryRun") === "true";
  const now = new Date().toISOString();

  // POs whose parent CO is CANCELLED but they themselves aren't.
  const leakRes = await db
    .prepare(
      `SELECT po.id AS poId, po.poNo, po.status AS "poStatus",
              co.id AS "coId", co.companyCOId, co.status AS "coStatus"
         FROM production_orders po
         JOIN consignment_orders co ON co.id = po.consignmentOrderId
        WHERE co.status = 'CANCELLED'
          AND po.status NOT IN ('COMPLETED', 'CANCELLED')`,
    )
    .all<{
      poId: string;
      poNo: string;
      poStatus: string;
      coId: string;
      companyCOId: string;
      coStatus: string;
    }>();
  const leaks = leakRes.results ?? [];

  // Non-terminal job_cards under those POs.
  let jcLeakCount = 0;
  let jcSample: Array<{ id: string; departmentCode: string | null }> = [];
  if (leaks.length > 0) {
    const poIds = leaks.map((l) => l.poId);
    const placeholders = poIds.map(() => "?").join(", ");
    const jcRes = await db
      .prepare(
        `SELECT id, departmentCode FROM job_cards
           WHERE productionOrderId IN (${placeholders})
             AND status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`,
      )
      .bind(...poIds)
      .all<{ id: string; departmentCode: string | null }>();
    jcLeakCount = (jcRes.results ?? []).length;
    jcSample = (jcRes.results ?? []).slice(0, 5);

    if (!dryRun) {
      const stmts: ReturnType<D1Database["prepare"]>[] = [];
      for (const l of leaks) {
        stmts.push(
          db
            .prepare(
              "UPDATE production_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
            )
            .bind(now, l.poId),
        );
      }
      for (const jc of jcRes.results ?? []) {
        stmts.push(
          db
            .prepare(
              "UPDATE job_cards SET status = 'CANCELLED' WHERE id = ?",
            )
            .bind(jc.id),
        );
      }
      // Batch in chunks of 50 to stay well under D1's per-batch budget.
      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50));
      }
    }
  }

  return c.json({
    success: true,
    dryRun,
    leakedPoCount: leaks.length,
    leakedJobCardCount: jcLeakCount,
    leaks: leaks.map((l) => ({
      poNo: l.poNo,
      poStatus: l.poStatus,
      companyCOId: l.companyCOId,
    })),
    sampleJobCards: jcSample,
  });
});

app.post("/suppliers-from-history", async (c) => {
  const denied = await requirePermission(c, "suppliers", "create");
  if (denied) return denied;

  let body: SuppliersFromHistoryBody;
  try {
    body = (await c.req.json()) as SuppliersFromHistoryBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const list = Array.isArray(body.suppliers) ? body.suppliers : null;
  if (!list) {
    return c.json(
      { success: false, error: "body.suppliers must be an array" },
      400,
    );
  }

  const db = c.var.DB;
  let inserted = 0;
  let skipped = 0;
  const errors: { code: string; message: string }[] = [];

  for (const s of list) {
    const code = String(s?.code ?? "").trim();
    const name = String(s?.name ?? "").trim();
    if (!code || !name) {
      errors.push({ code, message: "code and name are required" });
      continue;
    }
    try {
      const existing = await db
        .prepare("SELECT id FROM suppliers WHERE code = ? LIMIT 1")
        .bind(code)
        .first<{ id: string }>();
      if (existing) {
        skipped++;
        continue;
      }
      const id = `sup-${crypto.randomUUID().slice(0, 8)}`;
      await db
        .prepare(
          `INSERT INTO suppliers (id, code, name, contactPerson, phone, email,
             address, state, paymentTerms, status, rating,
             currency, statementType, agingOn, creditTerm,
             isActive, isGroupCompany, outstandingSen)
           VALUES (?, ?, ?, '', '', '', '', '', 'NET30', 'ACTIVE', 3,
                   'MYR', 'OPEN_ITEM', 'INVOICE_DATE', 'C.O.D.',
                   1, 0, 0)`,
        )
        .bind(id, code, name)
        .run();
      inserted++;
    } catch (err) {
      errors.push({
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    total: list.length,
    inserted,
    skipped,
    errors,
  });
});

app.post("/supplier-bindings-from-history", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "create");
  if (denied) return denied;

  let body: BindingsFromHistoryBody;
  try {
    body = (await c.req.json()) as BindingsFromHistoryBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const list = Array.isArray(body.bindings) ? body.bindings : null;
  if (!list) {
    return c.json(
      { success: false, error: "body.bindings must be an array" },
      400,
    );
  }

  const db = c.var.DB;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { ref: string; message: string }[] = [];

  // Cache supplier code → id within one request to avoid repeated lookups.
  const supplierCache = new Map<string, string | null>();
  // Cache material existence — silently skip bindings whose materialCode
  // doesn't exist in raw_materials yet (Phase A should have created them).
  const materialCache = new Map<string, boolean>();

  async function resolveSupplier(code: string): Promise<string | null> {
    if (supplierCache.has(code)) return supplierCache.get(code) ?? null;
    const row = await db
      .prepare("SELECT id FROM suppliers WHERE code = ? LIMIT 1")
      .bind(code)
      .first<{ id: string }>();
    const id = row?.id ?? null;
    supplierCache.set(code, id);
    return id;
  }
  async function materialExists(code: string): Promise<boolean> {
    if (materialCache.has(code)) return materialCache.get(code) === true;
    const row = await db
      .prepare("SELECT 1 AS x FROM raw_materials WHERE itemCode = ? LIMIT 1")
      .bind(code)
      .first<{ x: number }>();
    const exists = !!row;
    materialCache.set(code, exists);
    return exists;
  }

  for (const b of list) {
    const materialCode = String(b?.materialCode ?? "").trim();
    const supplierCode = String(b?.supplierCode ?? "").trim();
    const supplierSKU = String(b?.supplierSKU ?? "").trim();
    const unitPrice = Math.round(Number(b?.unitPriceSen) || 0);
    const isMain =
      b?.isMainSupplier === true ||
      Number(b?.isMainSupplier) === 1
        ? 1
        : 0;
    const ref = `${supplierCode}::${materialCode}`;

    if (!materialCode || !supplierCode || !supplierSKU) {
      errors.push({
        ref,
        message: "materialCode, supplierCode, supplierSKU required",
      });
      continue;
    }
    try {
      const supplierId = await resolveSupplier(supplierCode);
      if (!supplierId) {
        errors.push({ ref, message: `unknown supplier code ${supplierCode}` });
        continue;
      }
      if (!(await materialExists(materialCode))) {
        skipped++;
        continue;
      }

      // We need materialName to satisfy the NOT NULL constraint on the
      // supplier_material_bindings table. Pull it from the raw_materials row.
      const rmRow = await db
        .prepare(
          "SELECT description FROM raw_materials WHERE itemCode = ? LIMIT 1",
        )
        .bind(materialCode)
        .first<{ description: string }>();
      const materialName = rmRow?.description ?? materialCode;

      const existing = await db
        .prepare(
          `SELECT id FROM supplier_material_bindings
            WHERE materialCode = ? AND supplierId = ? LIMIT 1`,
        )
        .bind(materialCode, supplierId)
        .first<{ id: string }>();

      if (existing) {
        await db
          .prepare(
            `UPDATE supplier_material_bindings
                SET supplierSku = ?, unitPrice = ?, isMainSupplier = ?,
                    materialName = ?
              WHERE id = ?`,
          )
          .bind(supplierSKU, unitPrice, isMain, materialName, existing.id)
          .run();
        updated++;
      } else {
        const id = `smb-${crypto.randomUUID().slice(0, 8)}`;
        await db
          .prepare(
            `INSERT INTO supplier_material_bindings (id, supplierId, materialCode,
               materialName, supplierSku, unitPrice, currency, leadTimeDays,
               paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
             VALUES (?, ?, ?, ?, ?, ?, 'MYR', 0, 'NET30', 1, ?, '2030-12-31', ?)`,
          )
          .bind(
            id,
            supplierId,
            materialCode,
            materialName,
            supplierSKU,
            unitPrice,
            new Date().toISOString().slice(0, 10),
            isMain,
          )
          .run();
        inserted++;
      }
    } catch (err) {
      errors.push({
        ref,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    total: list.length,
    inserted,
    updated,
    skipped,
    errors,
  });
});

app.post("/historical-purchases-backfill", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: BackfillBody;
  try {
    body = (await c.req.json()) as BackfillBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const docs = Array.isArray(body.documents) ? body.documents : [];
  const skipStock = body.skipStock === true;
  const purchaseOrdersOnly = Array.isArray(body.purchaseOrders)
    ? body.purchaseOrders
    : [];

  if (docs.length === 0 && purchaseOrdersOnly.length === 0) {
    return c.json(
      {
        success: false,
        error:
          "body.documents or body.purchaseOrders (or both) must be a non-empty array",
      },
      400,
    );
  }

  const db = c.var.DB;
  let posCreated = 0;
  let grnsCreated = 0;
  let pisCreated = 0;
  let posOnlyCreated = 0;
  let lineItemsTotal = 0;
  let documentsProcessed = 0;
  let skipped = 0;
  const errors: { docNo: string; message: string }[] = [];

  // Per-batch caches (one request worth of docs).
  const supplierCache = new Map<
    string,
    { id: string; name: string } | null
  >();
  const rmCache = new Map<string, { id: string; description: string } | null>();

  async function resolveSupplier(code: string) {
    if (supplierCache.has(code)) return supplierCache.get(code) ?? null;
    const row = await db
      .prepare("SELECT id, name FROM suppliers WHERE code = ? LIMIT 1")
      .bind(code)
      .first<{ id: string; name: string }>();
    supplierCache.set(code, row ?? null);
    return row ?? null;
  }
  async function resolveRm(code: string) {
    if (rmCache.has(code)) return rmCache.get(code) ?? null;
    const row = await db
      .prepare(
        "SELECT id, description FROM raw_materials WHERE itemCode = ? LIMIT 1",
      )
      .bind(code)
      .first<{ id: string; description: string }>();
    rmCache.set(code, row ?? null);
    return row ?? null;
  }

  for (const doc of docs) {
    const docNo = String(doc?.docNo ?? "").trim();
    const docDate = String(doc?.docDate ?? "").trim();
    const supplierCode = String(doc?.supplierCode ?? "").trim();
    const itemsIn = Array.isArray(doc?.items) ? doc.items : [];

    if (!docNo || !docDate || !supplierCode || itemsIn.length === 0) {
      errors.push({
        docNo: docNo || "(missing)",
        message: "docNo, docDate, supplierCode, items required",
      });
      continue;
    }

    try {
      // Idempotency: skip if a PI with this piNo already exists.
      const existingPi = await db
        .prepare("SELECT id FROM purchase_invoices WHERE piNo = ? LIMIT 1")
        .bind(docNo)
        .first<{ id: string }>();
      if (existingPi) {
        skipped++;
        continue;
      }

      const supplier = await resolveSupplier(supplierCode);
      if (!supplier) {
        errors.push({
          docNo,
          message: `unknown supplier code ${supplierCode}`,
        });
        continue;
      }

      // Resolve items. Stocked items (materialCode set + RM exists) feed the
      // PO/GRN; non-stocked items (null materialCode, or unresolved code) are
      // PI-only (added to PI amountSen total).
      type Resolved = {
        materialCode: string | null;
        materialName: string;
        supplierSKU: string;
        qty: number;
        unitPriceSen: number;
        rmId: string | null;
      };
      const resolved: Resolved[] = [];
      for (const it of itemsIn) {
        const qty = Number(it?.qty) || 0;
        const unitPriceSen = Math.round(Number(it?.unitPriceSen) || 0);
        const desc = String(it?.description ?? "").trim();
        const matCode = it?.materialCode
          ? String(it.materialCode).trim()
          : null;
        const supSku = String(it?.supplierSKU ?? matCode ?? "").trim();
        let rmRow: { id: string; description: string } | null = null;
        if (matCode) {
          rmRow = await resolveRm(matCode);
        }
        resolved.push({
          materialCode: rmRow ? matCode : null,
          materialName: rmRow?.description ?? desc ?? matCode ?? "",
          supplierSKU: supSku,
          qty,
          unitPriceSen,
          rmId: rmRow?.id ?? null,
        });
      }
      const stockedItems = resolved.filter((r) => r.rmId !== null);

      // Compute totals. Math.round defends against float drift when qty is
      // a fraction (e.g. fabric: 261.6 * 890 = 232824.00000000003 in JS).
      // amountSen / totalSen / subtotalSen are INTEGER NOT NULL.
      const stockedSubtotal = Math.round(
        stockedItems.reduce((s, r) => s + r.qty * r.unitPriceSen, 0),
      );
      const piAmountSen = Math.round(
        resolved.reduce((s, r) => s + r.qty * r.unitPriceSen, 0),
      );

      // ----- PO -----
      const poId = `po-${crypto.randomUUID().slice(0, 8)}`;
      const poNo = `PO-IMPORT-${docNo}`;
      const nowIso = new Date().toISOString();
      const grnId = `grn-${crypto.randomUUID().slice(0, 8)}`;
      const grnNumber = `GRN-IMPORT-${docNo}`;
      const piId = `pi-${crypto.randomUUID().slice(0, 8)}`;

      // Build the per-document statement bundle. We push into one D1 batch
      // so the whole document is atomic — D1 batch is transactional.
      const statements: D1PreparedStatement[] = [];

      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_orders (id, poNo, supplierId, supplierName,
               subtotalSen, totalSen, status, orderDate, expectedDate,
               receivedDate, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'CLOSED', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            poId,
            poNo,
            supplier.id,
            supplier.name,
            stockedSubtotal,
            stockedSubtotal,
            docDate,
            docDate,
            docDate,
            `Imported from historical PI ${docNo}`,
            nowIso,
            nowIso,
          ),
      );

      // PO items + GRN items in matching order. poItemIndex links GRN line N
      // to PO line N — same convention as POST /api/grn.
      for (let i = 0; i < stockedItems.length; i++) {
        const it = stockedItems[i];
        const poItemId = `poi-${crypto.randomUUID().slice(0, 8)}`;
        const lineTotal = Math.round(it.qty * it.unitPriceSen);
        statements.push(
          db
            .prepare(
              `INSERT INTO purchase_order_items (id, purchaseOrderId,
                 materialCategory, materialName, supplierSKU, quantity,
                 unitPriceSen, totalSen, receivedQty, unit)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 'pcs')`,
            )
            .bind(
              poItemId,
              poId,
              it.materialName,
              it.supplierSKU,
              it.qty,
              it.unitPriceSen,
              lineTotal,
              it.qty, // mark as fully received since GRN is POSTED
            ),
        );
      }

      // ----- GRN -----
      statements.push(
        db
          .prepare(
            `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
               supplierName, receiveDate, receivedBy, totalAmount, qcStatus,
               status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 'PASSED', 'POSTED', ?)`,
          )
          .bind(
            grnId,
            grnNumber,
            poId,
            poNo,
            supplier.id,
            supplier.name,
            docDate,
            stockedSubtotal,
            `Imported from historical PI ${docNo}`,
          ),
      );

      // GRN items + the rm_batches / cost_ledger / balanceQty cascade.
      // The grn.ts postGRNToStock() helper would normally do this on the
      // DRAFT → POSTED transition, but we're inserting straight as POSTED,
      // so we replicate the side-effects inline.
      const receivedIso = `${docDate}T00:00:00.000Z`;
      for (let i = 0; i < stockedItems.length; i++) {
        const it = stockedItems[i];
        statements.push(
          db
            .prepare(
              `INSERT INTO grn_items (grnId, poItemIndex, materialCode,
                 materialName, orderedQty, receivedQty, acceptedQty,
                 rejectedQty, rejectionReason, unitPrice)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
            )
            .bind(
              grnId,
              i,
              it.supplierSKU,
              it.materialName,
              it.qty,
              it.qty,
              it.qty,
              it.unitPriceSen,
            ),
        );

        if (!skipStock && it.rmId && it.qty > 0) {
          const batchId = `rmb-grn-${grnId}-${i + 1}`;
          const ledgerId = `cl-${crypto.randomUUID().slice(0, 8)}`;
          const totalCostSen = Math.round(it.qty * it.unitPriceSen);
          statements.push(
            db
              .prepare(
                `INSERT INTO rm_batches (id, rmId, source, sourceRefId,
                   receivedDate, originalQty, remainingQty, unitCostSen,
                   created_at, notes)
                 VALUES (?, ?, 'GRN', ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                batchId,
                it.rmId,
                grnId,
                receivedIso,
                it.qty,
                it.qty,
                it.unitPriceSen,
                nowIso,
                `GRN ${grnNumber} line ${i + 1}`,
              ),
            db
              .prepare(
                `INSERT INTO cost_ledger (id, date, type, itemType, itemId,
                   batchId, qty, direction, unitCostSen, totalCostSen,
                   refType, refId, notes)
                 VALUES (?, ?, 'RM_RECEIPT', 'RM', ?, ?, ?, 'IN', ?, ?,
                         'GRN', ?, ?)`,
              )
              .bind(
                ledgerId,
                receivedIso,
                it.rmId,
                batchId,
                it.qty,
                it.unitPriceSen,
                totalCostSen,
                grnId,
                `Received via ${grnNumber}`,
              ),
            db
              .prepare(
                "UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?",
              )
              .bind(it.qty, it.rmId),
          );
        }
      }

      // ----- PI -----
      statements.push(
        db
          .prepare(
            `INSERT INTO purchase_invoices (id, piNo, purchaseOrderId, poRef,
               supplierId, supplierName, invoiceDate, dueDate, amountSen,
               status, remarks, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'APPROVED', ?, ?, ?)`,
          )
          .bind(
            piId,
            docNo,
            poId,
            poNo,
            supplier.id,
            supplier.name,
            docDate,
            piAmountSen,
            `Imported from historical PI ${docNo}; GRN ${grnNumber}`,
            nowIso,
            nowIso,
          ),
      );

      // ----- PI line items -----
      // Migration 0107 added purchase_invoice_items so we now persist the
      // per-line breakdown that was previously dropped on import. Stocked
      // items keep their materialCode link; non-stocked lines (fees, tax,
      // rebate, discount) are tagged with a heuristic line_type derived
      // from the description so the detail screen can render them as
      // labelled non-stock rows instead of stocked items.
      for (let i = 0; i < resolved.length; i++) {
        const it = resolved[i];
        const piItemId = `pii-${piId}-${i + 1}`;
        const lineTotal = Math.round(it.qty * it.unitPriceSen);
        let lineType: "STOCKED" | "FEE" | "TAX" | "REBATE" | "DISCOUNT" | "OTHER";
        if (it.rmId !== null) {
          lineType = "STOCKED";
        } else {
          const desc = it.materialName || "";
          if (/SST/i.test(desc)) lineType = "TAX";
          else if (/TRANSPORT|FEE|CHARGES/i.test(desc)) lineType = "FEE";
          else if (/REBATE/i.test(desc)) lineType = "REBATE";
          else if (/DISCOUNT/i.test(desc)) lineType = "DISCOUNT";
          else lineType = "OTHER";
        }
        statements.push(
          db
            .prepare(
              `INSERT INTO purchase_invoice_items (id, pi_id, material_code,
                 material_name, supplier_sku, qty, unit_price_sen,
                 line_total_sen, line_type, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
            )
            .bind(
              piItemId,
              piId,
              it.materialCode,
              it.materialName,
              it.supplierSKU,
              it.qty,
              it.unitPriceSen,
              lineTotal,
              lineType,
              nowIso,
            ),
        );
      }

      await db.batch(statements);

      posCreated++;
      grnsCreated++;
      pisCreated++;
      lineItemsTotal += resolved.length;
      documentsProcessed++;
    } catch (err) {
      errors.push({
        docNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----- Standalone PO seeding (original numbers, no GRN/PI/stock) -----
  for (const po of purchaseOrdersOnly) {
    const poNo = String(po?.poNo ?? "").trim();
    const docDate = String(po?.docDate ?? "").trim();
    const supplierCode = String(po?.supplierCode ?? "").trim();
    const itemsIn = Array.isArray(po?.items) ? po.items : [];

    if (!poNo || !docDate || !supplierCode || itemsIn.length === 0) {
      errors.push({
        docNo: poNo || "(missing)",
        message: "poNo, docDate, supplierCode, items required for purchaseOrders entry",
      });
      continue;
    }

    try {
      // Idempotency: skip if a purchase_orders row with this poNo already exists.
      const existingPo = await db
        .prepare("SELECT id FROM purchase_orders WHERE poNo = ? LIMIT 1")
        .bind(poNo)
        .first<{ id: string }>();
      if (existingPo) {
        skipped++;
        continue;
      }

      const supplier = await resolveSupplier(supplierCode);
      if (!supplier) {
        errors.push({
          docNo: poNo,
          message: `unknown supplier code ${supplierCode}`,
        });
        continue;
      }

      // Resolve items — look up RM for description; fall back to item description.
      const resolvedPoItems: Array<{
        materialName: string;
        supplierSKU: string;
        qty: number;
        unitPriceSen: number;
        lineTotal: number;
      }> = [];
      for (const it of itemsIn) {
        const qty = Number(it?.qty) || 0;
        const unitPriceSen = Math.round(Number(it?.unitPriceSen) || 0);
        const desc = String(it?.description ?? "").trim();
        const matCode = it?.materialCode ? String(it.materialCode).trim() : null;
        const supSku = String(it?.supplierSKU ?? matCode ?? "").trim();
        let materialName = desc;
        if (matCode) {
          const rmRow = await resolveRm(matCode);
          if (rmRow) materialName = rmRow.description;
        }
        resolvedPoItems.push({
          materialName: materialName || matCode || "",
          supplierSKU: supSku,
          qty,
          unitPriceSen,
          lineTotal: Math.round(qty * unitPriceSen),
        });
      }

      const subtotalSen = Math.round(
        resolvedPoItems.reduce((s, r) => s + r.qty * r.unitPriceSen, 0),
      );
      const nowIso = new Date().toISOString();
      const poId = `po-${crypto.randomUUID().slice(0, 8)}`;

      const poStatements: D1PreparedStatement[] = [];

      poStatements.push(
        db
          .prepare(
            `INSERT INTO purchase_orders (id, poNo, supplierId, supplierName,
               subtotalSen, totalSen, status, orderDate, expectedDate,
               receivedDate, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, NULL, ?, ?, ?)`,
          )
          .bind(
            poId,
            poNo,
            supplier.id,
            supplier.name,
            subtotalSen,
            subtotalSen,
            docDate,
            docDate,
            `Imported historical PO ${poNo}`,
            nowIso,
            nowIso,
          ),
      );

      for (let i = 0; i < resolvedPoItems.length; i++) {
        const it = resolvedPoItems[i];
        const poItemId = `poi-${crypto.randomUUID().slice(0, 8)}`;
        poStatements.push(
          db
            .prepare(
              `INSERT INTO purchase_order_items (id, purchaseOrderId,
                 materialCategory, materialName, supplierSKU, quantity,
                 unitPriceSen, totalSen, receivedQty, unit)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, 0, 'pcs')`,
            )
            .bind(
              poItemId,
              poId,
              it.materialName,
              it.supplierSKU,
              it.qty,
              it.unitPriceSen,
              it.lineTotal,
            ),
        );
      }

      await db.batch(poStatements);

      posOnlyCreated++;
      lineItemsTotal += resolvedPoItems.length;
    } catch (err) {
      errors.push({
        docNo: poNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    total: docs.length + purchaseOrdersOnly.length,
    documentsProcessed,
    posCreated,
    grnsCreated,
    pisCreated,
    posOnlyCreated,
    lineItemsTotal,
    skipped,
    errors,
  });
});

app.post("/backfill-supplier-material-bindings", async (c) => {
  // Same gate as POST /api/purchase-orders — anyone who can create a PO can
  // seed bindings (this is operator-driven cleanup, not admin-only).
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: BackfillBindingsBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as BackfillBindingsBody;
  } catch {
    body = {};
  }
  const dryRun = body.dryRun === true;

  const db = c.var.DB;

  // Find every RM that has no binding yet. NOT EXISTS keeps it idempotent —
  // RMs already covered (manually or by a previous run) are skipped.
  // Postgres alias quoting (AS "fooBar") preserves case on D1 as well.
  const candidatesRes = await db
    .prepare(
      `SELECT rm.itemCode    AS "itemCode",
              rm.description AS "description",
              rm.itemGroup   AS "itemGroup"
         FROM raw_materials rm
        WHERE NOT EXISTS (
                SELECT 1 FROM supplier_material_bindings smb
                 WHERE smb.materialCode = rm.itemCode
              )`,
    )
    .all<{ itemCode: string; description: string; itemGroup: string }>();
  const candidates = candidatesRes.results ?? [];

  let seeded = 0;
  let skippedNoHistory = 0;
  const seededSamples: {
    itemCode: string;
    supplierId: string;
    unitPriceSen: number;
  }[] = [];
  const skippedSamples: { itemCode: string; description: string }[] = [];
  const errors: { itemCode: string; message: string }[] = [];

  for (const rm of candidates) {
    try {
      // Look up the most-recent PO line item that mentions this RM's
      // itemCode anywhere in materialName. Procurement modal stores
      // materialName as "<rmCode> - <description>", so the LIKE catches
      // both that path and historical Excel-import variants.
      const hit = await db
        .prepare(
          `SELECT po.supplierId    AS "supplierId",
                  poi.unitPriceSen AS "unitPriceSen",
                  poi.supplierSKU  AS "supplierSKU"
             FROM purchase_order_items poi
             JOIN purchase_orders po ON po.id = poi.purchaseOrderId
            WHERE poi.materialName LIKE ?
            ORDER BY po.created_at DESC, po.id DESC
            LIMIT 1`,
        )
        .bind(`%${rm.itemCode}%`)
        .first<{ supplierId: string; unitPriceSen: number; supplierSKU: string | null }>();

      if (!hit || !hit.supplierId) {
        skippedNoHistory++;
        if (skippedSamples.length < 10) {
          skippedSamples.push({
            itemCode: rm.itemCode,
            description: rm.description,
          });
        }
        continue;
      }

      if (!dryRun) {
        const id = `smb-${crypto.randomUUID().slice(0, 8)}`;
        await db
          .prepare(
            `INSERT INTO supplier_material_bindings (id, supplierId, materialCode,
               materialName, supplierSku, unitPrice, currency, leadTimeDays,
               paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
             VALUES (?, ?, ?, ?, ?, ?, 'MYR', 0, 'NET30', 1, ?, '2030-12-31', 1)`,
          )
          .bind(
            id,
            hit.supplierId,
            rm.itemCode,
            rm.description,
            // supplierSku falls back to the rm itemCode when historical PO
            // line had nothing useful; this is conservative — operator can
            // refine per real supplier catalog later.
            hit.supplierSKU || rm.itemCode,
            hit.unitPriceSen || 0,
            new Date().toISOString().slice(0, 10),
          )
          .run();
      }

      seeded++;
      if (seededSamples.length < 10) {
        seededSamples.push({
          itemCode: rm.itemCode,
          supplierId: hit.supplierId,
          unitPriceSen: hit.unitPriceSen || 0,
        });
      }
    } catch (err) {
      errors.push({
        itemCode: rm.itemCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned: candidates.length,
    seeded,
    skippedNoHistory,
    errorCount: errors.length,
    seededSamples,
    skippedSamples,
    errors,
  });
});

app.post("/backfill-supplier-bindings-multi", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  const orgId = getOrgId(c);

  let body: BackfillBindingsMultiBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as BackfillBindingsMultiBody;
  } catch {
    body = {};
  }
  const dryRun = body.dryRun === true;
  const ensureMainOnExisting = body.ensureMainOnExisting === true;
  const useDescriptionFallback = body.disableDescriptionFallback !== true;

  const db = c.var.DB;

  // Every active RM in this org. Inactive RMs are skipped — operator deactivated
  // them deliberately, and binding them would just clutter the picker.
  const rmsRes = await db
    .prepare(
      `SELECT itemCode    AS "itemCode",
              description AS "description"
         FROM raw_materials
        WHERE orgId = ? AND isActive = 1`,
    )
    .bind(orgId)
    .all<{ itemCode: string; description: string }>();
  const rms = rmsRes.results ?? [];

  let bindingsInserted = 0;
  let mainAssignedNew = 0;
  let mainPromotedExisting = 0;
  let rmsWithoutHistory = 0;
  let rmsFullyCovered = 0;
  const seededSamples: {
    itemCode: string;
    supplierId: string;
    totalQty: number;
    isMain: boolean;
    matchSource: "code" | "description";
  }[] = [];
  const promotedSamples: { itemCode: string; supplierId: string }[] = [];
  const skippedSamples: { itemCode: string; description: string }[] = [];
  const errors: { itemCode: string; message: string }[] = [];

  let rmsMatchedByCode = 0;
  let rmsMatchedByDescription = 0;
  for (const rm of rms) {
    try {
      // Pass 1 — code match: poi.materialName equals or starts with the
      // RM's itemCode followed by space/dash. Strict prefix matching avoids
      // the AM275 ⊃ AM275-2 over-match.
      const codeExact = rm.itemCode;
      const codeDash = `${rm.itemCode} - %`;
      const codeSpace = `${rm.itemCode} %`;
      const codeAggsRes = await db
        .prepare(
          `SELECT po.supplierId        AS "supplierId",
                  SUM(poi.quantity)    AS "totalQty",
                  COUNT(*)             AS "poCount",
                  MAX(po.created_at)   AS "latestPoDate"
             FROM purchase_order_items poi
             JOIN purchase_orders po ON po.id = poi.purchaseOrderId
            WHERE po.orgId = ?
              AND (poi.materialName = ? OR poi.materialName LIKE ? OR poi.materialName LIKE ?)
            GROUP BY po.supplierId
            ORDER BY SUM(poi.quantity) DESC, MAX(po.created_at) DESC`,
        )
        .bind(orgId, codeExact, codeDash, codeSpace)
        .all<{
          supplierId: string;
          totalQty: number;
          poCount: number;
          latestPoDate: string;
        }>();
      let aggs = (codeAggsRes.results ?? []).filter((a) => a.supplierId);
      let matchSource: "code" | "description" = "code";

      // Pass 2 — description fallback: AutoCount-imported PIs stored only
      // generic descriptions ("FABRIC", "BEIGE") in materialName with no RM
      // code, so the code pass misses them. Match by rm.description (exact
      // or as a prefix segment in poi.materialName) so the operator's
      // historical fabric/filler buys propagate to the model-numbered RMs.
      // Skip empties and absurdly short descriptions (< 2 chars) to avoid
      // ridiculous wide matches.
      if (
        useDescriptionFallback &&
        aggs.length === 0 &&
        rm.description &&
        rm.description.trim().length >= 2
      ) {
        const descExact = rm.description.trim();
        const descSpace = `${descExact} %`;
        const descSpaceMid = `% ${descExact} %`;
        const descSpaceEnd = `% ${descExact}`;
        const descAggsRes = await db
          .prepare(
            `SELECT po.supplierId        AS "supplierId",
                    SUM(poi.quantity)    AS "totalQty",
                    COUNT(*)             AS "poCount",
                    MAX(po.created_at)   AS "latestPoDate"
               FROM purchase_order_items poi
               JOIN purchase_orders po ON po.id = poi.purchaseOrderId
              WHERE po.orgId = ?
                AND (poi.materialName = ?
                     OR poi.materialName LIKE ?
                     OR poi.materialName LIKE ?
                     OR poi.materialName LIKE ?)
              GROUP BY po.supplierId
              ORDER BY SUM(poi.quantity) DESC, MAX(po.created_at) DESC`,
          )
          .bind(orgId, descExact, descSpace, descSpaceMid, descSpaceEnd)
          .all<{
            supplierId: string;
            totalQty: number;
            poCount: number;
            latestPoDate: string;
          }>();
        aggs = (descAggsRes.results ?? []).filter((a) => a.supplierId);
        if (aggs.length > 0) matchSource = "description";
      }

      if (aggs.length === 0) {
        rmsWithoutHistory++;
        if (skippedSamples.length < 20) {
          skippedSamples.push({
            itemCode: rm.itemCode,
            description: rm.description,
          });
        }
        continue;
      }
      if (matchSource === "code") rmsMatchedByCode++;
      else rmsMatchedByDescription++;

      // Existing bindings for this RM — operator-set rows must not be touched.
      const existingRes = await db
        .prepare(
          `SELECT supplierId        AS "supplierId",
                  isMainSupplier    AS "isMainSupplier",
                  id                AS "id"
             FROM supplier_material_bindings
            WHERE orgId = ? AND materialCode = ?`,
        )
        .bind(orgId, rm.itemCode)
        .all<{ supplierId: string; isMainSupplier: number; id: string }>();
      const existing = existingRes.results ?? [];
      const existingSupplierIds = new Set(existing.map((r) => r.supplierId));
      let hasMain = existing.some((r) => r.isMainSupplier === 1);

      // Highest-qty supplier from history is the main candidate. If multiple
      // suppliers are tied on qty, ORDER BY tiebreak (latestPoDate) decides.
      const mainCandidate = aggs[0].supplierId;

      let insertedForThisRm = 0;
      for (const agg of aggs) {
        if (existingSupplierIds.has(agg.supplierId)) continue;

        // Pull the latest unitPrice + supplierSKU + unit for this (rm, supplier)
        // pair. Mirror whichever match strategy actually produced the
        // aggregate (code vs description) so the latest-row lookup hits
        // the same set of POs the aggregate considered.
        const latest = await (matchSource === "code"
          ? db
              .prepare(
                `SELECT poi.unitPriceSen AS "unitPriceSen",
                        poi.supplierSKU  AS "supplierSKU",
                        poi.unit         AS "unit"
                   FROM purchase_order_items poi
                   JOIN purchase_orders po ON po.id = poi.purchaseOrderId
                  WHERE po.orgId = ?
                    AND po.supplierId = ?
                    AND (poi.materialName = ? OR poi.materialName LIKE ? OR poi.materialName LIKE ?)
                  ORDER BY po.created_at DESC, po.id DESC
                  LIMIT 1`,
              )
              .bind(orgId, agg.supplierId, codeExact, codeDash, codeSpace)
          : db
              .prepare(
                `SELECT poi.unitPriceSen AS "unitPriceSen",
                        poi.supplierSKU  AS "supplierSKU",
                        poi.unit         AS "unit"
                   FROM purchase_order_items poi
                   JOIN purchase_orders po ON po.id = poi.purchaseOrderId
                  WHERE po.orgId = ?
                    AND po.supplierId = ?
                    AND (poi.materialName = ?
                         OR poi.materialName LIKE ?
                         OR poi.materialName LIKE ?
                         OR poi.materialName LIKE ?)
                  ORDER BY po.created_at DESC, po.id DESC
                  LIMIT 1`,
              )
              .bind(
                orgId,
                agg.supplierId,
                rm.description.trim(),
                `${rm.description.trim()} %`,
                `% ${rm.description.trim()} %`,
                `% ${rm.description.trim()}`,
              )
        ).first<{
          unitPriceSen: number;
          supplierSKU: string | null;
          unit: string | null;
        }>();

        const isMain = agg.supplierId === mainCandidate && !hasMain ? 1 : 0;

        if (!dryRun) {
          const id = `smb-${crypto.randomUUID().slice(0, 8)}`;
          await db
            .prepare(
              `INSERT INTO supplier_material_bindings (id, orgId, supplierId, materialCode,
                 materialName, supplierSku, unitPrice, currency, leadTimeDays,
                 paymentTerms, moq, priceValidFrom, priceValidTo, isMainSupplier)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'MYR', 0, 'NET30', 1, ?, '2030-12-31', ?)`,
            )
            .bind(
              id,
              orgId,
              agg.supplierId,
              rm.itemCode,
              rm.description,
              latest?.supplierSKU || rm.itemCode,
              latest?.unitPriceSen || 0,
              new Date().toISOString().slice(0, 10),
              isMain,
            )
            .run();
        }

        bindingsInserted++;
        insertedForThisRm++;
        if (isMain) {
          mainAssignedNew++;
          hasMain = true;
        }
        if (seededSamples.length < 30) {
          seededSamples.push({
            itemCode: rm.itemCode,
            supplierId: agg.supplierId,
            totalQty: Number(agg.totalQty) || 0,
            isMain: isMain === 1,
            matchSource,
          });
        }
      }

      if (insertedForThisRm === 0) {
        rmsFullyCovered++;
      }

      // Promote a main supplier on existing bindings when nothing was inserted
      // (or when the inserts didn't create a main because all candidates were
      // already bound). Only fires when ensureMainOnExisting flag is set —
      // operator opt-in, since this changes existing rows.
      if (ensureMainOnExisting && !hasMain && existing.length > 0) {
        // Pick the highest-qty supplier from history that ALSO has an existing
        // binding row. If history's mainCandidate is already bound, promote it.
        const promoteCandidate = aggs.find((a) =>
          existingSupplierIds.has(a.supplierId),
        );
        if (promoteCandidate) {
          const row = existing.find(
            (r) => r.supplierId === promoteCandidate.supplierId,
          );
          if (row && !dryRun) {
            await db
              .prepare(
                `UPDATE supplier_material_bindings SET isMainSupplier = 1 WHERE id = ?`,
              )
              .bind(row.id)
              .run();
          }
          if (row) {
            mainPromotedExisting++;
            if (promotedSamples.length < 20) {
              promotedSamples.push({
                itemCode: rm.itemCode,
                supplierId: promoteCandidate.supplierId,
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        itemCode: rm.itemCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    ensureMainOnExisting,
    descriptionFallbackEnabled: useDescriptionFallback,
    rmsScanned: rms.length,
    rmsMatchedByCode,
    rmsMatchedByDescription,
    rmsWithoutHistory,
    rmsFullyCovered,
    bindingsInserted,
    mainAssignedNew,
    mainPromotedExisting,
    errorCount: errors.length,
    seededSamples,
    promotedSamples,
    skippedSamples,
    errors,
  });
});

app.post("/backfill-historical-grns", async (c) => {
  // Same gate as POST /api/purchase-orders.
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: BackfillPhantomGrnsBody = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as BackfillPhantomGrnsBody;
  } catch {
    body = {};
  }
  // Also support ?dryRun=true on the query string for parity with other
  // backfill endpoints that read it from URL params.
  const dryRunQuery = c.req.query("dryRun");
  const dryRun = body.dryRun === true || dryRunQuery === "true";

  const db = c.var.DB;

  // Find every RECEIVED PO with no GRN. Postgres alias quoting (AS "fooBar")
  // preserves case so the JS side gets the field names back as-is.
  const candidatesRes = await db
    .prepare(
      `SELECT po.id           AS "poId",
              po.poNo         AS "poNo",
              po.supplierId   AS "supplierId",
              po.supplierName AS "supplierName",
              po.receivedDate AS "receivedDate",
              po.orderDate    AS "orderDate"
         FROM purchase_orders po
        WHERE po.status = 'RECEIVED'
          AND NOT EXISTS (
                SELECT 1 FROM grns g WHERE g.poId = po.id
              )
        ORDER BY po.poNo`,
    )
    .all<{
      poId: string;
      poNo: string;
      supplierId: string;
      supplierName: string | null;
      receivedDate: string | null;
      orderDate: string | null;
    }>();
  const candidates = candidatesRes.results ?? [];

  // Pre-scan the existing PHANTOM GRN sequence so we can keep numbering
  // contiguous across multiple runs. Format: GRN-PHANTOM-NNN.
  const seqRes = await db
    .prepare(
      `SELECT grnNumber FROM grns
        WHERE grnNumber LIKE 'GRN-PHANTOM-%'
        ORDER BY grnNumber DESC
        LIMIT 1`,
    )
    .first<{ grnNumber: string }>();
  let nextSeq = seqRes?.grnNumber
    ? Number(seqRes.grnNumber.split("-").pop()) + 1
    : 1;

  let created = 0;
  const errors: { poNo: string; message: string }[] = [];
  const sample: { poNo: string; grnNumber: string; lineCount: number }[] = [];

  for (const cand of candidates) {
    try {
      // Pull the parent PO's items so we can mirror them onto the GRN.
      // Each GRN line gets receivedQty = orderedQty = quantity, accepted
      // = received, rejected = 0 — matches "fully received per the PO".
      const itemsRes = await db
        .prepare(
          `SELECT id           AS "id",
                  materialName AS "materialName",
                  supplierSKU  AS "supplierSKU",
                  quantity     AS "quantity",
                  unitPriceSen AS "unitPriceSen"
             FROM purchase_order_items
            WHERE purchaseOrderId = ?`,
        )
        .bind(cand.poId)
        .all<{
          id: string;
          materialName: string | null;
          supplierSKU: string | null;
          quantity: number;
          unitPriceSen: number;
        }>();
      const items = itemsRes.results ?? [];
      if (items.length === 0) {
        // No PO items → nothing to mirror. Surface as an error so the
        // caller can spot-check (could indicate orphan data in 5.4).
        errors.push({
          poNo: cand.poNo,
          message: "PO has no line items — skipped",
        });
        continue;
      }

      const grnNumber = `GRN-PHANTOM-${String(nextSeq).padStart(3, "0")}`;
      nextSeq++;
      const grnId = `grn-${crypto.randomUUID().slice(0, 8)}`;
      // Receive date defaults to the PO's receivedDate, then orderDate,
      // then today — keep the timeline coherent for downstream reports.
      const receiveDate =
        cand.receivedDate || cand.orderDate || new Date().toISOString().slice(0, 10);
      const totalAmount = items.reduce(
        (s, it) => s + (it.quantity || 0) * (it.unitPriceSen || 0),
        0,
      );

      if (!dryRun) {
        const stmts: D1PreparedStatement[] = [];
        stmts.push(
          db
            .prepare(
              `INSERT INTO grns (id, grnNumber, poId, poNumber, supplierId,
                 supplierName, receiveDate, receivedBy, totalAmount,
                 qcStatus, status, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PASSED', 'POSTED', ?)`,
            )
            .bind(
              grnId,
              grnNumber,
              cand.poId,
              cand.poNo,
              cand.supplierId,
              cand.supplierName ?? "",
              receiveDate,
              "phantom-backfill",
              totalAmount,
              "Phantom backfill — historical RECEIVED PO, inventory already correct",
            ),
        );
        items.forEach((item, idx) => {
          stmts.push(
            db
              .prepare(
                `INSERT INTO grn_items (grnId, poItemIndex, materialCode,
                   materialName, orderedQty, receivedQty, acceptedQty,
                   rejectedQty, rejectionReason, unitPrice)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
              )
              .bind(
                grnId,
                idx,
                item.supplierSKU ?? "",
                item.materialName ?? "",
                item.quantity,
                item.quantity,
                item.quantity,
                item.unitPriceSen,
              ),
          );
        });

        await db.batch(stmts);
      }

      created++;
      if (sample.length < 5) {
        sample.push({
          poNo: cand.poNo,
          grnNumber,
          lineCount: items.length,
        });
      }
    } catch (err) {
      errors.push({
        poNo: cand.poNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    candidates: candidates.length,
    created,
    errors,
    sample,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/recompute-po-status-progress
//
// One-shot backfill that runs the recomputePoStatusAndProgress helper over
// every existing production_orders row. Required after the audit fix
// (2026-05-07): historic POs were stranded at status="PENDING" and
// progress=0 even when their JCs were all done. The helper itself is the
// same one wired into every live JC mutation site, so re-running it here
// gets every row to the canonical state.
//
// Skips ON_HOLD and CANCELLED (admin states). Returns counts +
// representative samples so the operator can sanity-check the diff
// before-and-after.
//
// Body: { dryRun?: boolean } — default false. Dry run computes the diff
// but does not write.
// ---------------------------------------------------------------------------
app.post("/recompute-po-status-progress", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: boolean } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
  } catch {
    body = {};
  }
  const dryRun = body?.dryRun === true;

  const db = c.var.DB;

  // Load every PO id. A few thousand at most — fits in one round-trip.
  const poRes = await db
    .prepare(`SELECT id, poNo, status, progress, completedDate FROM production_orders`)
    .all<{
      id: string;
      poNo: string;
      status: string;
      progress: number | null;
      completedDate: string | null;
    }>();
  const allPos = poRes.results ?? [];

  let scanned = 0;
  let skippedAdminState = 0;
  let statusChanged = 0;
  let progressChanged = 0;
  let completedDateChanged = 0;
  const errors: Array<{ poId: string; poNo: string; message: string }> = [];
  type Sample = {
    poId: string;
    poNo: string;
    before: { status: string; progress: number; completedDate: string | null };
    after: { status: string; progress: number; completedDate: string | null };
  };
  const statusSamples: Sample[] = [];
  const progressSamples: Sample[] = [];

  for (const po of allPos) {
    scanned++;
    if (po.status === "ON_HOLD" || po.status === "CANCELLED") {
      skippedAdminState++;
      continue;
    }

    if (dryRun) {
      // Replicate the helper's read path to compute the diff without writing.
      // Mirrors recomputePoStatusAndProgress exactly so the dry-run report
      // matches what the live run would do.
      const sibs = await db
        .prepare(
          `SELECT id, status, completedDate, wipQty, sequence
             FROM job_cards
            WHERE productionOrderId = ?`,
        )
        .bind(po.id)
        .all<{
          id: string;
          status: string;
          completedDate: string | null;
          wipQty: number | null;
          sequence: number;
        }>();
      const allJcs = sibs.results ?? [];
      const isDone = (s: string) => s === "COMPLETED" || s === "TRANSFERRED";
      const isInProgress = (s: string) =>
        s === "IN_PROGRESS" || s === "PAUSED";
      let derivedStatus: "PENDING" | "IN_PROGRESS" | "COMPLETED" = "PENDING";
      if (allJcs.length > 0) {
        if (allJcs.every((j) => isDone(j.status))) derivedStatus = "COMPLETED";
        else if (allJcs.some((j) => isInProgress(j.status)))
          derivedStatus = "IN_PROGRESS";
      }
      let pieces = 0;
      let donePieces = 0;
      for (const j of allJcs) {
        const t = Math.max(1, j.wipQty ?? 1);
        pieces += t;
        if (isDone(j.status)) donePieces += t;
      }
      const newProgress =
        pieces > 0 ? Math.round((donePieces / pieces) * 100) : 0;
      let newCompletedDate: string | null = po.completedDate ?? null;
      if (derivedStatus === "COMPLETED") {
        const dates = allJcs
          .map((j) => j.completedDate || "")
          .filter(Boolean)
          .sort();
        newCompletedDate =
          dates.length > 0
            ? dates[dates.length - 1]
            : (po.completedDate ??
              new Date().toISOString().slice(0, 10));
      }
      const sChanged = po.status !== derivedStatus;
      const pChanged = (po.progress ?? 0) !== newProgress;
      const cChanged =
        derivedStatus === "COMPLETED" &&
        (po.completedDate ?? null) !== (newCompletedDate ?? null);
      if (sChanged) statusChanged++;
      if (pChanged) progressChanged++;
      if (cChanged) completedDateChanged++;
      if (sChanged && statusSamples.length < 10) {
        statusSamples.push({
          poId: po.id,
          poNo: po.poNo,
          before: {
            status: po.status,
            progress: po.progress ?? 0,
            completedDate: po.completedDate ?? null,
          },
          after: {
            status: derivedStatus,
            progress: newProgress,
            completedDate: newCompletedDate,
          },
        });
      }
      if (pChanged && progressSamples.length < 10) {
        progressSamples.push({
          poId: po.id,
          poNo: po.poNo,
          before: {
            status: po.status,
            progress: po.progress ?? 0,
            completedDate: po.completedDate ?? null,
          },
          after: {
            status: derivedStatus,
            progress: newProgress,
            completedDate: newCompletedDate,
          },
        });
      }
      continue;
    }

    try {
      const result = await recomputePoStatusAndProgress(db, po.id);
      if (!result.changed || !result.before || !result.after) continue;
      if (result.statusChanged) {
        statusChanged++;
        if (statusSamples.length < 10) {
          statusSamples.push({
            poId: po.id,
            poNo: po.poNo,
            before: result.before,
            after: result.after,
          });
        }
      }
      if (result.progressChanged) {
        progressChanged++;
        if (progressSamples.length < 10) {
          progressSamples.push({
            poId: po.id,
            poNo: po.poNo,
            before: result.before,
            after: result.after,
          });
        }
      }
      if (result.completedDateChanged) completedDateChanged++;
    } catch (err) {
      errors.push({
        poId: po.id,
        poNo: po.poNo,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    success: true,
    dryRun,
    scanned,
    skippedAdminState,
    statusChanged,
    progressChanged,
    completedDateChanged,
    errors,
    samples: {
      status: statusSamples,
      progress: progressSamples,
    },
  });
});

app.post("/backfill-po-from-so-lines", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "update");
  if (denied) return denied;

  let body: { soIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as { soIds?: unknown; dryRun?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const soIdsRaw = Array.isArray(body.soIds)
    ? body.soIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : null;
  if (!soIdsRaw || soIdsRaw.length === 0) {
    return c.json(
      {
        success: false,
        error: "body.soIds must be a non-empty array of strings",
      },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  type ProcessResult = {
    soId: string;
    companySOId?: string | null;
    status: "ok" | "skipped" | "error";
    expectedPoCount?: number;
    actualPoCount?: number;
    changes?: Array<{
      poId: string;
      poNo: string;
      diffs: Record<
        string,
        { from: unknown; to: unknown }
      >;
    }>;
    error?: string;
  };
  const processed: ProcessResult[] = [];
  const allUpdateStatements: D1PreparedStatement[] = [];

  for (const soIdRaw of soIdsRaw) {
    // Resolve to internal id
    let soRow = await db
      .prepare(
        "SELECT id, companySOId FROM sales_orders WHERE id = ? LIMIT 1",
      )
      .bind(soIdRaw)
      .first<{ id: string; companySOId: string | null }>();
    if (!soRow) {
      soRow = await db
        .prepare(
          "SELECT id, companySOId FROM sales_orders WHERE companySOId = ? LIMIT 1",
        )
        .bind(soIdRaw)
        .first<{ id: string; companySOId: string | null }>();
    }
    if (!soRow) {
      processed.push({
        soId: soIdRaw,
        status: "error",
        error: "SO not found by id or companySOId",
      });
      continue;
    }
    const soId = soRow.id;

    // Load SO line items
    const linesRes = await db
      .prepare(
        `SELECT id, lineNo, lineSuffix, productId, productCode, productName,
                itemCategory, sizeCode, sizeLabel, fabricCode,
                divanHeightInches, legHeightInches, gapInches,
                specialOrder, quantity
           FROM sales_order_items WHERE salesOrderId = ?
           ORDER BY lineNo ASC`,
      )
      .bind(soId)
      .all<{
        id: string;
        lineNo: number | null;
        lineSuffix: string | null;
        productId: string | null;
        productCode: string | null;
        productName: string | null;
        itemCategory: string | null;
        sizeCode: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        gapInches: number | null;
        specialOrder: string | null;
        quantity: number;
      }>();
    const lines = linesRes.results ?? [];

    // Expand into per-PO unit list — mirrors createProductionOrdersForOrder
    // (production-builder.ts:519), which this route exists to detect drift
    // against, so the two conditions MUST stay identical:
    //   SOFA:          1 entry per line (line.quantity carried on the PO)
    //   BEDFRAME/ACC:  line.quantity entries per line
    const expected: BackfillExpectedUnit[] = [];
    for (const line of lines) {
      const isSofa = (line.itemCategory ?? "BEDFRAME") === "SOFA";
      // Was `isSofa && !isProject`. `sales_orders.is_project_order` was DROPPED
      // by migration 0114 (0 of 444 SOs ever had it; SOFA qty is forced to 1, so
      // the per-piece/merged distinction collapsed). The column is gone from the
      // rename map on purpose, so selecting `isProjectOrder` folded to
      // `isprojectorder` and this whole route died on `column does not exist`.
      const isSetItem = isSofa;
      const pieceCount = isSetItem ? 1 : Math.max(1, line.quantity || 1);
      const perPoQty = isSetItem ? line.quantity || 1 : 1;
      for (let p = 0; p < pieceCount; p++) {
        expected.push({
          lineId: line.id,
          lineSuffix: line.lineSuffix,
          lineNo: line.lineNo,
          productCode: line.productCode,
          productName: line.productName,
          productId: line.productId,
          itemCategory: line.itemCategory,
          sizeLabel: line.sizeLabel,
          sizeCode: line.sizeCode,
          fabricCode: line.fabricCode,
          divanHeightInches: line.divanHeightInches,
          legHeightInches: line.legHeightInches,
          gapInches: line.gapInches,
          specialOrder: line.specialOrder,
          unitQty: perPoQty,
        });
      }
    }

    // Load existing POs sorted by id (which encodes suffix)
    const posRes = await db
      .prepare(
        `SELECT id, poNo, productCode, productName, productId, itemCategory,
                sizeCode, sizeLabel, fabricCode,
                divanHeightInches, legHeightInches, gapInches,
                specialOrder, quantity, status
           FROM production_orders WHERE salesOrderId = ? AND status <> 'CANCELLED'
           ORDER BY id ASC`,
      )
      .bind(soId)
      .all<{
        id: string;
        poNo: string;
        productCode: string | null;
        productName: string | null;
        productId: string | null;
        itemCategory: string | null;
        sizeCode: string | null;
        sizeLabel: string | null;
        fabricCode: string | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        gapInches: number | null;
        specialOrder: string | null;
        quantity: number;
        status: string;
      }>();
    const pos = posRes.results ?? [];

    // PO count check
    if (pos.length !== expected.length) {
      processed.push({
        soId,
        companySOId: soRow.companySOId,
        status: "skipped",
        expectedPoCount: expected.length,
        actualPoCount: pos.length,
        error: `PO count mismatch (expected ${expected.length}, got ${pos.length}) — needs CREATE/DELETE which is out of scope for this backfill. Operator must investigate manually.`,
      });
      continue;
    }

    // Pair PO[i] with expected[i] and compute diffs
    const changes: NonNullable<ProcessResult["changes"]> = [];
    for (let i = 0; i < pos.length; i++) {
      const po = pos[i];
      const exp = expected[i];
      const diffs: Record<string, { from: unknown; to: unknown }> = {};

      const checks: Array<[string, unknown, unknown]> = [
        ["productCode", po.productCode, exp.productCode],
        ["productName", po.productName, exp.productName],
        ["productId", po.productId, exp.productId],
        ["itemCategory", po.itemCategory, exp.itemCategory],
        ["sizeCode", po.sizeCode, exp.sizeCode],
        ["sizeLabel", po.sizeLabel, exp.sizeLabel],
        ["fabricCode", po.fabricCode, exp.fabricCode],
        ["divanHeightInches", po.divanHeightInches, exp.divanHeightInches],
        ["legHeightInches", po.legHeightInches, exp.legHeightInches],
        ["gapInches", po.gapInches, exp.gapInches],
        ["specialOrder", po.specialOrder, exp.specialOrder],
        ["quantity", po.quantity, exp.unitQty],
      ];
      for (const [field, from, to] of checks) {
        const normFrom =
          from === null || from === undefined || from === "" ? null : from;
        const normTo =
          to === null || to === undefined || to === "" ? null : to;
        if (normFrom !== normTo) {
          diffs[field] = { from, to };
        }
      }

      if (Object.keys(diffs).length > 0) {
        changes.push({ poId: po.id, poNo: po.poNo, diffs });
        // Build UPDATE statement (only changed fields)
        const setClauses: string[] = [];
        const binds: unknown[] = [];
        for (const field of Object.keys(diffs)) {
          setClauses.push(`${field} = ?`);
          const val = (diffs[field].to ?? null) as unknown;
          binds.push(val);
        }
        if (setClauses.length > 0) {
          setClauses.push("updated_at = ?");
          binds.push(new Date().toISOString());
          binds.push(po.id);
          allUpdateStatements.push(
            db
              .prepare(
                `UPDATE production_orders SET ${setClauses.join(", ")} WHERE id = ?`,
              )
              .bind(...binds),
          );
        }
      }
    }

    processed.push({
      soId,
      companySOId: soRow.companySOId,
      status: "ok",
      expectedPoCount: expected.length,
      actualPoCount: pos.length,
      changes,
    });
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      processed,
      totalUpdates: allUpdateStatements.length,
    });
  }

  // Live: execute UPDATEs in chunks of 50
  const CHUNK = 50;
  let updated = 0;
  const errors: Array<{ chunk: number; message: string }> = [];
  for (let i = 0; i < allUpdateStatements.length; i += CHUNK) {
    const slice = allUpdateStatements.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    try {
      await db.batch(slice);
      updated += slice.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ chunk: i, message });
    }
  }

  return c.json({
    success: errors.length === 0,
    dryRun: false,
    processed,
    updated,
    totalUpdates: allUpdateStatements.length,
    errors,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/append-missing-pos
//
// One-shot fill-in for SOs whose original generator run emitted FEWER POs
// than the SO's per-unit total (e.g. SO-2604-303: BF line qty=2 produced
// only 1 PO; the 2nd unit's PO was never created).
//
// Calls createProductionOrdersForSO with `appendOnly: true`. Generator
// skips the bail-on-existing-POs check and runs its full per-unit
// expansion loop, emitting INSERT statements for every expected PO + JC.
// INSERT OR IGNORE on production_orders + deterministic poId/jcId scheme
// means pre-existing rows no-op silently; only new rows land.
//
// Body: { soIds: string[], dryRun: boolean }
// Returns: { success, dryRun, processed: [{soId, companySOId, existingPosCount, newStatements, newPos}], updated?, errors? }
//
// Permission: purchase-orders:create.
// ---------------------------------------------------------------------------
app.post("/append-missing-pos", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "create");
  if (denied) return denied;

  let body: { soIds?: unknown; dryRun?: unknown };
  try {
    body = (await c.req.json()) as { soIds?: unknown; dryRun?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const soIdsRaw = Array.isArray(body.soIds)
    ? body.soIds.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      )
    : null;
  if (!soIdsRaw || soIdsRaw.length === 0) {
    return c.json(
      { success: false, error: "body.soIds must be a non-empty array" },
      400,
    );
  }
  const dryRun = body.dryRun === true;
  const db = c.var.DB;

  type ProcessResult = {
    soId: string;
    companySOId?: string | null;
    status: "ok" | "error";
    existingPosCount?: number;
    newStatements?: number;
    newPos?: Array<{ poNo: string; poId: string; quantity: number }>;
    error?: string;
  };
  const processed: ProcessResult[] = [];
  const allStatements: D1PreparedStatement[] = [];

  for (const soIdRaw of soIdsRaw) {
    let so = await db
      .prepare("SELECT * FROM sales_orders WHERE id = ? LIMIT 1")
      .bind(soIdRaw)
      .first<SalesOrderRow>();
    if (!so) {
      so = await db
        .prepare("SELECT * FROM sales_orders WHERE companySOId = ? LIMIT 1")
        .bind(soIdRaw)
        .first<SalesOrderRow>();
    }
    if (!so) {
      processed.push({
        soId: soIdRaw,
        status: "error",
        error: "SO not found by id or companySOId",
      });
      continue;
    }
    const existing = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM production_orders WHERE salesOrderId = ? AND status <> 'CANCELLED'",
      )
      .bind(so.id)
      .first<{ n: number }>();
    const existingPosCount = Number(existing?.n ?? 0);

    const itemsRes = await db
      .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(so.id)
      .all<SalesOrderItemRow>();
    const items = itemsRes.results ?? [];

    const { statements, created } = await createProductionOrdersForSO(
      db,
      so,
      items,
      { appendOnly: true },
    );

    processed.push({
      soId: so.id,
      companySOId: so.companySOId,
      status: "ok",
      existingPosCount,
      newStatements: statements.length,
      newPos: created.map((p) => ({
        poNo: p.poNo,
        poId: p.id,
        quantity: p.quantity,
      })),
    });
    if (!dryRun) {
      allStatements.push(...statements);
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      processed,
      totalNewStatements: processed.reduce(
        (sum, p) => sum + (p.newStatements ?? 0),
        0,
      ),
    });
  }

  const CHUNK = 50;
  let executed = 0;
  const errors: Array<{ chunk: number; message: string }> = [];
  for (let i = 0; i < allStatements.length; i += CHUNK) {
    const slice = allStatements.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    try {
      await db.batch(slice);
      executed += slice.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ chunk: i, message });
    }
  }

  return c.json({
    success: errors.length === 0,
    dryRun: false,
    processed,
    executed,
    totalStatements: allStatements.length,
    errors,
  });
});

app.post("/backfill-po-line-no", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;
  const db = c.var.DB;
  let body: { dryRun?: boolean; soIds?: string[] } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // Empty body OK — defaults below.
  }
  const dryRun = body.dryRun !== false; // default true
  const filterSoIds = Array.isArray(body.soIds) && body.soIds.length > 0
    ? new Set(body.soIds)
    : null;

  // Pull every non-cancelled SO with its items. We hit it as one query
  // joining items so we don't do N+1 round-trips.
  const itemsRes = await db
    .prepare(
      `SELECT soi.salesOrderId, soi.lineNo, soi.itemCategory, soi.quantity,
              so.companySOId, so.status
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE COALESCE(so.status, '') <> 'CANCELLED'
        ORDER BY soi.salesOrderId, soi.lineNo`,
    )
    .all<{
      salesOrderId: string;
      lineNo: number;
      itemCategory: string | null;
      quantity: number;
      companySOId: string | null;
      status: string;
    }>();
  const itemsBySo = new Map<string, typeof itemsRes.results>();
  const companySOIdBySo = new Map<string, string>();
  for (const it of itemsRes.results ?? []) {
    if (!itemsBySo.has(it.salesOrderId)) {
      itemsBySo.set(it.salesOrderId, [] as unknown as typeof itemsRes.results);
    }
    (itemsBySo.get(it.salesOrderId) as unknown as typeof itemsRes.results)!.push(it);
    if (it.companySOId) companySOIdBySo.set(it.salesOrderId, it.companySOId);
  }

  const posRes = await db
    .prepare(
      `SELECT id AS "poId", poNo, salesOrderId, lineNo
         FROM production_orders
        WHERE salesOrderId IS NOT NULL AND salesOrderId <> ''
          AND COALESCE(status, '') <> 'CANCELLED'
        ORDER BY salesOrderId, poNo`,
    )
    .all<{
      poId: string;
      poNo: string;
      salesOrderId: string;
      lineNo: number;
    }>();
  const posBySo = new Map<string, typeof posRes.results>();
  for (const p of posRes.results ?? []) {
    if (!posBySo.has(p.salesOrderId)) {
      posBySo.set(p.salesOrderId, [] as unknown as typeof posRes.results);
    }
    (posBySo.get(p.salesOrderId) as unknown as typeof posRes.results)!.push(p);
  }

  const fixes: LinenoFixRow[] = [];
  const skipped: { salesOrderId: string; companySOId: string | null; reason: string }[] = [];

  for (const [soId, items] of itemsBySo.entries()) {
    if (filterSoIds && !filterSoIds.has(soId)) continue;
    const pos = posBySo.get(soId) ?? [];
    if (pos.length === 0) continue;

    // Sort POs by poNo's `-NN` suffix (numeric, falls back to lex).
    const sortedPos = [...pos].sort((a, b) => {
      const ma = /-(\d+)$/.exec(a.poNo);
      const mb = /-(\d+)$/.exec(b.poNo);
      const na = ma ? parseInt(ma[1], 10) : 0;
      const nb = mb ? parseInt(mb[1], 10) : 0;
      return na - nb;
    });
    const sortedItems = [...items].sort((a, b) => a.lineNo - b.lineNo);

    // Allocate POs to lines via cumulative-qty.
    const expectedLineNoByPoId = new Map<string, number>();
    let poIdx = 0;
    for (const line of sortedItems) {
      const isSofa = (line.itemCategory ?? "BEDFRAME") === "SOFA";
      // SOFA = 1 PO per line (set semantics); BF/ACC = N POs per line.
      const pieceCount = isSofa ? 1 : Math.max(1, line.quantity || 1);
      for (let k = 0; k < pieceCount; k++) {
        if (poIdx >= sortedPos.length) break;
        expectedLineNoByPoId.set(sortedPos[poIdx].poId, line.lineNo);
        poIdx++;
      }
    }

    // If we couldn't cover every PO, the SO has duplicate poNos / model
    // break (Pattern 2). Skip — surface for separate cleanup.
    if (poIdx !== sortedPos.length) {
      skipped.push({
        salesOrderId: soId,
        companySOId: companySOIdBySo.get(soId) ?? null,
        reason: `${sortedPos.length} POs but cumulative-qty mapping covered ${poIdx} (model break — likely duplicate poNo)`,
      });
      continue;
    }

    for (const p of sortedPos) {
      const expected = expectedLineNoByPoId.get(p.poId);
      if (expected === undefined) continue;
      if (expected !== p.lineNo) {
        fixes.push({
          poId: p.poId,
          poNo: p.poNo,
          companySOId: companySOIdBySo.get(soId) ?? "",
          currentLineNo: p.lineNo,
          expectedLineNo: expected,
        });
      }
    }
  }

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      candidatePoCount: fixes.length,
      affectedSoCount: new Set(fixes.map((f) => f.companySOId)).size,
      fixes,
      skipped,
    });
  }

  // Live: UPDATE each PO's lineNo. Sequential — small batch (~25 rows).
  const stmts = fixes.map((f) =>
    db
      .prepare(
        `UPDATE production_orders SET lineNo = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(f.expectedLineNo, new Date().toISOString(), f.poId),
  );
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
  return c.json({
    success: true,
    dryRun: false,
    updatedPoCount: fixes.length,
    affectedSoCount: new Set(fixes.map((f) => f.companySOId)).size,
    fixes,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /api/import/backfill-supplier-sku-1to1
//
// Wei Siang spec (2026-05-10): 731 of 969 supplier_material_bindings have
// supplierSku != materialCode — caused by an import default that
// dumped the same value (e.g. "PC151-01" on 153 rows) across unrelated
// internal codes. Operators were about to open POs against the wrong
// supplier SKU.
//
// Fix: force supplierSku = materialCode for every mismatched row. If
// any supplier really does use a different SKU, operator can fix that
// row manually in Maintenance afterwards (the backfill is a safe
// reset since no supplierDescription was set on these rows anyway).
//
// Body: { dryRun: boolean (default true) }
//
// Per project_migration_in_progress: one-shot, will be removed
// post-migration.
// ---------------------------------------------------------------------------
app.post("/backfill-supplier-sku-1to1", async (c) => {
  const denied = await requirePermission(c, "suppliers", "update");
  if (denied) return denied;

  let body: { dryRun?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // empty body OK
  }
  const dryRun = body.dryRun !== false;
  const db = c.var.DB;

  type Row = {
    id: string;
    materialCode: string | null;
    materialName: string | null;
    supplierSku: string | null;
  };

  const res = await db
    .prepare(
      `SELECT id, materialCode, materialName, supplierSku
         FROM supplier_material_bindings
         WHERE supplierSku IS NOT NULL
           AND materialCode IS NOT NULL
           AND supplierSku <> materialCode`,
    )
    .all<Row>();
  const rows = res.results ?? [];

  // Distribution of "wrong" supplierSku values for visibility
  const dist = new Map<string, number>();
  for (const r of rows) {
    const k = r.supplierSku || "";
    dist.set(k, (dist.get(k) || 0) + 1);
  }
  const topDist = [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([sku, count]) => ({ sku, count }));

  if (dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      mismatchCount: rows.length,
      topMismatchedSkus: topDist,
      sampleChanges: rows.slice(0, 20).map((r) => ({
        id: r.id,
        materialCode: r.materialCode,
        materialName: r.materialName,
        supplierSku_before: r.supplierSku,
        supplierSku_after: r.materialCode,
      })),
    });
  }

  // Live: batch update.
  const stmts: D1PreparedStatement[] = rows.map((r) =>
    db
      .prepare(
        `UPDATE supplier_material_bindings SET supplierSku = ? WHERE id = ?`,
      )
      .bind(r.materialCode, r.id),
  );
  // D1 batch limit ~100 per call — chunk.
  const chunkSize = 80;
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }

  return c.json({
    success: true,
    dryRun: false,
    updated: rows.length,
    topMismatchedSkus: topDist,
  });
});

export default app;

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const schemas = await import(
  pathToFileURL(resolve("src/lib/schemas/stock-adjustment.ts")).href
);
const stockRoute = readFileSync(
  resolve("src/api/routes/stock-adjustments.ts"),
  "utf8",
);
const serviceRoute = readFileSync(
  resolve("src/api/routes/service-orders.ts"),
  "utf8",
);
const inventoryRoute = readFileSync(
  resolve("src/api/routes/inventory.ts"),
  "utf8",
);
const adjustmentPage = readFileSync(
  resolve("src/pages/inventory/adjustments.tsx"),
  "utf8",
);
const serviceCasePage = readFileSync(
  resolve("src/pages/service-cases/detail.tsx"),
  "utf8",
);
const serviceOrderPage = readFileSync(
  resolve("src/pages/service-orders/detail.tsx"),
  "utf8",
);
const mobileForms = readFileSync(
  resolve("src/pages/m/config/forms.ts"),
  "utf8",
);
const mobileModules = readFileSync(
  resolve("src/pages/m/config/modules.ts"),
  "utf8",
);
const migration = readFileSync(
  resolve("migrations-postgres/0212_inventory_adjustment_guards.sql"),
  "utf8",
);

test("stock adjustment body is strict and does not accept actor spoofing", () => {
  const valid = {
    type: "RM",
    itemId: "rm-1",
    qtyDelta: -1.5,
    unitCostSen: 0,
    reason: "WRITE_OFF",
    notes: null,
  };
  assert.equal(schemas.createStockAdjustmentSchema.safeParse(valid).success, true);
  assert.equal(
    schemas.createStockAdjustmentSchema.safeParse({ ...valid, qtyDelta: "-1.5" })
      .success,
    false,
  );
  assert.equal(
    schemas.createStockAdjustmentSchema.safeParse({ ...valid, unitCostSen: -1 })
      .success,
    false,
  );
  assert.equal(
    schemas.createStockAdjustmentSchema.safeParse({
      ...valid,
      adjustedBy: "attacker",
    }).success,
    false,
  );
});

test("stock mutation is idempotent, server-attributed, and tenant scoped", () => {
  assert.match(stockRoute, /withIdempotency\(c, "stock-adjustments"/);
  assert.match(stockRoute, /valid Idempotency-Key header is required/);
  assert.match(stockRoute, /\.get\("userId"\)/);
  assert.doesNotMatch(stockRoute, /body\.adjustedBy/);
  assert.match(stockRoute, /raw_materials WHERE id = \? AND orgId = \?/);
  assert.match(stockRoute, /fg_batches WHERE id = \? AND orgId = \?/);
  assert.match(stockRoute, /WHERE rmId = \? AND orgId = \?/);
  assert.match(stockRoute, /INSERT INTO stock_adjustments \(id, orgId/);
  assert.match(stockRoute, /INSERT INTO stock_movements \(id, orgId/);
  assert.match(stockRoute, /INSERT INTO cost_ledger \(id, orgId/);
  assert.match(stockRoute, /INSERT INTO rm_batches \(id, orgId/);
});

test("FG adjustment callers and API share batch-level identity", () => {
  const stockTopUp = serviceCasePage.slice(
    serviceCasePage.indexOf("function StockTopUpPanel"),
    serviceCasePage.indexOf("function ActionLogPanel"),
  );
  assert.match(inventoryRoute, /app\.get\("\/fg-batches"/);
  assert.match(inventoryRoute, /WHERE fb\.orgId = \?/);
  assert.match(adjustmentPage, /"\/api\/inventory\/fg-batches"/);
  assert.match(stockTopUp, /"\/api\/inventory\/fg-batches"/);
  assert.match(adjustmentPage, /"Idempotency-Key": row\.idempotencyKey/);
  assert.match(stockTopUp, /"Idempotency-Key": issueIdempotencyKey\.current/);
  assert.doesNotMatch(adjustmentPage, /adjustedBy:\s*user/);
});

test("service return scrap follows the same safety baseline", () => {
  const scrap = serviceRoute.slice(
    serviceRoute.indexOf('app.post("/:id/returns/:rid/scrap"'),
    serviceRoute.indexOf("// DELETE /api/service-orders/:id"),
  );
  assert.match(scrap, /scrapServiceReturnSchema\.safeParse/);
  assert.match(scrap, /withIdempotency\(c, "service-return-scrap"/);
  assert.match(scrap, /issueStockAdjustmentNumber/);
  assert.match(scrap, /fg_batches WHERE id = \? AND orgId = \?/);
  assert.match(scrap, /INSERT INTO stock_adjustments \(id, orgId, adjNo/);
  assert.doesNotMatch(scrap, /body\.adjustedBy/);
  assert.match(serviceOrderPage, /"Idempotency-Key": scrapIdempotencyKey\.current/);
});

test("database guards reject concurrent negative stock", () => {
  for (const constraint of [
    "raw_materials_balance_nonnegative",
    "wip_items_stock_nonnegative",
    "fg_batches_remaining_nonnegative",
    "rm_batches_remaining_nonnegative",
    "stock_adjustments_direction_matches_qty",
  ]) {
    assert.match(migration, new RegExp(constraint));
  }
  assert.match(migration, /NOT VALID/g);
});

test("mobile stock adjustment fields match the API response", () => {
  assert.match(mobileForms, /"Idempotency-Key": idempotencyKey/);
  assert.match(mobileModules, /str\(r, "adjNo"\)/);
  assert.match(mobileModules, /num\(r, "qtyDelta"\)/);
  assert.match(mobileModules, /dateOnly\(r, "adjustedAt"\)/);
});

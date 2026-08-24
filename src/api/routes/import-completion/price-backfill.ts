// ---------------------------------------------------------------------------
// price-backfill — the two writes the July/August repricing still needed, as
// server-side endpoints instead of a loop in someone's browser.
//
// Owner 2026-08-24: 「有没有直接一次性的脚本，写进去然后就处理完的？」
//
//   POST /api/import/refresh-so-surcharges
//   POST /api/import/backfill-invoice-prices-from-so
//
// Both are dry-run by default, scoped the same way `/recompute-so-sofa-prices`
// is (date window, customers, unpaid only), and both echo the scope that
// actually ran. Run them IN THIS ORDER: an invoice is derived from its sales
// order, so refreshing a surcharge after the invoice pass would leave the two
// disagreeing.
//
// ## Service orders are never touched, by either
//
//   「service order是根据当初开的价格 0就是0 有amount就是有amount」
//
// A repair was quoted at a number — sometimes zero, for goodwill — the
// customer was told that number, and a price-list change months later does not
// reach back. There is deliberately no flag for it.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { getOrgId } from "../../lib/tenant";
import { calculateUnitPrice, calculateLineTotalWithDiscount } from "../../../lib/pricing";
import { loadSpecialsConfig, loadHeightsConfig } from "../../lib/specials-config";
import { resolveHeightPriceSen } from "../../../lib/height-surcharge";
import { resolveSpecialOrderPriceSen } from "../../../lib/special-order-surcharge";
import { resolveTotalHeightPriceSen } from "../../../lib/total-height-surcharge";

const app = new Hono<Env>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type ScopeQuery = {
  from: string;
  to: string;
  customerIds: string[];
  dryRun: boolean;
  sampleLimit: number;
};

function readScope(c: {
  req: { query: (k: string) => string | undefined };
}): ScopeQuery | { error: string } {
  const from = (c.req.query("from") || "").trim();
  const to = (c.req.query("to") || "").trim();
  for (const [label, v] of [["from", from], ["to", to]] as const) {
    if (v && !DATE_RE.test(v)) return { error: `${label} must be YYYY-MM-DD` };
  }
  return {
    from,
    to,
    customerIds: (c.req.query("customerIds") || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    dryRun: c.req.query("dryRun") !== "false",
    sampleLimit: Math.min(500, Math.max(1, Number(c.req.query("samples")) || 25)),
  };
}

// ---------------------------------------------------------------------------
// POST /refresh-so-surcharges
//
// Re-derive divan / leg / total-height / special-order from the owner's
// CURRENT lists (`variants-config`) for sales-order lines in scope, and rebuild
// the unit + line totals around them.
//
// Why this cannot go through the ordinary SO edit: on 2026-08-24 every one of
// the eight lines that disagreed with the config sat on an order the edit path
// refuses — production started, or a status past editing. Cancelling six
// production orders to correct RM 265 of surcharge is the wrong trade. This
// changes prices only; it touches nothing production reads.
//
// The resolvers DERIVE only when the field is omitted — a supplied number is
// trusted verbatim, including a deliberate 0. So this passes `undefined` on
// purpose: re-deriving IS the point. That also means a hand-zeroed surcharge
// is restored to list, which is why the response names every line it moved.
// ---------------------------------------------------------------------------
app.post("/refresh-so-surcharges", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
  const scope = readScope(c);
  if ("error" in scope) return c.json({ success: false, error: scope.error }, 400);
  const db = c.var.DB;
  const orgId = getOrgId(c);

  const [specials, heights] = await Promise.all([
    loadSpecialsConfig(db),
    loadHeightsConfig(db),
  ]);

  const soRes = await db
    .prepare(
      `SELECT id, companySOId, customerId, customerName, status, isServiceOrder,
              companySODate, created_at AS createdAt
         FROM sales_orders
        WHERE (orgId = ? OR orgId IS NULL) AND status != 'CANCELLED'`,
    )
    .bind(orgId)
    .all<{
      id: string;
      companySOId: string | null;
      customerId: string | null;
      customerName: string | null;
      status: string | null;
      isServiceOrder: unknown;
      companySODate: string | null;
      createdAt: string | null;
    }>();

  let sos = (soRes.results ?? []).filter(
    (so) => !(so.isServiceOrder === true || so.isServiceOrder === 1),
  );
  const serviceOrdersExcluded =
    (soRes.results ?? []).length - sos.length;
  const dateOf = (so: { companySODate: string | null; createdAt: string | null }) =>
    String(so.companySODate || so.createdAt || "").slice(0, 10);
  if (scope.from) sos = sos.filter((so) => dateOf(so) >= scope.from);
  if (scope.to) sos = sos.filter((so) => dateOf(so) <= scope.to);
  if (scope.customerIds.length) {
    const want = new Set(scope.customerIds);
    sos = sos.filter((so) => so.customerId && want.has(so.customerId));
  }

  // An order whose invoice is settled is money paid against a document the
  // customer holds. Same default as the sofa repricer.
  const paidRes = await db
    .prepare(
      `SELECT DISTINCT salesOrderId AS soId FROM invoices
        WHERE status IN ('PAID','PARTIAL_PAID') AND salesOrderId IS NOT NULL`,
    )
    .all<{ soId: string }>();
  const paid = new Set((paidRes.results ?? []).map((r) => r.soId));
  const beforePaid = sos.length;
  sos = sos.filter((so) => !paid.has(so.id));
  const paidOrdersExcluded = beforePaid - sos.length;

  const appliedScope = {
    from: scope.from || null,
    to: scope.to || null,
    customerIds: scope.customerIds.length ? scope.customerIds : null,
    serviceOrdersExcluded,
    paidOrdersExcluded,
    soCount: sos.length,
  };
  if (sos.length === 0) {
    return c.json({ success: true, dryRun: scope.dryRun, appliedScope, changes: [] });
  }

  const soById = new Map(sos.map((s) => [s.id, s] as const));
  const ids = sos.map((s) => s.id);
  const itemsRes = await db
    .prepare(
      `SELECT id, salesOrderId, productCode, quantity, gapInches,
              divanHeightInches, divanPriceSen, legHeightInches, legPriceSen,
              specialOrder, specialOrderPriceSen, totalHeightPriceSen,
              basePriceSen, unitPriceSen, lineTotalSen, discountSen
         FROM sales_order_items
        WHERE salesOrderId IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .all<Record<string, unknown>>();

  type Change = {
    soId: string;
    so: string | null;
    customer: string | null;
    status: string | null;
    itemId: string;
    product: string | null;
    field: string;
    oldRM: number;
    newRM: number;
    oldLineRM: number;
    newLineRM: number;
  };
  const changes: Change[] = [];
  const writes: Array<{
    itemId: string;
    divan: number;
    leg: number;
    special: number;
    totalHeight: number;
    unit: number;
    line: number;
    soId: string;
  }> = [];

  for (const raw of itemsRes.results ?? []) {
    const it = raw as Record<string, number | string | null>;
    const soId = String(it.salesOrderId ?? "");
    const so = soById.get(soId);
    if (!so) continue;

    // undefined = "derive it" — see the header note.
    const divan = resolveHeightPriceSen(
      undefined,
      it.divanHeightInches as number | string | null,
      heights.divanHeights,
      false,
    );
    const leg = resolveHeightPriceSen(
      undefined,
      it.legHeightInches as number | string | null,
      heights.legHeights,
      false,
    );
    const special = resolveSpecialOrderPriceSen(
      { specialOrder: it.specialOrder as string | null },
      specials,
    );
    const totalHeight = resolveTotalHeightPriceSen(
      undefined,
      it.gapInches as number | string | null,
      it.divanHeightInches as number | string | null,
      it.legHeightInches as number | string | null,
      heights.totalHeights,
      false,
    );

    const curDivan = Number(it.divanPriceSen) || 0;
    const curLeg = Number(it.legPriceSen) || 0;
    const curSpecial = Number(it.specialOrderPriceSen) || 0;
    const curTh = Number(it.totalHeightPriceSen) || 0;
    const moved: Array<[string, number, number]> = [];
    if (divan !== curDivan) moved.push(["divan", curDivan, divan]);
    if (leg !== curLeg) moved.push(["leg", curLeg, leg]);
    if (special !== curSpecial) moved.push(["special", curSpecial, special]);
    if (totalHeight !== curTh) moved.push(["totalHeight", curTh, totalHeight]);
    if (moved.length === 0) continue;

    const base = Number(it.basePriceSen) || 0;
    const qty = Number(it.quantity) || 0;
    const unit = calculateUnitPrice({
      basePriceSen: base,
      divanPriceSen: divan,
      legPriceSen: leg,
      totalHeightPriceSen: totalHeight,
      specialOrderPriceSen: special,
    });
    const line = calculateLineTotalWithDiscount(
      unit,
      qty,
      Number(it.discountSen) || 0,
    );
    const oldLine = Number(it.lineTotalSen) || 0;
    for (const [field, o, n] of moved) {
      changes.push({
        soId,
        so: so.companySOId,
        customer: so.customerName,
        status: so.status,
        itemId: String(it.id ?? ""),
        product: (it.productCode as string) ?? null,
        field,
        oldRM: o / 100,
        newRM: n / 100,
        oldLineRM: oldLine / 100,
        newLineRM: line / 100,
      });
    }
    writes.push({
      itemId: String(it.id ?? ""),
      divan,
      leg,
      special,
      totalHeight,
      unit,
      line,
      soId,
    });
  }

  const netSen = writes.reduce((acc, w) => acc + w.line, 0) -
    (itemsRes.results ?? [])
      .filter((r) => writes.some((w) => w.itemId === String((r as Record<string, unknown>).id)))
      .reduce((acc, r) => acc + (Number((r as Record<string, unknown>).lineTotalSen) || 0), 0);

  const summary = {
    linesTouched: writes.length,
    fieldChanges: changes.length,
    netLineDiffRM: Math.round(netSen) / 100,
  };
  if (scope.dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      appliedScope,
      summary,
      samplesTruncated: changes.length > scope.sampleLimit,
      changes: changes.slice(0, scope.sampleLimit),
    });
  }

  const dirty = new Set<string>();
  for (let i = 0; i < writes.length; i += 50) {
    const batch = writes.slice(i, i + 50);
    await db.batch(
      batch.map((w) => {
        dirty.add(w.soId);
        return db
          .prepare(
            `UPDATE sales_order_items
                SET divanPriceSen = ?, legPriceSen = ?, specialOrderPriceSen = ?,
                    totalHeightPriceSen = ?, unitPriceSen = ?, lineTotalSen = ?
              WHERE id = ?`,
          )
          .bind(w.divan, w.leg, w.special, w.totalHeight, w.unit, w.line, w.itemId);
      }),
    );
  }
  let sosUpdated = 0;
  for (const soId of dirty) {
    const sum = await db
      .prepare(
        `SELECT COALESCE(SUM(lineTotalSen), 0) AS sub FROM sales_order_items
          WHERE salesOrderId = ?`,
      )
      .bind(soId)
      .first<{ sub: number }>();
    const sub = Number(sum?.sub) || 0;
    await db
      .prepare(
        `UPDATE sales_orders SET subtotalSen = ?, totalSen = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
          WHERE id = ?`,
      )
      .bind(sub, sub, soId)
      .run();
    sosUpdated++;
  }

  return c.json({
    success: true,
    dryRun: false,
    appliedScope,
    summary,
    itemsUpdated: writes.length,
    sosUpdated,
    changes: changes.slice(0, scope.sampleLimit),
  });
});

export default app;

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
import {
  resolveSpecialOrderPriceSen,
  parseSpecialOrderTokens,
} from "../../../lib/special-order-surcharge";
import { specialOrderOptions } from "../../../lib/pricing-options";
import { resolveTotalHeightPriceSen } from "../../../lib/total-height-surcharge";

const app = new Hono<Env>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Option names the pricer can actually price. See the confidence note below. */
const KNOWN_SPECIAL_NAMES = new Set(specialOrderOptions.map((o) => o.name));

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
              specialOrder, specialOrderPriceSen, totalHeightPriceSen, customSpecials,
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
  const unresolved: Array<{
    so: string | null;
    product: string | null;
    field: string;
    keptRM: number;
    why: string;
  }> = [];
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
    // A special the current list does not name is UNKNOWN, not free. The first
    // run of this endpoint proved why: it would have wiped RM 9,670 of
    // special-order charges to zero across 27 lines, because `priceOfSen`
    // returns 0 for a token it cannot find and the line's own `customSpecials`
    // were never passed in. That is this repo's oldest bug shape — an absence
    // read as a value — and it had reappeared in the code written to fix
    // surcharges.
    //
    // So the rule is: derive only where the derivation is CONFIDENT. If any
    // token on the line is not priced by the config and not covered by a
    // custom special, the stored figure stands and the line is reported as
    // unresolved.
    let customSpecials: Array<{ surchargeSen?: number }> | null = null;
    try {
      const rawCs = it.customSpecials;
      const parsed = typeof rawCs === "string" ? JSON.parse(rawCs || "null") : rawCs;
      if (Array.isArray(parsed)) customSpecials = parsed;
    } catch {
      /* malformed — treat as absent, which the confidence check then catches */
    }
    const special = resolveSpecialOrderPriceSen(
      {
        specialOrder: it.specialOrder as string | null,
        customSpecials,
      },
      specials,
    );
    // Use the CANONICAL tokenizer, not a second copy of it. The first version
    // here split on /[,+]/ while the real one splits on /[;,]/ and drops
    // `OTHER: …` free-text notes — so 28 lines whose specials were perfectly
    // well known got filed as "not priced by the list" and left untouched.
    // Writing the parser twice is the same mistake that put six copies of a
    // dropped surcharge term in this repo.
    //
    // "Known" means the STATIC catalog names it: `priceOfSen` returns 0 for a
    // name absent from `specialOrderOptions` no matter what the config says,
    // so config membership alone is not enough to be confident.
    const specialTokens = parseSpecialOrderTokens(it.specialOrder as string | null);
    const specialConfident =
      specialTokens.length === 0 ||
      specialTokens.every((t) => KNOWN_SPECIAL_NAMES.has(t));
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
    // Same rule for the height surcharges: a height the list does not price is
    // unknown. `resolveHeightPriceSen` returns 0 for it, which would silently
    // remove a charge that was correct when the order was taken.
    const priced = (
      list: Array<{ value: string; priceSen: number }> | null,
      raw: unknown,
    ) => {
      const v = String(raw ?? "").replace(/"/g, "").trim();
      if (!v) return true; // no height on the line — 0 is the right answer
      return (list ?? []).some(
        (e) => String(e.value).replace(/"/g, "").trim() === v,
      );
    };
    const divanConfident = priced(heights.divanHeights, it.divanHeightInches);
    const legConfident = priced(heights.legHeights, it.legHeightInches);

    const moved: Array<[string, number, number]> = [];
    const unsure: string[] = [];
    if (divan !== curDivan) {
      if (divanConfident) moved.push(["divan", curDivan, divan]);
      else unsure.push("divan");
    }
    if (leg !== curLeg) {
      if (legConfident) moved.push(["leg", curLeg, leg]);
      else unsure.push("leg");
    }
    if (special !== curSpecial) {
      if (specialConfident) moved.push(["special", curSpecial, special]);
      else unsure.push("special");
    }
    // totalHeight derives from gap+divan+leg against its own list; the same
    // confidence rule applies to the SUM, so it rides on both height lookups.
    if (totalHeight !== curTh) {
      if (divanConfident && legConfident) moved.push(["totalHeight", curTh, totalHeight]);
      else unsure.push("totalHeight");
    }
    for (const f of unsure) {
      unresolved.push({
        so: so.companySOId,
        product: (it.productCode as string) ?? null,
        field: f,
        keptRM: (f === "divan" ? curDivan : f === "leg" ? curLeg : f === "special" ? curSpecial : curTh) / 100,
        why: "not priced by the current list — left as it was",
      });
    }
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
    leftAloneNotPricedByList: unresolved.length,
  };
  if (scope.dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      appliedScope,
      summary,
      samplesTruncated: changes.length > scope.sampleLimit,
      changes: changes.slice(0, scope.sampleLimit),
      unresolved: unresolved.slice(0, scope.sampleLimit),
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

// ---------------------------------------------------------------------------
// POST /backfill-invoice-prices-from-so
//
// Re-derive invoice line prices from the sales-order lines they were built
// from, for invoices in a date window. Run it AFTER the sales-order passes.
//
// ## It does not touch the ledger itself — it calls the edit that does
//
// Restating a SENT invoice means reversing its GL posting and re-posting the
// new one on the same hash chain, then collapsing the original legs. That is
// ~200 lines inside the invoice PUT. Copying it here was the obvious move and
// the wrong one: this same session found ONE dropped surcharge term living in
// six hand-written copies, and a tokenizer written twice that disagreed with
// itself. So this endpoint builds the `priceEdits` payload and SELF-CALLS
// `PUT /api/invoices/:id` — the same endpoint the Edit button uses —
// forwarding the caller's session cookie and CSRF header. The owner's
// instruction, satisfied literally: 「记得要用 edit 的功能走正常普通流程」.
//
// (Self-calling is an established pattern here: the scan queue's processBatch
// re-enters /api/scan-po/extract the same way.)
//
// ## Which lines it will and will not move
//
//   priceEdited = 0              derived by the system → re-derive
//   priceEdited = 1, unit > 0    a person set this price → LEAVE IT ALONE
//   priceEdited = 1, unit == 0   the BUG-2026-08-20-158 damage: editing one
//                                line wrote RM 0 into every line the operator
//                                had not typed into. The goods were delivered
//                                and were never free, so a zero here is not a
//                                decision — it is the hole that bug left.
//                                Re-derive. (90 such lines, RM 58k, measured
//                                2026-08-24.)
//
// A line whose sales-order line cannot be identified UNIQUELY is skipped and
// named. Same discipline as resolveSoItemId: count claimants, refuse when
// contested — a wrong identity makes a bad number look authoritative.
// ---------------------------------------------------------------------------
app.post("/backfill-invoice-prices-from-so", async (c) => {
  const denied = await requirePermission(c, "invoices", "update");
  if (denied) return denied;
  const scope = readScope(c);
  if ("error" in scope) return c.json({ success: false, error: scope.error }, 400);
  const db = c.var.DB;
  const orgId = getOrgId(c);
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 25));

  const invRes = await db
    .prepare(
      `SELECT id, invoiceNo, status, invoiceDate, deliveryOrderId, customerId,
              customerName, totalSen
         FROM invoices
        WHERE (orgId = ? OR orgId IS NULL)
          AND status IN ('SENT','DRAFT')
          AND deliveryOrderId IS NOT NULL AND deliveryOrderId != ''`,
    )
    .bind(orgId)
    .all<{
      id: string;
      invoiceNo: string;
      status: string;
      invoiceDate: string | null;
      deliveryOrderId: string;
      customerId: string | null;
      customerName: string | null;
      totalSen: number;
    }>();
  let invoices = invRes.results ?? [];
  const dateOf = (i: { invoiceDate: string | null }) =>
    String(i.invoiceDate ?? "").slice(0, 10);
  if (scope.from) invoices = invoices.filter((i) => dateOf(i) >= scope.from);
  if (scope.to) invoices = invoices.filter((i) => dateOf(i) <= scope.to);
  if (scope.customerIds.length) {
    const want = new Set(scope.customerIds);
    invoices = invoices.filter((i) => i.customerId && want.has(i.customerId));
  }

  const appliedScope = {
    from: scope.from || null,
    to: scope.to || null,
    customerIds: scope.customerIds.length ? scope.customerIds : null,
    statuses: ["SENT", "DRAFT"],
    invoicesInScope: invoices.length,
  };
  if (invoices.length === 0) {
    return c.json({ success: true, dryRun: scope.dryRun, appliedScope, plan: [] });
  }

  // ---- sales-order line index, refusing contested keys -------------------
  const soiRes = await db
    .prepare(
      `SELECT soi.salesOrderId, soi.productCode, soi.sizeCode, soi.fabricCode,
              soi.basePriceSen, soi.divanPriceSen, soi.legPriceSen,
              soi.totalHeightPriceSen, soi.specialOrderPriceSen,
              soi.discountSen, soi.unitPriceSen
         FROM sales_order_items soi
         JOIN sales_orders so ON so.id = soi.salesOrderId
        WHERE (so.orgId = ? OR so.orgId IS NULL)`,
    )
    .bind(orgId)
    .all<Record<string, unknown>>();

  type Build = {
    base: number;
    divan: number;
    leg: number;
    totalHeight: number;
    special: number;
    discount: number;
    unit: number;
  };
  const sig = (b: Build) =>
    `${b.base}|${b.divan}|${b.leg}|${b.totalHeight}|${b.special}|${b.discount}`;
  const full = new Map<string, Build[]>();
  const byCode = new Map<string, Build[]>();
  for (const r of soiRes.results ?? []) {
    const b: Build = {
      base: Number(r.basePriceSen) || 0,
      divan: Number(r.divanPriceSen) || 0,
      leg: Number(r.legPriceSen) || 0,
      totalHeight: Number(r.totalHeightPriceSen) || 0,
      special: Number(r.specialOrderPriceSen) || 0,
      discount: Number(r.discountSen) || 0,
      unit: Number(r.unitPriceSen) || 0,
    };
    const so = String(r.salesOrderId ?? "");
    const code = String(r.productCode ?? "");
    const size = String(r.sizeCode ?? "").trim();
    const fab = String(r.fabricCode ?? "").trim();
    const fk = `${so}|${code}|${size}|${fab}`;
    full.set(fk, [...(full.get(fk) ?? []), b]);
    const ck = `${so}|${code}`;
    byCode.set(ck, [...(byCode.get(ck) ?? []), b]);
  }
  const settle = (arr: Build[] | undefined): Build | null => {
    if (!arr || arr.length === 0) return null;
    const uniq = new Set(arr.map(sig));
    return uniq.size === 1 ? arr[0] : null;
  };

  const poRes = await db
    .prepare(
      `SELECT id, salesOrderId, productCode, sizeCode, fabricCode
         FROM production_orders WHERE (orgId = ? OR orgId IS NULL)`,
    )
    .bind(orgId)
    .all<Record<string, unknown>>();
  const poById = new Map<
    string,
    { so: string; code: string; size: string; fab: string }
  >();
  for (const p of poRes.results ?? []) {
    poById.set(String(p.id ?? ""), {
      so: String(p.salesOrderId ?? ""),
      code: String(p.productCode ?? ""),
      size: String(p.sizeCode ?? "").trim(),
      fab: String(p.fabricCode ?? "").trim(),
    });
  }

  type Edit = {
    id: string;
    product: string;
    qty: number;
    oldUnitRM: number;
    newUnitRM: number;
    wasZero: boolean;
    baseSen: number;
    divanSen: number;
    legSen: number;
    totalHeightSen: number;
    specialSen: number;
    discountSen: number;
  };
  const plan: Array<{
    id: string;
    invoiceNo: string;
    status: string;
    customer: string | null;
    edits: Edit[];
    deltaRM: number;
  }> = [];
  const unresolved: Array<{ invoiceNo: string; product: string; why: string }> = [];
  let leftAloneHandSet = 0;
  let alreadyCorrect = 0;

  // Two queries for the whole batch, not two PER INVOICE. The first version
  // ran 2 x 167 = 334 sequential round-trips inside one request and the worker
  // simply died — a 500 with no message, which reads like a bug in the logic
  // rather than what it was: too many trips.
  const doIds = [...new Set(invoices.map((i) => i.deliveryOrderId))];
  const invIds = invoices.map((i) => i.id);
  const [allDoRes, allLiRes] = await Promise.all([
    db
      .prepare(
        `SELECT deliveryOrderId, productionOrderId, productCode
           FROM delivery_order_items
          WHERE deliveryOrderId IN (${doIds.map(() => "?").join(",")})
          ORDER BY id`,
      )
      .bind(...doIds)
      .all<{
        deliveryOrderId: string;
        productionOrderId: string | null;
        productCode: string | null;
      }>(),
    db
      .prepare(
        `SELECT id, invoiceId, productCode, quantity, unitPriceSen, priceEdited
           FROM invoice_items
          WHERE invoiceId IN (${invIds.map(() => "?").join(",")})
          ORDER BY id`,
      )
      .bind(...invIds)
      .all<{
        id: string;
        invoiceId: string;
        productCode: string | null;
        quantity: number;
        unitPriceSen: number;
        priceEdited: number | null;
      }>(),
  ]);
  const doByOrder = new Map<string, Array<{ productionOrderId: string | null; productCode: string | null }>>();
  for (const d of allDoRes.results ?? []) {
    const k = String(d.deliveryOrderId ?? "");
    doByOrder.set(k, [...(doByOrder.get(k) ?? []), d]);
  }
  const liByInvoice = new Map<string, Array<{
    id: string;
    productCode: string | null;
    quantity: number;
    unitPriceSen: number;
    priceEdited: number | null;
  }>>();
  for (const l of allLiRes.results ?? []) {
    const k = String(l.invoiceId ?? "");
    liByInvoice.set(k, [...(liByInvoice.get(k) ?? []), l]);
  }

  for (const inv of invoices) {
    const doItems = doByOrder.get(inv.deliveryOrderId) ?? [];
    const liItems = liByInvoice.get(inv.id) ?? [];

    // Pair by PRODUCT CODE, and refuse when the pairing is ambiguous.
    //
    // The first version paired by "nth occurrence of this code", which needs a
    // reliable line order on both sides. There is none: `invoice_items` has no
    // line number, and the original `ORDER BY rowid` is a SQLite pseudo-column
    // that does not exist on Postgres at all — the endpoint 500'd the moment a
    // single invoice entered the scope.
    //
    // Ordering by `id` would have run, and been a guess: two lines of the same
    // product on one invoice can come from different sales orders at different
    // prices, and nothing says which line is which. So when a code appears more
    // than once, every delivery counterpart must resolve to the SAME build-up —
    // then the pairing cannot matter. If they disagree, those lines are
    // refused and named, exactly like a contested sales-order line.
    const pool = new Map<string, Array<{ productionOrderId: string | null }>>();
    for (const d of doItems) {
      const k = String(d.productCode ?? "");
      pool.set(k, [...(pool.get(k) ?? []), d]);
    }
    const edits: Edit[] = [];

    for (const li of liItems) {
      const code = String(li.productCode ?? "");
      const zero = (Number(li.unitPriceSen) || 0) === 0;
      const handSet = Number(li.priceEdited) === 1;
      if (handSet && !zero) {
        leftAloneHandSet++;
        continue;
      }
      const counterparts = pool.get(code) ?? [];
      if (counterparts.length === 0) {
        unresolved.push({
          invoiceNo: inv.invoiceNo,
          product: code,
          why: "no matching delivery line",
        });
        continue;
      }
      const builds: Build[] = [];
      let missingPo = false;
      for (const di of counterparts) {
        const po = poById.get(String(di.productionOrderId ?? ""));
        if (!po) {
          missingPo = true;
          break;
        }
        const one =
          settle(full.get(`${po.so}|${po.code}|${po.size}|${po.fab}`)) ??
          settle(byCode.get(`${po.so}|${po.code}`));
        if (!one) {
          missingPo = false;
          builds.length = 0;
          break;
        }
        builds.push(one);
      }
      if (missingPo) {
        unresolved.push({
          invoiceNo: inv.invoiceNo,
          product: code,
          why: "delivery line has no production order",
        });
        continue;
      }
      const b = settle(builds);
      if (!b) {
        unresolved.push({
          invoiceNo: inv.invoiceNo,
          product: code,
          why:
            builds.length > 1
              ? "same product on this invoice resolves to different prices — cannot tell which line is which"
              : "sales-order line missing or contested",
        });
        continue;
      }
      const oldUnit = Number(li.unitPriceSen) || 0;
      if (b.unit === oldUnit) {
        alreadyCorrect++;
        continue;
      }
      edits.push({
        id: li.id,
        product: code,
        qty: Number(li.quantity) || 0,
        oldUnitRM: oldUnit / 100,
        newUnitRM: b.unit / 100,
        wasZero: zero,
        baseSen: b.base,
        divanSen: b.divan,
        legSen: b.leg,
        totalHeightSen: b.totalHeight,
        specialSen: b.special,
        discountSen: b.discount,
      });
    }
    if (edits.length > 0) {
      plan.push({
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        status: inv.status,
        customer: inv.customerName,
        edits,
        deltaRM:
          Math.round(
            edits.reduce(
              (s, e) => s + (e.newUnitRM - e.oldUnitRM) * e.qty * 100,
              0,
            ),
          ) / 100,
      });
    }
  }

  const summary = {
    invoicesToEdit: plan.length,
    linesToEdit: plan.reduce((s, p) => s + p.edits.length, 0),
    zeroLinesRestored: plan.reduce(
      (s, p) => s + p.edits.filter((e) => e.wasZero).length,
      0,
    ),
    handSetLinesLeftAlone: leftAloneHandSet,
    alreadyCorrect,
    unresolvedLines: unresolved.length,
    netRM: Math.round(plan.reduce((s, p) => s + p.deltaRM, 0) * 100) / 100,
  };

  if (scope.dryRun) {
    return c.json({
      success: true,
      dryRun: true,
      appliedScope,
      summary,
      samplesTruncated: plan.length > scope.sampleLimit,
      plan: plan.slice(0, scope.sampleLimit),
      unresolved: unresolved.slice(0, scope.sampleLimit),
    });
  }

  // ---- apply, through the invoice's own edit endpoint --------------------
  const cookie = c.req.header("cookie") ?? "";
  const csrf = c.req.header("x-csrf-token") ?? "";
  const origin = new URL(c.req.url).origin;
  const applied: Array<{
    invoiceNo: string;
    ok: boolean;
    status: number;
    lines: number;
    error?: string;
  }> = [];
  const batch = plan.slice(0, limit);
  for (const p of batch) {
    const res = await fetch(`${origin}/api/invoices/${p.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        priceEdits: p.edits.map((e) => ({
          id: e.id,
          baseSen: e.baseSen,
          divanSen: e.divanSen,
          legSen: e.legSen,
          totalHeightSen: e.totalHeightSen,
          specialSen: e.specialSen,
          discountSen: e.discountSen,
          // Nothing here is a deliberate zero — the zero-restore lines are
          // exactly the ones a bug wrote 0 into. Leaving this false keeps the
          // endpoint's own zero-guard protecting the case it exists for.
          allowZero: false,
        })),
      }),
    });
    let error: string | undefined;
    if (!res.ok) {
      try {
        const j = (await res.json()) as { error?: string };
        error = j?.error;
      } catch {
        error = `HTTP ${res.status}`;
      }
    }
    applied.push({
      invoiceNo: p.invoiceNo,
      ok: res.ok,
      status: res.status,
      lines: p.edits.length,
      error,
    });
  }

  return c.json({
    success: true,
    dryRun: false,
    appliedScope,
    summary,
    // Idempotent: a second run re-derives and finds nothing left to do, so a
    // partial run is simply RE-RUN rather than resumed from a cursor.
    processed: applied.length,
    remaining: Math.max(0, plan.length - applied.length),
    ok: applied.filter((a) => a.ok).length,
    failed: applied.filter((a) => !a.ok),
    applied: applied.slice(0, scope.sampleLimit),
  });
});

export default app;

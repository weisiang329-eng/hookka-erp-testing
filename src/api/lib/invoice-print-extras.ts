// ---------------------------------------------------------------------------
// invoice-print-extras.ts — the invoice PDF's per-line enrichment, extracted
// so BOTH the GET /api/invoices/:id/print-extras endpoint AND the backend
// customer-notice email path build the SAME rich invoice (owner 2026-07-13:
// "客户收到的发票要跟我打印的一样"). Before this, the emailed invoice was
// built from a thin invoice_items projection — no order refs, no spec lines,
// no category grouping, no due date — so it looked emptier than the real one.
//
// This is a 1:1 move of the endpoint logic. Read-only; joins sales_orders /
// production_orders / delivery_order_items to resolve, per invoice line:
// category, customer PO / SO / REF / our company SO, and the price build-up.
//
// 2026-07-17 (BUG-2026-07-17-001): the order refs are now resolved by the
// invoice line's OWN production_order_id — see refByPo below. The old
// code|fabric|size maps remain only as a legacy fallback.
// ---------------------------------------------------------------------------
import { readInvoiceItemPoLink } from "./invoice-po-link";

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface InvoiceLineExtra {
  itemCategory: string | null;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  totalHeightInches: number | null;
  specialOrder: string | null;
  baseSen: number;
  divanSen: number;
  legSen: number;
  specialSen: number;
  unitSen: number;
  customerPOId?: string | null;
  customerSOLine?: string | null;
  customerRefLine?: string | null;
  companySO?: string | null;
}

export interface InvoicePrintExtras {
  customerSO: string;
  customerRef: string;
  priceByCode: Record<
    string,
    { baseSen: number; divanSen: number; legSen: number; specialSen: number; unitSen: number }
  >;
  items: Record<string, InvoiceLineExtra>;
}

/**
 * Compute the invoice's print enrichment, or null when the invoice is not
 * found. Same output shape the /print-extras endpoint returns.
 */
export async function computeInvoicePrintExtras(
  db: DbLike,
  invoiceId: string,
): Promise<InvoicePrintExtras | null> {
  const inv = await db
    .prepare("SELECT id, salesOrderId, deliveryOrderId FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<{ id: string; salesOrderId: string | null; deliveryOrderId: string | null }>();
  if (!inv) return null;

  let customerSO = "";
  if (inv.salesOrderId) {
    const so = await db
      .prepare("SELECT customerSO, customerSOId FROM sales_orders WHERE id = ?")
      .bind(inv.salesOrderId)
      .first<{ customerSO: string | null; customerSOId: string | null }>();
    customerSO = so?.customerSOId || so?.customerSO || "";
  }
  let customerRef = "";
  if (inv.deliveryOrderId) {
    const refRow = await db
      .prepare(
        `SELECT po.customerReference AS r
           FROM delivery_order_items di
           JOIN production_orders po ON po.id = di.productionOrderId
          WHERE di.deliveryOrderId = ?
            AND po.customerReference IS NOT NULL
            AND po.customerReference != ''
          LIMIT 1`,
      )
      .bind(inv.deliveryOrderId)
      .first<{ r: string | null }>();
    customerRef = refRow?.r ?? "";
  }

  const soIdSeeds = new Set<string>();
  if (inv.salesOrderId) soIdSeeds.add(inv.salesOrderId);
  if (inv.deliveryOrderId) {
    const doLines = await db
      .prepare(
        `SELECT po.salesOrderId, po.companySOId, di.salesOrderNo
           FROM delivery_order_items di
           LEFT JOIN production_orders po ON po.id = di.productionOrderId
          WHERE di.deliveryOrderId = ?`,
      )
      .bind(inv.deliveryOrderId)
      .all<{ salesOrderId: string | null; companySOId: string | null; salesOrderNo: string | null }>();
    for (const d of doLines.results ?? []) {
      if (d.salesOrderId) soIdSeeds.add(d.salesOrderId);
      if (d.companySOId) soIdSeeds.add(d.companySOId);
      if (d.salesOrderNo) soIdSeeds.add(d.salesOrderNo);
    }
  }

  const realSoIds = new Set<string>();
  type SoRef = {
    companySO: string | null;
    customerPO: string | null;
    customerSO: string | null;
    customerSOId: string | null;
    reference: string | null;
  };
  const soRefByKey = new Map<string, SoRef>();
  if (soIdSeeds.size > 0) {
    const seeds = Array.from(soIdSeeds);
    const ph = seeds.map(() => "?").join(",");
    const soRes = await db
      .prepare(
        `SELECT id, companySO, companySOId, customerPO, customerSO, customerSOId, reference
           FROM sales_orders
          WHERE id IN (${ph}) OR companySOId IN (${ph}) OR companySO IN (${ph})`,
      )
      .bind(...seeds, ...seeds, ...seeds)
      .all<{
        id: string | null;
        companySO: string | null;
        companySOId: string | null;
        customerPO: string | null;
        customerSO: string | null;
        customerSOId: string | null;
        reference: string | null;
      }>();
    for (const s of soRes.results ?? []) {
      if (s.id) realSoIds.add(s.id);
      const v: SoRef = {
        companySO: s.companySOId ?? s.companySO ?? null,
        customerPO: s.customerPO ?? null,
        customerSO: s.customerSO ?? null,
        customerSOId: s.customerSOId ?? null,
        reference: s.reference ?? null,
      };
      for (const k of [s.id, s.companySOId, s.companySO]) if (k) soRefByKey.set(k, v);
    }
  }

  const tight = new Map<string, InvoiceLineExtra>();
  const loose = new Map<string, InvoiceLineExtra>();
  const byCode = new Map<string, InvoiceLineExtra>();
  const priceByCode: InvoicePrintExtras["priceByCode"] = {};
  if (realSoIds.size > 0) {
    const ids = Array.from(realSoIds);
    const ph = ids.map(() => "?").join(",");
    const siRes = await db
      .prepare(
        `SELECT productCode, fabricCode, sizeLabel, itemCategory,
                gapInches, divanHeightInches, legHeightInches, specialOrder,
                basePriceSen, divanPriceSen, legPriceSen,
                specialOrderPriceSen, unitPriceSen
           FROM sales_order_items WHERE salesOrderId IN (${ph})`,
      )
      .bind(...ids)
      .all<{
        productCode: string | null;
        fabricCode: string | null;
        sizeLabel: string | null;
        itemCategory: string | null;
        gapInches: number | null;
        divanHeightInches: number | null;
        legHeightInches: number | null;
        specialOrder: string | null;
        basePriceSen: number;
        divanPriceSen: number;
        legPriceSen: number;
        specialOrderPriceSen: number;
        unitPriceSen: number;
      }>();
    for (const r of siRes.results ?? []) {
      const code = (r.productCode ?? "").trim();
      const fab = (r.fabricCode ?? "").trim();
      const size = (r.sizeLabel ?? "").trim();
      const g = r.gapInches ?? null;
      const d = r.divanHeightInches ?? null;
      const l = r.legHeightInches ?? null;
      const v: InvoiceLineExtra = {
        itemCategory: r.itemCategory ?? null,
        gapInches: g,
        divanHeightInches: d,
        legHeightInches: l,
        totalHeightInches:
          g == null && d == null && l == null
            ? null
            : (Number(g) || 0) + (Number(d) || 0) + (Number(l) || 0),
        specialOrder: r.specialOrder ?? null,
        baseSen: Number(r.basePriceSen) || 0,
        divanSen: Number(r.divanPriceSen) || 0,
        legSen: Number(r.legPriceSen) || 0,
        specialSen: Number(r.specialOrderPriceSen) || 0,
        unitSen: Number(r.unitPriceSen) || 0,
      };
      if (code) {
        const tk = `${code}|${fab}|${size}`;
        const lk = `${code}|${fab}`;
        if (!tight.has(tk)) tight.set(tk, v);
        if (!loose.has(lk)) loose.set(lk, v);
        if (!byCode.has(code)) byCode.set(code, v);
        if (!priceByCode[code])
          priceByCode[code] = {
            baseSen: v.baseSen,
            divanSen: v.divanSen,
            legSen: v.legSen,
            specialSen: v.specialSen,
            unitSen: v.unitSen,
          };
      }
    }
  }

  type RefVal = {
    customerPOId: string | null;
    customerSOLine: string | null;
    customerRefLine: string | null;
    companySO: string | null;
  };
  const refTight = new Map<string, RefVal>();
  const refLoose = new Map<string, RefVal>();
  const refByCode = new Map<string, RefVal>();
  // BUG-2026-07-17-001 — the EXACT map. The three maps above are keyed by
  // product code/fabric/size and built first-one-wins, which mislabels any
  // consolidated DO carrying repeated product+fabric lines from DIFFERENT SOs
  // (INV-2607-060: 4 of 12 lines cited the wrong customer PO; three SOs' POs
  // never appeared while one appeared 3×). The refs were always sourced from
  // the DO — only the KEY was a guess. Keyed by productionOrderId there is
  // nothing to guess: one DO line, one invoice line, one answer.
  const refByPo = new Map<string, RefVal>();
  if (inv.deliveryOrderId) {
    const dRefRes = await db
      .prepare(
        `SELECT di.productionOrderId, di.productCode, di.fabricCode,
                di.sizeLabel, di.salesOrderNo,
                po.customerPOId, po.customerReference,
                po.salesOrderId, po.companySOId
           FROM delivery_order_items di
           LEFT JOIN production_orders po ON po.id = di.productionOrderId
          WHERE di.deliveryOrderId = ?`,
      )
      .bind(inv.deliveryOrderId)
      .all<{
        productionOrderId: string | null;
        productCode: string | null;
        fabricCode: string | null;
        sizeLabel: string | null;
        salesOrderNo: string | null;
        customerPOId: string | null;
        customerReference: string | null;
        salesOrderId: string | null;
        companySOId: string | null;
      }>();
    for (const d of dRefRes.results ?? []) {
      const so =
        soRefByKey.get(d.salesOrderId || "") ||
        soRefByKey.get(d.companySOId || "") ||
        soRefByKey.get(d.salesOrderNo || "");
      const rv: RefVal = {
        customerPOId: d.customerPOId || so?.customerPO || null,
        customerSOLine: so?.customerSOId || so?.customerSO || null,
        customerRefLine: d.customerReference || so?.reference || null,
        companySO: so?.companySO || d.companySOId || d.salesOrderNo || null,
      };
      // Exact, per-line. No first-one-wins: each DO line has its own entry.
      if (d.productionOrderId) refByPo.set(d.productionOrderId, rv);
      const code = (d.productCode ?? "").trim();
      const fab = (d.fabricCode ?? "").trim();
      const size = (d.sizeLabel ?? "").trim();
      if (code) {
        const tk = `${code}|${fab}|${size}`;
        const lk = `${code}|${fab}`;
        if (!refTight.has(tk)) refTight.set(tk, rv);
        if (!refLoose.has(lk)) refLoose.set(lk, rv);
        if (!refByCode.has(code)) refByCode.set(code, rv);
      }
    }
  }

  const items: Record<string, InvoiceLineExtra> = {};
  const invItemsRes = await db
    .prepare(
      `SELECT id, productCode, fabricCode, sizeLabel,
              basePriceSen, divanPriceSen, legPriceSen,
              specialOrderPriceSen, priceEdited, production_order_id
         FROM invoice_items WHERE invoiceId = ?`,
    )
    .bind(invoiceId)
    .all<{
      id: string;
      productCode: string | null;
      fabricCode: string | null;
      sizeLabel: string | null;
      basePriceSen: number | null;
      divanPriceSen: number | null;
      legPriceSen: number | null;
      specialOrderPriceSen: number | null;
      priceEdited: number | null;
    }>();
  for (const r of invItemsRes.results ?? []) {
    const code = (r.productCode ?? "").trim();
    const fab = (r.fabricCode ?? "").trim();
    const size = (r.sizeLabel ?? "").trim();
    const v =
      tight.get(`${code}|${fab}|${size}`) || loose.get(`${code}|${fab}`) || byCode.get(code);
    // BUG-2026-07-17-001 — prefer the EXACT link the invoice now carries. The
    // code-keyed maps below stay ONLY as the fallback for legacy rows written
    // before invoice_items.production_order_id existed (and for the
    // bill-the-SO-lines fallback path, which has no DO line behind it). Once
    // those are backfilled this fallback should never fire.
    const poLink = readInvoiceItemPoLink(r as unknown as Record<string, unknown>);
    const rf =
      (poLink ? refByPo.get(poLink) : undefined) ||
      refTight.get(`${code}|${fab}|${size}`) ||
      refLoose.get(`${code}|${fab}`) ||
      refByCode.get(code);
    if (!r.id) continue;
    const edited = Number(r.priceEdited) === 1;
    const invBase = Number(r.basePriceSen) || 0;
    const invDivan = Number(r.divanPriceSen) || 0;
    const invLeg = Number(r.legPriceSen) || 0;
    const invSpecial = Number(r.specialOrderPriceSen) || 0;
    if (v || rf || edited) {
      items[r.id] = {
        itemCategory: v?.itemCategory ?? null,
        gapInches: v?.gapInches ?? null,
        divanHeightInches: v?.divanHeightInches ?? null,
        legHeightInches: v?.legHeightInches ?? null,
        totalHeightInches: v?.totalHeightInches ?? null,
        specialOrder: v?.specialOrder ?? null,
        baseSen: edited ? invBase : (v?.baseSen ?? 0),
        divanSen: edited ? invDivan : (v?.divanSen ?? 0),
        legSen: edited ? invLeg : (v?.legSen ?? 0),
        specialSen: edited ? invSpecial : (v?.specialSen ?? 0),
        unitSen: edited ? invBase + invDivan + invLeg + invSpecial : (v?.unitSen ?? 0),
        customerPOId: rf?.customerPOId ?? null,
        customerSOLine: rf?.customerSOLine ?? null,
        customerRefLine: rf?.customerRefLine ?? null,
        companySO: rf?.companySO ?? null,
      };
    }
  }

  return { customerSO, customerRef, priceByCode, items };
}

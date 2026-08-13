// ---------------------------------------------------------------------------
// Sofa combo pass + line base-price resolution — shared by Sales Orders AND
// Consignment Orders (owner 2026-06-11: "CO 处理方式要跟 SO 完全一样").
//
// runSofaComboPass(): renegotiates matched sofa sets down to their combo total
// right before the subtotal is summed. Idempotent (a group whose sum is not
// MORE than the combo total is left alone), best-effort (any failure leaves
// prices exactly as resolved — never blocks the save).
//
// resolveLineBasePriceSen(): the per-line base price chain used where a line
// needs (re-)pricing — customer seat-height price → customer base → product
// seat-height price → product base → 0. SOFA lines are force-re-derived on
// every edit so a combo-split base can't stick once the set is broken.
// ---------------------------------------------------------------------------
import {
  applySofaCombos,
  type ComboLineInput,
  type ComboRuleInput,
  type SofaTier,
} from "./sofa-combo";
import {
  calculateUnitPrice,
  calculateLineTotalWithDiscount,
} from "../../lib/pricing";
import { resolveCustomerPriceAsOf } from "../routes/customer-products";

export type ComboPassItem = {
  id: string;
  productId: string | null;
  productCode: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  basePriceSen: number;
  divanPriceSen: number;
  legPriceSen: number;
  // BUG-CLASS C1 (2026-08-13). Both callers — the SO and the CO write paths —
  // carry a FIFTH price component, and this pass used to recompute the unit
  // price from only four of them. Every line whose base the combo renegotiated
  // therefore had its total-height surcharge silently deleted from the stored
  // unit price. Optional because the type predates the column; `?? 0` at every
  // use, never a re-derivation (a component we were not given is not a price
  // of zero to invent — it is simply absent from this line).
  totalHeightPriceSen?: number;
  // Same shape, other direction: the recompute below used to overwrite
  // lineTotalSen with a bare unit × qty, dropping the per-line discount the
  // caller had already subtracted — so a renegotiated sofa line stored MORE
  // than the operator approved. The frontend's own combo preview
  // (sales/create.tsx) feeds `getLineTotal`, i.e. discount included, so this
  // is also what makes the screen and the save agree.
  discountSen?: number;
  specialOrderPriceSen: number;
  unitPriceSen: number;
  lineTotalSen: number;
};

const isNumericSize = (s: unknown): s is string =>
  typeof s === "string" && /^\d+(\.\d+)?$/.test(s);

/** Seat height for per-seat pricing: create-page payloads carry seatHeight;
 *  edit/stored/scan payloads carry the bare seat size in sizeCode/sizeLabel. */
export function seatHeightOf(
  raw: Record<string, unknown> | undefined,
  sizeCode: string | null | undefined,
  sizeLabel: string | null | undefined,
): string {
  if (raw && isNumericSize(raw.seatHeight)) return raw.seatHeight;
  if (isNumericSize(sizeCode ?? undefined)) return sizeCode as string;
  if (isNumericSize(sizeLabel ?? undefined)) return sizeLabel as string;
  return "";
}

/** Customer seat/base → product seat/base → fallbackSen. Never throws. */
export async function resolveLineBasePriceSen(
  db: D1Database,
  opts: {
    productId: string | null | undefined;
    customerId: string | null | undefined;
    asOf: string;
    seatHeight: string;
    fallbackSen: number;
  },
): Promise<number> {
  const { productId, customerId, asOf, seatHeight, fallbackSen } = opts;
  if (!productId) return fallbackSen;
  try {
    if (customerId) {
      const cp = await resolveCustomerPriceAsOf(db, productId, customerId, asOf);
      if (cp) {
        if (cp.seatHeightPrices && cp.seatHeightPrices.length > 0 && seatHeight) {
          const shp = cp.seatHeightPrices.find(
            (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
          );
          if (shp?.priceSen) return shp.priceSen;
        }
        if (cp.basePriceSen) return cp.basePriceSen;
      }
    }
    // SELECT * — the d1-compat adapter doesn't translate explicit camelCase
    // projections (BUG-2026-06-10-001).
    const prod = await db
      .prepare("SELECT * FROM products WHERE id = ?")
      .bind(productId)
      .first<{ basePriceSen: number | null; seatHeightPrices: unknown }>();
    if (prod) {
      let shp: Array<{ height: string; priceSen: number }> = [];
      if (Array.isArray(prod.seatHeightPrices)) {
        shp = prod.seatHeightPrices as typeof shp;
      } else if (typeof prod.seatHeightPrices === "string") {
        try {
          shp = JSON.parse(prod.seatHeightPrices || "[]");
        } catch {
          shp = [];
        }
      }
      if (seatHeight && shp.length > 0) {
        const cell = shp.find(
          (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
        );
        if (cell?.priceSen) return cell.priceSen;
      }
      if (Number(prod.basePriceSen)) return Number(prod.basePriceSen);
    }
  } catch {
    /* fall through */
  }
  return fallbackSen;
}

export async function runSofaComboPass(
  db: D1Database,
  customerId: string,
  items: ComboPassItem[],
  rawItems: Array<Record<string, unknown>>,
): Promise<void> {
  try {
    const sofa = items.filter((i) => (i.itemCategory ?? "") === "SOFA");
    if (sofa.length < 2) return; // a combo needs at least two pieces
    // baseModel per product — authoritative from the catalog (the client copy
    // is only a fallback; scan-PO / edit payloads don't carry it).
    const prodIds = [...new Set(sofa.map((i) => i.productId).filter((x): x is string => !!x))];
    const baseModelByProd = new Map<string, string>();
    if (prodIds.length > 0) {
      const ph = prodIds.map(() => "?").join(",");
      const res = await db
        .prepare(`SELECT * FROM products WHERE id IN (${ph})`)
        .bind(...prodIds)
        .all<{ id: string; baseModel: string | null }>();
      for (const r of res.results ?? [])
        if (r.id) baseModelByProd.set(r.id, r.baseModel ?? "");
    }
    // Fabric tier — sofaPriceTier ?? priceTier ?? null. A null (untracked
    // fabric) disqualifies the whole group, exactly like the create page.
    const fabs = [...new Set(sofa.map((i) => i.fabricCode).filter((x): x is string => !!x))];
    const tierByFab = new Map<string, SofaTier | null>();
    if (fabs.length > 0) {
      const ph = fabs.map(() => "?").join(",");
      const res = await db
        .prepare(`SELECT * FROM fabric_trackings WHERE fabricCode IN (${ph})`)
        .bind(...fabs)
        .all<{
          fabricCode: string;
          sofaPriceTier: SofaTier | null;
          priceTier: SofaTier | null;
        }>();
      for (const r of res.results ?? [])
        tierByFab.set(r.fabricCode, r.sofaPriceTier ?? r.priceTier ?? null);
    }
    // Applicable rules: ALL of this customer's + company-wide, effective today
    // (UTC — same clock the create page used). The helper picks the best.
    const todayDateStr = new Date().toISOString().slice(0, 10);
    const rulesRes = await db
      .prepare(
        "SELECT * FROM sofa_combo_rules WHERE (customerId = ? OR customerId IS NULL) AND effectiveFrom <= ?",
      )
      .bind(customerId, todayDateStr)
      .all<{
        baseModel: string;
        componentSizes: string;
        fabricTier: "ANY" | SofaTier;
        pricesByHeight: string;
        customerId: string | null;
        effectiveFrom: string;
      }>();
    const rules: ComboRuleInput[] = [];
    for (const r of rulesRes.results ?? []) {
      try {
        rules.push({
          baseModel: String(r.baseModel ?? ""),
          componentSizes: JSON.parse(r.componentSizes || "[]"),
          fabricTier: r.fabricTier,
          pricesByHeight: JSON.parse(r.pricesByHeight || "{}"),
          customerId: r.customerId ?? null,
          effectiveFrom: r.effectiveFrom,
        });
      } catch {
        /* skip a malformed rule row */
      }
    }
    if (rules.length === 0) return;
    const lines: ComboLineInput[] = items.map((it, idx) => {
      const raw = rawItems[idx] ?? {};
      const code = it.productCode ?? "";
      const baseModel =
        (it.productId ? baseModelByProd.get(it.productId) : "") ||
        String(raw.baseModel ?? "");
      // Rule componentSizes match PIECE codes ("2A(LHF)"). The create page
      // sends the piece in sizeCode, but scan-PO / stored rows carry the SEAT
      // size there — derive the piece from productCode ("{baseModel}-{piece}").
      const piece =
        baseModel && code.startsWith(`${baseModel}-`)
          ? code.slice(baseModel.length + 1)
          : (it.sizeCode ?? "");
      const seatHeight = seatHeightOf(raw, it.sizeCode, it.sizeLabel);
      return {
        key: it.id,
        itemCategory: it.itemCategory ?? "",
        baseModel,
        sizeCode: piece,
        seatHeight,
        fabricCode: it.fabricCode ?? "",
        fabricTier: it.fabricCode ? (tierByFab.get(it.fabricCode) ?? null) : null,
        basePriceSen: it.basePriceSen,
        divanPriceSen: it.divanPriceSen,
        legPriceSen: it.legPriceSen,
        // Was a hardcoded 0. It feeds `surchargesPerUnitSen` in
        // distributeComboUnitPrices, so a zero here hands the surcharge's worth
        // of the agreed combo total to the BASE price — the set still totals
        // right, but each line's build-up stops adding up.
        totalHeightPriceSen: it.totalHeightPriceSen ?? 0,
        specialOrderPriceSen: it.specialOrderPriceSen,
        quantity: it.quantity,
      };
    });
    const result = applySofaCombos(lines, rules, { customerId, todayDateStr });
    if (result.newBaseByKey.size === 0) return;
    for (const it of items) {
      const nb = result.newBaseByKey.get(it.id);
      if (typeof nb !== "number") continue;
      it.basePriceSen = nb;
      // EVERY component, and the discount. This one statement is the whole of
      // BUG-CLASS C1 in miniature: the sum has to name all five parts, and the
      // line total has to keep the subtraction its caller already made.
      it.unitPriceSen = calculateUnitPrice({
        basePriceSen: nb,
        divanPriceSen: it.divanPriceSen,
        legPriceSen: it.legPriceSen,
        totalHeightPriceSen: it.totalHeightPriceSen ?? 0,
        specialOrderPriceSen: it.specialOrderPriceSen,
      });
      it.lineTotalSen = calculateLineTotalWithDiscount(
        it.unitPriceSen,
        it.quantity,
        it.discountSen ?? 0,
      );
    }
  } catch (e) {
    console.warn("[sofa-combo-pass] skipped:", e);
  }
}

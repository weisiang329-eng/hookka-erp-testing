// ---------------------------------------------------------------------------
// Migrate BF Master Tracker + SF Master Tracker → sales_orders (+ cascade to
// production_orders + job_cards via /api/sales-orders/:id/confirm).
//
// Headers on sheet row 11 (0-based 10). Data starts row 12.
//
// Mapping:
//   Customer Name "Houzs XX"  → Houzs Century + delivery hub by state (KL/PG/SRW/SBH)
//   Customer Name "Carress"   → Carress       + default hub
//   Customer Name "The Conts" → The Conts     + default hub
//   PRODUCT CODE              → D1 products.code via normalize (strip spaces/dashes, uppercase)
//   BF MODEL (5FT/6FT/Q/K/S/SS/SK/SP) → sizeCode disambiguator (BF D1 codes have trailing `(Q/5FT)` etc.)
//   SF PRODUCT CODE (can be "5535-2A(LHF), 5535-1NA, 5535-CNR") → split on comma, each = 1 line
//
// Grouping for SO: (customerId + customerPO + companySO-without-line-suffix).
// Each row with matching `Customer PO` and `Company SO` base (stripped `-NN`)
// becomes one SO with N line items.
//
// Idempotency: before creating, check GET /api/sales-orders for existing
// (customerId + customerPO). Skip if found.
//
// Run: npx tsx scripts/migrate-orders-from-trackers.ts
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
 
const xl = require("xlsx") as typeof import("xlsx");

const SHEET = "C:/Users/User/Downloads/Production Sheet (9).xlsx";
const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";
// BF uses sheet row 11 (0-indexed 10) as the header row.
// SF has a double header: row 10 (0-indexed 9) has the SF-specific labels
//   (Gap/Divan/Size) while row 11 (0-indexed 10) is an alias header with
//   BF-compatible labels ("Blank"/"Sofa Size"). We need row 10 to find the
//   SF-specific columns. Data for both starts at row 12 (0-indexed 11).
const HEADER_ROW_IDX = 10;
const SF_HEADER_ROW_IDX = 9;
const DATA_START_IDX = 11;

// Customer name alias → D1 customer + state preference
// These sheet names map to ONE D1 customer (Houzs Century) with different hubs.
const CUSTOMER_MAP: Record<string, { d1Name: string; state: string }> = {
  "Houzs KL": { d1Name: "Houzs Century", state: "KL" },
  "Houzs PG": { d1Name: "Houzs Century", state: "PG" },
  "Houzs SRW": { d1Name: "Houzs Century", state: "SRW" },
  "Houzs SBH": { d1Name: "Houzs Century", state: "SBH" },
  Carress: { d1Name: "Carress", state: "KL" },
  "The Conts": { d1Name: "The Conts", state: "KL" },
};

// BF MODEL label → sizeCode used on D1 products
const BF_MODEL_TO_SIZE: Record<string, string> = {
  "5FT": "Q",
  "6FT": "K",
  "3FT": "S",
  "3.5FT": "SS",
  K: "K",
  Q: "Q",
  S: "S",
  SS: "SS",
  SK: "SK",
  SP: "SP",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}
function n(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}
function senFromRM(v: unknown): number {
  const x = n(v);
  return Math.round(x * 100);
}
function str(v: unknown): string {
  return (v == null ? "" : String(v)).trim();
}
function excelDateToIso(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return s;
}

async function login(): Promise<string> {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("login failed");
  return j.data.token;
}

type Customer = {
  id: string;
  code: string;
  name: string;
  deliveryHubs: Array<{ id: string; code: string; shortName: string; state: string; isDefault: boolean }>;
};
type Product = {
  id: string;
  code: string;
  name: string;
  category: string;
  sizeCode: string;
  sizeLabel: string;
  basePriceSen?: number;
};

async function getJson<T>(token: string, path: string): Promise<T> {
  const r = await fetch(`${PROD}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return (await r.json()) as T;
}
async function postJson<T>(token: string, path: string, body: unknown): Promise<{ ok: boolean; status: number; j: T }> {
  const r = await fetch(`${PROD}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let j: T;
  try { j = (await r.json()) as T; } catch { j = {} as T; }
  return { ok: r.ok, status: r.status, j };
}

// ---------------------------------------------------------------------------
// Load sheet rows
// We preserve raw cell access via `__raw[i]` so the mapper can read by column
// index regardless of misleading header labels (BF: col17=gap, col18=divan
// despite header labels being "Blank(Dont use for sofa)" / "Sofa Size").
// ---------------------------------------------------------------------------
type TrackerRow = Record<string, unknown> & { _row: number; __raw: unknown[] };
function loadRows(tab: string): TrackerRow[] {
  const wb = xl.readFile(SHEET);
  const ws = wb.Sheets[tab];
  if (!ws) throw new Error(`tab ${tab} not found`);
  const aoa = xl.utils.sheet_to_json<unknown[]>(ws, { defval: "", header: 1, raw: true });
  const header = aoa[HEADER_ROW_IDX] as unknown[];
  const rows: TrackerRow[] = [];
  for (let r = DATA_START_IDX; r < aoa.length; r++) {
    const raw = (aoa[r] || []) as unknown[];
    if (!raw.some((v, i) => i < 36 && str(v) !== "")) continue;
    // Require customer PO AND product code
    if (str(raw[0]) === "" || str(raw[12]) === "") continue;
    const o: TrackerRow = { _row: r + 1, __raw: raw };
    header.forEach((h, i) => { if (h) (o as Record<string, unknown>)[String(h)] = raw[i]; });
    rows.push(o);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
type Failure = {
  row: number;
  tab: string;
  customerPO: string;
  productCode: string;
  customer: string;
  reason: string;
};

async function main() {
  console.log("=== Migration start ===");
  const token = await login();
  console.log("Logged in.");

  // Fetch customers + products + existing SOs
  const custsRes = await getJson<{ data: Customer[] }>(token, "/api/customers");
  const prodsRes = await getJson<{ data: Product[] }>(token, "/api/products");
  const sosRes = await getJson<{ data: Array<{ id: string; customerPO: string; customerId: string; companySOId: string | null }> }>(token, "/api/sales-orders");

  const customersByName = new Map<string, Customer>();
  for (const c of custsRes.data) customersByName.set(c.name.toLowerCase(), c);

  const productsByNorm = new Map<string, Product[]>();
  for (const p of prodsRes.data) {
    const k = normalizeCode(p.code);
    if (!productsByNorm.has(k)) productsByNorm.set(k, []);
    productsByNorm.get(k)!.push(p);
  }
  // Also index by sizeless prefix for BF multi-size resolution
  function stripTrailingSizeParen(code: string): string {
    return code.replace(/\([^()]*[/][^()]*\)$/g, "");
  }
  const productsByPrefix = new Map<string, Product[]>();
  for (const p of prodsRes.data) {
    const k = normalizeCode(stripTrailingSizeParen(p.code));
    if (!productsByPrefix.has(k)) productsByPrefix.set(k, []);
    productsByPrefix.get(k)!.push(p);
  }

  // Existing SOs indexed by (customerId, customerPO)
  const existingByKey = new Set<string>();
  for (const so of sosRes.data) {
    existingByKey.add(`${so.customerId}|${so.customerPO}`);
  }
  console.log(`D1 customers: ${custsRes.data.length}, products: ${prodsRes.data.length}, existing SOs: ${sosRes.data.length}`);

  // ---------------------------------------------------------------------------
  // Phase 2 — ensure all tracker customer names are resolvable
  // ---------------------------------------------------------------------------
  const bfRows = loadRows("BF Master Tracker");
  const sfRows = loadRows("SF Master Tracker");
  console.log(`Sheet rows: BF=${bfRows.length} SF=${sfRows.length}`);

  const trackerCustomers = new Set<string>();
  [...bfRows, ...sfRows].forEach((r) => {
    const n = str(r["Customer Name"]);
    if (n) trackerCustomers.add(n);
  });

  const customersCreated: string[] = [];
  for (const name of trackerCustomers) {
    const alias = CUSTOMER_MAP[name];
    const d1Name = alias?.d1Name ?? name;
    if (customersByName.has(d1Name.toLowerCase())) continue;
    // Create with minimal fields
    const payload = {
      code: `300-${d1Name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3)}`,
      name: d1Name,
    };
    const res = await postJson<{ success: boolean; data: Customer; error?: string }>(
      token, "/api/customers", payload,
    );
    if (res.ok && res.j.success) {
      customersByName.set(d1Name.toLowerCase(), res.j.data);
      customersCreated.push(d1Name);
      console.log(`Created customer: ${d1Name}`);
    } else {
      console.log(`FAILED to create customer ${d1Name}: ${res.status} ${JSON.stringify(res.j)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — build SO groups and post
  // ---------------------------------------------------------------------------
  type LineItem = {
    row: number;
    tab: "BF" | "SF";
    raw: Record<string, unknown>;
    product: Product;
    lineRaw: {
      productCode: string;
      productId: string;
      productName: string;
      itemCategory: string;
      sizeCode: string;
      sizeLabel: string;
      fabricCode: string;
      quantity: number;
      divanHeightInches: number | null;
      legHeightInches: number | null;
      gapInches: number | null;
      specialOrder: string;
      basePriceSen: number;
      divanPriceSen: number;
      legPriceSen: number;
      specialOrderPriceSen: number;
      notes: string;
    };
  };

  type SOGroup = {
    tab: "BF" | "SF";
    customerName: string;        // sheet name (e.g. "Houzs PG")
    customerId: string;
    hubId: string | null;
    hubState: string;
    customerPO: string;
    customerPOId: string;
    customerPODate: string;
    customerSO: string;
    customerSOId: string;
    reference: string;
    companySO: string;
    companySOId: string;         // base (no -NN line suffix) — purely informational; D1 re-generates
    companySODate: string;
    customerDeliveryDate: string;
    hookkaExpectedDD: string;
    hookkaDeliveryOrder: string;
    notes: string;
    items: LineItem[];
  };

  const groups = new Map<string, SOGroup>();
  const failures: Failure[] = [];

  function makeBFLineItem(r: TrackerRow): LineItem | null {
    const code = str(r["PRODUCT CODE"]);
    const model = str(r["MODEL"]).toUpperCase();
    let candidates = productsByNorm.get(normalizeCode(code));
    if (!candidates || candidates.length === 0) {
      // Fall back to sizeless prefix match
      const stripped = normalizeCode(code.replace(/\([^()]*[/][^()]*\)$/g, ""));
      candidates = productsByPrefix.get(stripped) || [];
    }
    let product: Product | undefined;
    if (candidates.length === 1) product = candidates[0];
    else if (candidates.length > 1) {
      const sizeCode = BF_MODEL_TO_SIZE[model] || "";
      product = candidates.find((p) => p.sizeCode === sizeCode) || candidates[0];
    }
    if (!product) {
      failures.push({ row: r._row, tab: "BF", customerPO: str(r["Customer PO"]), productCode: code, customer: str(r["Customer Name"]), reason: `No product match (MODEL=${model})` });
      return null;
    }
    // BF col mapping — use INDEX, not label, because BF header labels are misleading:
    //   col 17 labeled "Blank(Dont use for sofa)" is actually GAP (inches) — values 10/12/14
    //   col 18 labeled "Sofa Size" is actually DIVAN height (inches) — typically 8
    //   col 20 labeled "Leg (inches)" — leg height
    const gapIn = n(r.__raw[17]);
    const divanIn = n(r.__raw[18]);
    const legIn = n(r.__raw[20]);
    const basePrice = senFromRM(r["Base Price"]);
    const divanPriceSen = senFromRM(r["Divan Price"]);
    const legPriceSen = senFromRM(r["Leg Price"]);
    const specialPriceSen = senFromRM(r["Special Order Price"]);
    const quantity = 1; // tracker rows are per-unit; one row = one unit
    return {
      row: r._row,
      tab: "BF",
      raw: r,
      product,
      lineRaw: {
        productCode: product.code,
        productId: product.id,
        productName: product.name,
        itemCategory: "BEDFRAME",
        sizeCode: product.sizeCode || "",
        sizeLabel: product.sizeLabel || model || "",
        fabricCode: str(r["Fabric Code"]),
        quantity,
        divanHeightInches: divanIn > 0 ? divanIn : null,
        legHeightInches: legIn > 0 ? legIn : null,
        gapInches: gapIn > 0 ? gapIn : null,
        specialOrder: str(r["Special Order"]),
        basePriceSen: basePrice,
        divanPriceSen,
        legPriceSen,
        specialOrderPriceSen: specialPriceSen,
        notes: str(r["Notes"]),
      },
    };
  }

  function makeSFLineItems(r: TrackerRow): LineItem[] {
    const code = str(r["PRODUCT CODE"]);
    // Split on comma OR newline — some rows use multi-line product code cells.
    const parts = code.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) {
      failures.push({ row: r._row, tab: "SF", customerPO: str(r["Customer PO"]), productCode: code, customer: str(r["Customer Name"]), reason: "Empty product code" });
      return [];
    }
    // SF row-level fields:
    //   col 13 = Item Category (SOFA | ACCESSORIES)
    //   col 15 = Fabric Code — applies to ALL modules on the row
    //   col 16 = Base Price (sheet RM value for the whole set/line)
    //   col 18 = Sofa Size (seat depth, inches) — SOFA only; blank for accessories
    //            NOTE: SF header row 9 labels this "Divan (inches)" but data
    //            shows it's actually seat depth (28/30/32 etc). The task spec
    //            defines col S as "Sofa Size".
    //   col 17 / col 20 are effectively unused for SF (always blank) — SF
    //            tracker does not populate gap/leg for sofas in this sheet.
    const rowCat = str(r["Item Category"]).toUpperCase() || "SOFA";
    const isSofa = rowCat === "SOFA";
    const basePrice = senFromRM(r["Base Price"]);
    const sofaSizeRaw = str(r.__raw[18]);
    const sofaSizeNum = n(r.__raw[18]);
    const rowSizeCode = isSofa && sofaSizeNum > 0 ? String(sofaSizeNum) : "";
    const rowSizeLabel = rowSizeCode ? `${rowSizeCode}"` : "";
    const gapIn = n(r.__raw[17]);
    const legIn = n(r.__raw[20]);
    const divanPriceSen = senFromRM(r["Divan Price"]);
    const legPriceSen = senFromRM(r["Leg Price"]);
    const specialPriceSen = senFromRM(r["Special Order Price"]);
    const fabricCode = str(r["Fabric Code"]);
    const notes = str(r["Notes"]);
    const specialOrder = str(r["Special Order"]);
    void sofaSizeRaw;

    const out: LineItem[] = [];
    for (let idx = 0; idx < parts.length; idx++) {
      const p = parts[idx];
      const cand = productsByNorm.get(normalizeCode(p));
      let prod: Product | undefined = cand && cand.length > 0 ? cand[0] : undefined;
      if (!prod) {
        // Try fuzzy: find any product whose normalized code === normalized part
        const targetNorm = normalizeCode(p);
        for (const prodCand of productsByNorm.values()) {
          for (const x of prodCand) {
            if (normalizeCode(x.code) === targetNorm) { prod = x; break; }
          }
          if (prod) break;
        }
      }
      if (!prod) {
        failures.push({ row: r._row, tab: "SF", customerPO: str(r["Customer PO"]), productCode: p, customer: str(r["Customer Name"]), reason: "No SF product match" });
        continue;
      }
      // Per-module line:
      //   - sizeCode / sizeLabel come from the ROW's Sofa Size (for SOFA rows).
      //     This is the seat depth that applies to the whole set — each
      //     module inherits it. Accessories (pillows) keep their own size
      //     label from the product (e.g. "12\" X 28\"").
      //   - fabricCode comes from the ROW (single fabric per set).
      //   - unitPriceSen prefers product.basePriceSen when the product has
      //     one; otherwise the row's total Base Price lands on the FIRST
      //     module line (idx 0) with 0 on subsequent modules — the sheet only
      //     gives a single total per row, so this preserves the total while
      //     keeping sums correct.
      const productUnitPrice = typeof prod.basePriceSen === "number" ? prod.basePriceSen : 0;
      const linePriceSen = productUnitPrice > 0
        ? productUnitPrice
        : (idx === 0 ? basePrice : 0);
      const lineSizeCode = isSofa ? (rowSizeCode || prod.sizeCode || "") : (prod.sizeCode || "");
      const lineSizeLabel = isSofa
        ? (rowSizeLabel || prod.sizeLabel || "")
        : (prod.sizeLabel || "");
      out.push({
        row: r._row,
        tab: "SF",
        raw: r,
        product: prod,
        lineRaw: {
          productCode: prod.code,
          productId: prod.id,
          productName: prod.name,
          itemCategory: prod.category || rowCat,
          sizeCode: lineSizeCode,
          sizeLabel: lineSizeLabel,
          fabricCode,
          quantity: 1,
          // SF tracker doesn't populate divan/gap/leg for sofas in this sheet;
          // keep optional fields null unless explicitly numeric in the row.
          divanHeightInches: null,
          legHeightInches: legIn > 0 ? legIn : null,
          gapInches: gapIn > 0 ? gapIn : null,
          specialOrder,
          basePriceSen: linePriceSen,
          // Row-level adders go on the first module only (they describe the
          // whole set, not each piece).
          divanPriceSen: idx === 0 ? divanPriceSen : 0,
          legPriceSen: idx === 0 ? legPriceSen : 0,
          specialOrderPriceSen: idx === 0 ? specialPriceSen : 0,
          notes,
        },
      });
    }
    return out;
  }

  function buildGroupKey(row: Record<string, unknown>, custId: string): string | null {
    const customerPO = str(row["Customer PO"]);
    if (!customerPO) return null;
    return `${custId}|${customerPO}`;
  }

  function addRowToGroups(tab: "BF" | "SF", row: TrackerRow, items: LineItem[]) {
    if (items.length === 0) return;
    const sheetCustName = str(row["Customer Name"]);
    const alias = CUSTOMER_MAP[sheetCustName];
    const d1Name = alias?.d1Name ?? sheetCustName;
    const cust = customersByName.get(d1Name.toLowerCase());
    if (!cust) {
      failures.push({
        row: row._row, tab, customerPO: str(row["Customer PO"]),
        productCode: items[0]?.lineRaw.productCode ?? "", customer: sheetCustName,
        reason: `Customer ${d1Name} not in D1`,
      });
      return;
    }
    const preferredState = alias?.state ?? str(row["Customer State"]) ?? "";
    const hub =
      (preferredState && cust.deliveryHubs.find((h) => h.state === preferredState)) ||
      cust.deliveryHubs.find((h) => h.isDefault) ||
      cust.deliveryHubs[0] ||
      null;

    const key = buildGroupKey(row, cust.id)!;
    let grp = groups.get(key);
    if (!grp) {
      grp = {
        tab,
        customerName: sheetCustName,
        customerId: cust.id,
        hubId: hub?.id ?? null,
        hubState: preferredState || hub?.state || "",
        customerPO: str(row["Customer PO"]),
        customerPOId: str(row["Customer PO ID"]) || str(row["Customer PO"]),
        customerPODate: excelDateToIso(row["Customer PO Date"]),
        customerSO: str(row["Customer SO"]),
        customerSOId: str(row["Customer SO ID"]),
        reference: str(row["Reference"]),
        companySO: str(row["Company SO"]),
        companySOId: str(row["Company SO ID"]) || str(row["Company SO"]),
        companySODate: excelDateToIso(row["Company SO Date"]),
        customerDeliveryDate: excelDateToIso(row["Customer Delivery Date"]),
        hookkaExpectedDD: excelDateToIso(row["Hookka Expected DD"]),
        hookkaDeliveryOrder: str(row["Hookka Delivery Order"]),
        notes: str(row["Notes"]),
        items: [],
      };
      groups.set(key, grp);
    }
    for (const it of items) grp.items.push(it);
  }

  for (const r of bfRows) {
    const item = makeBFLineItem(r);
    if (item) addRowToGroups("BF", r, [item]);
  }
  for (const r of sfRows) {
    const items = makeSFLineItems(r);
    if (items.length > 0) addRowToGroups("SF", r, items);
  }

  console.log(`\nBuilt ${groups.size} SO groups. Row failures so far: ${failures.length}`);

  // Actually post each group
  let created = 0;
  let skipped = 0;
  let confirmed = 0;
  let poCreated = 0;
  let soPostFail = 0;
  let confirmFail = 0;

  let i = 0;
  for (const grp of groups.values()) {
    i++;
    const idempotencyKey = `${grp.customerId}|${grp.customerPO}`;
    if (existingByKey.has(idempotencyKey)) {
      skipped++;
      continue;
    }
    const payload = {
      customerId: grp.customerId,
      customerPO: grp.customerPO,
      customerPOId: grp.customerPOId,
      customerPODate: grp.customerPODate,
      customerSO: grp.customerSO,
      customerSOId: grp.customerSOId,
      reference: grp.reference,
      hubId: grp.hubId,
      customerState: grp.hubState,
      companySO: grp.companySO,
      companySODate: grp.companySODate,
      customerDeliveryDate: grp.customerDeliveryDate,
      hookkaExpectedDD: grp.hookkaExpectedDD,
      hookkaDeliveryOrder: grp.hookkaDeliveryOrder,
      notes: grp.notes,
      items: grp.items.map((it) => ({
        productId: it.lineRaw.productId,
        productCode: it.lineRaw.productCode,
        productName: it.lineRaw.productName,
        itemCategory: it.lineRaw.itemCategory,
        sizeCode: it.lineRaw.sizeCode,
        sizeLabel: it.lineRaw.sizeLabel,
        fabricCode: it.lineRaw.fabricCode,
        quantity: it.lineRaw.quantity,
        divanHeightInches: it.lineRaw.divanHeightInches,
        legHeightInches: it.lineRaw.legHeightInches,
        gapInches: it.lineRaw.gapInches,
        specialOrder: it.lineRaw.specialOrder,
        basePriceSen: it.lineRaw.basePriceSen,
        divanPriceSen: it.lineRaw.divanPriceSen,
        legPriceSen: it.lineRaw.legPriceSen,
        specialOrderPriceSen: it.lineRaw.specialOrderPriceSen,
        notes: it.lineRaw.notes,
      })),
    };
    const res = await postJson<{ success: boolean; data?: { id: string; companySOId: string }; error?: string }>(
      token, "/api/sales-orders", payload,
    );
    if (!res.ok || !res.j.success || !res.j.data) {
      soPostFail++;
      failures.push({
        row: grp.items[0]?.row ?? 0, tab: grp.tab, customerPO: grp.customerPO,
        productCode: grp.items[0]?.lineRaw.productCode ?? "", customer: grp.customerName,
        reason: `SO POST ${res.status}: ${res.j.error ?? JSON.stringify(res.j)}`,
      });
      continue;
    }
    created++;
    const soId = res.j.data.id;
    const companySOId = res.j.data.companySOId;

    // Confirm to trigger cascade
    const confRes = await postJson<{ success: boolean; productionOrders?: Array<{ id: string }>; error?: string }>(
      token, `/api/sales-orders/${soId}/confirm`, { notes: "Migrated from tracker" },
    );
    if (!confRes.ok || !confRes.j.success) {
      confirmFail++;
      failures.push({
        row: grp.items[0]?.row ?? 0, tab: grp.tab, customerPO: grp.customerPO,
        productCode: companySOId, customer: grp.customerName,
        reason: `Confirm failed ${confRes.status}: ${confRes.j.error ?? JSON.stringify(confRes.j)}`,
      });
    } else {
      confirmed++;
      poCreated += confRes.j.productionOrders?.length ?? 0;
    }
    if (i % 20 === 0) console.log(`  Progress: ${i}/${groups.size} — created=${created} confirmed=${confirmed} POs=${poCreated} skipped=${skipped} postFail=${soPostFail} confirmFail=${confirmFail}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — Report
  // ---------------------------------------------------------------------------
  console.log(`\n=== REPORT ===`);
  console.log(`Total rows parsed: BF=${bfRows.length} SF=${sfRows.length} (${bfRows.length + sfRows.length})`);
  console.log(`Total SO groups built: ${groups.size}`);
  console.log(`SOs created: ${created}`);
  console.log(`SOs confirmed: ${confirmed}`);
  console.log(`SOs skipped (already exist): ${skipped}`);
  console.log(`POs generated (cascade): ${poCreated}`);
  console.log(`Customers created: ${customersCreated.length} (${customersCreated.join(", ") || "—"})`);
  console.log(`SO POST failures: ${soPostFail}`);
  console.log(`Confirm failures: ${confirmFail}`);
  console.log(`Total failures: ${failures.length}`);
  if (failures.length > 0) {
    console.log(`\n=== FAILURES ===`);
    const byReason = new Map<string, number>();
    for (const f of failures) {
      byReason.set(f.reason, (byReason.get(f.reason) || 0) + 1);
      console.log(`  [${f.tab} R${f.row}] PO=${f.customerPO} code=${f.productCode} cust=${f.customer} :: ${f.reason}`);
    }
    console.log(`\nFailures by reason:`);
    for (const [reason, count] of byReason) console.log(`  ${count}x ${reason}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

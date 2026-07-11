// ---------------------------------------------------------------------------
// procurement-agent.ts — Procurement Agent SKELETON (read-only, honesty-first).
//
// Blueprint (docs/AGENTS-BLUEPRINT.md · Procurement JD): the Procurement Agent
// is PARKED until its data prerequisites are met — ① supplier lead time per
// raw material, ② PO expectedDate discipline, ③ MRP accuracy. Until then it
// is READ-ONLY and must answer "insufficient data" rather than guess. This
// module is the interface the CS Agent orchestrator calls for the MATERIALS
// leg of a delivery promise.
//
// Honesty guard: every answer that would require missing data comes back as
// { etaKnown: false } with an explicit note. NO date is ever invented here —
// an ETA is only ever a real purchase_orders.expectedDate.
//
// Data sources (all existing tables, no schema changes):
//   raw_materials                 → on-hand (balanceQty)
//   bom_templates.wipComponents   → material explosion (mirrors mrp.ts walk)
//   purchase_orders + items       → in-transit qty + expectedDate ETA
//   supplier_material_bindings    → leadTimeDays coverage (readiness metric)
//   mrp_runs                      → MRP freshness (readiness metric)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Readiness — is the Procurement Agent allowed to answer with confidence?
// ---------------------------------------------------------------------------

export interface ProcurementReadiness {
  ready: boolean;
  /** Human-readable list of the data gaps blocking full activation. */
  missing: string[];
  stats: {
    rawMaterialsTotal: number;
    /** Distinct active materials with a supplier binding carrying leadTimeDays > 0. */
    rawMaterialsWithLeadTime: number;
    leadTimeCoveragePct: number;
    openPOsTotal: number;
    openPOsWithExpectedDate: number;
    expectedDateCoveragePct: number;
    /** ISO timestamp of the newest persisted MRP run, or null when none. */
    lastMrpRunAt: string | null;
    mrpRunAgeDays: number | null;
  };
}

// Activation thresholds (blueprint: data must be "补齐" before the agent is
// allowed to speak with confidence). Deliberately strict — under-promise.
const READY_LEAD_TIME_PCT = 90;
const READY_EXPECTED_DATE_PCT = 90;
const READY_MRP_MAX_AGE_DAYS = 7;

/** PO statuses that count as "open / in transit" (pre-receipt lifecycle). */
const OPEN_PO_STATUSES = ["SUBMITTED", "CONFIRMED", "PARTIAL_RECEIVED"] as const;
/** SQL IN-list built from the constant (fixed literals, not user input). */
const OPEN_PO_STATUS_SQL = OPEN_PO_STATUSES.map((s) => `'${s}'`).join(",");

export async function procurementReadiness(
  db: D1Database,
): Promise<ProcurementReadiness> {
  const [rmTotalRow, rmLeadRow, poRow] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM raw_materials WHERE isActive = 1")
      .first<{ n: number }>(),
    // Lead-time data DOES have a home: supplier_material_bindings.leadTimeDays
    // (the same column mrp.ts reads). Coverage = distinct active materials
    // with at least one binding whose leadTimeDays > 0.
    db
      .prepare(
        `SELECT COUNT(DISTINCT b.materialCode) AS n
           FROM supplier_material_bindings b
           JOIN raw_materials r ON r.itemCode = b.materialCode
          WHERE r.isActive = 1
            AND COALESCE(b.leadTimeDays, 0) > 0`,
      )
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN expectedDate IS NOT NULL AND expectedDate <> ''
                         THEN 1 ELSE 0 END) AS "withEta"
           FROM purchase_orders
          WHERE status IN (${OPEN_PO_STATUS_SQL})`,
      )
      .first<{ total: number; withEta: number | null; witheta?: number | null }>(),
  ]);

  // MRP freshness — mrp_runs may not exist on a fresh deploy (its migration
  // self-applies inside the mrp route). Treat a query failure as "no runs".
  let lastMrpRunAt: string | null = null;
  try {
    const run = await db
      .prepare("SELECT runDate FROM mrp_runs ORDER BY runDate DESC LIMIT 1")
      .first<{ runDate: string | null; run_date?: string | null }>();
    lastMrpRunAt = run ? (run.runDate ?? run.run_date ?? null) : null;
  } catch {
    lastMrpRunAt = null;
  }

  const rawMaterialsTotal = Number(rmTotalRow?.n) || 0;
  const rawMaterialsWithLeadTime = Number(rmLeadRow?.n) || 0;
  const openPOsTotal = Number(poRow?.total) || 0;
  // Dual-key read — the adapter may fold the alias to lowercase.
  const openPOsWithExpectedDate =
    Number(poRow?.withEta ?? poRow?.witheta) || 0;

  const leadTimeCoveragePct =
    rawMaterialsTotal > 0
      ? Math.round((rawMaterialsWithLeadTime / rawMaterialsTotal) * 100)
      : 0;
  const expectedDateCoveragePct =
    openPOsTotal > 0
      ? Math.round((openPOsWithExpectedDate / openPOsTotal) * 100)
      : 100; // no open POs = nothing missing an ETA

  let mrpRunAgeDays: number | null = null;
  if (lastMrpRunAt) {
    const age = (Date.now() - new Date(lastMrpRunAt).getTime()) / 86400000;
    mrpRunAgeDays = Number.isFinite(age) ? Math.floor(age) : null;
  }

  const missing: string[] = [];
  if (leadTimeCoveragePct < READY_LEAD_TIME_PCT) {
    missing.push(
      `Supplier lead-time data incomplete: ${rawMaterialsWithLeadTime}/${rawMaterialsTotal} active raw materials have a supplier binding with leadTimeDays > 0 (${leadTimeCoveragePct}%, need >= ${READY_LEAD_TIME_PCT}%).`,
    );
  }
  if (expectedDateCoveragePct < READY_EXPECTED_DATE_PCT) {
    missing.push(
      `PO expectedDate discipline incomplete: ${openPOsWithExpectedDate}/${openPOsTotal} open POs carry an expected date (${expectedDateCoveragePct}%, need >= ${READY_EXPECTED_DATE_PCT}%).`,
    );
  }
  if (mrpRunAgeDays == null) {
    missing.push("No MRP run persisted yet — run MRP at least weekly.");
  } else if (mrpRunAgeDays > READY_MRP_MAX_AGE_DAYS) {
    missing.push(
      `Latest MRP run is ${mrpRunAgeDays} days old (need <= ${READY_MRP_MAX_AGE_DAYS} days).`,
    );
  }

  return {
    ready: missing.length === 0,
    missing,
    stats: {
      rawMaterialsTotal,
      rawMaterialsWithLeadTime,
      leadTimeCoveragePct,
      openPOsTotal,
      openPOsWithExpectedDate,
      expectedDateCoveragePct,
      lastMrpRunAt,
      mrpRunAgeDays,
    },
  };
}

// ---------------------------------------------------------------------------
// Material availability — v1: BOM needs vs current RM stock (+ in-transit PO).
// ---------------------------------------------------------------------------

export interface MaterialNeed {
  code: string;
  name?: string;
  unit?: string;
  qty: number;
}

export interface MaterialLine {
  code: string;
  name: string;
  unit: string;
  requiredQty: number;
  onHand: number;
  enough: boolean;
  shortQty: number;
  /** Outstanding (ordered − received) qty on open POs for this material. */
  inTransitQty: number;
  /**
   * Real expectedDate of the open PO(s) covering the shortage — never a
   * computed guess. null when the shortage isn't covered or the covering PO
   * has no expectedDate.
   */
  eta: string | null;
  etaKnown: boolean;
  note?: string;
}

export interface MaterialAvailabilityResult {
  /** false only when the request itself couldn't be resolved (no BOM at all). */
  ok: boolean;
  allEnough: boolean;
  /** true when every short line has a real PO expectedDate covering it. */
  etaKnown: boolean;
  /**
   * Date materials are ready: today when everything is on hand; the latest
   * covering-PO expectedDate when shortages are fully covered in transit;
   * null when any shortage has no known ETA (honesty guard — no guessing).
   */
  readyDate: string | null;
  materials: MaterialLine[];
  notes: string[];
}

// --- BOM explosion (mirrors src/api/routes/mrp.ts, simplified) --------------
// v1 skeleton intentionally SKIPS the dimension-scaling rules
// (expandMaterialQty / parseMaterialScaling) that full MRP applies — those
// need per-order dimensions (gap / divan height / seat height) that a bare
// productCode query doesn't carry. Quantities here are the unscaled BOM qty,
// which is exact for fixed-qty materials and a floor for scaled ones. The
// result notes flag this so no caller mistakes it for full MRP.

type BomMaterial = {
  code?: string;
  inventoryCode?: string;
  name?: string;
  unit?: string;
  qty?: number;
};

type BomWipNode = {
  quantity?: number;
  materials?: BomMaterial[];
  children?: BomWipNode[];
};

type BomTemplateRow = {
  id: string;
  productCode: string;
  wipComponents: string | null;
  versionStatus: string | null;
};

function normCode(s: string | null | undefined): string {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function findBomTemplate(
  productCode: string,
  templates: BomTemplateRow[],
): BomTemplateRow | undefined {
  const want = normCode(productCode);
  return (
    templates.find((t) => t.productCode === productCode && t.versionStatus === "ACTIVE") ||
    templates.find((t) => normCode(t.productCode) === want && t.versionStatus === "ACTIVE") ||
    templates.find((t) => t.productCode === productCode) ||
    templates.find((t) => normCode(t.productCode) === want)
  );
}

function parseWipComponents(raw: string | null): BomWipNode[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as BomWipNode[];
    if (parsed && Array.isArray((parsed as { components?: unknown }).components)) {
      return (parsed as { components: BomWipNode[] }).components;
    }
  } catch {
    // fall through
  }
  return [];
}

function collectNeeds(
  node: BomWipNode,
  orderQty: number,
  parentQty: number,
  into: Map<string, MaterialNeed>,
): void {
  const effectiveQty = (node.quantity || 1) * parentQty;
  for (const mat of node.materials || []) {
    const key = mat.inventoryCode || mat.code;
    if (!key) continue;
    const matQty = (mat.qty || 0) * effectiveQty * orderQty;
    if (matQty <= 0) continue;
    const existing = into.get(key);
    if (existing) {
      existing.qty += matQty;
    } else {
      into.set(key, {
        code: key,
        name: mat.name || key,
        unit: mat.unit || "PCS",
        qty: matQty,
      });
    }
  }
  for (const child of node.children || []) {
    collectNeeds(child, orderQty, effectiveQty, into);
  }
}

/**
 * Explode BOM needs for one or more product lines. Returns the merged
 * per-material needs plus the product codes that had NO usable BOM template
 * (those lines simply can't be material-checked — callers must surface that,
 * not paper over it).
 */
export async function explodeBomNeeds(
  db: D1Database,
  lines: Array<{ productCode: string; qty: number }>,
): Promise<{ needs: MaterialNeed[]; missingBom: string[] }> {
  const res = await db
    .prepare(
      "SELECT id, productCode, wipComponents, versionStatus FROM bom_templates",
    )
    .all<BomTemplateRow>();
  const templates = res.results ?? [];

  const merged = new Map<string, MaterialNeed>();
  const missingBom: string[] = [];
  for (const line of lines) {
    const code = (line.productCode || "").trim();
    const qty = Math.max(1, Math.floor(line.qty || 1));
    if (!code) continue;
    const tpl = findBomTemplate(code, templates);
    const nodes = tpl ? parseWipComponents(tpl.wipComponents) : [];
    if (nodes.length === 0) {
      missingBom.push(code);
      continue;
    }
    for (const node of nodes) collectNeeds(node, qty, 1, merged);
  }
  return { needs: [...merged.values()], missingBom };
}

type RawMaterialStockRow = {
  itemCode: string;
  itemName?: string | null;
  item_name?: string | null;
  unit?: string | null;
  balanceQty: number | null;
  balance_qty?: number | null;
};

type OpenPoLineRow = {
  materialCode?: string | null;
  material_code?: string | null;
  quantity: number | null;
  receivedQty?: number | null;
  received_qty?: number | null;
  expectedDate?: string | null;
  expected_date?: string | null;
  poNo?: string | null;
};

/** Local YYYY-MM-DD (never toISOString — that shifts by timezone). */
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * v1 material availability: BOM-exploded needs vs current raw_materials
 * stock, with open-PO in-transit cover. Accepts either a single product, a
 * list of order lines, or pre-exploded needs.
 *
 * Honesty guard: a shortage only gets an `eta` when a REAL open-PO
 * expectedDate covers it. Anything else → etaKnown:false and (when the
 * readiness check says lead-time data is incomplete) an explicit
 * "supplier lead-time data incomplete" note. We never synthesize a date
 * from leadTimeDays here — that's the parked full-agent's job once the
 * data is maintained.
 */
export async function materialAvailability(
  db: D1Database,
  input:
    | { productCode: string; qty: number }
    | { lines: Array<{ productCode: string; qty: number }> }
    | { needs: MaterialNeed[] },
): Promise<MaterialAvailabilityResult> {
  const notes: string[] = [];

  // ── Resolve needs ──────────────────────────────────────────────────────────
  let needs: MaterialNeed[] = [];
  if ("needs" in input) {
    needs = input.needs.filter((n) => n.code && n.qty > 0);
  } else {
    const lines =
      "lines" in input
        ? input.lines
        : [{ productCode: input.productCode, qty: input.qty }];
    const exploded = await explodeBomNeeds(db, lines);
    needs = exploded.needs;
    if (exploded.missingBom.length > 0) {
      notes.push(
        `No BOM template with materials for: ${exploded.missingBom.join(", ")} — those lines are NOT material-checked.`,
      );
    }
    if (needs.length === 0) {
      return {
        ok: false,
        allEnough: false,
        etaKnown: false,
        readyDate: null,
        materials: [],
        notes: [
          ...notes,
          "Material availability could not be computed — no BOM material data for the requested product(s).",
        ],
      };
    }
    notes.push(
      "v1 BOM explosion uses unscaled BOM quantities (dimension-scaling rules are skipped — full MRP applies them per-order).",
    );
  }

  if (needs.length === 0) {
    return {
      ok: false,
      allEnough: false,
      etaKnown: false,
      readyDate: null,
      materials: [],
      notes: [...notes, "No material needs supplied."],
    };
  }

  // ── Load stock + open-PO in-transit lines ─────────────────────────────────
  const [stockRes, poRes, readiness] = await Promise.all([
    db
      .prepare(
        "SELECT itemCode, itemName, unit, balanceQty FROM raw_materials",
      )
      .all<RawMaterialStockRow>(),
    db
      .prepare(
        `SELECT i.materialCode AS "materialCode",
                i.quantity      AS quantity,
                i.receivedQty   AS "receivedQty",
                p.expectedDate  AS "expectedDate",
                p.poNo          AS "poNo"
           FROM purchase_order_items i
           JOIN purchase_orders p ON p.id = i.purchaseOrderId
          WHERE p.status IN (${OPEN_PO_STATUS_SQL})`,
      )
      .all<OpenPoLineRow>(),
    procurementReadiness(db),
  ]);

  const stockByCode = new Map<string, RawMaterialStockRow>();
  for (const r of stockRes.results ?? []) {
    if (r.itemCode) stockByCode.set(r.itemCode, r);
  }

  // In-transit lines grouped per material, sorted by expectedDate (known
  // dates first, ascending; undated last).
  const transitByCode = new Map<
    string,
    Array<{ outstanding: number; eta: string | null; poNo: string }>
  >();
  for (const r of poRes.results ?? []) {
    const code = (r.materialCode ?? r.material_code ?? "").trim();
    if (!code) continue;
    const outstanding = Math.max(
      0,
      (Number(r.quantity) || 0) - (Number(r.receivedQty ?? r.received_qty) || 0),
    );
    if (outstanding <= 0) continue;
    const eta = (r.expectedDate ?? r.expected_date ?? "").slice(0, 10) || null;
    const list = transitByCode.get(code) ?? [];
    list.push({ outstanding, eta, poNo: (r.poNo ?? "").trim() });
    transitByCode.set(code, list);
  }
  for (const list of transitByCode.values()) {
    list.sort((a, b) => {
      if (a.eta && b.eta) return a.eta.localeCompare(b.eta);
      if (a.eta) return -1;
      if (b.eta) return 1;
      return 0;
    });
  }

  // ── Per-material verdicts ─────────────────────────────────────────────────
  const materials: MaterialLine[] = [];
  for (const need of needs) {
    const stock = stockByCode.get(need.code);
    const onHand = Number(stock?.balanceQty ?? stock?.balance_qty) || 0;
    const requiredQty = need.qty;
    const shortQty = Math.max(0, requiredQty - onHand);
    const transit = transitByCode.get(need.code) ?? [];
    const inTransitQty = transit.reduce((s, t) => s + t.outstanding, 0);

    let eta: string | null = null;
    let etaKnown = false;
    let note: string | undefined;
    if (shortQty > 0) {
      // Walk in-transit POs (dated first) until the shortage is covered.
      let remaining = shortQty;
      let coveredByUndated = false;
      for (const t of transit) {
        if (remaining <= 0) break;
        remaining -= t.outstanding;
        if (t.eta) {
          eta = t.eta; // last (latest) dated PO needed to cover
        } else {
          coveredByUndated = true;
        }
      }
      if (remaining <= 0 && !coveredByUndated && eta) {
        etaKnown = true;
        note = `Shortage covered by open PO(s); latest expected arrival ${eta}.`;
      } else if (remaining <= 0) {
        eta = null;
        etaKnown = false;
        note =
          "Shortage covered by open PO qty, but the covering PO has no expected date — ETA unknown.";
      } else {
        eta = null;
        etaKnown = false;
        note = readiness.ready
          ? "Shortage not covered by any open PO — a new PO is required before an ETA exists."
          : "Shortage not covered by open POs and supplier lead-time data incomplete — ETA unknown.";
      }
    }

    materials.push({
      code: need.code,
      name: stock?.itemName ?? stock?.item_name ?? need.name ?? need.code,
      unit: stock?.unit ?? need.unit ?? "PCS",
      requiredQty: Math.ceil(requiredQty * 100) / 100,
      onHand,
      enough: shortQty <= 0,
      shortQty: Math.ceil(shortQty * 100) / 100,
      inTransitQty,
      eta,
      etaKnown,
      ...(note ? { note } : {}),
    });
  }

  const shortLines = materials.filter((m) => !m.enough);
  const allEnough = shortLines.length === 0;
  const everyShortCovered =
    shortLines.length > 0 && shortLines.every((m) => m.etaKnown && m.eta);

  let readyDate: string | null = null;
  if (allEnough) {
    readyDate = todayLocalIso();
  } else if (everyShortCovered) {
    readyDate = shortLines.reduce<string>(
      (max, m) => (m.eta && m.eta > max ? m.eta : max),
      "",
    ) || null;
  }

  if (!allEnough && !everyShortCovered && !readiness.ready) {
    notes.push(
      "Procurement Agent is not fully activated (data prerequisites incomplete) — it answers 'insufficient data' rather than guessing an arrival date.",
    );
  }

  return {
    ok: true,
    allEnough,
    etaKnown: allEnough || everyShortCovered,
    readyDate,
    materials,
    notes,
  };
}

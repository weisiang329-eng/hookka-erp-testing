// ---------------------------------------------------------------------------
// Sofa combo rules — append-only effective-dated combo deals for sofa modules.
//
// Each row says "if a customer buys these componentSizes together for this
// baseModel at this fabricTier, charge pricesByHeight[seatHeight] instead of
// summing the per-module prices". Resolver (used downstream by sales/create
// detection in Phase 3c — NOT in this PR) picks the newest row scoped by
// (baseModel, componentSizes, fabricTier, customerId) where effectiveFrom
// <= today. customerId NULL = company-wide; set = customer override.
//
// Pattern matches customer-products.ts: same JSON helper, idiomatic
// c.var.DB usage, same { success, data } shape, append-only history.
// componentSizes is canonicalised (sorted ascending) before storage so
// "L+2A" and "2A+L" collapse to the same JSON key — the resolver does
// the same sort on the lookup side.
//
// Endpoints:
//   GET    /                               list rules (filter by ?baseModel / ?customerId)
//   POST   /                               create new effective-dated rule
//   DELETE /:id                            remove one rule
//
// No PUT — edits = new effective-dated row, mirroring product_prices /
// customer_product_prices.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

const FABRIC_TIERS = ["ANY", "PRICE_1", "PRICE_2", "PRICE_3"] as const;
type FabricTier = (typeof FABRIC_TIERS)[number];

type SofaComboRuleRow = {
  id: string;
  baseModel: string;
  componentSizes: string; // JSON sorted array, e.g. '["2A","L"]'
  fabricTier: FabricTier;
  pricesByHeight: string; // JSON object, e.g. '{"24":180000,...}'
  customerId: string | null;
  effectiveFrom: string;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
};

type JoinedRow = SofaComboRuleRow & { customerName: string | null };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function genId(): string {
  return `scr-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Canonicalise componentSizes. Storage shape is now an array of OR-groups:
//
//   [["2A(LHF)","2A(RHF)"], ["L(LHF)","L(RHF)"]]
//
// Each group is "any-of": at SO-detection time the cart needs at least one
// module matching some entry in each group. Groups together are "all-of".
// Lets a single rule cover all four handedness variants of a 2A+L deal.
//
// Backwards-compat: if the caller posts a flat string[] (legacy shape used
// by the first iteration of this UI), each element is wrapped into its own
// 1-element group. Sorted within groups + across groups so equivalent
// shapes hash to the same JSON.
function canonicalSizes(input: unknown): string[][] | null {
  if (!Array.isArray(input)) return null;
  // Detect legacy flat shape (string[]) and wrap to grouped shape.
  const groups: unknown[] =
    input.length > 0 && typeof input[0] === "string"
      ? input.map((v) => [v])
      : input;
  const cleaned: string[][] = [];
  for (const g of groups) {
    if (!Array.isArray(g)) return null;
    const inner: string[] = [];
    for (const v of g) {
      if (typeof v !== "string") return null;
      const t = v.trim();
      if (!t) continue;
      if (!inner.includes(t)) inner.push(t);
    }
    if (inner.length === 0) continue;
    cleaned.push(inner.slice().sort());
  }
  if (cleaned.length === 0) return null;
  cleaned.sort((a, b) => a[0].localeCompare(b[0]));
  return cleaned;
}

function isValidPricesByHeight(input: unknown): input is Record<string, number> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return false;
  }
  return Object.keys(input as Record<string, unknown>).length > 0;
}

function isValidFabricTier(t: unknown): t is FabricTier {
  return typeof t === "string" && (FABRIC_TIERS as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// GET /api/sofa-combos
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const baseModel = c.req.query("baseModel");
  const customerId = c.req.query("customerId");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (baseModel) {
    where.push("scr.baseModel = ?");
    binds.push(baseModel);
  }
  if (customerId) {
    if (customerId === "null" || customerId === "NULL") {
      where.push("scr.customerId IS NULL");
    } else {
      where.push("scr.customerId = ?");
      binds.push(customerId);
    }
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const res = await c.var.DB.prepare(
    `SELECT scr.*, cu.name AS "customerName"
       FROM sofa_combo_rules scr
       LEFT JOIN customers cu ON cu.id = scr.customerId
       ${whereSql}
       ORDER BY scr.baseModel, scr.effectiveFrom DESC, scr.created_at DESC`,
  )
    .bind(...binds)
    .all<JoinedRow>();

  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    baseModel: r.baseModel,
    componentSizes: parseJson<string[][]>(r.componentSizes, []),
    fabricTier: r.fabricTier,
    pricesByHeight: parseJson<Record<string, number>>(r.pricesByHeight, {}),
    customerId: r.customerId,
    customerName: r.customerName,
    effectiveFrom: r.effectiveFrom,
    notes: r.notes ?? "",
    createdAt: r.createdAt,
    createdBy: r.createdBy,
  }));

  return c.json({ success: true, data });
});

// ---------------------------------------------------------------------------
// POST /api/sofa-combos — append-only create
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "sofa-combos", "create");
  if (denied) return denied;

  try {
    const body = await c.req.json();
    const baseModel = String(body.baseModel ?? "").trim();
    const fabricTier = body.fabricTier;
    const effectiveFrom = String(body.effectiveFrom ?? "").trim();

    if (!baseModel) {
      return c.json({ success: false, error: "baseModel is required" }, 400);
    }
    if (!isValidFabricTier(fabricTier)) {
      return c.json(
        {
          success: false,
          error: `fabricTier must be one of ${FABRIC_TIERS.join(", ")}`,
        },
        400,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return c.json(
        { success: false, error: "effectiveFrom (YYYY-MM-DD) is required" },
        400,
      );
    }

    const sizes = canonicalSizes(body.componentSizes);
    if (!sizes) {
      return c.json(
        {
          success: false,
          error: "componentSizes must be a non-empty array of strings",
        },
        400,
      );
    }
    if (!isValidPricesByHeight(body.pricesByHeight)) {
      return c.json(
        {
          success: false,
          error:
            "pricesByHeight must be a non-empty object of seatHeight -> sen (>=0)",
        },
        400,
      );
    }

    // Optional customerId — when set, validate the FK manually so we return
    // a friendly 400 instead of a Postgres FK violation.
    const customerId = body.customerId ? String(body.customerId) : null;
    if (customerId) {
      const cust = await c.var.DB.prepare(
        "SELECT id FROM customers WHERE id = ?",
      )
        .bind(customerId)
        .first<{ id: string }>();
      if (!cust) {
        return c.json(
          { success: false, error: "customerId not found" },
          400,
        );
      }
    }

    const id = genId();
    const sizesJson = JSON.stringify(sizes);
    const pricesJson = JSON.stringify(body.pricesByHeight);
    const notes = body.notes ? String(body.notes) : null;
    const createdBy = body.createdBy ? String(body.createdBy) : null;

    await c.var.DB.prepare(
      `INSERT INTO sofa_combo_rules
         (id, baseModel, componentSizes, fabricTier, pricesByHeight,
          customerId, effectiveFrom, notes, createdBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        baseModel,
        sizesJson,
        fabricTier,
        pricesJson,
        customerId,
        effectiveFrom,
        notes,
        createdBy,
      )
      .run();

    const row = await c.var.DB.prepare(
      `SELECT scr.*, cu.name AS "customerName"
         FROM sofa_combo_rules scr
         LEFT JOIN customers cu ON cu.id = scr.customerId
         WHERE scr.id = ?`,
    )
      .bind(id)
      .first<JoinedRow>();
    if (!row) {
      return c.json(
        { success: false, error: "Failed to create combo rule" },
        500,
      );
    }

    return c.json(
      {
        success: true,
        data: {
          id: row.id,
          baseModel: row.baseModel,
          componentSizes: parseJson<string[][]>(row.componentSizes, []),
          fabricTier: row.fabricTier,
          pricesByHeight: parseJson<Record<string, number>>(
            row.pricesByHeight,
            {},
          ),
          customerId: row.customerId,
          customerName: row.customerName,
          effectiveFrom: row.effectiveFrom,
          notes: row.notes ?? "",
          createdAt: row.createdAt,
          createdBy: row.createdBy,
        },
      },
      201,
    );
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sofa-combos/copy-from-master
//   body: { customerId, effectiveFrom?: string }
//
// Snapshot every company-wide combo rule (customerId IS NULL) into a
// customer-specific duplicate so the customer's combos can be edited
// independently of the master. Mirrors the Customer Products / Customer
// Maintenance copy-from-master pattern Wei Siang asked for.
//
// Skips rules that already have a customer-scoped duplicate (same
// baseModel + componentSizes + fabricTier already exists for this
// customer) — re-running the action is idempotent. Each new copy
// inherits the source's pricesByHeight + notes verbatim, with
// effectiveFrom defaulted to today (or whatever the caller passed).
// ---------------------------------------------------------------------------
app.post("/copy-from-master", async (c) => {
  const denied = await requirePermission(c, "sofa-combos", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const customerId = String(body.customerId ?? "").trim();
    const effectiveFrom = String(body.effectiveFrom ?? todayIso()).trim();
    if (!customerId) {
      return c.json(
        { success: false, error: "customerId is required" },
        400,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      return c.json(
        { success: false, error: "effectiveFrom must be YYYY-MM-DD" },
        400,
      );
    }

    // Master combos = the latest effective row per (baseModel, componentSizes,
    // fabricTier) where customerId IS NULL. Group + take the most-recent so
    // the customer doesn't inherit obsolete past pricing.
    const masterRes = await c.var.DB.prepare(
      `SELECT id, baseModel, componentSizes, fabricTier, pricesByHeight,
              effectiveFrom, notes
         FROM sofa_combo_rules
        WHERE customerId IS NULL
        ORDER BY baseModel, componentSizes, fabricTier,
                 effectiveFrom DESC, created_at DESC`,
    ).all<{
      id: string;
      baseModel: string;
      componentSizes: string;
      fabricTier: string;
      pricesByHeight: string;
      effectiveFrom: string;
      notes: string | null;
    }>();
    const masterRows = masterRes.results ?? [];
    const seenKey = new Set<string>();
    const newest: typeof masterRows = [];
    for (const r of masterRows) {
      const k = `${r.baseModel}|${r.componentSizes}|${r.fabricTier}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      newest.push(r);
    }

    // Existing customer-scoped rules — used to skip duplicates so the
    // operation is safe to re-run.
    const existingRes = await c.var.DB.prepare(
      `SELECT baseModel, componentSizes, fabricTier
         FROM sofa_combo_rules
        WHERE customerId = ?`,
    )
      .bind(customerId)
      .all<{ baseModel: string; componentSizes: string; fabricTier: string }>();
    const existingKeys = new Set(
      (existingRes.results ?? []).map(
        (r) => `${r.baseModel}|${r.componentSizes}|${r.fabricTier}`,
      ),
    );

    const inserts: D1PreparedStatement[] = [];
    let copied = 0;
    let skipped = 0;
    for (const r of newest) {
      const k = `${r.baseModel}|${r.componentSizes}|${r.fabricTier}`;
      if (existingKeys.has(k)) {
        skipped++;
        continue;
      }
      copied++;
      inserts.push(
        c.var.DB.prepare(
          `INSERT INTO sofa_combo_rules
             (id, baseModel, componentSizes, fabricTier, pricesByHeight,
              customerId, effectiveFrom, notes, createdBy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          genId(),
          r.baseModel,
          r.componentSizes,
          r.fabricTier,
          r.pricesByHeight,
          customerId,
          effectiveFrom,
          r.notes,
          null,
        ),
      );
    }
    if (inserts.length > 0) await c.var.DB.batch(inserts);

    return c.json({
      success: true,
      data: { copied, skipped, sourceMasterRules: newest.length },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sofa-combos/:id
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "sofa-combos", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id FROM sofa_combo_rules WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Combo rule not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM sofa_combo_rules WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: { id: existing.id } });
});

export default app;
export { canonicalSizes, FABRIC_TIERS };
export type { FabricTier };

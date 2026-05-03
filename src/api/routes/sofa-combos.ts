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

// Canonicalise componentSizes: dedupe + sort ascending so "L+2A" and "2A+L"
// hash to the same JSON. Sorted lexicographically — the values are short
// SKU size codes ("2A", "3A", "L", "CNR", "OTT", ...) and lexicographic
// order is stable across writes/reads.
function canonicalSizes(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const cleaned: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (!t) continue;
    cleaned.push(t);
  }
  if (cleaned.length === 0) return null;
  return Array.from(new Set(cleaned)).sort();
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
    componentSizes: parseJson<string[]>(r.componentSizes, []),
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
          componentSizes: parseJson<string[]>(row.componentSizes, []),
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

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
  // Combo pricing is a per-customer PRICE list and had no gate at all — anyone
  // who could reach the page could read it. Owner 2026-08-05 removed it from
  // R&D; that only means anything if the endpoint enforces it too.
  const denied = await requirePermission(c, "sofa-combos", "read");
  if (denied) return denied;
  const baseModel = c.req.query("baseModel");
  const customerId = c.req.query("customerId");
  // When set with a real customerId, the response also includes
  // company-wide (customerId IS NULL) combos whose baseModel matches a
  // product this customer is assigned (via customer_products). Lets the
  // customer's combo panel surface "All customers" combos that
  // ACTUALLY apply to them, instead of nothing or everything.
  const includeApplicableMaster =
    c.req.query("includeApplicableMaster") === "true";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (baseModel) {
    where.push("scr.baseModel = ?");
    binds.push(baseModel);
  }
  let customerScopeSql = "";
  if (customerId) {
    if (customerId === "null" || customerId === "NULL") {
      where.push("scr.customerId IS NULL");
    } else if (includeApplicableMaster) {
      // OR clause: customer-specific rows OR company-wide rows whose
      // baseModel is in the customer's assigned product baseModels.
      // Compute the assigned baseModels first.
      const cpRes = await c.var.DB
        .prepare(
          `SELECT DISTINCT p.code FROM customer_products cp
             JOIN products p ON p.id = cp.productId
            WHERE cp.customerId = ?`,
        )
        .bind(customerId)
        .all<{ code: string }>();
      const baseModels = new Set<string>();
      for (const r of cpRes.results ?? []) {
        // baseModel = first segment before the first '-' (matches the
        // pattern used elsewhere: "5535-2A(LHF)" → "5535").
        const bm = (r.code || "").split("-")[0];
        if (bm) baseModels.add(bm);
      }
      if (baseModels.size === 0) {
        // Customer has no assigned products → only their customer-scoped
        // combos qualify; no master overlay.
        where.push("scr.customerId = ?");
        binds.push(customerId);
      } else {
        const bmList = Array.from(baseModels);
        const placeholders = bmList.map(() => "?").join(",");
        customerScopeSql =
          `(scr.customerId = ? OR (scr.customerId IS NULL AND scr.baseModel IN (${placeholders})))`;
        binds.push(customerId, ...bmList);
        where.push(customerScopeSql);
      }
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

    // Mirror EVERY master combo row (full effective-dated history) into
    // the customer scope. Previously only the newest row per (baseModel,
    // componentSizes, fabricTier) was copied — that hid the master's
    // pricing timeline from the customer-side history dialog. Wei Siang
    // explicitly asked for parity with the SKU price-history flow.
    //
    // Idempotency: dedup by (baseModel, componentSizes, fabricTier,
    // effectiveFrom). Re-running this on a customer with partial mirror
    // backfills only the missing rows.
    const masterRes = await c.var.DB.prepare(
      `SELECT id, baseModel, componentSizes, fabricTier, pricesByHeight,
              effectiveFrom, notes
         FROM sofa_combo_rules
        WHERE customerId IS NULL
        ORDER BY baseModel, componentSizes, fabricTier,
                 effectiveFrom ASC, created_at ASC`,
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

    // Existing customer-scoped rules — keyed by (baseModel,
    // componentSizes, fabricTier, effectiveFrom) so historical mirrored
    // rows aren't overwritten on re-run.
    const existingRes = await c.var.DB.prepare(
      `SELECT baseModel, componentSizes, fabricTier, effectiveFrom
         FROM sofa_combo_rules
        WHERE customerId = ?`,
    )
      .bind(customerId)
      .all<{
        baseModel: string;
        componentSizes: string;
        fabricTier: string;
        effectiveFrom: string;
      }>();
    const existingKeys = new Set(
      (existingRes.results ?? []).map(
        (r) =>
          `${r.baseModel}|${r.componentSizes}|${r.fabricTier}|${r.effectiveFrom}`,
      ),
    );

    const inserts: D1PreparedStatement[] = [];
    let copied = 0;
    let skipped = 0;
    for (const r of masterRows) {
      const k = `${r.baseModel}|${r.componentSizes}|${r.fabricTier}|${r.effectiveFrom}`;
      if (existingKeys.has(k)) {
        skipped++;
        continue;
      }
      copied++;
      // Preserve master row's effectiveFrom so the customer's history
      // dialog shows the same timeline (not a single snapshot dated
      // today). Notes prefixed so the source is visible.
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
          r.effectiveFrom,
          r.notes
            ? `Mirrored from Master: ${r.notes}`
            : `Mirrored from Master ${r.effectiveFrom}`,
          null,
        ),
      );
    }
    // Batch in chunks of 50 (D1 statement-per-batch cap).
    for (let i = 0; i < inserts.length; i += 50) {
      await c.var.DB.batch(inserts.slice(i, i + 50));
    }

    return c.json({
      success: true,
      data: {
        copied,
        skipped,
        sourceMasterRules: masterRows.length,
        // effectiveFrom from body retained for backward-compat clients
        // that look at it (now unused — each row uses master's own date).
        effectiveFromIgnored: effectiveFrom,
      },
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/sofa-combos/:id — in-place edit of an existing combo rule.
//
// Mirrors the POST validation rules. Accepts the SAME body shape as POST so
// the FE can reuse the create form for editing.
//
// Note: this is an IN-PLACE update — it does NOT create a new effective-
// dated row. If the operator wants to schedule a price change with a new
// effectiveFrom, they should use POST (which creates a new row + leaves
// the old one as past history). Use PUT only when the original row was
// entered with wrong data (typo, wrong customer, wrong tier, etc.).
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "sofa-combos", "update");
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

    const sizesJson = JSON.stringify(sizes);
    const pricesJson = JSON.stringify(body.pricesByHeight);
    const notes = body.notes !== undefined ? (body.notes ? String(body.notes) : null) : undefined;

    await c.var.DB
      .prepare(
        `UPDATE sofa_combo_rules
            SET baseModel = ?,
                componentSizes = ?,
                fabricTier = ?,
                pricesByHeight = ?,
                customerId = ?,
                effectiveFrom = ?
                ${notes !== undefined ? ", notes = ?" : ""}
          WHERE id = ?`,
      )
      .bind(
        ...(notes !== undefined
          ? [baseModel, sizesJson, fabricTier, pricesJson, customerId, effectiveFrom, notes, id]
          : [baseModel, sizesJson, fabricTier, pricesJson, customerId, effectiveFrom, id]),
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

    return c.json({
      success: true,
      data: row
        ? {
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
          }
        : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: msg }, 400);
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

// ---------------------------------------------------------------------------
// D1-backed fabric-tracking route.
//
// Mirrors src/api/routes/fabric-tracking.ts response shape. Reads/writes the
// fabric_trackings table directly; row columns already match the FabricTracking
// TS type 1:1 (see schema L169-186).
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { computeFabricMetrics } from "../lib/fabric-usage";
import { getOrgId } from "../lib/tenant";
import { withSnapshot } from "../lib/snapshot";

const app = new Hono<Env>();

// Explicit snapshot wipe on write. fabric_tracking_snapshot depends on
// fabric_trackings, but that table has no updated_at/created_at column, so the
// freshness probe cannot auto-invalidate the snapshot. Every fabric_trackings
// write path must DELETE the snapshot rows itself. Wrapped so a wipe failure
// never breaks the save.
async function wipeFabricSnapshot(c: Context<Env>) {
  try {
    const { getOrgId } = await import("../lib/tenant");
    const { invalidateSnapshot } = await import("../lib/snapshot");
    await invalidateSnapshot(
      c.var.DB,
      { tableName: "fabric_tracking_snapshot", sourceTables: [] },
      getOrgId(c),
    );
  } catch (e) {
    console.warn("[fabric-write] fabric_tracking_snapshot wipe failed:", e);
  }
}

type FabricTrackingRow = {
  id: string;
  fabricCode: string;
  fabricDescription: string | null;
  fabricCategory: "B.M-FABR" | "S-FABR" | "S.M-FABR" | "LINING" | "WEBBING" | null;
  // Legacy single-tier column. Kept for back-compat — older code paths still
  // read it, and the resolver helper falls back to it when the split columns
  // are NULL.
  priceTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  // Split per-context tiers (migration 0069). sofaPriceTier covers SOFA AND
  // ACCESSORY contexts; bedframePriceTier covers BEDFRAME only.
  sofaPriceTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  bedframePriceTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  price: number;
  soh: number;
  poOutstanding: number;
  lastMonthUsage: number;
  oneWeekUsage: number;
  twoWeeksUsage: number;
  oneMonthUsage: number;
  shortage: number;
  reorderPoint: number;
  supplier: string | null;
  leadTimeDays: number;
};

function rowToTracking(r: FabricTrackingRow) {
  return {
    id: r.id,
    fabricCode: r.fabricCode,
    fabricDescription: r.fabricDescription ?? "",
    fabricCategory: r.fabricCategory ?? "B.M-FABR",
    priceTier: r.priceTier ?? "PRICE_1",
    sofaPriceTier: r.sofaPriceTier ?? null,
    bedframePriceTier: r.bedframePriceTier ?? null,
    price: r.price,
    soh: r.soh,
    poOutstanding: r.poOutstanding,
    lastMonthUsage: r.lastMonthUsage,
    oneWeekUsage: r.oneWeekUsage,
    twoWeeksUsage: r.twoWeeksUsage,
    oneMonthUsage: r.oneMonthUsage,
    shortage: r.shortage,
    reorderPoint: r.reorderPoint,
    supplier: r.supplier ?? "",
    leadTimeDays: r.leadTimeDays,
  };
}

/**
 * Resolve the effective fabric tier for a given product context. SOFA and
 * ACCESSORY both use sofaPriceTier; BEDFRAME uses bedframePriceTier. Falls
 * back to the legacy priceTier when the split column is NULL (legacy rows
 * pre-migration-0069), then to PRICE_2 as a final default.
 */
export function effectiveTierForCategory(
  fabric: {
    sofaPriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
    bedframePriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
    priceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  } | null | undefined,
  category: "SOFA" | "ACCESSORY" | "BEDFRAME",
): "PRICE_1" | "PRICE_2" | "PRICE_3" {
  if (!fabric) return "PRICE_2";
  if (category === "BEDFRAME") {
    return fabric.bedframePriceTier ?? fabric.priceTier ?? "PRICE_2";
  }
  return fabric.sofaPriceTier ?? fabric.priceTier ?? "PRICE_2";
}

// GET /api/fabric-tracking?category=B.M-FABR&shortageOnly=true
//
// Live-compute path (post 2026-05-07): every fabric SKU in raw_materials
// (itemGroup IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')) gets
// a row in the response. fabric_trackings is treated as an optional
// metadata cache (description, priceTier, supplier, leadTimeDays) merged
// in by fabricCode when present. The metric columns (soh, poOutstanding,
// lastMonthUsage, oneWeekUsage, twoWeeksUsage, oneMonthUsage, shortage)
// are ALWAYS live-computed from the same FAB_CUT JC source the Fab
// Cutting dept page uses.
//
// Source aggregation (see src/api/lib/fabric-usage.ts):
//   - SOH               ← raw_materials.balanceQty per itemCode
//   - PO Outstanding    ← purchase_order_items where PO not received
//   - Historical (30d)  ← cost_ledger RM_ISSUE rows
//   - 1wk/2wk/1mo Usage ← active FAB_CUT JCs where dueDate within window,
//                          fabricUsageMeters from BOM template
//   - Shortage          ← SOH + Outstanding − 1mo (signed; negative = under)
type RawMaterialFabricRow = {
  id: string;
  itemCode: string;
  description: string | null;
  itemGroup: string | null;
};

const FABRIC_GROUPS = new Set(["B.M-FABR", "S-FABR", "S.M-FABR", "LINING", "WEBBING"]);

app.get("/", async (c) => {
  const category = c.req.query("category");
  const shortageOnly = c.req.query("shortageOnly") === "true";
  const orgId = getOrgId(c);

  // 2026-05-23 perf fix — cache-aside snapshot. Same pattern as
  // sales-orders/stats (~line 960). The endpoint joins across 6 source
  // tables (job_cards, production_orders, raw_materials,
  // purchase_order_items, cost_ledger, bom_templates) and the result is
  // stable between fabric movements, so it's a textbook cache candidate.
  // Layer 2 invalidates the moment any source table's freshness column
  // moves; the schema-aware probe in snapshot-freshness.ts handles tables
  // that lack `updated_at` (it falls back to `created_at` or skips them).
  //
  // cache_key encodes the ?category= and ?shortageOnly= query-string
  // variants so each combo gets its own row.
  const cacheKey = `category=${category ?? ""}&shortageOnly=${
    shortageOnly ? "1" : "0"
  }`;

  const payload = await withSnapshot(
    c.var.DB,
    {
      tableName: "fabric_tracking_snapshot",
      sourceTables: [
        "job_cards",
        "production_orders",
        "raw_materials",
        "purchase_order_items",
        "cost_ledger",
        "bom_templates",
        "purchase_orders",
      ],
    },
    orgId,
    async () => {
      // Pull every fabric raw material + the static fabric_trackings rows
      // (used as metadata cache) + live metrics in parallel.
      const [rmRes, trackingsRes, liveMetrics] = await Promise.all([
        c.var.DB.prepare(
          `SELECT id, itemCode, description, itemGroup
             FROM raw_materials
            WHERE itemCode IS NOT NULL
              AND itemGroup IN ('B.M-FABR','S-FABR','S.M-FABR','LINING','WEBBING')
            ORDER BY itemCode`,
        ).all<RawMaterialFabricRow>(),
        c.var.DB.prepare(
          "SELECT * FROM fabric_trackings",
        ).all<FabricTrackingRow>(),
        computeFabricMetrics(c.var.DB),
      ]);

      // Build a fabricCode → tracking-cache map for metadata merging.
      const trackingByCode = new Map<string, FabricTrackingRow>();
      for (const t of trackingsRes.results ?? []) {
        if (t.fabricCode) trackingByCode.set(t.fabricCode, t);
      }

      // One response row per fabric raw material. Metadata defaults from
      // the RM row (itemGroup → fabricCategory, description →
      // fabricDescription, unitPriceSen → price); the fabric_trackings
      // cache adds priceTier / supplier / leadTimeDays / reorderPoint
      // when present.
      let data = (rmRes.results ?? [])
        .filter((rm) => rm.itemGroup && FABRIC_GROUPS.has(rm.itemGroup))
        .map((rm) => {
          const cached = trackingByCode.get(rm.itemCode);
          const m = liveMetrics.get(rm.itemCode);
          // Price comes from the legacy fabric_trackings cache when
          // present (manually maintained); raw_materials has no
          // per-fabric price column today, so 0 is the default for
          // fabrics with no cache row.
          const priceDisplay = cached?.price ?? 0;
          return {
            // Identity. Prefer the cached tracking id so existing PUT
            // writes hit the same row; fall back to the RM id for
            // fabrics that have no tracking row yet.
            id: cached?.id ?? rm.id,
            fabricCode: rm.itemCode,
            fabricDescription:
              cached?.fabricDescription ?? rm.description ?? "",
            fabricCategory:
              (cached?.fabricCategory as FabricTrackingRow["fabricCategory"]) ??
              (rm.itemGroup as FabricTrackingRow["fabricCategory"]) ??
              "B.M-FABR",
            priceTier: cached?.priceTier ?? "PRICE_1",
            sofaPriceTier: cached?.sofaPriceTier ?? null,
            bedframePriceTier: cached?.bedframePriceTier ?? null,
            price: priceDisplay,
            // ----- LIVE metric columns -----
            soh: m?.soh ?? 0,
            poOutstanding: m?.poOutstanding ?? 0,
            lastMonthUsage: m?.lastMonthUsage ?? 0,
            oneWeekUsage: m?.oneWeekUsage ?? 0,
            twoWeeksUsage: m?.twoWeeksUsage ?? 0,
            oneMonthUsage: m?.oneMonthUsage ?? 0,
            shortage: m?.shortage ?? 0,
            // ----- Metadata pass-through -----
            reorderPoint: cached?.reorderPoint ?? 0,
            supplier: cached?.supplier ?? "",
            leadTimeDays: cached?.leadTimeDays ?? 0,
          };
        });

      if (category) {
        data = data.filter((r) => r.fabricCategory === category);
      }
      if (shortageOnly) {
        data = data.filter((r) => r.shortage < 0);
      }
      return { success: true as const, data };
    },
    cacheKey,
  );

  return c.json(payload);
});

type FabricTrackingBody = {
  fabricCode?: string;
  fabricDescription?: string | null;
  fabricCategory?: FabricTrackingRow["fabricCategory"];
  priceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3";
  sofaPriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  bedframePriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  price?: number;
  soh?: number;
  poOutstanding?: number;
  lastMonthUsage?: number;
  oneWeekUsage?: number;
  twoWeeksUsage?: number;
  oneMonthUsage?: number;
  shortage?: number;
  reorderPoint?: number;
  supplier?: string | null;
  leadTimeDays?: number;
};

function genTrackingId(): string {
  return `ft-${crypto.randomUUID().slice(0, 8)}`;
}

// POST /api/fabric-tracking — create a new tracking row. In the LIVE cascade
// model the canonical way to create is via POST /api/raw-materials, but this
// endpoint covers direct edits from the Fabric Tracking tab.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "fabric-tracking", "create");
  if (denied) return denied;
  let body: FabricTrackingBody;
  try {
    body = (await c.req.json()) as FabricTrackingBody;
  } catch {
    return c.json({ success: false, error: "Invalid JSON" }, 400);
  }
  const fabricCode = (body.fabricCode ?? "").trim();
  if (!fabricCode) {
    return c.json({ success: false, error: "fabricCode is required" }, 400);
  }
  const existing = await c.var.DB.prepare(
    "SELECT id FROM fabric_trackings WHERE fabricCode = ? LIMIT 1",
  )
    .bind(fabricCode)
    .first<{ id: string }>();
  if (existing) {
    return c.json(
      {
        success: false,
        error: `Fabric tracking for ${fabricCode} already exists`,
      },
      400,
    );
  }
  const fabricCategory = body.fabricCategory ?? "B.M-FABR";
  const priceTier = body.priceTier ?? "PRICE_2";
  // Seed both split columns from the legacy priceTier when the caller didn't
  // supply them explicitly — keeps newly-created rows behaving identically
  // to legacy rows until the operator splits them in the UI.
  const sofaPriceTier = body.sofaPriceTier ?? priceTier;
  const bedframePriceTier = body.bedframePriceTier ?? priceTier;
  const id = genTrackingId();
  await c.var.DB.prepare(
    `INSERT INTO fabric_trackings
       (id, fabricCode, fabricDescription, fabricCategory, priceTier,
        sofaPriceTier, bedframePriceTier,
        price, soh, poOutstanding, lastMonthUsage, oneWeekUsage,
        twoWeeksUsage, oneMonthUsage, shortage, reorderPoint, supplier, leadTimeDays)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fabricCode,
      body.fabricDescription ?? null,
      fabricCategory,
      priceTier,
      sofaPriceTier,
      bedframePriceTier,
      Number(body.price) || 0,
      Number(body.soh) || 0,
      Number(body.poOutstanding) || 0,
      Number(body.lastMonthUsage) || 0,
      Number(body.oneWeekUsage) || 0,
      Number(body.twoWeeksUsage) || 0,
      Number(body.oneMonthUsage) || 0,
      Number(body.shortage) || 0,
      Number(body.reorderPoint) || 0,
      body.supplier ?? null,
      Number(body.leadTimeDays) || 0,
    )
    .run();
  const created = await c.var.DB.prepare(
    "SELECT * FROM fabric_trackings WHERE id = ?",
  )
    .bind(id)
    .first<FabricTrackingRow>();
  if (!created) {
    return c.json(
      { success: false, error: "Failed to create fabric tracking" },
      500,
    );
  }
  await wipeFabricSnapshot(c);
  return c.json({ success: true, data: rowToTracking(created) }, 201);
});

// DELETE /api/fabric-tracking/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "fabric-tracking", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM fabric_trackings WHERE id = ?",
  )
    .bind(id)
    .first<FabricTrackingRow>();
  if (!existing) {
    return c.json(
      { success: false, error: "Fabric tracking entry not found" },
      404,
    );
  }
  await c.var.DB.prepare("DELETE FROM fabric_trackings WHERE id = ?")
    .bind(id)
    .run();
  await wipeFabricSnapshot(c);
  return c.json({ success: true, data: rowToTracking(existing) });
});

// PUT /api/fabric-tracking/:id — partial update (priceTier, price, soh,
// reorderPoint). Mirrors the in-memory "only these four fields" behavior.
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "fabric-tracking", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM fabric_trackings WHERE id = ?",
  )
    .bind(id)
    .first<FabricTrackingRow>();
  if (!existing) {
    return c.json(
      { success: false, error: "Fabric tracking entry not found" },
      404,
    );
  }

  try {
    const body = await c.req.json();

    const isValidTier = (
      v: unknown,
    ): v is "PRICE_1" | "PRICE_2" | "PRICE_3" =>
      v === "PRICE_1" || v === "PRICE_2" || v === "PRICE_3";

    let priceTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | null = existing.priceTier;
    if (body.priceTier !== undefined && isValidTier(body.priceTier)) {
      priceTier = body.priceTier;
    }
    let sofaPriceTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | null =
      existing.sofaPriceTier;
    if (body.sofaPriceTier !== undefined) {
      sofaPriceTier = isValidTier(body.sofaPriceTier)
        ? body.sofaPriceTier
        : null;
    }
    let bedframePriceTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | null =
      existing.bedframePriceTier;
    if (body.bedframePriceTier !== undefined) {
      bedframePriceTier = isValidTier(body.bedframePriceTier)
        ? body.bedframePriceTier
        : null;
    }
    const price = body.price !== undefined ? Number(body.price) : existing.price;
    const soh = body.soh !== undefined ? Number(body.soh) : existing.soh;
    const reorderPoint =
      body.reorderPoint !== undefined
        ? Number(body.reorderPoint)
        : existing.reorderPoint;

    await c.var.DB.prepare(
      `UPDATE fabric_trackings
         SET priceTier = ?, sofaPriceTier = ?, bedframePriceTier = ?,
             price = ?, soh = ?, reorderPoint = ?
       WHERE id = ?`,
    )
      .bind(
        priceTier,
        sofaPriceTier,
        bedframePriceTier,
        price,
        soh,
        reorderPoint,
        id,
      )
      .run();

    const updated = await c.var.DB.prepare(
      "SELECT * FROM fabric_trackings WHERE id = ?",
    )
      .bind(id)
      .first<FabricTrackingRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload fabric tracking" },
        500,
      );
    }
    await wipeFabricSnapshot(c);
    return c.json({ success: true, data: rowToTracking(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;

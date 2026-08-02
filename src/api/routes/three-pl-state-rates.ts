// ---------------------------------------------------------------------------
// three-pl-state-rates.ts — per-provider, per-state delivery rate card.
//
// Each 3PL provider (row in the legacy `drivers` table — COMPANIES, see
// migration 0014's naming-misnomer note) quotes by DESTINATION STATE: a
// Penang trip and a Johor trip cost different money. This table keys the
// rate pair on (provider_id, state) where `state` is a canonical 3-letter
// code from src/lib/malaysia-states.ts. 0/0 = unset (house rule): the
// provider does not serve that state / no quote captured yet.
//
// Endpoints (RBAC resource "drivers", same as the provider company route):
//   GET /?providerId=X   fixed card: one entry per canonical state (16).
//                        Missing rows are lazily seeded (INSERT ... ON
//                        CONFLICT DO NOTHING) so the UI always sees the
//                        full grid.
//   PUT /bulk            { providerId, rates: [{ state, ratePerTripSen,
//                        ratePerExtraDropSen, remarks? }] } — validates
//                        every state against MALAYSIA_STATES codes
//                        (reject-don't-normalize: legacy shorthand like
//                        "KL" is a 400, not a silent KUL), upserts the
//                        whole batch in one transaction, returns the
//                        fresh card.
//
// Phase 1 = schema + CRUD + UI only. NO cost-calculation path reads this
// table yet (delivery-orders.ts / packing-lists.ts / consignments are
// untouched); wiring the DO cost lookup to the state card is Phase 2.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { MALAYSIA_STATES, isMalaysiaStateCode } from "../../lib/malaysia-states";

const app = new Hono<Env>();

// --- Runtime self-apply (production-folders.ts pattern) ---------------------
// Mirrors migrations-postgres/0157_three_pl_state_rates.sql so prod works
// before the migration script runs. Module-level promise = one flight per
// isolate; per-statement try/catch so a benign failure (table already
// exists) never poisons the cached promise.
let pendingMigrations: Promise<void> | null = null;
export function ensureThreePlStateRatesSchema(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS three_pl_state_rates (
         id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL DEFAULT 'hookka',
         provider_id TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
         state TEXT NOT NULL,
         rate_per_trip_sen INTEGER NOT NULL DEFAULT 0,
         rate_per_extra_drop_sen INTEGER NOT NULL DEFAULT 0,
         remarks TEXT,
         created_at TEXT,
         updated_at TEXT,
         UNIQUE (provider_id, state)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_three_pl_state_rates_provider
         ON three_pl_state_rates(provider_id)`,
    ];
    await runSelfApply(db, "three-pl-state-rates", stmts);
  })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    pendingMigrations = null;
    throw err;
  });
  return pendingMigrations;
}

type StateRateRow = {
  id: string;
  orgId: string;
  providerId: string;
  state: string;
  ratePerTripSen: number;
  ratePerExtraDropSen: number;
  remarks: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function rowToRate(row: StateRateRow, label: string) {
  return {
    id: row.id,
    providerId: row.providerId,
    state: row.state,
    stateLabel: label,
    ratePerTripSen: row.ratePerTripSen,
    ratePerExtraDropSen: row.ratePerExtraDropSen,
    remarks: row.remarks ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

function genId(): string {
  return `tpsr-${crypto.randomUUID().slice(0, 8)}`;
}

// Seed any missing canonical-state rows for the provider (0/0 = unset),
// then read the full card back in MALAYSIA_STATES display order. Always
// returns exactly one entry per canonical state.
async function seedAndReadCard(
  db: D1Database,
  orgId: string,
  providerId: string,
) {
  const now = new Date().toISOString();
  await db.batch(
    MALAYSIA_STATES.map((s) =>
      db
        .prepare(
          `INSERT INTO three_pl_state_rates
             (id, orgId, providerId, state, ratePerTripSen, ratePerExtraDropSen, remarks, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?)
           ON CONFLICT (providerId, state) DO NOTHING`,
        )
        .bind(genId(), orgId, providerId, s.code, now, now),
    ),
  );
  const res = await db
    .prepare(
      "SELECT * FROM three_pl_state_rates WHERE orgId = ? AND providerId = ?",
    )
    .bind(orgId, providerId)
    .all<StateRateRow>();
  const byCode = new Map((res.results ?? []).map((r) => [r.state, r]));
  return MALAYSIA_STATES.map((s) => {
    const row = byCode.get(s.code);
    // Synthesize a zero entry if the seed insert raced/failed — the card
    // contract is "one entry per canonical state", never a sparse list.
    return row
      ? rowToRate(row, s.label)
      : rowToRate(
          {
            id: "",
            orgId,
            providerId,
            state: s.code,
            ratePerTripSen: 0,
            ratePerExtraDropSen: 0,
            remarks: null,
            createdAt: null,
            updatedAt: null,
          },
          s.label,
        );
  });
}

// Org-scoped provider existence check — the card hangs off a company row.
async function findProvider(
  db: D1Database,
  orgId: string,
  providerId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM drivers WHERE id = ? AND orgId = ?")
    .bind(providerId, orgId)
    .first<{ id: string }>();
  return !!row;
}

// GET /api/three-pl-state-rates?providerId=...
// Auth-only (no per-role read gate) — mirrors the sibling drivers.ts /
// three-pl-vehicles.ts GETs so every role that can open the 3PL tab can
// also read the rate card. Mutations below ARE gated (drivers:update).
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  const providerId = (c.req.query("providerId") || "").trim();
  if (!providerId) {
    return c.json({ success: false, error: "providerId is required" }, 400);
  }
  await ensureThreePlStateRatesSchema(c.var.DB);
  if (!(await findProvider(c.var.DB, orgId, providerId))) {
    return c.json({ success: false, error: "Provider not found" }, 404);
  }
  const data = await seedAndReadCard(c.var.DB, orgId, providerId);
  return c.json({ success: true, data, total: data.length });
});

// PUT /api/three-pl-state-rates/bulk
// Body: { providerId, rates: [{ state, ratePerTripSen, ratePerExtraDropSen, remarks? }] }
// Validates EVERYTHING before writing anything; the upsert batch runs in a
// single transaction (SupabaseAdapter.batch wraps sql.begin).
app.put("/bulk", async (c) => {
  const denied = await requirePermission(c, "drivers", "update");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const body = await c.req.json();
    const providerId =
      typeof body.providerId === "string" ? body.providerId.trim() : "";
    if (!providerId || !Array.isArray(body.rates)) {
      return c.json(
        { success: false, error: "providerId and rates[] are required" },
        400,
      );
    }
    await ensureThreePlStateRatesSchema(c.var.DB);
    if (!(await findProvider(c.var.DB, orgId, providerId))) {
      return c.json({ success: false, error: "Provider not found" }, 404);
    }

    // --- Validate every entry up front (reject-don't-normalize) ---------
    type CleanRate = {
      state: string;
      ratePerTripSen: number;
      ratePerExtraDropSen: number;
      remarks: string | null | undefined; // undefined = leave existing remarks
    };
    const seen = new Set<string>();
    const cleaned: CleanRate[] = [];
    for (const raw of body.rates as unknown[]) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const state = entry.state;
      if (!isMalaysiaStateCode(state)) {
        return c.json(
          {
            success: false,
            error: `Unknown state code: ${String(state)}. Use canonical codes (${MALAYSIA_STATES.map((s) => s.code).join(", ")}).`,
          },
          400,
        );
      }
      if (seen.has(state)) {
        return c.json(
          { success: false, error: `Duplicate state in rates: ${state}` },
          400,
        );
      }
      seen.add(state);
      const trip = entry.ratePerTripSen;
      const drop = entry.ratePerExtraDropSen;
      if (
        typeof trip !== "number" ||
        !Number.isInteger(trip) ||
        trip < 0 ||
        typeof drop !== "number" ||
        !Number.isInteger(drop) ||
        drop < 0
      ) {
        return c.json(
          {
            success: false,
            error: `Invalid rate for ${state}: ratePerTripSen and ratePerExtraDropSen must be non-negative integers (sen)`,
          },
          400,
        );
      }
      if (entry.remarks !== undefined && typeof entry.remarks !== "string") {
        return c.json(
          { success: false, error: `Invalid remarks for ${state}: must be a string` },
          400,
        );
      }
      cleaned.push({
        state,
        ratePerTripSen: trip,
        ratePerExtraDropSen: drop,
        remarks: entry.remarks as string | undefined,
      });
    }

    // --- Upsert the whole card in one batch (transaction) ---------------
    if (cleaned.length > 0) {
      const now = new Date().toISOString();
      await c.var.DB.batch(
        cleaned.map((r) => {
          // Two variants so an entry WITHOUT remarks leaves any existing
          // remark untouched (don't clobber a field the caller didn't send).
          const sql =
            r.remarks !== undefined
              ? `INSERT INTO three_pl_state_rates
                   (id, orgId, providerId, state, ratePerTripSen, ratePerExtraDropSen, remarks, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (providerId, state) DO UPDATE SET
                   ratePerTripSen = EXCLUDED.ratePerTripSen,
                   ratePerExtraDropSen = EXCLUDED.ratePerExtraDropSen,
                   remarks = EXCLUDED.remarks,
                   updated_at = EXCLUDED.updated_at`
              : `INSERT INTO three_pl_state_rates
                   (id, orgId, providerId, state, ratePerTripSen, ratePerExtraDropSen, remarks, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
                 ON CONFLICT (providerId, state) DO UPDATE SET
                   ratePerTripSen = EXCLUDED.ratePerTripSen,
                   ratePerExtraDropSen = EXCLUDED.ratePerExtraDropSen,
                   updated_at = EXCLUDED.updated_at`;
          const stmt = c.var.DB.prepare(sql);
          return r.remarks !== undefined
            ? stmt.bind(
                genId(),
                orgId,
                providerId,
                r.state,
                r.ratePerTripSen,
                r.ratePerExtraDropSen,
                r.remarks,
                now,
                now,
              )
            : stmt.bind(
                genId(),
                orgId,
                providerId,
                r.state,
                r.ratePerTripSen,
                r.ratePerExtraDropSen,
                now,
                now,
              );
        }),
      );
    }

    const data = await seedAndReadCard(c.var.DB, orgId, providerId);
    return c.json({ success: true, data, total: data.length });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

export default app;

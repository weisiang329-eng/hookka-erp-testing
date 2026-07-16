// ---------------------------------------------------------------------------
// Pay rules — effective-dated versions (owner 2026-06-11).
//   GET  /api/pay-rules        → all versions + the rules in force today
//   POST /api/pay-rules        → schedule a new version { effectiveFrom, rules, note? }
//   DELETE /api/pay-rules/:id  → remove a FUTURE-dated version only (a typo in
//                                a scheduled change); in-force history is kept.
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import {
  DEFAULT_PAY_RULES,
  normalizePayRules,
  resolvePayRulesAsOf,
} from "../../lib/pay-rules";
import {
  ensurePayRuleVersions,
  loadPayRuleVersions,
} from "../lib/pay-rules-store";

const app = new Hono<Env>();

// Explicit snapshot wipe on write. worker_payslips_snapshot and
// worker_history_snapshot both derive from pay_rule_versions, but that table
// has no updated_at/created_at column so the freshness probe cannot
// auto-invalidate them. Every pay_rule_versions write path must DELETE the
// affected snapshot rows itself. Wrapped so a wipe failure never breaks the save.
async function wipePayRuleSnapshots(c: Context<Env>) {
  try {
    const { getOrgId } = await import("../lib/tenant");
    const { invalidateSnapshot } = await import("../lib/snapshot");
    const orgId = getOrgId(c);
    await invalidateSnapshot(
      c.var.DB,
      { tableName: "worker_payslips_snapshot", sourceTables: [] },
      orgId,
    );
    await invalidateSnapshot(
      c.var.DB,
      { tableName: "worker_history_snapshot", sourceTables: [] },
      orgId,
    );
  } catch (e) {
    console.warn("[pay-rules-write] snapshot wipe failed:", e);
  }
}

app.get("/", async (c) => {
  const denied = await requirePermission(c, "payslips", "read");
  if (denied) return denied;
  const versions = await loadPayRuleVersions(c.var.DB);
  const today = new Date().toISOString().slice(0, 10);
  versions.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return c.json({
    success: true,
    data: {
      versions,
      defaults: DEFAULT_PAY_RULES,
      effectiveToday: resolvePayRulesAsOf(versions, today),
    },
  });
});

app.post("/", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const effectiveFrom = String(body.effectiveFrom ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return c.json(
      { success: false, error: "effectiveFrom must be YYYY-MM-DD" },
      400,
    );
  }
  const rules = normalizePayRules(body.rules);
  if (rules.shiftEndMin <= rules.shiftStartMin) {
    return c.json(
      { success: false, error: "Shift end must be after shift start" },
      400,
    );
  }
  if (rules.shiftEndMin - rules.shiftStartMin <= rules.lunchMin) {
    return c.json(
      { success: false, error: "Lunch cannot consume the whole shift" },
      400,
    );
  }
  await ensurePayRuleVersions(c.var.DB);
  const id = `prv-${crypto.randomUUID().slice(0, 8)}`;
  await c.var.DB.prepare(
    `INSERT INTO pay_rule_versions (id, effectivefrom, rulesjson, note, createdat, createdby)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      effectiveFrom,
      JSON.stringify(rules),
      (body.note as string) ?? null,
      new Date().toISOString(),
      (body.changedBy as string) ?? null,
    )
    .run();
  await wipePayRuleSnapshots(c);
  return c.json({ success: true, data: { id, effectiveFrom, rules } }, 201);
});

app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "payslips", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const today = new Date().toISOString().slice(0, 10);
  await ensurePayRuleVersions(c.var.DB);
  // Only future-dated versions can be removed — in-force history is the
  // audit trail for already-computed payrolls.
  const res = await c.var.DB.prepare(
    "DELETE FROM pay_rule_versions WHERE id = ? AND effectivefrom > ?",
  )
    .bind(id, today)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    return c.json(
      { success: false, error: "Only future-dated versions can be deleted" },
      400,
    );
  }
  await wipePayRuleSnapshots(c);
  return c.json({ success: true });
});

export default app;

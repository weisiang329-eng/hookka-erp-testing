// ---------------------------------------------------------------------------
// D1-backed workers route.
//
// Mirrors the old src/api/routes/workers.ts shape so the SPA frontend
// doesn't need any changes. On POST/PUT, `departmentCode` is resolved by
// joining on the departments table rather than trusting the client payload.
// ---------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { normalizePaymentMethod } from "../../lib/payment-method";
import { ensurePaymentColumns } from "../lib/payment-columns";
import { effectiveSalarySenForMonth } from "../../lib/labor-engine";
import { emitAudit } from "../lib/audit";
import { hashPin } from "../lib/auth-utils";

const app = new Hono<Env>();

type WorkerRow = {
  id: string;
  empNo: string;
  name: string;
  departmentId: string | null;
  departmentCode: string | null;
  // Multi-department support — Wei Siang 2026-05-10. JSON array of dept
  // codes, e.g. '["FAB_CUT","FAB_SEW"]'. departmentCode stays as the
  // primary (legacy single) for back-compat with reads that filter by code.
  departmentCodes: string | null;
  // Production categories the worker covers. JSON array of "SOFA" / "BEDFRAME".
  // Empty/null = no filter (worker handles whatever). For Operator Leaders
  // this scopes which (dept × category) cells the Team dashboard surfaces.
  categories: string | null;
  position: string | null;
  phone: string | null;
  status: string;
  basicSalarySen: number;
  workingHoursPerDay: number;
  workingDaysPerMonth: number;
  otMultiplier: number | null;
  // Per-worker statutory toggles (migration 0131). When false the matching
  // line in calcStatutory (payslips.ts) is zeroed out. Defaults to TRUE on
  // existing rows via the migration so legacy behaviour is preserved; the
  // operator opts out individual workers via the Employee Master tab.
  epfEnabled: boolean | null;
  socsoEnabled: boolean | null;
  eisEnabled: boolean | null;
  pcbEnabled: boolean | null;
  joinDate: string | null;
  icNumber: string | null;
  passportNumber: string | null;
  nationality: string | null;
  // YYYY-MM-DD last day of employment (migration 0143). NULL for current
  // staff. Set together with status = 'RESIGNED' so payroll stops after the
  // resignation month.
  resignedAt: string | null;
  // Per-worker efficiency bonus config (migration 0151). efficiencyAllowanceSen
  // = the flat bonus (money, in sen) paid when the worker's efficiency over the
  // selected payroll period reaches efficiencyThresholdPct. Both default 0 on
  // existing rows, so no one earns a bonus until the operator sets a real
  // amount. The Payroll entitlement engine (Phase 2) consumes these.
  efficiencyAllowanceSen: number;
  efficiencyThresholdPct: number | null;
  // How this worker is paid — the DEFAULT the payroll run copies each month.
  paymentMethod: string | null;
  bankName: string | null;
  bankAccount: string | null;
};

type DepartmentRow = {
  id: string;
  code: string;
  workingHoursPerDay: number;
};

function parseDepartmentCodes(raw: string | null, fallback: string): string[] {
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const cleaned = arr
          .filter((x): x is string => typeof x === "string" && x.length > 0);
        if (cleaned.length > 0) return cleaned;
      }
    } catch {
      /* fall through to single */
    }
  }
  return fallback ? [fallback] : [];
}

function parseCategories(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.filter(
        (x): x is string => typeof x === "string" && (x === "SOFA" || x === "BEDFRAME"),
      );
    }
  } catch {
    /* malformed → no filter */
  }
  return [];
}

function rowToWorker(row: WorkerRow) {
  return {
    id: row.id,
    empNo: row.empNo,
    name: row.name,
    departmentId: row.departmentId ?? "",
    departmentCode: row.departmentCode ?? "",
    departmentCodes: parseDepartmentCodes(row.departmentCodes, row.departmentCode ?? ""),
    categories: parseCategories(row.categories),
    position: row.position ?? "",
    phone: row.phone ?? "",
    status: row.status,
    basicSalarySen: row.basicSalarySen,
    workingHoursPerDay: row.workingHoursPerDay,
    workingDaysPerMonth: row.workingDaysPerMonth,
    otMultiplier: row.otMultiplier ?? 1.5,
    // Statutory toggles — null/undefined treated as true so the response
    // shape is always boolean (matches the DB default of TRUE).
    epfEnabled: row.epfEnabled !== false,
    socsoEnabled: row.socsoEnabled !== false,
    eisEnabled: row.eisEnabled !== false,
    pcbEnabled: row.pcbEnabled !== false,
    joinDate: row.joinDate ?? "",
    icNumber: row.icNumber ?? "",
    passportNumber: row.passportNumber ?? "",
    nationality: row.nationality ?? "",
    resignedAt: row.resignedAt ?? "",
    efficiencyAllowanceSen: row.efficiencyAllowanceSen ?? 0,
    efficiencyThresholdPct: row.efficiencyThresholdPct ?? 0,
    paymentMethod: normalizePaymentMethod(row.paymentMethod),
    bankName: row.bankName ?? "",
    bankAccount: row.bankAccount ?? "",
  };
}

function genId(): string {
  return `worker-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/workers?departmentId=dept-1
//   ?departmentCode=FAB_CUT — alternative when caller has the code (e.g.
//   the Service Case root-cause form picks dept by code, not id).
app.get("/", async (c) => {
  await ensurePaymentColumns(c.var.DB);
  // RBAC gate (P3.3-followup) — workers:read.
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const departmentId = c.req.query("departmentId");
  const departmentCode = c.req.query("departmentCode");
  let stmt: D1PreparedStatement;
  if (departmentId) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM workers WHERE departmentId = ? ORDER BY empNo",
    ).bind(departmentId);
  } else if (departmentCode) {
    stmt = c.var.DB.prepare(
      "SELECT * FROM workers WHERE departmentCode = ? ORDER BY empNo",
    ).bind(departmentCode);
  } else {
    stmt = c.var.DB.prepare("SELECT * FROM workers ORDER BY empNo");
  }
  const res = await stmt.all<WorkerRow>();
  const data = (res.results ?? []).map(rowToWorker);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/workers — create
app.post("/", async (c) => {
  await ensurePaymentColumns(c.var.DB);
  // RBAC gate (P3.3-followup) — workers:create.
  const denied = await requirePermission(c, "workers", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const {
      name,
      empNo,
      departmentId,
      position,
      phone,
      basicSalarySen,
      workingHoursPerDay,
      otMultiplier,
      epfEnabled,
      socsoEnabled,
      eisEnabled,
      pcbEnabled,
      efficiencyAllowanceSen,
      efficiencyThresholdPct,
      paymentMethod,
      bankName,
      bankAccount,
    } = body;

    if (!name || !empNo) {
      return c.json(
        { success: false, error: "name and empNo are required" },
        400,
      );
    }

    // Efficiency bonus config — reject out-of-range rather than normalize
    // (mirrors the frontend Save guard). Allowance is money in sen (>= 0);
    // threshold is a percentage (0–100). Undefined → default 0.
    const effAllowanceSen =
      efficiencyAllowanceSen == null ? 0 : Math.round(Number(efficiencyAllowanceSen));
    const effThresholdPct =
      efficiencyThresholdPct == null ? 0 : Number(efficiencyThresholdPct);
    if (!Number.isFinite(effAllowanceSen) || effAllowanceSen < 0) {
      return c.json(
        { success: false, error: "Efficiency allowance must be 0 or more." },
        400,
      );
    }
    if (!Number.isFinite(effThresholdPct) || effThresholdPct < 0 || effThresholdPct > 100) {
      return c.json(
        { success: false, error: "Efficiency threshold must be between 0 and 100." },
        400,
      );
    }

    const department = await c.var.DB.prepare(
      "SELECT id, code, workingHoursPerDay FROM departments WHERE id = ?",
    )
      .bind(departmentId)
      .first<DepartmentRow>();
    if (!department) {
      return c.json({ success: false, error: "Department not found" }, 400);
    }

    const id = genId();
    const joinDate = new Date().toISOString().split("T")[0];
    const resolvedHours =
      workingHoursPerDay ?? department.workingHoursPerDay;

    // Multi-dept support: caller may pass an explicit departmentCodes array.
    // If absent, fall back to a single-element array of the resolved primary
    // department code so the new column never holds NULL on creates.
    const incomingCodes = Array.isArray(body.departmentCodes)
      ? (body.departmentCodes as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : null;
    const codesArr =
      incomingCodes && incomingCodes.length > 0 ? incomingCodes : [department.code];
    // Primary department code = the array's first entry. Keeps existing
    // single-code consumers (lookups by departmentCode) working.
    const primaryCode = codesArr[0];

    const incomingCategories = Array.isArray(body.categories)
      ? (body.categories as unknown[]).filter(
          (x): x is string => x === "SOFA" || x === "BEDFRAME",
        )
      : [];

    await c.var.DB.prepare(
      `INSERT INTO workers (id, empNo, name, departmentId, departmentCode, departmentCodes, categories, position,
         phone, status, basicSalarySen, workingHoursPerDay, workingDaysPerMonth, otMultiplier,
         epfEnabled, socsoEnabled, eisEnabled, pcbEnabled,
         joinDate, icNumber, passportNumber, nationality,
         efficiencyAllowanceSen, efficiencyThresholdPct,
         paymentMethod, bankName, bankAccount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        empNo,
        name,
        departmentId,
        primaryCode,
        JSON.stringify(codesArr),
        JSON.stringify(incomingCategories),
        position ?? "",
        phone ?? "",
        "ACTIVE",
        basicSalarySen ?? 0,
        resolvedHours,
        26,
        Number.isFinite(otMultiplier) ? otMultiplier : 1.5,
        // Statutory flags — default false (matches the new-worker UX). The
        // DB column default is TRUE for back-compat but we now opt-in via
        // explicit value so the operator's unticked form is honoured.
        typeof epfEnabled === "boolean" ? epfEnabled : false,
        typeof socsoEnabled === "boolean" ? socsoEnabled : false,
        typeof eisEnabled === "boolean" ? eisEnabled : false,
        typeof pcbEnabled === "boolean" ? pcbEnabled : false,
        joinDate,
        "",
        "",
        "",
        effAllowanceSen,
        effThresholdPct,
        // Cash needs no bank; storing them anyway leaves a stale account behind
        // the moment someone is switched to cash.
        normalizePaymentMethod(paymentMethod),
        normalizePaymentMethod(paymentMethod) === "CASH" ? null : (typeof bankName === "string" ? bankName.trim() : null),
        normalizePaymentMethod(paymentMethod) === "CASH" ? null : (typeof bankAccount === "string" ? bankAccount.trim() : null),
      )
      .run();

    const created = await c.var.DB.prepare(
      "SELECT * FROM workers WHERE id = ?",
    )
      .bind(id)
      .first<WorkerRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create worker" },
        500,
      );
    }
    return c.json({ success: true, data: rowToWorker(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/workers/:id
app.get("/:id", async (c) => {
  await ensurePaymentColumns(c.var.DB);
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  if (!row) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }
  return c.json({ success: true, data: rowToWorker(row) });
});

// PUT /api/workers/:id — update
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM workers WHERE id = ?",
    )
      .bind(id)
      .first<WorkerRow>();
    if (!existing) {
      return c.json({ success: false, error: "Worker not found" }, 404);
    }
    const body = await c.req.json();

    // If departmentId changes, re-resolve departmentCode from the departments table.
    let nextDepartmentCode = existing.departmentCode;
    const nextDepartmentId =
      body.departmentId !== undefined
        ? body.departmentId
        : existing.departmentId;
    if (
      body.departmentId !== undefined &&
      body.departmentId !== existing.departmentId
    ) {
      const department = await c.var.DB.prepare(
        "SELECT id, code, workingHoursPerDay FROM departments WHERE id = ?",
      )
        .bind(body.departmentId)
        .first<DepartmentRow>();
      if (!department) {
        return c.json({ success: false, error: "Department not found" }, 400);
      }
      nextDepartmentCode = department.code;
    } else if (body.departmentCode !== undefined) {
      // Allow explicit override only when departmentId didn't change.
      nextDepartmentCode = body.departmentCode;
    }

    // Multi-dept resolution. If caller passes departmentCodes explicitly use
    // it; otherwise keep the existing array (or fall back to the single
    // primary code we just resolved). Primary code is always set to the
    // first entry of the final array.
    const incomingCodes = Array.isArray(body.departmentCodes)
      ? (body.departmentCodes as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : null;
    const existingCodes = parseDepartmentCodes(
      existing.departmentCodes,
      existing.departmentCode ?? "",
    );
    const finalCodes =
      incomingCodes !== null && incomingCodes.length > 0
        ? incomingCodes
        : existingCodes.length > 0
          ? existingCodes
          : nextDepartmentCode
            ? [nextDepartmentCode]
            : [];
    const finalPrimary = finalCodes[0] ?? nextDepartmentCode ?? "";

    const incomingCategories = Array.isArray(body.categories)
      ? (body.categories as unknown[]).filter(
          (x): x is string => x === "SOFA" || x === "BEDFRAME",
        )
      : null;
    const finalCategories =
      incomingCategories !== null
        ? incomingCategories
        : parseCategories(existing.categories);

    // ── Resignation. status === 'RESIGNED' requires a resignation date so
    //    payroll knows which month is the worker's last paid one. Moving the
    //    status to anything else clears the date. A bad date is rejected at the
    //    backend (the frontend Save handler rejects the same way) rather than
    //    silently stored.
    const nextStatus = body.status ?? existing.status;
    const isValidDate = (v: unknown): v is string =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    let nextResignedAt: string | null;
    if (nextStatus === "RESIGNED") {
      const candidate =
        body.resignedAt !== undefined ? body.resignedAt : existing.resignedAt;
      if (!isValidDate(candidate)) {
        return c.json(
          {
            success: false,
            error: "A resignation date (YYYY-MM-DD) is required when status is Resigned.",
          },
          400,
        );
      }
      nextResignedAt = candidate;
    } else {
      // Reject a stray resignedAt on a non-resigned worker rather than store a
      // contradictory pair.
      if (body.resignedAt && isValidDate(body.resignedAt)) {
        return c.json(
          {
            success: false,
            error: "Set status to Resigned before recording a resignation date.",
          },
          400,
        );
      }
      nextResignedAt = null;
    }

    // Efficiency bonus config — reject out-of-range (same guard as POST +
    // the frontend Save handler). Undefined in the body keeps the existing
    // value (partial-update friendly).
    const nextEffAllowanceSen =
      body.efficiencyAllowanceSen == null
        ? existing.efficiencyAllowanceSen ?? 0
        : Math.round(Number(body.efficiencyAllowanceSen));
    const nextEffThresholdPct =
      body.efficiencyThresholdPct == null
        ? existing.efficiencyThresholdPct ?? 0
        : Number(body.efficiencyThresholdPct);
    if (!Number.isFinite(nextEffAllowanceSen) || nextEffAllowanceSen < 0) {
      return c.json(
        { success: false, error: "Efficiency allowance must be 0 or more." },
        400,
      );
    }
    if (
      !Number.isFinite(nextEffThresholdPct) ||
      nextEffThresholdPct < 0 ||
      nextEffThresholdPct > 100
    ) {
      return c.json(
        { success: false, error: "Efficiency threshold must be between 0 and 100." },
        400,
      );
    }

    const merged = {
      // Payment defaults — an omitted field keeps what is already stored, so a
      // partial PUT from another screen can't silently blank someone's bank.
      paymentMethod: body.paymentMethod ?? existing.paymentMethod,
      bankName: body.bankName ?? existing.bankName,
      bankAccount: body.bankAccount ?? existing.bankAccount,
      name: body.name ?? existing.name,
      empNo: body.empNo ?? existing.empNo,
      departmentId: nextDepartmentId,
      departmentCode: finalPrimary,
      departmentCodes: JSON.stringify(finalCodes),
      categories: JSON.stringify(finalCategories),
      position: body.position ?? existing.position ?? "",
      phone: body.phone ?? existing.phone ?? "",
      status: nextStatus,
      basicSalarySen: body.basicSalarySen ?? existing.basicSalarySen,
      workingHoursPerDay:
        body.workingHoursPerDay ?? existing.workingHoursPerDay,
      workingDaysPerMonth:
        body.workingDaysPerMonth ?? existing.workingDaysPerMonth,
      otMultiplier:
        body.otMultiplier ?? existing.otMultiplier ?? 1.5,
      epfEnabled:
        typeof body.epfEnabled === "boolean"
          ? body.epfEnabled
          : existing.epfEnabled !== false,
      socsoEnabled:
        typeof body.socsoEnabled === "boolean"
          ? body.socsoEnabled
          : existing.socsoEnabled !== false,
      eisEnabled:
        typeof body.eisEnabled === "boolean"
          ? body.eisEnabled
          : existing.eisEnabled !== false,
      pcbEnabled:
        typeof body.pcbEnabled === "boolean"
          ? body.pcbEnabled
          : existing.pcbEnabled !== false,
      joinDate: body.joinDate ?? existing.joinDate ?? "",
      icNumber: body.icNumber ?? existing.icNumber ?? "",
      passportNumber: body.passportNumber ?? existing.passportNumber ?? "",
      nationality: body.nationality ?? existing.nationality ?? "",
      resignedAt: nextResignedAt,
      efficiencyAllowanceSen: nextEffAllowanceSen,
      efficiencyThresholdPct: nextEffThresholdPct,
    };

    await c.var.DB.prepare(
      `UPDATE workers SET
         name = ?, empNo = ?, departmentId = ?, departmentCode = ?, departmentCodes = ?, categories = ?,
         position = ?, phone = ?, status = ?, basicSalarySen = ?,
         workingHoursPerDay = ?, workingDaysPerMonth = ?, otMultiplier = ?,
         epfEnabled = ?, socsoEnabled = ?, eisEnabled = ?, pcbEnabled = ?,
         joinDate = ?, icNumber = ?, passportNumber = ?, nationality = ?, resignedAt = ?,
         efficiencyAllowanceSen = ?, efficiencyThresholdPct = ?,
         paymentMethod = ?, bankName = ?, bankAccount = ?
       WHERE id = ?`,
    )
      .bind(
        merged.name,
        merged.empNo,
        merged.departmentId,
        merged.departmentCode,
        merged.departmentCodes,
        merged.categories,
        merged.position,
        merged.phone,
        merged.status,
        merged.basicSalarySen,
        merged.workingHoursPerDay,
        merged.workingDaysPerMonth,
        merged.otMultiplier,
        merged.epfEnabled,
        merged.socsoEnabled,
        merged.eisEnabled,
        merged.pcbEnabled,
        merged.joinDate,
        merged.icNumber,
        merged.passportNumber,
        merged.nationality,
        merged.resignedAt,
        merged.efficiencyAllowanceSen,
        merged.efficiencyThresholdPct,
        normalizePaymentMethod(merged.paymentMethod),
        normalizePaymentMethod(merged.paymentMethod) === "CASH" ? null : (merged.bankName || null),
        normalizePaymentMethod(merged.paymentMethod) === "CASH" ? null : (merged.bankAccount || null),
        id,
      )
      .run();

    // Resigning / deactivating a worker locks them OUT of the worker app
    // immediately: purge their login tokens so a phone already signed in is
    // kicked. (Login already blocks non-ACTIVE, and getWorker now rejects a
    // non-ACTIVE worker on every request — this clears the lingering session
    // so the lock takes effect the moment you set the status, not on next login.)
    if (merged.status !== "ACTIVE") {
      await c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
        .bind(id)
        .run();
    }

    // Keep the salary-history in sync with an inline salary edit: correct the
    // row currently in effect (newest effectiveFrom <= today) so payroll — which
    // reads the history — reflects the change. A future-dated raise is set via
    // POST /:id/salary-history instead. Best-effort (skip if table absent).
    if (
      body.basicSalarySen !== undefined &&
      merged.basicSalarySen !== existing.basicSalarySen
    ) {
      try {
        const todayIso = new Date().toISOString().slice(0, 10);
        const cur = await c.var.DB.prepare(
          "SELECT id FROM worker_salary_history WHERE workerId = ? AND effectiveFrom <= ? ORDER BY effectiveFrom DESC, createdAt DESC LIMIT 1",
        )
          .bind(id, todayIso)
          .first<{ id: string }>();
        if (cur) {
          await c.var.DB.prepare(
            "UPDATE worker_salary_history SET basicSalarySen = ? WHERE id = ?",
          )
            .bind(merged.basicSalarySen, cur.id)
            .run();
        } else {
          await c.var.DB.prepare(
            "INSERT INTO worker_salary_history (id, workerId, basicSalarySen, effectiveFrom, note) VALUES (?, ?, ?, ?, ?)",
          )
            .bind(
              `wsh-${crypto.randomUUID().slice(0, 8)}`,
              id,
              merged.basicSalarySen,
              todayIso,
              "Inline salary correction",
            )
            .run();
        }
      } catch (e) {
        console.warn("[workers] salary-history inline sync skipped:", e);
      }
    }

    const updated = await c.var.DB.prepare(
      "SELECT * FROM workers WHERE id = ?",
    )
      .bind(id)
      .first<WorkerRow>();
    if (!updated) {
      return c.json({ success: false, error: "Worker not found" }, 404);
    }
    return c.json({ success: true, data: rowToWorker(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/workers/:id
//
// Default behaviour is a *soft* delete — flips status to INACTIVE so the
// row's history (piece completions, payroll, attendance) stays intact.
// Live worker tokens are purged so any session for that worker is killed
// immediately.
//
// `?hard=1` requires the workers:delete permission (P3.3-followup) — used
// to be a hard-coded SUPER_ADMIN check, now delegated to the role matrix
// so a custom role with workers:delete can be configured. SUPER_ADMIN
// short-circuits via lib/rbac.ts so existing admin behavior is preserved.
// FKs from worker_pins / worker_tokens / attendance / salary_adjustments /
// worker_salary_periods / payroll_records cascade via ON DELETE CASCADE
// (see migrations/0001_init.sql). The soft-FK pic1Id / pic2Id columns on
// job_cards + piece_pics are not declared as FKs, so we explicitly NULL
// them out first to avoid dangling references.
app.delete("/:id", async (c) => {
  // Soft delete is gated as workers:delete too — the row flip kills live
  // sessions and is a security-relevant mutation. Hard delete picks up
  // the same gate; if needed a future split can add a separate
  // `workers:hard-delete` action to the seed.
  const denied = await requirePermission(c, "workers", "delete");
  if (denied) return denied;

  const id = c.req.param("id");
  const existing = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  if (!existing) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }

  const hard = c.req.query("hard") === "1";

  if (hard) {

    // Nullify the soft-FK pic columns on job_cards + piece_pics so the
    // cascade delete doesn't leave orphaned worker references. Wrapped in
    // a batch with the terminal DELETE so partial failures roll back.
    await c.var.DB.batch([
      c.var.DB.prepare(
        "UPDATE job_cards SET pic1Id = NULL, pic1Name = NULL WHERE pic1Id = ?",
      ).bind(id),
      c.var.DB.prepare(
        "UPDATE job_cards SET pic2Id = NULL, pic2Name = NULL WHERE pic2Id = ?",
      ).bind(id),
      c.var.DB.prepare(
        "UPDATE piece_pics SET pic1Id = NULL, pic1Name = NULL WHERE pic1Id = ?",
      ).bind(id),
      c.var.DB.prepare(
        "UPDATE piece_pics SET pic2Id = NULL, pic2Name = NULL WHERE pic2Id = ?",
      ).bind(id),
      c.var.DB.prepare("DELETE FROM workers WHERE id = ?").bind(id),
    ]);

    // Audit emit (P3.4) — hard delete is irreversible; capture the row
    // snapshot so a future forensic query can reconstruct who/what was
    // wiped. Soft delete is journaled via job_card_events / status flips
    // already; only the hard-delete branch needs an audit row here.
    await emitAudit(c, {
      resource: "workers",
      resourceId: id,
      action: "delete",
      before: rowToWorker(existing),
    });

    // Return a synthetic "terminated" snapshot so the client sees the final
    // state without another round-trip.
    return c.json({
      success: true,
      data: { ...rowToWorker(existing), status: "DELETED" },
    });
  }

  // Soft delete path — idempotent: re-hitting on an already-INACTIVE row is
  // a no-op (status stays INACTIVE, no audit column on this table).
  //
  // NOTE: the workers table has no updated_at column (see 0001_init.sql),
  // which is why the spec's `updated_at = ?` clause is skipped here.
  await c.var.DB.batch([
    c.var.DB.prepare(
      "UPDATE workers SET status = 'INACTIVE' WHERE id = ?",
    ).bind(id),
    // Kill any live worker-portal sessions so the inactive worker can't
    // keep browsing on an old token.
    c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?").bind(id),
  ]);
  const updated = await c.var.DB.prepare("SELECT * FROM workers WHERE id = ?")
    .bind(id)
    .first<WorkerRow>();
  return c.json({
    success: true,
    data: updated
      ? rowToWorker(updated)
      : { ...rowToWorker(existing), status: "INACTIVE" },
  });
});

// ---------------------------------------------------------------------------
// Admin PIN provisioning
// ---------------------------------------------------------------------------
//
// Two endpoints for the Employee Master page so the operator can hand out PINs
// directly instead of relying on workers self-onboarding via the existing
// /api/worker-auth/login firstTimePin path. Cleartext PINs are returned EXACTLY
// once in the response (subsequent reads only see the SHA-256 hash) — admin
// must record/distribute on the spot.
//
// Both endpoints are gated by workers:update. Setting/rotating a PIN also
// invalidates active worker_tokens for the worker so any open mobile session
// is forced to re-authenticate with the new PIN.
//
// The existing self-service reset (POST /api/worker-auth/reset-pin via
// empNo + phoneLast4) remains alive — both flows coexist.
// ---------------------------------------------------------------------------

function generateRandomPin(): string {
  // 6-digit numeric PIN. Math.random is fine here because the entropy of any
  // 6-digit PIN is bounded by the 10^6 search space (regardless of generator),
  // and the worker portal already throttles login attempts at 10/15min via
  // checkLoginRateLimit. crypto.getRandomValues would be marginally better
  // but adds no real security gain for this use case.
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

// POST /api/workers/:id/set-pin
// Body: { pin?: string } — when omitted, generate a random 6-digit PIN.
// Response: { success: true, data: { workerId, empNo, name, pin } }
//   pin is the cleartext, ONE-TIME RETURN ONLY. Admin records and shares.
app.post("/:id/set-pin", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;

  const id = c.req.param("id");
  const worker = await c.var.DB.prepare(
    "SELECT id, empNo, name, status FROM workers WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; empNo: string; name: string; status: string }>();
  if (!worker) {
    return c.json({ success: false, error: "Worker not found" }, 404);
  }

  let body: { pin?: string } = {};
  try {
    body = (await c.req.json()) as { pin?: string };
  } catch {
    body = {};
  }

  let cleartext: string;
  if (typeof body.pin === "string" && body.pin.length > 0) {
    if (!/^\d{6}$/.test(body.pin)) {
      return c.json(
        { success: false, error: "PIN must be 6 digits" },
        400,
      );
    }
    cleartext = body.pin;
  } else {
    cleartext = generateRandomPin();
  }

  const hashed = await hashPin(cleartext);
  const now = new Date().toISOString();

  // UPSERT — admin sets must_reset = false (no forced reset on first login;
  // worker can use the PIN directly).
  await c.var.DB.prepare(
    `INSERT INTO worker_pins (workerId, pin, updatedAt, must_reset) VALUES (?, ?, ?, false)
     ON CONFLICT (workerId) DO UPDATE SET pin = EXCLUDED.pin, updatedAt = EXCLUDED.updatedAt, must_reset = false`,
  )
    .bind(worker.id, hashed, now)
    .run();

  // Force re-login on any open worker portal session for this worker.
  await c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
    .bind(worker.id)
    .run();

  // Audit row — record that the PIN was reset by an admin. The cleartext PIN
  // is intentionally NOT stored on the audit row; only the fact of the reset.
  await emitAudit(c, {
    resource: "workers",
    resourceId: worker.id,
    action: "pin-reset",
  });

  return c.json({
    success: true,
    data: {
      workerId: worker.id,
      empNo: worker.empNo,
      name: worker.name,
      pin: cleartext,
    },
  });
});

// POST /api/workers/bulk-generate-pins
// Body: { workerIds?: string[] }
//   - omitted/empty: every ACTIVE worker without an existing worker_pins row
//   - provided: only those ids (skips ones that are not ACTIVE or vanished)
// Response: { success: true, data: { generated: [{ workerId, empNo, name, pin }], skipped: number } }
//   Cleartext PINs only here — admin must download/record before navigating away.
app.post("/bulk-generate-pins", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;

  let body: { workerIds?: string[] } = {};
  try {
    body = (await c.req.json()) as { workerIds?: string[] };
  } catch {
    body = {};
  }

  let targets: { id: string; empNo: string; name: string }[];
  let skipped = 0;
  if (Array.isArray(body.workerIds) && body.workerIds.length > 0) {
    // Caller-supplied list — fetch matching ACTIVE workers, count ones that
    // didn't resolve as skipped.
    const placeholders = body.workerIds.map(() => "?").join(",");
    const res = await c.var.DB.prepare(
      `SELECT id, empNo, name FROM workers WHERE id IN (${placeholders}) AND status = 'ACTIVE'`,
    )
      .bind(...body.workerIds)
      .all<{ id: string; empNo: string; name: string }>();
    targets = res.results ?? [];
    skipped = body.workerIds.length - targets.length;
  } else {
    // Default — every ACTIVE worker WITHOUT an existing PIN row.
    const res = await c.var.DB.prepare(
      `SELECT w.id AS id, w.empNo AS empNo, w.name AS name
         FROM workers w
         LEFT JOIN worker_pins p ON p.workerId = w.id
        WHERE w.status = 'ACTIVE' AND p.workerId IS NULL
        ORDER BY w.empNo`,
    ).all<{ id: string; empNo: string; name: string }>();
    targets = res.results ?? [];
  }

  const generated: {
    workerId: string;
    empNo: string;
    name: string;
    pin: string;
  }[] = [];
  const now = new Date().toISOString();

  for (const t of targets) {
    const cleartext = generateRandomPin();
    const hashed = await hashPin(cleartext);
    await c.var.DB.prepare(
      `INSERT INTO worker_pins (workerId, pin, updatedAt, must_reset) VALUES (?, ?, ?, false)
       ON CONFLICT (workerId) DO UPDATE SET pin = EXCLUDED.pin, updatedAt = EXCLUDED.updatedAt, must_reset = false`,
    )
      .bind(t.id, hashed, now)
      .run();
    await c.var.DB.prepare("DELETE FROM worker_tokens WHERE workerId = ?")
      .bind(t.id)
      .run();
    generated.push({
      workerId: t.id,
      empNo: t.empNo,
      name: t.name,
      pin: cleartext,
    });
  }

  // Single audit row capturing the bulk action; per-worker rows would be
  // noisy on a fresh-onboarding batch of 30+ workers. resourceId is left
  // empty since this targets multiple workers; the after payload lists the
  // affected workerIds for forensic reconstruction (without cleartext PINs).
  await emitAudit(c, {
    resource: "workers",
    resourceId: "*",
    action: "pin-bulk-generate",
    after: {
      workerIds: generated.map((g) => g.workerId),
      count: generated.length,
    },
  });

  return c.json({
    success: true,
    data: {
      generated,
      skipped,
    },
  });
});

// ---------------------------------------------------------------------------
// Effective-dated salary (worker_salary_history). A worker's salary on any date
// = the newest row whose effectiveFrom <= that date; workers.basic_salary_sen is
// the current snapshot. Payroll day-weights a mid-month raise (labor-engine
// effectiveSalarySenForMonth). These endpoints manage the dated rows.
// ---------------------------------------------------------------------------

/** Re-sync workers.basic_salary_sen to the row effective TODAY (newest
 *  effectiveFrom <= today), so the scalar everything else reads stays current. */
async function resyncCurrentSalary(c: Context<Env>, workerId: string): Promise<void> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const cur = await c.var.DB.prepare(
    "SELECT basicSalarySen FROM worker_salary_history WHERE workerId = ? AND effectiveFrom <= ? ORDER BY effectiveFrom DESC, createdAt DESC LIMIT 1",
  )
    .bind(workerId, todayIso)
    .first<{ basicSalarySen: number }>();
  if (cur) {
    await c.var.DB.prepare("UPDATE workers SET basicSalarySen = ? WHERE id = ?")
      .bind(Number(cur.basicSalarySen) || 0, workerId)
      .run();
  }
}

// GET /:id/salary-history — the worker's dated salary rows, newest first.
app.get("/:id/salary-history", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const id = c.req.param("id");
  const res = await c.var.DB.prepare(
    "SELECT id, basicSalarySen, effectiveFrom, note FROM worker_salary_history WHERE workerId = ? ORDER BY effectiveFrom DESC, createdAt DESC",
  )
    .bind(id)
    .all<{ id: string; basicSalarySen: number; effectiveFrom: string; note: string | null }>();
  const data = (res.results ?? []).map((r) => ({
    id: r.id,
    basicSalarySen: Number(r.basicSalarySen) || 0,
    effectiveFrom: r.effectiveFrom,
    note: r.note ?? "",
  }));
  return c.json({ success: true, data, total: data.length });
});

// POST /:id/salary-history — record a salary change effective from a date.
// Body: { effectiveFrom: YYYY-MM-DD, basicSalarySen: int(sen), note? }.
// Upserts one row per (worker, effectiveFrom), then re-syncs the current scalar.
app.post("/:id/salary-history", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  let body: { effectiveFrom?: unknown; basicSalarySen?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom.trim() : "";
  const salaryNum = typeof body.basicSalarySen === "number" ? body.basicSalarySen : Number(body.basicSalarySen);
  const note = typeof body.note === "string" ? body.note : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return c.json({ success: false, error: "effectiveFrom must be YYYY-MM-DD" }, 400);
  }
  if (!Number.isFinite(salaryNum) || salaryNum < 0) {
    return c.json({ success: false, error: "basicSalarySen must be a non-negative number (sen)" }, 400);
  }
  const salarySen = Math.round(salaryNum);
  const worker = await c.var.DB.prepare("SELECT id FROM workers WHERE id = ?").bind(id).first<{ id: string }>();
  if (!worker) return c.json({ success: false, error: "Worker not found" }, 404);

  const rowId = `wsh-${crypto.randomUUID().slice(0, 8)}`;
  await c.var.DB.batch([
    c.var.DB.prepare("DELETE FROM worker_salary_history WHERE workerId = ? AND effectiveFrom = ?").bind(id, effectiveFrom),
    c.var.DB.prepare(
      "INSERT INTO worker_salary_history (id, workerId, basicSalarySen, effectiveFrom, note) VALUES (?, ?, ?, ?, ?)",
    ).bind(rowId, id, salarySen, effectiveFrom, note || null),
  ]);
  await resyncCurrentSalary(c, id);
  return c.json(
    { success: true, data: { id: rowId, effectiveFrom, basicSalarySen: salarySen, note } },
    201,
  );
});

// GET /salary/effective?period=YYYY-MM — each worker's day-weighted effective
// salary (sen) for the month, so the Labor Cost reconciliation rates match the
// payslips (which use the same figure). Past months use their historical salary.
// 2-segment path so it never collides with GET /:id.
app.get("/salary/effective", async (c) => {
  const denied = await requirePermission(c, "workers", "read");
  if (denied) return denied;
  const period = c.req.query("period") ?? "";
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return c.json({ success: false, error: "period (YYYY-MM) required" }, 400);
  }
  const [y, m] = period.split("-").map(Number);
  const phRow = await c.var.DB.prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind("public_holidays")
    .first<{ value: string | null }>();
  const publicHolidays = new Set<string>();
  if (phRow?.value) {
    try {
      const parsed = JSON.parse(phRow.value);
      if (Array.isArray(parsed)) {
        for (const d of parsed) if (typeof d === "string") publicHolidays.add(d);
      }
    } catch {
      /* malformed → no holidays */
    }
  }
  const wRes = await c.var.DB.prepare("SELECT id, basicSalarySen FROM workers")
    .all<{ id: string; basicSalarySen: number }>();
  const histByWorker = new Map<
    string,
    Array<{ effectiveFrom: string; basicSalarySen: number }>
  >();
  try {
    const hRes = await c.var.DB.prepare(
      "SELECT workerId, basicSalarySen, effectiveFrom FROM worker_salary_history",
    ).all<{ workerId: string; basicSalarySen: number; effectiveFrom: string }>();
    for (const r of hRes.results ?? []) {
      const a = histByWorker.get(r.workerId) ?? [];
      a.push({ effectiveFrom: r.effectiveFrom, basicSalarySen: Number(r.basicSalarySen) || 0 });
      histByWorker.set(r.workerId, a);
    }
  } catch {
    /* table not migrated yet → everyone falls back to their scalar */
  }
  const data: Record<string, number> = {};
  for (const w of wRes.results ?? []) {
    data[w.id] = effectiveSalarySenForMonth(
      histByWorker.get(w.id) ?? [],
      Number(w.basicSalarySen) || 0,
      y,
      m,
      publicHolidays,
    );
  }
  return c.json({ success: true, data });
});

// DELETE /:id/salary-history/:rowId — remove a dated row (undo a mis-entry),
// then re-sync the current scalar.
app.delete("/:id/salary-history/:rowId", async (c) => {
  const denied = await requirePermission(c, "workers", "update");
  if (denied) return denied;
  const id = c.req.param("id");
  const rowId = c.req.param("rowId");
  await c.var.DB.prepare("DELETE FROM worker_salary_history WHERE id = ? AND workerId = ?")
    .bind(rowId, id)
    .run();
  await resyncCurrentSalary(c, id);
  return c.json({ success: true, data: { id: rowId } });
});

export default app;

// ---------------------------------------------------------------------------
// check-leave-balance-fingerprint.mjs — READ-ONLY.
//
// Prove, against the live database, whether the leave-entitlement change moves
// anybody's balance. It computes BOTH balances for every active worker:
//
//   OLD  the arithmetic that shipped before this change, verbatim:
//        entitlement (a hardcoded 8 annual / 14 medical) MINUS the sum of every
//        APPROVED leave of that type over ALL history, with public holidays
//        charged as leave.
//
//   NEW  src/lib/leave-entitlement.ts: per-worker entitlement from data
//        (NULL → the same 8 / 14 default), usage restricted to ONE leave year,
//        and public holidays excluded.
//
// It prints a fingerprint of each set and lists every worker whose figure
// differs, with the reason. Nothing is written.
//
//   HOOKKA_PROD_DB_URL='...' node scripts/check-leave-balance-fingerprint.mjs
//
// WHY THIS SCRIPT EXISTS RATHER THAN A NUMBER IN THE PR: the change was
// developed without live database access (the credential in the local .dev.vars
// is rotated and authentication fails), so the prod impact is UNMEASURED here.
// This is the measurement, for whoever has the credential to run. Do not
// describe the deploy as "proven no-op" until it has been run — the deterministic
// no-op proof in tests/leave-entitlement.test.mjs covers the LOGIC, not this
// database's rows.
//
// Expect two kinds of legitimate difference, and read them carefully:
//
//   * "year-reset"   the worker had APPROVED leave in an EARLIER year that the
//                    old formula was still charging them for, forever. Their
//                    balance goes UP. This is BUG-2026-08-13-131 being fixed.
//   * "holiday"      an approved request overlapped a date in the owner's
//                    public-holiday list. Their balance goes UP by that many
//                    days. This is BUG-2026-08-13-132 being fixed, and it is
//                    what the owner explicitly asked for.
//
// A difference of any OTHER kind is a defect in this change — investigate it
// before deploying.
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { createHash } from "node:crypto";
import {
  DEFAULT_ANNUAL_ENTITLEMENT_DAYS,
  DEFAULT_MEDICAL_ENTITLEMENT_DAYS,
  parsePublicHolidays,
  chargeableLeaveDays,
  resolveEntitlementDays,
  computeLeaveBalance,
  currentLeaveYear,
} from "../src/lib/leave-entitlement.ts";

const OLD_ENTITLEMENTS = {
  ANNUAL: DEFAULT_ANNUAL_ENTITLEMENT_DAYS,
  MEDICAL: DEFAULT_MEDICAL_ENTITLEMENT_DAYS,
};

const fingerprint = (rows) =>
  createHash("sha256")
    .update(rows.map((r) => `${r.id}|${r.annual}|${r.medical}`).join(";"))
    .digest("hex")
    .slice(0, 16);

const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 10 });

try {
  const leaveYear = Number(process.argv[2]) || currentLeaveYear();

  // The override columns may not exist yet (the runtime self-apply creates them
  // on the first request after deploy). Treat "column missing" as "no overrides",
  // which is precisely the pre-deploy state this script is here to compare against.
  let workers;
  try {
    workers = await sql`
      SELECT id, name, status, annual_leave_entitlement_days, medical_leave_entitlement_days
        FROM workers WHERE status = 'ACTIVE' ORDER BY id`;
  } catch {
    workers = await sql`SELECT id, name, status FROM workers WHERE status = 'ACTIVE' ORDER BY id`;
    console.log("note: entitlement override columns do not exist yet — treating every worker as unset.\n");
  }

  const leaves = await sql`
    SELECT worker_id, type, status, start_date, end_date, days FROM leaves`;

  const phRow = await sql`SELECT value FROM kv_config WHERE key = 'public_holidays'`;
  const publicHolidays = parsePublicHolidays(phRow[0]?.value ?? null);

  const byWorker = new Map();
  for (const l of leaves) {
    const norm = {
      type: l.type,
      status: l.status,
      startDate: typeof l.start_date === "string" ? l.start_date : String(l.start_date ?? "").slice(0, 10),
      endDate: typeof l.end_date === "string" ? l.end_date : String(l.end_date ?? "").slice(0, 10),
      days: Number(l.days) || 0,
    };
    const arr = byWorker.get(l.worker_id) ?? [];
    arr.push(norm);
    byWorker.set(l.worker_id, arr);
  }

  const oldRows = [];
  const newRows = [];
  const diffs = [];

  for (const w of workers) {
    const mine = byWorker.get(w.id) ?? [];
    const o = {}, n = {};

    for (const type of ["ANNUAL", "MEDICAL"]) {
      // OLD: all history, holidays charged, hardcoded entitlement.
      const oldUsed = mine
        .filter((l) => l.type === type && l.status === "APPROVED")
        .reduce((s, l) => s + l.days, 0);
      o[type] = OLD_ENTITLEMENTS[type] - oldUsed;

      // NEW: shared module.
      const b = computeLeaveBalance({ leaves: mine, worker: w, type, leaveYear, publicHolidays });
      n[type] = b.remainingDays;

      if (o[type] !== n[type]) {
        const inYear = mine.filter(
          (l) => l.type === type && l.status === "APPROVED" && String(l.startDate).slice(0, 4) === String(leaveYear),
        );
        const otherYearDays = oldUsed - inYear.reduce((s, l) => s + l.days, 0);
        const holidayDays = inYear.reduce(
          (s, l) => s + (l.days - chargeableLeaveDays(l, publicHolidays)),
          0,
        );
        const overrideUsed = resolveEntitlementDays(type, w) !== OLD_ENTITLEMENTS[type];
        const reasons = [];
        if (otherYearDays > 0) reasons.push(`year-reset +${otherYearDays}`);
        if (holidayDays > 0) reasons.push(`holiday +${holidayDays}`);
        if (overrideUsed) reasons.push(`per-worker override`);
        if (!reasons.length) reasons.push("UNEXPLAINED — investigate");
        diffs.push(
          `  ${w.name} (${w.id}) ${type}: ${o[type]} → ${n[type]}   [${reasons.join(", ")}]`,
        );
      }
    }
    oldRows.push({ id: w.id, annual: o.ANNUAL, medical: o.MEDICAL });
    newRows.push({ id: w.id, annual: n.ANNUAL, medical: n.MEDICAL });
  }

  console.log(`leave year        : ${leaveYear}`);
  console.log(`active workers    : ${workers.length}`);
  console.log(`leave rows        : ${leaves.length}`);
  console.log(`public holidays   : ${publicHolidays.size}`);
  console.log(`OLD fingerprint   : ${fingerprint(oldRows)}`);
  console.log(`NEW fingerprint   : ${fingerprint(newRows)}`);

  if (!diffs.length) {
    console.log(`\n✓ IDENTICAL — no worker's balance moves on deploy.`);
  } else {
    console.log(`\n⚠ ${diffs.length} balance(s) change on deploy:\n`);
    for (const d of diffs) console.log(d);
    console.log(
      `\nEach line above must be one the owner has agreed to. "year-reset" and\n` +
        `"holiday" are the requested fixes; "UNEXPLAINED" is a defect.`,
    );
  }
} finally {
  await sql.end();
}

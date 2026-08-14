// ---------------------------------------------------------------------------
// leave-entitlement.test.mjs — leave entitlement is DATA, the leave year RESETS,
// and a public holiday never consumes annual leave.
//
// Four defects, one area:
//
//   BUG-2026-08-13-130  Entitlement was a hardcoded frontend constant
//                       (`LEAVE_ENTITLEMENTS = { ANNUAL: 8, MEDICAL: 14 }` in
//                       src/pages/employees.tsx). There was no column, so it
//                       could not differ per employee at all.
//
//   BUG-2026-08-13-131  No year reset. The office balance was
//                       `ENTITLEMENT − Σ approved days` over ALL history, so it
//                       only ever decreased, forever. A worker who took 8 days
//                       in 2025 had 0 annual days for the rest of their life.
//
//   BUG-2026-08-13-132  Public holidays were charged against leave. The balance
//                       summed `l.days` with no filter, while the owner
//                       maintains a holiday list in Employees and asked for it
//                       to be respected: 「应该根据我在 employee 那边放的
//                       public holiday」.
//
//   BUG-2026-08-13-133  TWO copies of the policy, disagreeing. The office used
//                       ANNUAL 8; `src/api/routes/worker.ts` used
//                       `annualEntitlement = 14` — so the worker's phone showed
//                       nearly double the office's annual figure for the same
//                       person, for as long as that endpoint has existed. Bug
//                       class C4 (more than one copy of the same list).
//
// The tests are in two halves:
//
//   Part 1 — BEHAVIOUR, against the real module. Includes the no-op proof: with
//            no override and no holiday overlap, every balance is identical to
//            what the old arithmetic produced.
//   Part 2 — SOURCE guards, so a future edit cannot quietly restore a hardcoded
//            entitlement, drop the year filter, or stop excluding holidays.
//
// EOL note: this repo is checked out CRLF. Every source guard below matches
// with `\s` / `[\s\S]` or on an EOL-normalised copy — a literal "\n" anchor
// silently matches NOTHING here and produces a green test over a live bug.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_ANNUAL_ENTITLEMENT_DAYS,
  DEFAULT_MEDICAL_ENTITLEMENT_DAYS,
  STATUTORY_ANNUAL_TIERS,
  statutoryAnnualEntitlementDays,
  parsePublicHolidays,
  countPublicHolidaysInRange,
  chargeableLeaveDays,
  calendarLeaveDays,
  leaveYearOfYmd,
  isInLeaveYear,
  resolveEntitlementDays,
  computeLeaveBalance,
} from "../src/lib/leave-entitlement.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
// Normalise EOLs on read. Everything below can then be written against "\n"
// without depending on how git checked the file out.
const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const EMPLOYEES = "src/pages/employees.tsx";
const WORKER_ROUTE = "src/api/routes/worker.ts";
const LEAVES_ROUTE = "src/api/routes/leaves.ts";
const WORKERS_ROUTE = "src/api/routes/workers.ts";
const POLICY = "src/lib/leave-entitlement.ts";
const ENSURE = "src/api/lib/ensure-leave-columns.ts";

// ===========================================================================
// PART 1 — BEHAVIOUR
// ===========================================================================

test("defaults are exactly today's numbers — 8 annual / 14 medical", () => {
  // If either of these moves, somebody's balance moves on deploy.
  assert.equal(DEFAULT_ANNUAL_ENTITLEMENT_DAYS, 8);
  assert.equal(DEFAULT_MEDICAL_ENTITLEMENT_DAYS, 14);
});

test("no override resolves to the defaults, in every empty shape", () => {
  for (const w of [null, undefined, {}, { annualLeaveEntitlementDays: null }, { annual_leave_entitlement_days: "" }]) {
    assert.equal(resolveEntitlementDays("ANNUAL", w), 8, `annual for ${JSON.stringify(w)}`);
  }
  for (const w of [null, undefined, {}, { medicalLeaveEntitlementDays: null }]) {
    assert.equal(resolveEntitlementDays("MEDICAL", w), 14, `medical for ${JSON.stringify(w)}`);
  }
});

test("entitlement can differ per employee — the whole point of BUG-130", () => {
  assert.equal(resolveEntitlementDays("ANNUAL", { annualLeaveEntitlementDays: 16 }), 16);
  assert.equal(resolveEntitlementDays("MEDICAL", { medicalLeaveEntitlementDays: 22 }), 22);
  // A deliberate 0 is an override, NOT "unset" — `|| DEFAULT` would eat it.
  assert.equal(resolveEntitlementDays("ANNUAL", { annualLeaveEntitlementDays: 0 }), 0);
});

test("overrides are read dual-keyed (camelCase AND snake_case)", () => {
  // HOOKKA-GOTCHAS: a `SELECT *` arrives renamed, an explicit snake_case SELECT
  // does not. Reading only one spelling is a silent `undefined`.
  assert.equal(resolveEntitlementDays("ANNUAL", { annual_leave_entitlement_days: 12 }), 12);
  assert.equal(resolveEntitlementDays("MEDICAL", { medical_leave_entitlement_days: 30 }), 30);
});

test("a junk override falls back to the default rather than NaN", () => {
  assert.equal(resolveEntitlementDays("ANNUAL", { annualLeaveEntitlementDays: "abc" }), 8);
  assert.equal(resolveEntitlementDays("ANNUAL", { annualLeaveEntitlementDays: -5 }), 8);
});

test("public holidays parse from the owner's kv_config payload", () => {
  const set = parsePublicHolidays('["2026-01-01","2026-05-01","garbage",42,null]');
  assert.deepEqual([...set].sort(), ["2026-01-01", "2026-05-01"]);
  // Malformed / absent payloads mean NO holidays, never a throw — the balance
  // page must not 500 because the config is bad.
  for (const bad of [null, undefined, "", "{not json", '{"a":1}', "[]"]) {
    assert.equal(parsePublicHolidays(bad).size, 0, `for ${JSON.stringify(bad)}`);
  }
});

test("holidays are counted only INSIDE the request's range, inclusive", () => {
  const hol = new Set(["2026-01-01", "2026-01-05", "2026-02-01"]);
  assert.equal(countPublicHolidaysInRange("2026-01-01", "2026-01-05", hol), 2, "both endpoints count");
  assert.equal(countPublicHolidaysInRange("2026-01-02", "2026-01-04", hol), 0, "none inside");
  assert.equal(countPublicHolidaysInRange("2026-01-01", "2026-12-31", hol), 3);
  // A reversed or malformed range charges nothing rather than going negative.
  assert.equal(countPublicHolidaysInRange("2026-01-05", "2026-01-01", hol), 0);
  assert.equal(countPublicHolidaysInRange("nope", "2026-01-05", hol), 0);
});

test("a public holiday inside a leave request does NOT consume leave (BUG-132)", () => {
  const hol = new Set(["2026-01-01"]);
  const leave = { startDate: "2026-01-01", endDate: "2026-01-05", days: 5 };
  assert.equal(chargeableLeaveDays(leave, new Set()), 5, "no holidays configured → unchanged");
  assert.equal(chargeableLeaveDays(leave, hol), 4, "the holiday is given back");
});

test("chargeable days never go negative, even if holidays outnumber the days", () => {
  const hol = new Set(["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.equal(chargeableLeaveDays({ startDate: "2026-01-01", endDate: "2026-01-03", days: 1 }, hol), 0);
});

test("chargeable days preserve an approver's manual `days` edit", () => {
  // The office PUT lets an approver set `days` by hand. Recomputing the span
  // would silently discard that; only the holidays are subtracted.
  const leave = { startDate: "2026-03-01", endDate: "2026-03-10", days: 3 };
  assert.equal(chargeableLeaveDays(leave, new Set()), 3);
});

test("a malformed date range falls back to the stored days, not to zero", () => {
  assert.equal(chargeableLeaveDays({ startDate: "", endDate: "", days: 4 }, new Set(["2026-01-01"])), 4);
});

test("calendarLeaveDays is inclusive and timezone-proof", () => {
  assert.equal(calendarLeaveDays("2026-01-01", "2026-01-01"), 1, "single day");
  assert.equal(calendarLeaveDays("2026-01-01", "2026-01-05"), 5);
  assert.equal(calendarLeaveDays("2026-12-30", "2027-01-02"), 4, "across new year");
  assert.equal(calendarLeaveDays("2026-02-28", "2026-03-01"), 2, "non-leap February");
  assert.equal(calendarLeaveDays("2024-02-28", "2024-03-01"), 3, "leap February");
  assert.equal(calendarLeaveDays("junk", "2026-01-05"), 1, "malformed → floor of 1");
});

test("the leave year is the calendar year of the START date", () => {
  assert.equal(leaveYearOfYmd("2026-08-14"), 2026);
  assert.equal(leaveYearOfYmd("nope"), null);
  assert.ok(isInLeaveYear("2026-01-01", 2026));
  assert.ok(!isInLeaveYear("2025-12-31", 2026));
  // A request spanning new year belongs wholly to its start year — the same
  // rule the shipped worker.ts filter already applied.
  assert.ok(isInLeaveYear("2025-12-30", 2025));
});

test("the balance RESETS each leave year (BUG-131)", () => {
  const leaves = [
    { type: "ANNUAL", status: "APPROVED", startDate: "2025-06-01", endDate: "2025-06-08", days: 8 },
    { type: "ANNUAL", status: "APPROVED", startDate: "2026-03-01", endDate: "2026-03-02", days: 2 },
  ];
  const y2026 = computeLeaveBalance({
    leaves, worker: null, type: "ANNUAL", leaveYear: 2026, publicHolidays: new Set(),
  });
  // Before the fix this was 8 − 10 = −2 forever. The 2025 leave is spent 2025
  // days and must not follow the worker into 2026.
  assert.equal(y2026.usedDays, 2);
  assert.equal(y2026.remainingDays, 6);

  const y2025 = computeLeaveBalance({
    leaves, worker: null, type: "ANNUAL", leaveYear: 2025, publicHolidays: new Set(),
  });
  assert.equal(y2025.usedDays, 8, "the old year still reports its own usage");
  assert.equal(y2025.remainingDays, 0);
});

test("only APPROVED leave of the matching type is charged", () => {
  const leaves = [
    { type: "ANNUAL", status: "PENDING", startDate: "2026-03-01", endDate: "2026-03-03", days: 3 },
    { type: "ANNUAL", status: "REJECTED", startDate: "2026-03-05", endDate: "2026-03-06", days: 2 },
    { type: "MEDICAL", status: "APPROVED", startDate: "2026-03-08", endDate: "2026-03-09", days: 2 },
    { type: "ANNUAL", status: "APPROVED", startDate: "2026-03-11", endDate: "2026-03-11", days: 1 },
  ];
  const opts = { leaves, worker: null, leaveYear: 2026, publicHolidays: new Set() };
  assert.equal(computeLeaveBalance({ ...opts, type: "ANNUAL" }).usedDays, 1);
  assert.equal(computeLeaveBalance({ ...opts, type: "MEDICAL" }).usedDays, 2);
});

test("the office balance is NOT clamped — an over-draw stays visible", () => {
  const leaves = [
    { type: "ANNUAL", status: "APPROVED", startDate: "2026-03-01", endDate: "2026-03-12", days: 12 },
  ];
  const b = computeLeaveBalance({
    leaves, worker: null, type: "ANNUAL", leaveYear: 2026, publicHolidays: new Set(),
  });
  // The approver is the only person who can act on an over-draw; hiding it
  // behind Math.max(0, …) is what the old worker.ts did.
  assert.equal(b.remainingDays, -4);
});

test("PROOF OF NO-OP: with no override and no holiday overlap, the balance is byte-identical to the old arithmetic", () => {
  // The old office formula, verbatim from employees.tsx before this change.
  const OLD_ENTITLEMENTS = { ANNUAL: 8, MEDICAL: 14 };
  const oldBalance = (leaves, type) =>
    OLD_ENTITLEMENTS[type] -
    leaves.filter((l) => l.type === type && l.status === "APPROVED").reduce((s, l) => s + l.days, 0);

  // A book that stays inside ONE leave year and touches no configured holiday
  // — i.e. the conditions under which nothing is allowed to move.
  const leaves = [
    { type: "ANNUAL", status: "APPROVED", startDate: "2026-03-02", endDate: "2026-03-04", days: 3 },
    { type: "ANNUAL", status: "PENDING", startDate: "2026-04-02", endDate: "2026-04-03", days: 2 },
    { type: "MEDICAL", status: "APPROVED", startDate: "2026-05-06", endDate: "2026-05-07", days: 2 },
    { type: "EMERGENCY", status: "APPROVED", startDate: "2026-06-01", endDate: "2026-06-01", days: 1 },
  ];
  const publicHolidays = new Set(["2026-01-01", "2026-12-25"]); // none overlap

  for (const type of ["ANNUAL", "MEDICAL"]) {
    const now = computeLeaveBalance({ leaves, worker: null, type, leaveYear: 2026, publicHolidays });
    assert.equal(now.remainingDays, oldBalance(leaves, type), `${type} remaining must not move`);
    assert.equal(now.entitlementDays, OLD_ENTITLEMENTS[type], `${type} entitlement must not move`);
  }
});

test("statutory tiers are reference data — correct, but NOT the active default", () => {
  assert.equal(statutoryAnnualEntitlementDays(0), 8);
  assert.equal(statutoryAnnualEntitlementDays(1.9), 8);
  assert.equal(statutoryAnnualEntitlementDays(2), 12);
  assert.equal(statutoryAnnualEntitlementDays(4.9), 12);
  assert.equal(statutoryAnnualEntitlementDays(5), 16);
  assert.equal(statutoryAnnualEntitlementDays(40), 16);
  assert.equal(STATUTORY_ANNUAL_TIERS[0].days, DEFAULT_ANNUAL_ENTITLEMENT_DAYS, "8 is the statutory floor AND today's default");

  // The load-bearing assertion: the tiers must NOT be wired into resolution.
  // A worker with 10 years of service still resolves to the default until the
  // owner decides otherwise — nobody silently gains 8 days on deploy.
  assert.equal(resolveEntitlementDays("ANNUAL", { joinDate: "2010-01-01" }), 8);
  const src = read(POLICY);
  const resolver = src.slice(src.indexOf("export function resolveEntitlementDays"));
  assert.ok(
    !/statutoryAnnualEntitlementDays|STATUTORY_ANNUAL_TIERS/.test(resolver),
    "resolveEntitlementDays must not consult the statutory tiers — that is the owner's decision",
  );
});

// ===========================================================================
// PART 2 — SOURCE GUARDS
// ===========================================================================

test("the frontend entitlement CONSTANT is gone and does not come back (BUG-130)", () => {
  const src = read(EMPLOYEES);
  assert.ok(
    !/const\s+LEAVE_ENTITLEMENTS\s*=/.test(src),
    "employees.tsx must not redeclare a hardcoded LEAVE_ENTITLEMENTS constant",
  );
  assert.ok(
    !/LEAVE_ENTITLEMENTS\s*\.\s*(ANNUAL|MEDICAL)/.test(src),
    "employees.tsx must not read entitlement from a constant",
  );
});

test("the office balance comes from the server, not from local arithmetic", () => {
  const src = read(EMPLOYEES);
  // Matched as a COMPLETE quoted string. A bare `includes("/api/leaves/balances")`
  // is satisfied by "/api/leaves/balancesXX" — a substring check cannot tell a
  // live endpoint from a typo'd one, and this assertion passed with the URL
  // broken until the mutation run caught it.
  assert.ok(
    /"\/api\/leaves\/balances"/.test(src),
    "the office screen must read the server-computed balance endpoint",
  );
  // The specific shape of the old bug: entitlement minus a sum, in the page.
  assert.ok(
    !/annualRemaining:\s*[A-Za-z_$][\w$]*\s*-\s*annualUsed/.test(src),
    "the page must not recompute a remaining balance from a local entitlement",
  );
});

test("worker.ts no longer carries its own entitlement literals (BUG-133)", () => {
  const src = read(WORKER_ROUTE);
  assert.ok(
    !/const\s+annualEntitlement\s*=\s*\d+/.test(src),
    "worker.ts must not hardcode an annual entitlement — this is the literal that said 14 while the office said 8",
  );
  assert.ok(
    !/const\s+medicalEntitlement\s*=\s*\d+/.test(src),
    "worker.ts must not hardcode a medical entitlement",
  );
  // BOTH balances, named individually. A single `computeLeaveBalance(` match is
  // a SINGLE-SITE guard: it stays green while one of the two calls is torn out,
  // which is exactly the failure mode BUG-CLASSES records for the efficiency
  // guard ("the guard that pinned the surviving real metric was single-site").
  assert.ok(
    /const\s+annual\s*=\s*computeLeaveBalance\s*\(/.test(src),
    "worker.ts must compute the ANNUAL balance through the shared policy module",
  );
  assert.ok(
    /const\s+medical\s*=\s*computeLeaveBalance\s*\(/.test(src),
    "worker.ts must compute the MEDICAL balance through the shared policy module",
  );
  // ...and the response must actually publish those objects' entitlements,
  // rather than a number computed some other way.
  assert.ok(
    /annualEntitlement:\s*annual\.entitlementDays/.test(src) &&
      /medicalEntitlement:\s*medical\.entitlementDays/.test(src),
    "worker.ts must publish the shared module's entitlement figures",
  );
});

test("both leave surfaces import the ONE policy module (class C4)", () => {
  for (const rel of [WORKER_ROUTE, LEAVES_ROUTE]) {
    const src = read(rel);
    assert.ok(
      /from\s+"(\.\.\/)+lib\/leave-entitlement"/.test(src),
      `${rel} must import src/lib/leave-entitlement`,
    );
  }
});

test("the balance path excludes public holidays from the OWNER'S list (BUG-132)", () => {
  const policy = read(POLICY);
  assert.ok(
    /countPublicHolidaysInRange\s*\(/.test(
      policy.slice(policy.indexOf("export function chargeableLeaveDays")),
    ),
    "chargeableLeaveDays must subtract public holidays",
  );
  // It must read the SAME kv_config row the payroll paths read — not a second,
  // divergent holiday list.
  // The key is matched as a COMPLETE quoted string: `public_holidays` as a bare
  // substring is also present in "public_holidays_v2", so the loose form stayed
  // green while the route read a key that does not exist — i.e. while the
  // owner's configured holidays were silently ignored. Caught by mutation.
  for (const rel of [LEAVES_ROUTE, WORKER_ROUTE]) {
    const src = read(rel);
    assert.ok(
      /kv_config[\s\S]{0,160}?"public_holidays"/.test(src),
      `${rel} must load holidays from kv_config['public_holidays'] — the exact key the payroll paths read`,
    );
  }
});

test("the leave-year filter is applied in the shared module (BUG-131)", () => {
  const policy = read(POLICY);
  const fn = policy.slice(policy.indexOf("export function computeLeaveBalance"));
  assert.ok(
    /isInLeaveYear\s*\(/.test(fn),
    "computeLeaveBalance must filter by leave year — without it the balance never resets",
  );
});

test("the new columns are snake_case and reach prod via the runtime self-apply", () => {
  const ensure = read(ENSURE);
  for (const col of ["annual_leave_entitlement_days", "medical_leave_entitlement_days"]) {
    assert.ok(
      new RegExp(`ALTER\\s+TABLE\\s+workers\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${col}`, "i").test(ensure),
      `${col} must be self-applied — migrations are inert on deploy here`,
    );
    // snake_case, so no column-rename-map entry is needed.
    assert.ok(!/[A-Z]/.test(col), `${col} must be snake_case`);
  }
  // C9: the memo must not be a bare cached promise.
  assert.ok(
    /memoizeSelfApply\s*\(/.test(ensure),
    "the self-apply must use memoizeSelfApply so a FAILED round is retried, not remembered as done",
  );
});

test("every handler that names the new columns awaits the self-apply first", () => {
  // A SELECT of a column that does not exist fails exactly like an INSERT, so
  // the read paths need the ensure just as much as the write path does.
  const cases = [
    [LEAVES_ROUTE, 'app.get("/balances"'],
    [WORKER_ROUTE, 'app.get("/leaves"'],
    [WORKERS_ROUTE, 'app.put("/:id"'],
  ];
  for (const [rel, anchor] of cases) {
    const src = read(rel);
    const at = src.indexOf(anchor);
    assert.ok(at !== -1, `${rel}: could not find handler ${anchor}`);
    // Bound the window to THIS handler — up to the next top-level `app.<verb>(`
    // — rather than a fixed character count. A fixed window either truncates a
    // long handler (workers.ts PUT runs ~250 lines before its UPDATE) or bleeds
    // into the next one and passes on a neighbour's ensure call.
    const rest = src.slice(at + anchor.length);
    const nextAt = rest.search(/\napp\.(get|post|put|patch|delete)\(/);
    const body = nextAt === -1 ? rest : rest.slice(0, nextAt);
    const ensureAt = body.indexOf("ensureLeaveEntitlementColumns");
    const colAt = body.search(/_leave_entitlement_days/);
    assert.ok(ensureAt !== -1, `${rel} ${anchor} must await ensureLeaveEntitlementColumns`);
    assert.ok(colAt !== -1, `${rel} ${anchor} was expected to name the entitlement columns`);
    assert.ok(
      ensureAt < colAt,
      `${rel} ${anchor}: the self-apply must be awaited BEFORE the statement naming the columns`,
    );
  }
});

test("the server derives leave days from the dates instead of trusting the client (class C1)", () => {
  const src = read(LEAVES_ROUTE);
  // Scoped to the POST handler. A file-wide `calendarLeaveDays(` match is
  // satisfied by the PUT's call while the POST goes back to trusting the
  // client — the mutation run proved that exact pass.
  const at = src.indexOf('app.post("/"');
  assert.ok(at !== -1, "could not find the leaves POST handler");
  const rest = src.slice(at);
  const nextAt = rest.search(/\napp\.(get|post|put|patch|delete)\(/);
  const post = nextAt === -1 ? rest : rest.slice(0, nextAt);

  assert.ok(
    /const\s+daysNum\s*=\s*calendarLeaveDays\s*\(/.test(post),
    "the leaves POST must derive the span with the shared helper",
  );
  // Any shape of "believe the client's day count", not just the original one.
  assert.ok(
    !/Number\s*\(\s*(body\s*\.\s*)?days\s*\)/.test(post),
    "the leaves POST must not store whatever `days` the client posted",
  );
});

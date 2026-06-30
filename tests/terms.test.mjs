import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/terms.ts")).href);

// Aging is by CALENDAR month (owner rule 2026-06-30): this month = Current (0),
// last month = 1, etc. The day and the 1-month payment term are irrelevant to
// the bucket. `now` is injected so the assertions are time-zone / date stable.
// Mid-month noon UTC keeps getMonth() in the same month across all runner TZs.
const JUN = new Date(Date.UTC(2026, 5, 15, 12)); // 2026-06 (June)

test("monthsOverdue — this month is Current (0)", () => {
  assert.equal(m.monthsOverdue("2026-06-01", JUN), 0);
  assert.equal(m.monthsOverdue("2026-06-30", JUN), 0); // day irrelevant
});

test("monthsOverdue — last month is 1", () => {
  assert.equal(m.monthsOverdue("2026-05-01", JUN), 1);
  assert.equal(m.monthsOverdue("2026-05-31", JUN), 1);
});

test("monthsOverdue — two / three / older months", () => {
  assert.equal(m.monthsOverdue("2026-04-15", JUN), 2);
  assert.equal(m.monthsOverdue("2026-03-15", JUN), 3);
  assert.equal(m.monthsOverdue("2026-01-15", JUN), 5);
});

test("monthsOverdue — crosses the year boundary", () => {
  const JAN = new Date(Date.UTC(2026, 0, 15, 12)); // 2026-01
  assert.equal(m.monthsOverdue("2026-01-10", JAN), 0); // this month
  assert.equal(m.monthsOverdue("2025-12-10", JAN), 1); // last month (Dec)
  assert.equal(m.monthsOverdue("2025-11-10", JAN), 2);
});

test("monthsOverdue — a future-dated invoice is negative (still Current via <=0 bucket)", () => {
  assert.equal(m.monthsOverdue("2026-07-10", JUN), -1);
});

test("monthsOverdue — unparseable date → 0", () => {
  assert.equal(m.monthsOverdue(null, JUN), 0);
  assert.equal(m.monthsOverdue("", JUN), 0);
  assert.equal(m.monthsOverdue("not-a-date", JUN), 0);
});

// Due date is the 1-month term (last day of the month AFTER the invoice month)
// — unchanged; aging is independent of it.
test("nextMonthDueDate — last day of the next month", () => {
  assert.equal(m.nextMonthDueDate("2026-06-15"), "2026-07-31");
  assert.equal(m.nextMonthDueDate("2026-12-10"), "2027-01-31");
});

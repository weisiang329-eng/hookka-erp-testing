// ---------------------------------------------------------------------------
// planning-capacity-pin.test.mjs — owner pins override measured capacity.
//
// Capacity is derived from actual output and drifts ±20%/day toward it, so a
// plain "set" would be quietly walked back to reality within a week. A PIN has
// to win outright, or it isn't a pin. These tests hold that line, and hold the
// bounds that stop a typo installing an absurd budget.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveOne,
  setCapacityPin,
  loadCapacityPins,
  CAPACITY_PINS_KEY,
  MIN_PIN_MIN,
  MAX_PIN_MIN,
  MAX_DAILY_DRIFT,
} from "../src/api/lib/planning-adaptive-capacity.ts";

test("a pin wins over the measured figure", () => {
  const r = resolveOne("FAB_SEW", 2704, 3540, 2700, 1200);
  assert.equal(r.reason, "pinned");
  assert.equal(r.effectiveMinPerDay, 1200);
  // The measured value is still reported so the console can show the gap.
  assert.equal(r.measuredMinPerDay, 2704);
});

test("a pin is not eroded by the daily drift limit", () => {
  // Without a pin this would be rate-limited to previous ± 20%.
  const previous = 1000;
  const pinned = 5000;
  const r = resolveOne("FAB_CUT", 900, 564, previous, pinned);
  assert.equal(r.effectiveMinPerDay, pinned);
  assert.notEqual(r.effectiveMinPerDay, Math.round(previous * (1 + MAX_DAILY_DRIFT)));
});

test("a pin holds even when the department produced nothing", () => {
  // Cold start would otherwise fall back to the previous/configured value.
  const r = resolveOne("PACKING", 0, null, null, 600);
  assert.equal(r.reason, "pinned");
  assert.equal(r.effectiveMinPerDay, 600);
});

test("a pin is clamped to sane bounds", () => {
  assert.equal(resolveOne("FOAM", 100, 480, null, 1).effectiveMinPerDay, MIN_PIN_MIN);
  assert.equal(resolveOne("FOAM", 100, 480, null, 9e9).effectiveMinPerDay, MAX_PIN_MIN);
});

test("no pin leaves the measured behaviour untouched", () => {
  const withNull = resolveOne("FAB_SEW", 2704, 3540, 2700, null);
  const withNothing = resolveOne("FAB_SEW", 2704, 3540, 2700);
  assert.equal(withNull.reason, "measured");
  assert.deepEqual(withNull, withNothing);
});

function makeDb(initial = null) {
  let stored = initial;
  const writes = [];
  return {
    writes,
    get stored() {
      return stored;
    },
    prepare(sql) {
      const exec = {
        async all() {
          return { results: [] };
        },
        async first() {
          return stored === null ? null : { value: JSON.stringify(stored) };
        },
        async run(...args) {
          writes.push(sql);
        },
      };
      return {
        ...exec,
        bind: (...args) => ({
          ...exec,
          async run() {
            writes.push({ sql, args });
            if (sql.includes("INSERT INTO kv_config")) stored = JSON.parse(args[1]);
          },
        }),
      };
    },
  };
}

test("setting a pin stores exactly one clamped value", async () => {
  const db = makeDb();
  const r = await setCapacityPin(db, "fab_sew", 1200);
  assert.equal(r.ok, true);
  assert.equal(r.dept, "FAB_SEW", "the department code is normalised");
  assert.equal(r.minutesPerDay, 1200);
  assert.deepEqual(db.stored, { FAB_SEW: 1200 });
  assert.ok(db.writes.some((w) => w.args?.includes(CAPACITY_PINS_KEY)));
});

test("clearing a pin removes only that department", async () => {
  const db = makeDb({ FAB_SEW: 1200, FRAMING: 900 });
  const r = await setCapacityPin(db, "FAB_SEW", null);
  assert.equal(r.ok, true);
  assert.equal(r.minutesPerDay, null);
  assert.deepEqual(db.stored, { FRAMING: 900 }, "other pins must survive");
});

test("an unknown department is rejected, not silently stored", async () => {
  const db = makeDb();
  const r = await setCapacityPin(db, "NOT_A_DEPT", 500);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown department/);
  assert.equal(db.stored, null, "a bad code must never reach kv_config");
});

test("an out-of-range value is rejected with the bounds stated", async () => {
  const db = makeDb();
  for (const bad of [0, -100, MIN_PIN_MIN - 1, MAX_PIN_MIN + 1, Number.NaN]) {
    const r = await setCapacityPin(db, "FRAMING", bad);
    assert.equal(r.ok, false, `${bad} should have been rejected`);
    assert.match(r.error, /between/);
  }
  assert.equal(db.stored, null);
});

test("pins round-trip through kv_config", async () => {
  const db = makeDb({ FRAMING: 900, BOGUS: "abc", NEGATIVE: -5 });
  const pins = await loadCapacityPins(db);
  assert.equal(pins.FRAMING, 900);
  assert.equal(pins.BOGUS, undefined, "unparseable values are dropped, not trusted");
  assert.equal(pins.NEGATIVE, undefined);
});

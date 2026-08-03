// ---------------------------------------------------------------------------
// planning-deadlines.test.mjs — the backward pass and the slack priority.
//
// The backward pass must mirror the forward chain in planning-chain.ts exactly.
// If the two ever disagree, deadlines become fiction and every priority built
// on them is wrong, so the handoff arithmetic is pinned here department by
// department for BOTH lanes (sofa detours through foam bonding; bedframe does
// not).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import {
  deptDeadlines,
  slack,
  durationDays,
  priorityKey,
  UNDATED_SLACK,
  DEFAULT_SHIP_BUFFER_DAYS,
} from "../src/api/lib/planning-deadlines.ts";
import { DEFAULT_CHAIN_CONFIG } from "../src/api/lib/planning-capacity.ts";

// A calendar with no weekends or holidays keeps the arithmetic readable — the
// real calendar is injected by the caller and tested where it lives.
const backWorkday = (day, n) => day - n;

const chain = DEFAULT_CHAIN_CONFIG;

test("bedframe deadlines walk the chain back from the customer date", () => {
  const dd = 100;
  const d = deptDeadlines({ customerDd: dd, lane: "BEDFRAME", chain, backWorkday });

  // Packing finishes one working day before delivery (the ship buffer).
  assert.equal(d.PACKING, dd - DEFAULT_SHIP_BUFFER_DAYS);
  // Packing rides the upholstery day.
  assert.equal(d.UPHOLSTERY, d.PACKING);
  // Bedframe goes framing -> upholstery directly; no foam stage.
  assert.equal(d.FRAMING, d.UPHOLSTERY - chain.uphHandoffDays);
  assert.equal(d.FOAM, null);
  // Webbing runs the same day as framing.
  assert.equal(d.WEBBING, d.FRAMING);
  assert.equal(d.WOOD_CUT, d.FRAMING - chain.frameHandoffDays);
  assert.equal(d.FAB_SEW, d.WOOD_CUT - chain.woodHandoffDays);
  assert.equal(d.FAB_CUT, d.FAB_SEW - chain.sewHandoffDays);
});

test("sofa deadlines detour through foam bonding", () => {
  const dd = 100;
  const d = deptDeadlines({ customerDd: dd, lane: "SOFA", chain, backWorkday });

  assert.equal(d.UPHOLSTERY, dd - DEFAULT_SHIP_BUFFER_DAYS);
  assert.equal(d.FOAM, d.UPHOLSTERY - chain.uphHandoffDays);
  assert.equal(d.FRAMING, d.FOAM - chain.foamHandoffDays);
  // The foam stage costs a sofa an extra day upstream versus a bedframe.
  const bed = deptDeadlines({ customerDd: dd, lane: "BEDFRAME", chain, backWorkday });
  assert.ok(d.FAB_CUT < bed.FAB_CUT, "sofa must start cutting earlier than bedframe");
});

test("the whole chain fits inside the promise it was derived from", () => {
  const dd = 100;
  const d = deptDeadlines({ customerDd: dd, lane: "SOFA", chain, backWorkday });
  for (const dept of Object.keys(d)) {
    if (d[dept] === null) continue;
    assert.ok(d[dept] < dd, `${dept} deadline must precede the customer date`);
  }
  assert.ok(d.FAB_CUT < d.FAB_SEW);
  assert.ok(d.FAB_SEW < d.WOOD_CUT);
  assert.ok(d.WOOD_CUT < d.FRAMING);
  assert.ok(d.FRAMING < d.UPHOLSTERY);
});

test("an undated order has no deadline anywhere", () => {
  const d = deptDeadlines({ customerDd: null, lane: "BEDFRAME", chain, backWorkday });
  for (const dept of Object.keys(d)) assert.equal(d[dept], null);
});

test("the ship buffer is configurable", () => {
  const d = deptDeadlines({
    customerDd: 100,
    lane: "BEDFRAME",
    chain,
    backWorkday,
    shipBufferDays: 5,
  });
  assert.equal(d.PACKING, 95);
});

test("slack is the room left after the work itself", () => {
  // Can start day 10, must finish day 20, needs 3 days: 8 days spare.
  assert.equal(slack({ floor: 10, deadline: 20, durationDays: 3 }), 8);
  // Exactly enough room is zero slack, not negative.
  assert.equal(slack({ floor: 10, deadline: 12, durationDays: 3 }), 0);
});

test("slack goes negative exactly when the promise is impossible", () => {
  const s = slack({ floor: 10, deadline: 11, durationDays: 5 });
  assert.ok(s < 0, "five days of work cannot fit in two — slack must be negative");
});

test("undated work has no slack to measure", () => {
  assert.equal(slack({ floor: 1, deadline: null, durationDays: 2 }), null);
});

test("the long-chain order outranks the short-chain order sharing its due date", () => {
  // The exact case the old due-date sort could not distinguish.
  const dd = 100;
  const bed = deptDeadlines({ customerDd: dd, lane: "BEDFRAME", chain, backWorkday });

  // SO A still needs cutting: floor is today (day 1), deadline is the cut date.
  const aSlack = slack({ floor: 1, deadline: bed.FAB_CUT, durationDays: 1 });
  // SO B only needs packing, due much later in the chain.
  const bSlack = slack({ floor: 1, deadline: bed.PACKING, durationDays: 1 });

  assert.ok(aSlack < bSlack, "the order with more chain left must be the more urgent");

  const keys = [
    priorityKey({ slack: bSlack, deadline: bed.PACKING, tiebreak: "SO-B" }),
    priorityKey({ slack: aSlack, deadline: bed.FAB_CUT, tiebreak: "SO-A" }),
  ].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  assert.equal(keys[0][3], "SO-A", "SO-A must sort first");
});

test("dated work always outranks undated work", () => {
  const dated = priorityKey({ slack: 500, deadline: 900, tiebreak: "SO-DATED" });
  const undated = priorityKey({ slack: null, deadline: null, tiebreak: "SO-UNDATED" });
  assert.ok(dated[0] < undated[0]);
  assert.equal(undated[0], UNDATED_SLACK);
});

test("equal urgency groups by batch key so batching survives the sort", () => {
  const a = priorityKey({ slack: 3, deadline: 50, groupKey: "PC151-01", tiebreak: "SO-9" });
  const b = priorityKey({ slack: 3, deadline: 50, groupKey: "PC151-01", tiebreak: "SO-1" });
  const c = priorityKey({ slack: 3, deadline: 50, groupKey: "PC151-06", tiebreak: "SO-5" });
  const sorted = [c, a, b].sort((x, y) => {
    for (let i = 0; i < x.length; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  });
  assert.deepEqual(
    sorted.map((k) => k[2]),
    ["PC151-01", "PC151-01", "PC151-06"],
    "same-fabric work must stay adjacent",
  );
});

test("duration converts minutes into whole working days", () => {
  assert.equal(durationDays(0, 480), 1, "even trivial work occupies a day");
  assert.equal(durationDays(480, 480), 1);
  assert.equal(durationDays(481, 480), 2);
  assert.equal(durationDays(1440, 480), 3);
  assert.equal(durationDays(100, 0), 1, "a zero budget must not divide by zero");
});

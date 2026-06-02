// ---------------------------------------------------------------------------
// planning-scheduler.test.mjs — sanity guard for the pure Fab Cut scheduler
// (src/api/lib/planning-scheduler.ts), the TypeScript port of the trusted
// Python cutter.
//
// It feeds the sample input shape (scripts/_algo_ref/schedule_rows.json — a
// row-array export of WAITING FAB_CUT cards) through scheduleCutting() and
// asserts the load-bearing invariants:
//   1. No cut is scheduled before START (the first working day).
//   2. The shared bedframe+sofa per-day pool never exceeds the active reserve-
//      tier budget (and each accessory day stays within its own ceiling).
//   3. Every WAITING cut appears exactly once across the Cut Calendar.
//   4. Calendar + By Day day-separators land only on working days (never a
//      Sunday or a holiday).
//   5. All emitted lane labels are English (no Chinese characters anywhere).
//
// A second tiny hand-built fixture pins exact day placement for an urgent vs
// far-future split so a regression in the floor / pull-window logic is caught.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scheduleCutting } from "../src/api/lib/planning-scheduler.ts";
import { DEFAULT_CAPACITY_CONFIG } from "../src/api/lib/planning-capacity.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── helpers ─────────────────────────────────────────────────────────────────

// Day number (days since 1970-01-01) from a YYYY-MM-DD string — same epoch the
// scheduler uses internally, recomputed here independently for assertions.
function toDayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function dowOf(dayNum) {
  return ((dayNum % 7) + 4 + 7) % 7; // 0 = Sunday
}

// Pull "YYYY-MM-DD" out of a separator label like "2026-06-02  Tue   (Day 1)".
function isoFromLabel(label) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(label));
  return m ? m[1] : null;
}

// Derive a size token from a wipLabel's second "|" segment, e.g.
// "1005-(Q) | (5FT) | ..." -> "5FT"; "5531-2S | (28) | ..." -> "28".
function sizeFromLabel(wipLabel) {
  const parts = String(wipLabel).split("|").map((p) => p.trim());
  const seg = parts[1] ?? "";
  const inner = seg.replace(/^\(/, "").replace(/\)$/, "").trim();
  return inner;
}

// Map a schedule_rows.json row → CutCard. Columns (verified against the file):
// [0 soNo, 1 customer, 2 model, 3 wipLabel, 4 category, 5 qty, 6 customerDd,
//  7 expectedDd, 8 ..., 9 status, 10 ...].
function rowToCard(r) {
  const wipLabel = String(r[3]);
  const config = wipLabel.split("|")[0].trim() || "(none)";
  return {
    soPo: String(r[0]),
    customer: String(r[1] ?? ""),
    label: wipLabel,
    fabric: "",
    lane: String(r[4]).toUpperCase(),
    config,
    size: sizeFromLabel(wipLabel),
    sets: Math.max(1, Number(r[5]) || 1),
    customerDd: /^\d{4}-\d{2}-\d{2}/.test(String(r[6])) ? String(r[6]).slice(0, 10) : null,
    expectedDd: /^\d{4}-\d{2}-\d{2}/.test(String(r[7])) ? String(r[7]).slice(0, 10) : null,
  };
}

const LANE_CATS = new Set(["BEDFRAME", "SOFA", "ACCESSORY"]);

function loadFixtureCards() {
  const raw = JSON.parse(
    readFileSync(join(HERE, "..", "scripts", "_algo_ref", "schedule_rows.json"), "utf8"),
  );
  return raw.map(rowToCard).filter((c) => LANE_CATS.has(c.lane));
}

// Reserve-tier budget for a working-day index (1-based), per the config.
function tierBudget(cfg, dayIndex) {
  for (const t of cfg.reserveTiers) if (dayIndex <= t.uptoDay) return t.cuts;
  return cfg.reserveTiers[cfg.reserveTiers.length - 1].cuts;
}

// Walk working days from START, returning a Map<iso, 1-based workday index>.
function workdayIndexMap(startIso, holidays, maxDays = 400) {
  const holidaySet = new Set(holidays);
  const isOff = (dn) => dowOf(dn) === 0 || holidaySet.has(isoOf(dn));
  const idx = new Map();
  let dn = toDayNum(startIso);
  while (isOff(dn)) dn += 1; // align to first working day
  let i = 1;
  for (let k = 0; k < maxDays; k++) {
    idx.set(isoOf(dn), i);
    // step to next workday
    dn += 1;
    while (isOff(dn)) dn += 1;
    i += 1;
  }
  return idx;
}

// Inverse of toDayNum → YYYY-MM-DD (independent reimplementation).
function isoOf(z) {
  const zz = z + 719468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const yy = m <= 2 ? y + 1 : y;
  return `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const HAS_CHINESE = /[一-鿿]/;

// ── tests ────────────────────────────────────────────────────────────────────

test("scheduleCutting: fixture invariants (no early cut, pool budget, each cut once)", () => {
  const cards = loadFixtureCards();
  assert.ok(cards.length > 100, `expected a sizeable fixture, got ${cards.length}`);

  const startDate = "2026-06-02";
  const holidays = ["2026-06-01"];
  const snap = scheduleCutting({
    cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays,
    startDate,
    generatedAt: "2026-06-02",
  });

  const startDn = (() => {
    let dn = toDayNum(startDate);
    const off = new Set(holidays);
    while (dowOf(dn) === 0 || off.has(isoOf(dn))) dn += 1;
    return dn;
  })();

  const cal = snap.sheets["Cut Calendar"];
  assert.ok(Array.isArray(cal) && cal.length > 1, "Cut Calendar should have rows");

  // Walk the calendar: track the current day-separator, count distinct cuts,
  // and tally per-day pool usage (bedframe + sofa) and accessory usage.
  const idxMap = workdayIndexMap(startDate, holidays);
  const poolByDay = new Map(); // iso -> bedframe+sofa slot count (header rows)
  const accByDay = new Map();
  const seenCuts = new Set();
  let curIso = null;

  const HEADER = cal[0];
  const laneCol = 1;
  const cutCol = 2;
  const soPoCol = 5;

  for (let i = 1; i < cal.length; i++) {
    const row = cal[i];
    const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
    if (nonEmpty.length === 1 && row[0]) {
      // date separator
      curIso = isoFromLabel(row[0]);
      assert.ok(curIso, `separator should carry an ISO date: ${row[0]}`);
      // (2) + (4): separators land on real working days, never before START.
      assert.ok(idxMap.has(curIso), `separator ${curIso} is not a working day`);
      assert.ok(toDayNum(curIso) >= startDn, `cut day ${curIso} is before START ${startDate}`);
      continue;
    }
    const cut = String(row[cutCol] ?? "").trim();
    if (cut) {
      // First row of a group: count one cut + one pool/acc slot for this day.
      assert.ok(curIso, "a cut row appeared before any date separator");
      const laneLabel = String(row[laneCol] ?? "");
      // (5) English only.
      assert.ok(!HAS_CHINESE.test(laneLabel), `non-English lane label: ${laneLabel}`);
      const key = `${cut}@${curIso}`;
      assert.ok(!seenCuts.has(key), `cut ${cut} double-counted on ${curIso}`);
      seenCuts.add(key);
      if (/pillow|accessor/i.test(laneLabel)) {
        accByDay.set(curIso, (accByDay.get(curIso) ?? 0) + 1);
      } else {
        poolByDay.set(curIso, (poolByDay.get(curIso) ?? 0) + 1);
      }
    }
  }

  // (2) per-day shared pool never exceeds the active tier budget.
  for (const [iso, used] of poolByDay) {
    const dayIndex = idxMap.get(iso);
    const budget = tierBudget(DEFAULT_CAPACITY_CONFIG, dayIndex);
    assert.ok(
      used <= budget,
      `pool on ${iso} (day ${dayIndex}) used ${used} > tier budget ${budget}`,
    );
  }
  // accessory never exceeds its own lane ceiling.
  for (const [iso, used] of accByDay) {
    assert.ok(
      used <= DEFAULT_CAPACITY_CONFIG.laneCap.ACCESSORY,
      `accessory on ${iso} used ${used} > ceiling ${DEFAULT_CAPACITY_CONFIG.laneCap.ACCESSORY}`,
    );
  }

  // (3) every WAITING card appears exactly once in the calendar body.
  const soPoCounts = new Map();
  for (let i = 1; i < cal.length; i++) {
    const row = cal[i];
    const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
    if (nonEmpty.length === 1 && row[0]) continue; // separator
    const so = String(row[soPoCol] ?? "").trim();
    if (!so) continue;
    soPoCounts.set(so, (soPoCounts.get(so) ?? 0) + 1);
  }
  const totalRows = [...soPoCounts.values()].reduce((a, b) => a + b, 0);
  assert.equal(
    totalRows,
    cards.length,
    `calendar item rows (${totalRows}) must equal WAITING cards (${cards.length})`,
  );

  // (5) No Chinese anywhere in any sheet.
  for (const [name, rows] of Object.entries(snap.sheets)) {
    for (const row of rows) {
      for (const cell of row) {
        assert.ok(!HAS_CHINESE.test(String(cell ?? "")), `Chinese found in sheet ${name}: ${cell}`);
      }
    }
  }

  assert.equal(snap.department, "Fabric Cutting");
  assert.ok(snap.sheets["By Day"].length > 1, "By Day should have rows");
});

test("scheduleCutting: urgent cut goes ASAP, far-future cut floors near its own date", () => {
  // Two cards of the SAME cut identity, dates far enough apart (> pull window)
  // that they must split into two batches: one overdue (urgent), one far out.
  const cards = [
    {
      soPo: "SO-A-01",
      customer: "X",
      label: "9001-(K) | (6FT) | KS-1 | (FC)",
      fabric: "KS-1",
      lane: "BEDFRAME",
      config: "9001-(K)",
      size: "6FT",
      sets: 1,
      customerDd: "2026-05-20", // overdue vs START 2026-06-02
      expectedDd: null,
    },
    {
      soPo: "SO-B-01",
      customer: "Y",
      label: "9001-(K) | (6FT) | KS-1 | (FC)",
      fabric: "KS-1",
      lane: "BEDFRAME",
      config: "9001-(K)",
      size: "6FT",
      sets: 1,
      customerDd: "2026-07-15", // far future
      expectedDd: null,
    },
  ];
  const startDate = "2026-06-02";
  const snap = scheduleCutting({
    cards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays: ["2026-06-01"],
    startDate,
    generatedAt: "2026-06-02",
  });

  const cal = snap.sheets["Cut Calendar"];
  // Collect each cut's day from its preceding separator.
  let curIso = null;
  const placed = []; // { soPo, iso }
  for (let i = 1; i < cal.length; i++) {
    const row = cal[i];
    const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
    if (nonEmpty.length === 1 && row[0]) {
      curIso = isoFromLabel(row[0]);
      continue;
    }
    const so = String(row[5] ?? "").trim();
    if (so) placed.push({ soPo: so, iso: curIso });
  }

  const urgent = placed.find((p) => p.soPo === "SO-A-01");
  const far = placed.find((p) => p.soPo === "SO-B-01");
  assert.ok(urgent, "urgent card should be placed");
  assert.ok(far, "far-future card should be placed");

  // Urgent (overdue) cut starts on the first working day.
  assert.equal(urgent.iso, "2026-06-02", `urgent cut should be ASAP, got ${urgent.iso}`);
  // Far-future cut is NOT pulled to day 1 — it floors near its own July date.
  assert.ok(
    toDayNum(far.iso) > toDayNum("2026-06-15"),
    `far-future cut should sit near its own date, got ${far.iso}`,
  );
});

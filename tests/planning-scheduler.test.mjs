// ---------------------------------------------------------------------------
// planning-scheduler.test.mjs — sanity guard for the pure Fab Cut scheduler
// (src/api/lib/planning-scheduler.ts), the TypeScript port of the trusted
// Python cutter.
//
// It feeds the sample input shape (scripts/schedule_rows.json — a
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
import { computeChain } from "../src/api/lib/planning-chain.ts";
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
    readFileSync(join(HERE, "..", "scripts", "schedule_rows.json"), "utf8"),
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

// ── Phase 2: full production-chain invariants ────────────────────────────────

// Derive a coarse wipType from a wip label so the chain can identify base vs
// cushion etc. (the flat fixture has no explicit wipType column).
function wipTypeFromLabel(lane, label) {
  const l = String(label).toLowerCase();
  if (lane === "BEDFRAME") {
    if (l.includes("divan")) return "DIVAN";
    if (l.includes("(hb)") || l.includes("headboard")) return "HEADBOARD";
    return "DIVAN";
  }
  if (lane === "SOFA") {
    if (l.includes("stool") || l.includes("-base")) return "SOFA_BASE";
    if (l.includes("cushion")) return "SOFA_CUSHION";
    if (l.includes("(lhf)") || l.includes("(rhf)") || /a\(/.test(l)) return "SOFA_ARMREST";
    return "SOFA_BASE";
  }
  return "";
}

// One flat fixture row -> a ChainCard for a given downstream department. Each
// production line flows through every department, so a row yields one card per
// dept (mirrors the real ERP's per-department job cards).
function rowToChainCard(r, dept) {
  const wipLabel = String(r[3]);
  const lane = String(r[4]).toUpperCase();
  const so = String(r[0]);
  return {
    dept,
    soPo: so,
    soId: so,
    customer: String(r[1] ?? ""),
    label: wipLabel,
    fabric: "",
    lane,
    model: String(r[2] ?? ""),
    size: sizeFromLabel(wipLabel),
    sets: Math.max(1, Number(r[5]) || 1),
    mins: Math.max(1, Number(r[10]) || 1) * Math.max(1, Number(r[5]) || 1),
    customerDd: /^\d{4}-\d{2}-\d{2}/.test(String(r[6])) ? String(r[6]).slice(0, 10) : null,
    expectedDd: /^\d{4}-\d{2}-\d{2}/.test(String(r[7])) ? String(r[7]).slice(0, 10) : null,
    wipType: wipTypeFromLabel(lane, wipLabel),
    cutDone: false,
    noCutStep: false,
  };
}

const CHAIN_DEPTS = ["FAB_SEW", "WOOD_CUT", "FRAMING", "WEBBING", "FOAM", "UPHOLSTERY", "PACKING"];

function loadFixtureRows() {
  return JSON.parse(
    readFileSync(join(HERE, "..", "scripts", "schedule_rows.json"), "utf8"),
  ).filter((r) => LANE_CATS.has(String(r[4]).toUpperCase()));
}

// Walk a per-SO grouped calendar sheet returning, per SO id, the EARLIEST day
// it appears (its scheduled day for that dept).
function soDaysFromCalendar(sheet, soCol) {
  let curIso = null;
  const days = new Map();
  for (let i = 1; i < sheet.length; i++) {
    const row = sheet[i];
    const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
    if (nonEmpty.length === 1 && row[0]) {
      curIso = isoFromLabel(row[0]);
      continue;
    }
    const so = String(row[soCol] ?? "").trim();
    if (so && curIso) {
      const dn = toDayNum(curIso);
      if (!days.has(so) || dn < days.get(so)) days.set(so, dn);
    }
  }
  return days;
}

function numericCell(cell) {
  if (typeof cell === "number") return cell;
  const n = parseFloat(String(cell ?? "").replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function countCalendarItems(sheet) {
  let n = 0;
  for (let i = 1; i < sheet.length; i++) {
    const row = sheet[i];
    const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
    if (nonEmpty.length === 1 && row[0]) continue;
    n += 1;
  }
  return n;
}

test("computeChain: cross-department invariants from the fixture", () => {
  const rows = loadFixtureRows();
  const cutCards = rows.map(rowToCard);
  const chainCards = [];
  for (const r of rows) for (const dept of CHAIN_DEPTS) chainCards.push(rowToChainCard(r, dept));

  const startDate = "2026-06-02";
  const holidays = ["2026-06-01"];
  const out = computeChain({
    cutCards,
    chainCards,
    config: DEFAULT_CAPACITY_CONFIG,
    holidays,
    startDate,
    generatedAt: "2026-06-02",
  });

  const startDn = (() => {
    let dn = toDayNum(startDate);
    const o = new Set(holidays);
    while (dowOf(dn) === 0 || o.has(isoOf(dn))) dn += 1;
    return dn;
  })();
  const idxMap = workdayIndexMap(startDate, holidays);

  const names = {
    cutting: "Fabric Cutting",
    sewing: "Fabric Sewing",
    woodCutting: "Wood Cutting",
    framing: "Framing",
    foamBonding: "Foam Bonding",
    upholstery: "Upholstery",
    packing: "Packing",
    webbing: "Webbing",
  };
  for (const [k, dep] of Object.entries(names)) {
    assert.equal(out[k].department, dep, `${k} department name`);
    assert.ok(Object.keys(out[k].sheets).length >= 3, `${k} should have >= 3 sheets`);
  }

  // (A) No Chinese anywhere across every sheet of every dept.
  for (const snap of Object.values(out)) {
    for (const [name, sheetRows] of Object.entries(snap.sheets)) {
      for (const row of sheetRows) {
        for (const cell of row) {
          assert.ok(
            !HAS_CHINESE.test(String(cell ?? "")),
            `Chinese found in ${snap.department} / ${name}: ${cell}`,
          );
        }
      }
    }
  }

  // (B) Calendar day separators land on working days, never before START.
  const calSheets = {
    "Sew Calendar": out.sewing.sheets["Sew Calendar"],
    "Wood Cut Calendar": out.woodCutting.sheets["Wood Cut Calendar"],
    "Framing Calendar": out.framing.sheets["Framing Calendar"],
    "Foam Calendar": out.foamBonding.sheets["Foam Calendar"],
    "Uph Calendar": out.upholstery.sheets["Uph Calendar"],
    "Pack Calendar": out.packing.sheets["Pack Calendar"],
    "Webbing Calendar": out.webbing.sheets["Webbing Calendar"],
  };
  for (const [name, sheet] of Object.entries(calSheets)) {
    for (let i = 1; i < sheet.length; i++) {
      const row = sheet[i];
      const nonEmpty = row.filter((c) => c !== "" && c !== null && c !== undefined);
      if (nonEmpty.length === 1 && row[0]) {
        const iso = isoFromLabel(row[0]);
        assert.ok(iso, `${name} separator should carry an ISO date: ${row[0]}`);
        assert.ok(idxMap.has(iso), `${name} separator ${iso} is not a working day`);
        assert.ok(toDayNum(iso) >= startDn, `${name} day ${iso} before START`);
      }
    }
  }

  // Per-SO scheduled day for each dept (earliest appearance in its calendar).
  const sewDay = soDaysFromCalendar(out.sewing.sheets["Sew Calendar"], 1);
  const woodDay = soDaysFromCalendar(out.woodCutting.sheets["Wood Cut Calendar"], 2);
  const frameDay = soDaysFromCalendar(out.framing.sheets["Framing Calendar"], 2);
  const foamDay = soDaysFromCalendar(out.foamBonding.sheets["Foam Calendar"], 2);
  const uphDay = soDaysFromCalendar(out.upholstery.sheets["Uph Calendar"], 2);
  const packDay = soDaysFromCalendar(out.packing.sheets["Pack Calendar"], 2);
  const webDay = soDaysFromCalendar(out.webbing.sheets["Webbing Calendar"], 2);

  const off = new Set(holidays);
  const isOffDn = (dn) => dowOf(dn) === 0 || off.has(isoOf(dn));
  const addWd = (dn, n) => {
    let x = dn;
    while (isOffDn(x)) x += 1;
    for (let k = 0; k < n; k++) {
      x += 1;
      while (isOffDn(x)) x += 1;
    }
    return x;
  };

  // (C) wood floor >= sew end + 2 working days.
  for (const [so, wd] of woodDay) {
    if (sewDay.has(so)) {
      assert.ok(wd >= addWd(sewDay.get(so), 2), `wood ${so} (${isoOf(wd)}) must be >= sew+2`);
    }
  }
  // (D) framing floor >= wood + 1.
  for (const [so, fd] of frameDay) {
    if (woodDay.has(so)) {
      assert.ok(fd >= addWd(woodDay.get(so), 1), `framing ${so} (${isoOf(fd)}) must be >= wood+1`);
    }
  }
  // (E) foam >= framing + 1 (sofa).
  for (const [so, fd] of foamDay) {
    if (frameDay.has(so)) {
      assert.ok(fd >= addWd(frameDay.get(so), 1), `foam ${so} must be >= framing+1`);
    }
  }
  // (F) upholstery >= framing+1 (bedframe) or foam+1 (sofa).
  for (const [so, ud] of uphDay) {
    const fb = frameDay.has(so) ? addWd(frameDay.get(so), 1) : null;
    const sf = foamDay.has(so) ? addWd(foamDay.get(so), 1) : null;
    const floor = sf ?? fb;
    if (floor !== null) {
      assert.ok(ud >= floor, `upholstery ${so} (${isoOf(ud)}) must be >= upstream+1`);
    }
  }
  // (G) packing day == upholstery day.
  for (const [so, pd] of packDay) {
    if (uphDay.has(so)) assert.equal(pd, uphDay.get(so), `packing ${so} must equal upholstery day`);
  }
  // (H) webbing day == framing day.
  for (const [so, wd] of webDay) {
    if (frameDay.has(so)) assert.equal(wd, frameDay.get(so), `webbing ${so} must equal framing day`);
  }

  // (I) per-lane per-day load never exceeds capacity.
  const sewBD = out.sewing.sheets["By Day"];
  for (let i = 1; i < sewBD.length; i++) {
    assert.ok(numericCell(sewBD[i][5]) <= numericCell(sewBD[i][6]) + 1e-6, `sew over cap`);
  }
  const woodBD = out.woodCutting.sheets["By Day"];
  for (let i = 1; i < woodBD.length; i++) {
    assert.ok(numericCell(woodBD[i][5]) <= numericCell(woodBD[i][6]), `wood sets over cap`);
  }
  const frBD = out.framing.sheets["By Day"];
  for (let i = 1; i < frBD.length; i++) {
    assert.ok(numericCell(frBD[i][2]) <= numericCell(frBD[i][3]) + 1e-6, `framing BF over cap`);
    assert.ok(numericCell(frBD[i][4]) <= numericCell(frBD[i][5]) + 1e-6, `framing SOFA over cap`);
  }
  const uphBD = out.upholstery.sheets["By Day"];
  for (let i = 1; i < uphBD.length; i++) {
    assert.ok(numericCell(uphBD[i][5]) <= numericCell(uphBD[i][6]) + 1e-6, `uph over cap`);
  }
  const foamBD = out.foamBonding.sheets["By Day"];
  for (let i = 1; i < foamBD.length; i++) {
    assert.ok(numericCell(foamBD[i][5]) <= numericCell(foamBD[i][6]) + 1e-6, `foam over cap`);
  }

  // (J) every WAITING card appears once per its dept in that dept's calendar.
  // Sewing covers all lanes (pillows sew too); wood/framing are bedframe+sofa
  // only (accessory has no wood/framing step).
  const bfSofaCount = rows.filter((r) => /BEDFRAME|SOFA/.test(String(r[4]).toUpperCase())).length;
  assert.equal(
    countCalendarItems(out.sewing.sheets["Sew Calendar"]),
    rows.length,
    `sew rows must equal all cards`,
  );
  assert.equal(
    countCalendarItems(out.framing.sheets["Framing Calendar"]),
    bfSofaCount,
    `framing rows must equal bedframe+sofa cards`,
  );
  assert.equal(
    countCalendarItems(out.woodCutting.sheets["Wood Cut Calendar"]),
    bfSofaCount,
    `wood rows must equal bedframe+sofa cards`,
  );
});

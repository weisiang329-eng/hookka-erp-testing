// ---------------------------------------------------------------------------
// dept-perf-summary-projection.test.mjs
//
// Locks the 2026-08-14 /employees fan-out/payload pass:
//
//   BUG-2026-08-13-110 — three callers asked GET /api/department-performance
//     for its FULL payload (per-job-card drilldown for every day in the window)
//     while reading ONLY `data.totals`. The `?view=summary` projection already
//     existed and had one report caller (src/pages/reports.tsx:1743).
//   BUG-2026-08-13-111 — the Employee Performance tab pulled EVERY worker's
//     attendance for its date window and filtered to one worker in the browser,
//     even though GET /api/attendance has supported `?employeeId=` since dc12.
//   BUG-2026-08-13-112 — the three mobile /m sources did the same as -103.
//
// Two halves:
//   A. EQUIVALENCE — the summary projection is proved to carry byte-identical
//      totals and byte-identical daily core figures. This is the "a fast wrong
//      answer is worse than a slow right one" gate: if projectPerformanceSummary
//      ever starts RECOMPUTING instead of PROJECTING, this fails.
//   B. SOURCE LOCKS — the callers must keep asking for the narrow read. A future
//      "simplify the URL" edit that drops `view=summary` or `employeeId=` puts
//      the megabytes straight back and nothing else would notice.
//
// Source locks are EOL-agnostic on purpose: these files are CRLF in the working
// tree, so any regex anchored on a literal "\n" silently matches nothing and
// reports a false all-clear. Every pattern below is built against text that has
// been normalised to \n first.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { projectPerformanceSummary } from '../src/api/routes/department-performance.ts';

// EOL normalisation — see header. Read every source through this.
function readSrc(rel) {
  return readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

// Drop `//` line comments and `/* */` blocks. Needed wherever the assertion is
// "this identifier is GONE": the fixes in this pass left comments that name the
// removed identifiers, and matching one of those is a false failure.
// Deliberately crude — it is only ever used on assertions about the ABSENCE of
// an identifier, where over-stripping can only make the test stricter.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// A synthetic payload in the exact shape the handler builds (see the
// `daily` construction at department-performance.ts:660-708). Deterministic:
// no Math.random, so the byte sizes this prints are reproducible.
//
// `jcPerDay` is the only free parameter. It is calibrated in the measurement
// test below against the ONE real prod figure the repo has for this endpoint:
// "a 61-day range is 9.5 MB" (department-performance.ts:91-98, measured on prod
// 2026-08-13). Everything else — 50 workers/day, 2 pics per card — is the shape
// the handler produces, not a guess about volume.
// ---------------------------------------------------------------------------
function buildFullPayload({ days, jcPerDay, workersPerDay = 50 }) {
  const daily = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.UTC(2026, 5, 1) + d * 86400000)
      .toISOString()
      .slice(0, 10);
    const jobs = [];
    const workers = [];
    for (let w = 0; w < workersPerDay; w++) {
      workers.push({
        workerId: `wkr-${String(w).padStart(4, '0')}`,
        workerName: `Worker Number ${w}`,
        workingMinutes: 480 + (w % 7) * 15,
        productionMinutes: 400 + (w % 11) * 9,
        jobs: [],
      });
    }
    for (let j = 0; j < jcPerDay; j++) {
      const jobCardId = `jc-${date}-${String(j).padStart(5, '0')}`;
      const a = workers[j % workersPerDay];
      const b = workers[(j + 1) % workersPerDay];
      jobs.push({
        jobCardId,
        poNo: `PO-2606-${String(j).padStart(4, '0')}`,
        departmentCode: 'FAB_SEW',
        productCode: `PRD-${String(j % 400).padStart(4, '0')}`,
        productName: `Sofa Cover Assembly Variant ${j % 400}`,
        wipLabel: `WIP-${j % 12}`,
        sizeLabel: '3 SEATER',
        productionMinutes: 45 + (j % 30),
        workers: [
          { id: a.workerId, name: a.workerName },
          { id: b.workerId, name: b.workerName },
        ],
      });
      for (const wk of [a, b]) {
        wk.jobs.push({
          jobCardId,
          productCode: `PRD-${String(j % 400).padStart(4, '0')}`,
          productName: `Sofa Cover Assembly Variant ${j % 400}`,
          wipLabel: `WIP-${j % 12}`,
          poNo: `PO-2606-${String(j).padStart(4, '0')}`,
          productionMinutes: Math.round((45 + (j % 30)) / 2),
        });
      }
    }
    const workingMinutes = workers.reduce((s, w) => s + w.workingMinutes, 0);
    const productionMinutes = jobs.reduce((s, j) => s + j.productionMinutes, 0);
    daily.push({
      date,
      workingMinutes,
      productionMinutes,
      efficiencyPct:
        workingMinutes > 0
          ? Math.round((productionMinutes / workingMinutes) * 100)
          : 0,
      workers,
      jobs,
    });
  }
  const totalWorking = daily.reduce((s, r) => s + r.workingMinutes, 0);
  const totalProduction = daily.reduce((s, r) => s + r.productionMinutes, 0);
  return {
    range: { from: daily[0]?.date ?? '', to: daily[daily.length - 1]?.date ?? '' },
    departmentCode: null,
    category: null,
    totals: {
      workingMinutes: totalWorking,
      productionMinutes: totalProduction,
      efficiencyPct:
        totalWorking > 0 ? Math.round((totalProduction / totalWorking) * 100) : 0,
      workerCount: workersPerDay,
    },
    daily,
  };
}

const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

// ---------------------------------------------------------------------------
// A. EQUIVALENCE
// ---------------------------------------------------------------------------

test('summary projects totals BY REFERENCE — the KPI cards cannot drift', () => {
  const full = buildFullPayload({ days: 31, jcPerDay: 40 });
  const summary = projectPerformanceSummary(full);
  // Reference identity is the strongest possible statement: the summary view
  // does not re-derive the number, it hands back the same object. Every
  // /employees KPI card (Present / Working Hours / Avg Efficiency) reads it.
  assert.equal(
    summary.totals,
    full.totals,
    'projectPerformanceSummary must pass `totals` straight through. If it ever ' +
      'recomputes them, the summary and full views can disagree and the ' +
      '/employees KPI cards silently diverge from the Department Performance tab.',
  );
});

test('fingerprint: totals + daily core figures are byte-identical across views', () => {
  const full = buildFullPayload({ days: 31, jcPerDay: 40 });
  const summary = projectPerformanceSummary(full);

  // The fingerprint technique from docs/PERF-BACKLOG.md ("Verification technique
  // that worked"), applied to exactly the fields the narrowed callers read.
  const fingerprint = (p) =>
    JSON.stringify({
      range: p.range,
      departmentCode: p.departmentCode,
      category: p.category,
      totals: p.totals,
      daily: (p.daily ?? []).map((d) => [
        d.date,
        d.workingMinutes,
        d.productionMinutes,
        d.efficiencyPct,
      ]),
    });

  assert.equal(
    fingerprint(summary),
    fingerprint(full),
    'Summary and full views must fingerprint identically over range + totals + ' +
      'daily core figures. A difference here means the projection changed the data.',
  );
});

test('per-worker range rollup sums the SAME per-day numbers (no second formula)', () => {
  const full = buildFullPayload({ days: 10, jcPerDay: 25 });
  const summary = projectPerformanceSummary(full);

  const expected = new Map();
  for (const day of full.daily) {
    for (const w of day.workers) {
      const cell = expected.get(w.workerId) ?? { working: 0, production: 0 };
      cell.working += w.workingMinutes;
      cell.production += w.productionMinutes;
      expected.set(w.workerId, cell);
    }
  }
  assert.equal(summary.workers.length, expected.size);
  for (const w of summary.workers) {
    const e = expected.get(w.workerId);
    assert.ok(e, `unexpected worker ${w.workerId} in summary`);
    assert.equal(w.workingMinutes, e.working);
    assert.equal(w.productionMinutes, e.production);
    assert.equal(
      w.efficiencyPct,
      e.working > 0 ? Math.round((e.production / e.working) * 100) : 0,
    );
  }
});

// ---------------------------------------------------------------------------
// A2. MEASUREMENT — the before/after payload table, computed from the real
// projection function. Method and calibration are printed so the numbers can
// be re-derived rather than taken on trust.
// ---------------------------------------------------------------------------

test('measured: summary is at least 20x smaller than the full payload', () => {
  // Calibrate jcPerDay so a 61-day full payload lands on the one real prod
  // measurement we have for this endpoint: 9.5 MB (department-performance.ts:
  // 91-98, measured on prod 2026-08-13).
  const TARGET_61D_BYTES = 9.5 * 1024 * 1024;
  let lo = 1;
  let hi = 4000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (bytes(buildFullPayload({ days: 61, jcPerDay: mid })) < TARGET_61D_BYTES) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const jcPerDay = lo;

  const rows = [];
  for (const days of [61, 31, 7, 1]) {
    const full = buildFullPayload({ days, jcPerDay });
    const summary = projectPerformanceSummary(full);
    rows.push({
      window: `${days} day${days === 1 ? '' : 's'}`,
      fullKB: +(bytes(full) / 1024).toFixed(1),
      summaryKB: +(bytes(summary) / 1024).toFixed(1),
      ratio: +(bytes(full) / bytes(summary)).toFixed(1),
    });
  }
  console.log(
    `\n  calibration: jcPerDay=${jcPerDay} (chosen so 61 days ≈ 9.5 MB, the prod figure)\n`,
  );
  console.table(rows);

  // The two /employees callers request a CALENDAR MONTH window, so the 31-day
  // row is the one that matters. Bound is deliberately conservative — the
  // point of the assertion is "an order of magnitude", not a pinned constant
  // that breaks when the generator is tweaked.
  const month = rows.find((r) => r.window === '31 days');
  assert.ok(
    month.ratio >= 20,
    `summary must be >=20x smaller over a calendar month; measured ${month.ratio}x`,
  );
});

// ---------------------------------------------------------------------------
// B. SOURCE LOCKS
// ---------------------------------------------------------------------------

test('BUG-2026-08-13-110: /employees totals-only callers ask for view=summary', () => {
  const src = readSrc('src/pages/employees.tsx');

  // Page-level KPI cards. Reads `summaryPerfResp?.data?.totals` and nothing else.
  assert.match(
    src,
    /useCachedJson<DeptPerfResponse>\(\s*`\/api\/department-performance\?view=summary&from=\$\{summaryRange\.from\}&to=\$\{summaryRange\.to\}`/,
    'The /employees summary-card fetch must carry view=summary. It reads only ' +
      'data.totals; the full payload ships a per-job-card drilldown for every ' +
      'day in the window (9.5 MB / 61 days on prod).',
  );

  // Attendance tab month KPI. Reads `monthPerfResp?.data?.totals?.efficiencyPct`.
  assert.match(
    src,
    /useCachedJson<DeptPerfResponse>\(\s*`\/api\/department-performance\?view=summary&from=\$\{monthFrom\}&to=\$\{monthTo\}`/,
    'The Attendance tab month-efficiency fetch must carry view=summary. It reads ' +
      'exactly one number (totals.efficiencyPct) off a whole-calendar-month payload.',
  );

  // NEGATIVE half: the Department Performance TAB itself must NOT be narrowed —
  // it is the one caller that genuinely renders daily[].workers[].jobs[].
  assert.match(
    src,
    /const url = `\/api\/department-performance\?from=\$\{dateFrom\}&to=\$\{dateTo\}&departmentCode=/,
    'The Department Performance TAB must keep requesting the FULL payload — its ' +
      'expand-a-day drilldown renders daily[].workers[] and their jobs[]. ' +
      'Narrowing this one would blank the drilldown.',
  );
});

test('BUG-2026-08-13-111: Employee Performance attendance fetch is employee-scoped', () => {
  const src = readSrc('src/pages/employees.tsx');

  assert.match(
    src,
    /const attUrl = selectedEmployeeId\s*\n?\s*\? `\/api\/attendance\?employeeId=\$\{encodeURIComponent\(selectedEmployeeId\)\}&from=\$\{dateFrom\}&to=\$\{dateTo\}`/,
    'The Employee Performance tab must scope its attendance read to the selected ' +
      'worker server-side (GET /api/attendance?employeeId=, attendance.ts:126-143). ' +
      'It renders ONE worker; pulling the whole org\'s punches for the window and ' +
      'filtering in the browser is the exact whole-org-fetch shape this repo has ' +
      'been unwinding.',
  );

  // Guard the old shape explicitly so a revert cannot pass by accident.
  assert.doesNotMatch(
    src,
    /const attUrl = `\/api\/attendance\?from=\$\{dateFrom\}&to=\$\{dateTo\}`/,
    'The unscoped whole-org attendance fetch is back on the Employee Performance ' +
      'tab. Re-add &employeeId= — see BUG-2026-08-13-111.',
  );
});

test('BUG-2026-08-13-114: /employees first paint waits on the worker list only', () => {
  // Comments are stripped first: the fix left a long explanatory note that
  // NAMES the removed identifiers, and a naive source search would match that
  // note and report the bug as still present (or, worse, be relaxed until it
  // matched nothing at all). Assert against CODE.
  const code = stripComments(readSrc('src/pages/employees.tsx'));

  // `assert.ok` rather than `assert.doesNotMatch` on purpose — the latter
  // prints the entire 500 KB file as `actual` on failure, which buries the
  // message that explains what broke.
  assert.ok(
    !/setDateAttendance/.test(code),
    'setDateAttendance is back. That state was write-only — `const [, setDateAttendance]` ' +
      'never destructured the value — so every write to it, and the /api/attendance ' +
      'fetch feeding it, was dead weight on the mount burst. See BUG-2026-08-13-114.',
  );
  assert.ok(
    !/attendanceLoading/.test(code),
    'The page-level `loading` gate is reading an attendance fetch again. That ' +
      'makes the ENTIRE Employees page hold its first paint behind a whole-org ' +
      'read, in a serialised request queue, for data nothing renders.',
  );
  assert.ok(
    /const loading = workersLoading;/.test(code),
    'Page-level `loading` must be workersLoading alone.',
  );
  assert.ok(
    !/`\/api\/attendance\?date=\$\{todayStr\(\)\}`/.test(code),
    'the page-level /api/attendance?date=today fetch is back — see BUG-2026-08-13-114',
  );
  // The invalidation it was tangled with is NOT dead and must survive: it is
  // what makes the Attendance / Employee Performance tabs re-read after the
  // Working Hours grid saves a punch-derived row.
  assert.ok(
    /const refreshAttendance = useCallback\([\s\S]{0,200}invalidateCachePrefix\("\/api\/attendance"\)/.test(
      code,
    ),
    'refreshAttendance must still invalidate the /api/attendance cache prefix — ' +
      'that is the load-bearing half of what it used to do.',
  );
});

test('BUG-2026-08-13-112: mobile department-performance sources ask for view=summary', () => {
  const src = readSrc('src/pages/m/config/modules.ts');

  const calls = src.match(/`\/api\/department-performance\?[^`]*`/g) ?? [];
  assert.equal(
    calls.length,
    3,
    `expected 3 /api/department-performance sources in modules.ts, found ${calls.length}: ${calls.join(', ')}`,
  );
  for (const call of calls) {
    assert.ok(
      call.includes('view=summary'),
      `mobile source ${call} must carry view=summary — phones on the factory ` +
        'floor are on the worst networks in the building, and every one of these ' +
        'three sources reads a key (data.departments) the full payload does not ' +
        'even contain.',
    );
  }
});

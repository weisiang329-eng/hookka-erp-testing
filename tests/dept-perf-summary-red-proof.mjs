// ---------------------------------------------------------------------------
// dept-perf-summary-red-proof.mjs — RUN BY HAND. It MUTATES SOURCE FILES.
//
//   node --import tsx/esm tests/dept-perf-summary-red-proof.mjs
//
// Proves tests/dept-perf-summary-projection.test.mjs actually fails when the
// bugs it locks are put back. A guard that has never been seen red is a guard
// you are trusting on faith — and on this repo an assertion anchored on a
// literal "\n" against a CRLF file has produced four false all-clears in one
// week, every one of them a green test that could not fail.
//
// Each mutation is a BYTE CHANGE to the real source, names the SPECIFIC test
// that must go red, and is reverted afterwards (originals are restored in a
// finally block, and the script refuses to start on a dirty tree).
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const TESTS = [
  'tests/dept-perf-summary-projection.test.mjs',
  'tests/attendance-list-no-photo-blobs.test.mjs',
];

const MUTATIONS = [
  {
    name: 'M1 — /employees KPI cards drop view=summary (BUG-2026-08-13-110)',
    file: 'src/pages/employees.tsx',
    find: '`/api/department-performance?view=summary&from=${summaryRange.from}&to=${summaryRange.to}`',
    replace: '`/api/department-performance?from=${summaryRange.from}&to=${summaryRange.to}`',
    mustFail: 'BUG-2026-08-13-110',
  },
  {
    name: 'M2 — Attendance tab month KPI drops view=summary (BUG-2026-08-13-110)',
    file: 'src/pages/employees.tsx',
    find: '`/api/department-performance?view=summary&from=${monthFrom}&to=${monthTo}`',
    replace: '`/api/department-performance?from=${monthFrom}&to=${monthTo}`',
    mustFail: 'BUG-2026-08-13-110',
  },
  {
    name: 'M3 — Department Performance TAB gets narrowed too, blanking its drilldown',
    file: 'src/pages/employees.tsx',
    find: 'const url = `/api/department-performance?from=${dateFrom}&to=${dateTo}&departmentCode=',
    replace: 'const url = `/api/department-performance?view=summary&from=${dateFrom}&to=${dateTo}&departmentCode=',
    mustFail: 'BUG-2026-08-13-110',
  },
  {
    name: 'M4 — Employee Performance tab goes back to the whole-org attendance fetch (BUG-2026-08-13-111)',
    file: 'src/pages/employees.tsx',
    find: `const attUrl = selectedEmployeeId
    ? \`/api/attendance?employeeId=\${encodeURIComponent(selectedEmployeeId)}&from=\${dateFrom}&to=\${dateTo}\`
    : "";`,
    replace: 'const attUrl = `/api/attendance?from=${dateFrom}&to=${dateTo}`;',
    mustFail: 'BUG-2026-08-13-111',
  },
  {
    name: 'M5 — one mobile source drops view=summary (BUG-2026-08-13-112)',
    file: 'src/pages/m/config/modules.ts',
    find: '`/api/department-performance?view=summary&from=${w.from}&to=${w.to}`',
    replace: '`/api/department-performance?from=${w.from}&to=${w.to}`',
    replaceFirstOnly: true,
    mustFail: 'BUG-2026-08-13-112',
  },
  {
    name: 'M6 — GET /api/attendance goes back to SELECT * (BUG-2026-08-13-113)',
    file: 'src/api/routes/attendance.ts',
    find: '`SELECT ${NARROW_COLS} FROM attendance_records ${where}`',
    replace: '`SELECT * FROM attendance_records ${where}`',
    mustFail: 'does not read the punch-selfie blobs',
  },
  {
    name: 'M7 — the 42703 fallback becomes a bare catch, swallowing transient DB errors (BUG-2026-08-13-113)',
    file: 'src/api/routes/attendance.ts',
    find: '    if (code !== "42703" && !/column .* does not exist/i.test(msg)) throw e;',
    replace: '    void code; void msg;',
    mustFail: 'transient DB error is NOT swallowed',
  },
  {
    name: 'M8 — /employees first paint waits on an attendance fetch again (BUG-2026-08-13-114)',
    file: 'src/pages/employees.tsx',
    find: '  const loading = workersLoading;',
    replace: '  const loading = workersLoading || attendanceLoading;',
    mustFail: 'BUG-2026-08-13-114',
  },
  {
    name: 'M9 — projectPerformanceSummary RECOMPUTES totals instead of projecting them',
    file: 'src/api/routes/department-performance.ts',
    find: '    totals: data.totals,\n    daily: (data.daily ?? []).map((d) => ({',
    replace: '    totals: { ...data.totals },\n    daily: (data.daily ?? []).map((d) => ({',
    mustFail: 'summary projects totals BY REFERENCE',
  },
];

function gitClean() {
  const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return out;
}

function runTest() {
  try {
    execFileSync(process.execPath, ['--import', 'tsx/esm', '--test', ...TESTS], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { failed: false, out: '' };
  } catch (e) {
    return { failed: true, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const originals = new Map();
function snapshot(file) {
  if (!originals.has(file)) {
    originals.set(file, readFileSync(resolve(process.cwd(), file), 'utf8'));
  }
}
function restoreAll() {
  for (const [file, src] of originals) {
    writeFileSync(resolve(process.cwd(), file), src);
  }
}

const dirty = gitClean();
if (dirty.trim()) {
  console.log('Working tree is dirty. That is expected while the branch is in\n' +
    'progress — this script restores byte-for-byte from an in-memory snapshot,\n' +
    'not from git, so it is safe. Files it will touch:\n  ' +
    [...new Set(MUTATIONS.map((m) => m.file))].join('\n  ') + '\n');
}

let pass = 0;
let harnessErrors = 0;
try {
  // Sanity: the suite must be GREEN before any mutation, or "it went red" means nothing.
  const baseline = runTest();
  if (baseline.failed) {
    console.error('BASELINE IS ALREADY RED — fix that first.\n' + baseline.out);
    process.exit(1);
  }
  console.log('baseline: GREEN\n');

  for (const m of MUTATIONS) {
    snapshot(m.file);
    const path = resolve(process.cwd(), m.file);
    // EOL-agnostic: every source file in this repo is CRLF on disk, so a
    // multi-line anchor written with "\n" matches NOTHING and the mutation
    // silently no-ops — which reads as "the guard held" when in fact the bug
    // was never reintroduced. Normalise before searching. The originals are
    // restored byte-for-byte from the snapshot, CRLFs included.
    const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const count = src.split(m.find).length - 1;
    if (count === 0) {
      console.error(`  ✗ ${m.name}\n      HARNESS ERROR: anchor not found in ${m.file}.`);
      harnessErrors++;
      continue;
    }
    const mutated = m.replaceFirstOnly
      ? src.replace(m.find, m.replace)
      : src.split(m.find).join(m.replace);
    if (mutated === src) {
      console.error(`  ✗ ${m.name}\n      HARNESS ERROR: mutation changed nothing.`);
      harnessErrors++;
      continue;
    }
    writeFileSync(path, mutated);
    const res = runTest();
    restoreAll();
    if (res.failed && res.out.includes(m.mustFail)) {
      console.log(`  ✓ ${m.name}\n      RED, and the failing test names "${m.mustFail}"`);
      pass++;
    } else if (res.failed) {
      console.error(
        `  ✗ ${m.name}\n      went red, but NOT via "${m.mustFail}" — the wrong test is catching it.`,
      );
      harnessErrors++;
    } else {
      console.error(`  ✗ ${m.name}\n      STAYED GREEN. The guard does not guard.`);
      harnessErrors++;
    }
  }
} finally {
  restoreAll();
}

console.log(
  `\n${pass}/${MUTATIONS.length} mutations proved red, ${harnessErrors} harness failures.`,
);
process.exit(harnessErrors === 0 && pass === MUTATIONS.length ? 0 : 1);

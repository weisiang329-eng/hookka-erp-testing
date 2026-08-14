// ---------------------------------------------------------------------------
// attendance-list-no-photo-blobs.test.mjs — BUG-2026-08-13-113.
//
// GET /api/attendance used to `SELECT *`. A punch selfie is REQUIRED to clock
// in or out and is stored INLINE on the row as a base64 JPEG data URL (capped
// at 600 KB), so every list read dragged two image blobs per worker-day out of
// Postgres — and then threw them away, returning a boolean. The Working Hours
// tab, the DEFAULT tab of /employees, asks for a whole month.
//
// This is a BEHAVIOURAL test against the real Hono handler with a stub DB, not
// a source grep, because the thing that must be proved is an EQUIVALENCE: the
// narrow projection and the old whole-row read produce byte-identical response
// bodies. A fast wrong answer would be worse than the slow right one.
//
// Three properties:
//   1. the query does not SELECT the photo blobs (that is the whole point),
//   2. narrow-path output === SELECT *-path output, byte for byte,
//   3. on a cold database (no runtime geo/photo columns → Postgres 42703) the
//      handler falls back to SELECT * instead of 500ing, and a NON-42703 error
//      is rethrown rather than answered with a second heavy query.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import attendance from '../src/api/routes/attendance.ts';

// A row as Postgres + the d1-compat driver hand it back for `SELECT *`:
// mapped columns arrive camelCase, the RUNTIME-added geo/photo columns arrive
// folded to all-lowercase (they were created through the same unmapped path).
function rowSelectStar({ id, employeeId, date, photoIn, photoOut }) {
  return {
    id,
    employeeId,
    employeeName: `Worker ${employeeId}`,
    departmentCode: 'FAB_SEW',
    departmentName: 'Fabric Sewing',
    date,
    clockIn: '08:02',
    clockOut: '18:11',
    status: 'PRESENT',
    workingMinutes: 609,
    productionTimeMinutes: 518,
    efficiencyPct: 96,
    overtimeMinutes: 60,
    deptBreakdown: JSON.stringify([
      { deptCode: 'FAB_SEW', minutes: 518, productCode: '' },
    ]),
    notes: '',
    clockinlat: 3.187681,
    clockinlng: 101.570928,
    clockoutlat: null,
    clockoutlng: null,
    // The blobs. ~40 KB each in real life; their PRESENCE is what matters here.
    clockinphoto: photoIn ? 'data:image/jpeg;base64,' + 'A'.repeat(40_000) : null,
    clockoutphoto: photoOut ? 'data:image/jpeg;base64,' + 'B'.repeat(40_000) : null,
  };
}

// The same row as the NARROW projection returns it: no blobs, two boolean
// aliases instead. Aliases are lowercase because postgres folds unquoted
// identifiers and `transform.column.from` leaves a name with no underscore
// alone (db-pg.ts:57).
function rowNarrow(spec) {
  const r = rowSelectStar(spec);
  const { clockinphoto, clockoutphoto, ...rest } = r;
  return {
    ...rest,
    hasclockinphoto: clockinphoto !== null,
    hasclockoutphoto: clockoutphoto !== null,
  };
}

const SPECS = [
  { id: 'att-1', employeeId: 'wkr-01', date: '2026-08-03', photoIn: true, photoOut: true },
  { id: 'att-2', employeeId: 'wkr-02', date: '2026-08-03', photoIn: true, photoOut: false },
  { id: 'att-3', employeeId: 'wkr-03', date: '2026-08-04', photoIn: false, photoOut: false },
];

// Stub DB. `mode` decides what the FIRST (narrow) query does.
function makeDb(mode) {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      seen.push(sql);
      const isStar = /SELECT \* FROM attendance_records/.test(sql);
      return {
        bind() {
          return {
            async all() {
              if (isStar) return { results: SPECS.map(rowSelectStar), success: true };
              if (mode === 'coldColumn') {
                const e = new Error(
                  'column "clockinphoto" of relation "attendance_records" does not exist',
                );
                e.code = '42703';
                throw e;
              }
              if (mode === 'transient') {
                const e = new Error('Timed out while creating a new server connection');
                e.code = 'CONNECT_TIMEOUT';
                throw e;
              }
              return { results: SPECS.map(rowNarrow), success: true };
            },
          };
        },
      };
    },
  };
}

async function call(db, query = '?from=2026-08-01&to=2026-08-31') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('orgId', 'hookka');
    c.set('DB', db);
    await next();
  });
  app.route('/api/attendance', attendance);
  return app.request(`/api/attendance${query}`);
}

test('the list query does not read the punch-selfie blobs', async () => {
  const db = makeDb('narrow');
  const res = await call(db);
  assert.equal(res.status, 200);

  assert.equal(db.seen.length, 1, 'exactly one query on the happy path');
  const sql = db.seen[0];
  assert.doesNotMatch(
    sql,
    /SELECT \*/,
    'GET /api/attendance must not SELECT * — that pulls two base64 JPEG blobs ' +
      'per worker-day out of Postgres only to discard them.',
  );
  // The blob columns may appear ONLY inside an IS NOT NULL test, never as a
  // selected value. Strip the two allowed forms, then nothing may remain.
  const stripped = sql
    .replace(/\(clockInPhoto IS NOT NULL\) AS hasclockinphoto/i, '')
    .replace(/\(clockOutPhoto IS NOT NULL\) AS hasclockoutphoto/i, '');
  assert.doesNotMatch(
    stripped,
    /clockInPhoto|clockOutPhoto/i,
    'the photo columns may only be referenced as an IS NOT NULL has-flag',
  );
  // Everything the response shape needs must still be asked for.
  for (const col of [
    'employeeId', 'employeeName', 'departmentCode', 'departmentName', 'date',
    'clockIn', 'clockOut', 'status', 'workingMinutes', 'productionTimeMinutes',
    'efficiencyPct', 'overtimeMinutes', 'deptBreakdown', 'notes',
    'clockInLat', 'clockInLng', 'clockOutLat', 'clockOutLng',
  ]) {
    assert.ok(
      new RegExp(`\\b${col}\\b`).test(sql),
      `narrow projection dropped ${col} — the response would lose a field`,
    );
  }
});

test('FINGERPRINT: narrow projection and SELECT * produce identical bodies', async () => {
  const narrow = await (await call(makeDb('narrow'))).json();
  // 'coldColumn' forces the handler down the SELECT * fallback, which is the
  // pre-change behaviour — so this compares new against old on the same data.
  const star = await (await call(makeDb('coldColumn'))).json();

  assert.equal(
    JSON.stringify(narrow),
    JSON.stringify(star),
    'the narrowed read must return byte-identical JSON to the whole-row read',
  );
  // And it must be RIGHT, not merely consistent: spot-check the flags the
  // projection now computes in SQL rather than from the blob.
  assert.deepEqual(
    narrow.data.map((r) => [r.id, r.hasClockInPhoto, r.hasClockOutPhoto]),
    [
      ['att-1', true, true],
      ['att-2', true, false],
      ['att-3', false, false],
    ],
  );
  // The geo columns survive the projection (they arrive folded-lowercase and
  // are read dual-key).
  assert.equal(narrow.data[0].clockInLat, 3.187681);
  assert.equal(narrow.data[0].clockOutLat, null);
  assert.equal(narrow.total, 3);
});

test('cold database (42703) falls back to SELECT * instead of 500ing', async () => {
  const db = makeDb('coldColumn');
  const res = await call(db);
  assert.equal(res.status, 200);
  assert.equal(db.seen.length, 2, 'narrow attempt, then the SELECT * fallback');
  assert.doesNotMatch(db.seen[0], /SELECT \*/);
  assert.match(db.seen[1], /SELECT \* FROM attendance_records/);
});

test('a transient DB error is NOT swallowed into a second heavy query', async () => {
  const db = makeDb('transient');
  // Hono's onError turns the thrown error into a response rather than letting
  // app.request reject, so the observable proof is: the error PROPAGATED out of
  // the handler (non-2xx) and no second query was issued.
  const res = await call(db);
  assert.notEqual(
    res.status,
    200,
    'only "column does not exist" (42703) may trigger the fallback. A bare ' +
      'catch would answer a pooler blip with a second whole-row read and a ' +
      '200, hiding the outage instead of surfacing it.',
  );
  assert.equal(db.seen.length, 1, 'no fallback query for a non-42703 failure');
});

test('?employeeId= composes with the date window (the BUG-2026-08-13-111 read)', async () => {
  const db = makeDb('narrow');
  const res = await call(db, '?employeeId=wkr-02&from=2026-08-01&to=2026-08-31');
  assert.equal(res.status, 200);
  const sql = db.seen[0];
  assert.match(sql, /employeeId = \?/, 'employeeId must reach the WHERE clause');
  assert.match(sql, /date >= \?/);
  assert.match(sql, /date <= \?/);
  assert.match(
    sql,
    /ORDER BY date DESC, employeeId/,
    'ordering must be unchanged from the unscoped call — with from/to set and ' +
      'no ?date=, both take the same branch (attendance.ts orderBy).',
  );
});

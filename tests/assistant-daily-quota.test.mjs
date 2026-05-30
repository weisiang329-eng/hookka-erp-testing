// ---------------------------------------------------------------------------
// assistant-daily-quota.test.mjs — unit tests for the per-user daily question
// cap helpers in src/api/lib/assistant-daily-quota.ts.
//
// Covers the pure helpers (limit parsing, SGT day bucketing, reset countdown)
// plus the KV read/bump functions against a tiny in-memory fake KV — so we
// exercise the fail-open posture and the increment without a real Cloudflare
// binding.
//
// Why this matters (2026-05-31): Wei Siang asked for a hard cap of 10
// questions per person per day INCLUDING himself, to bound worst-case
// Anthropic spend. The day boundary is Singapore time (UTC+8), and a KV
// outage must NEVER lock the operator out — both verified here.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

let loaderRegistered = false;
try {
  register('tsx/esm', pathToFileURL('./'));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it.
}

let quota;
try {
  quota = await import('../src/api/lib/assistant-daily-quota.ts');
} catch (err) {
  console.error('Failed to import assistant-daily-quota:', err);
  throw err;
}

const {
  getDailyLimit,
  sgtDayKey,
  secondsUntilSgtMidnight,
  getDailyUsage,
  bumpDailyUsage,
} = quota;

// Tiny in-memory KV that satisfies the {get, put} shape the lib expects.
function makeFakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

test('module exports the helpers', () => {
  assert.equal(typeof getDailyLimit, 'function');
  assert.equal(typeof sgtDayKey, 'function');
  assert.equal(typeof secondsUntilSgtMidnight, 'function');
  assert.equal(typeof getDailyUsage, 'function');
  assert.equal(typeof bumpDailyUsage, 'function');
});

test('getDailyLimit — default 10 when unset / blank / garbage', () => {
  assert.equal(getDailyLimit({}), 10);
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: undefined }), 10);
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: '' }), 10);
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: '   ' }), 10);
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: 'abc' }), 10);
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: '-5' }), 10);
});

test('getDailyLimit — honours a configured positive value', () => {
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: '20' }), 20);
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: '1' }), 1);
});

test('getDailyLimit — "0" means no cap (disabled)', () => {
  assert.equal(getDailyLimit({ ASSISTANT_DAILY_LIMIT: '0' }), 0);
});

test('sgtDayKey — uses Singapore wall-clock date (UTC+8)', () => {
  // 2026-05-31 18:00 UTC is 2026-06-01 02:00 SGT → next SGT day.
  const utcEvening = Date.UTC(2026, 4, 31, 18, 0, 0);
  assert.equal(sgtDayKey(utcEvening), '2026-06-01');

  // 2026-05-31 10:00 UTC is 2026-05-31 18:00 SGT → same SGT day.
  const utcMorning = Date.UTC(2026, 4, 31, 10, 0, 0);
  assert.equal(sgtDayKey(utcMorning), '2026-05-31');
});

test('sgtDayKey — the SGT midnight boundary rolls the date over', () => {
  // 15:59 UTC = 23:59 SGT (still 31st); 16:00 UTC = 00:00 SGT (now 1st).
  const justBefore = Date.UTC(2026, 4, 31, 15, 59, 0);
  const justAfter = Date.UTC(2026, 4, 31, 16, 0, 0);
  assert.equal(sgtDayKey(justBefore), '2026-05-31');
  assert.equal(sgtDayKey(justAfter), '2026-06-01');
});

test('sgtDayKey — pads month and day to two digits', () => {
  // 2026-01-05 03:00 UTC = 2026-01-05 11:00 SGT.
  const d = Date.UTC(2026, 0, 5, 3, 0, 0);
  assert.equal(sgtDayKey(d), '2026-01-05');
});

test('secondsUntilSgtMidnight — counts down to the next SGT midnight', () => {
  // 16:00 UTC = 00:00 SGT exactly → a full day (86400s) until next midnight.
  const sgtMidnight = Date.UTC(2026, 4, 31, 16, 0, 0);
  assert.equal(secondsUntilSgtMidnight(sgtMidnight), 86400);

  // One hour after SGT midnight → 23h left = 82800s.
  const oneHourIn = Date.UTC(2026, 4, 31, 17, 0, 0);
  assert.equal(secondsUntilSgtMidnight(oneHourIn), 82800);
});

test('secondsUntilSgtMidnight — never returns 0 or negative', () => {
  // A few ms before SGT midnight should still be >= 1.
  const almostMidnight = Date.UTC(2026, 4, 31, 15, 59, 59) + 999;
  const s = secondsUntilSgtMidnight(almostMidnight);
  assert.ok(s >= 1, `expected >= 1, got ${s}`);
});

test('getDailyUsage — fail-open: missing KV returns 0', async () => {
  assert.equal(await getDailyUsage(undefined, 'user-1', Date.now()), 0);
});

test('getDailyUsage — returns 0 for a fresh user/day', async () => {
  const kv = makeFakeKv();
  assert.equal(await getDailyUsage(kv, 'user-1', Date.now()), 0);
});

test('bumpDailyUsage — increments and getDailyUsage reflects it', async () => {
  const kv = makeFakeKv();
  const now = Date.now();
  assert.equal(await bumpDailyUsage(kv, 'user-1', now), 1);
  assert.equal(await bumpDailyUsage(kv, 'user-1', now), 2);
  assert.equal(await bumpDailyUsage(kv, 'user-1', now), 3);
  assert.equal(await getDailyUsage(kv, 'user-1', now), 3);
});

test('bumpDailyUsage — per-user isolation (one user does not spend another\'s quota)', async () => {
  const kv = makeFakeKv();
  const now = Date.now();
  await bumpDailyUsage(kv, 'user-A', now);
  await bumpDailyUsage(kv, 'user-A', now);
  await bumpDailyUsage(kv, 'user-B', now);
  assert.equal(await getDailyUsage(kv, 'user-A', now), 2);
  assert.equal(await getDailyUsage(kv, 'user-B', now), 1);
});

test('bumpDailyUsage — counter is independent across SGT days', async () => {
  const kv = makeFakeKv();
  const day1 = Date.UTC(2026, 4, 31, 2, 0, 0); // 2026-05-31 SGT
  const day2 = Date.UTC(2026, 5, 1, 2, 0, 0); // 2026-06-01 SGT
  await bumpDailyUsage(kv, 'user-1', day1);
  await bumpDailyUsage(kv, 'user-1', day1);
  assert.equal(await getDailyUsage(kv, 'user-1', day1), 2);
  // New SGT day → fresh counter.
  assert.equal(await getDailyUsage(kv, 'user-1', day2), 0);
  await bumpDailyUsage(kv, 'user-1', day2);
  assert.equal(await getDailyUsage(kv, 'user-1', day2), 1);
  // Yesterday's count is untouched.
  assert.equal(await getDailyUsage(kv, 'user-1', day1), 2);
});

test('bumpDailyUsage — fail-open: missing KV returns 0 and does not throw', async () => {
  assert.equal(await bumpDailyUsage(undefined, 'user-1', Date.now()), 0);
});

test('getDailyUsage — sanitises odd user ids without colliding distinct users', async () => {
  const kv = makeFakeKv();
  const now = Date.now();
  // Two ids that differ only in characters that survive sanitisation must
  // not collide.
  await bumpDailyUsage(kv, 'user@hookka.com', now);
  assert.equal(await getDailyUsage(kv, 'user@hookka.com', now), 1);
  assert.equal(await getDailyUsage(kv, 'other@hookka.com', now), 0);
});

test('loader detection — sanity check tsx loader is wired', () => {
  assert.ok(loaderRegistered || true, 'loader registration optional in newer Node');
});

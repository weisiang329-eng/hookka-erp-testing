// ---------------------------------------------------------------------------
// resign-lockout.test.mjs — structural guards for "marking a worker RESIGNED
// locks them out of the worker app". Two halves that must BOTH hold:
//   1. Every worker-app request rejects a non-ACTIVE worker (not just fresh
//      logins) — the token resolver itself doesn't check status, so a phone
//      already signed in before the worker resigned would otherwise keep
//      working forever (tokens have no expiry).
//   2. Setting status to non-ACTIVE purges the worker's login tokens, so an
//      already-open session is kicked the moment the operator resigns them.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKER = readFileSync(
  resolve(process.cwd(), "src/api/routes/worker.ts"),
  "utf8",
);
const WORKERS = readFileSync(
  resolve(process.cwd(), "src/api/routes/workers.ts"),
  "utf8",
);

test("getWorker rejects a non-ACTIVE worker on EVERY request (not just login)", () => {
  assert.ok(
    /async function getWorker\([\s\S]{0,1400}w\.status !== "ACTIVE"/.test(WORKER),
    "getWorker must 403 when the resolved worker is not ACTIVE",
  );
  assert.ok(
    WORKER.includes("Employee account inactive"),
    "the rejection must carry the inactive-account error",
  );
});

test("resigning/deactivating a worker purges their login tokens (kills the open session)", () => {
  assert.ok(
    /merged\.status !== "ACTIVE"[\s\S]{0,200}DELETE FROM worker_tokens WHERE workerId = \?/.test(
      WORKERS,
    ),
    "the worker PUT must delete worker_tokens when the new status is not ACTIVE",
  );
});

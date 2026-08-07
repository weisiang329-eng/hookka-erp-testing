// readbackWithRetry — the transient-readback retry behind verifiedSave.
//
// The write returns 2xx before the readback runs, so a readback that throws
// (the global 30s fetch cap firing on a slow tail — "signal is aborted without
// reason") or comes back empty is almost always transient. Reporting that one
// blip as "save failed" rolled the UI back and told the owner their credit-
// limit edit was lost when it had actually persisted. This retries first.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const vs = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/verified-save.ts")).href
);

test("a first-attempt abort, then success, resolves to the value", async () => {
  let n = 0;
  const r = await vs.readbackWithRetry(async () => {
    n++;
    if (n === 1) throw new DOMException("signal is aborted without reason", "AbortError");
    return { id: "c1", creditLimitSen: 25000000 };
  }, (v) => v == null);
  assert.equal(n, 2, "should have retried once");
  assert.equal(r.lastErr, null);
  assert.deepEqual(r.value, { id: "c1", creditLimitSen: 25000000 });
});

test("a null first result is retried when emptyIsRetryable says so", async () => {
  let n = 0;
  const r = await vs.readbackWithRetry(async () => {
    n++;
    return n < 2 ? null : { id: "c1" };
  }, (v) => v == null);
  assert.equal(n, 2);
  assert.deepEqual(r.value, { id: "c1" });
});

test("persistent failure gives up after 3 attempts and reports the last error", async () => {
  let n = 0;
  const r = await vs.readbackWithRetry(async () => {
    n++;
    throw new Error("still down");
  }, (v) => v == null);
  assert.equal(n, 3, "exactly READBACK_ATTEMPTS tries");
  assert.equal(r.value, null);
  assert.match(String(r.lastErr), /still down/);
});

test("bulk mode (emptyIsRetryable=false) accepts an empty array without retrying", async () => {
  let n = 0;
  const r = await vs.readbackWithRetry(async () => {
    n++;
    return [];
  }, () => false);
  assert.equal(n, 1, "an empty array is a valid bulk shape — no retry");
  assert.deepEqual(r.value, []);
});

test("bulk mode still retries a throw", async () => {
  let n = 0;
  const r = await vs.readbackWithRetry(async () => {
    n++;
    if (n === 1) throw new Error("blip");
    return [{ id: "a" }];
  }, () => false);
  assert.equal(n, 2);
  assert.deepEqual(r.value, [{ id: "a" }]);
});

test("succeeds on the very first try without delay when the readback is healthy", async () => {
  let n = 0;
  const t0 = Date.now();
  const r = await vs.readbackWithRetry(async () => { n++; return { id: "x" }; }, (v) => v == null);
  assert.equal(n, 1);
  assert.ok(Date.now() - t0 < 250, "no backoff delay on first-try success");
  assert.deepEqual(r.value, { id: "x" });
});

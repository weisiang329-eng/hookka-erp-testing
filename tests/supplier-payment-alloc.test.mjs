import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/supplier-payment-alloc.ts")).href);

test("computeAlloc — MYR partial: booked=bank, no fx", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 100000, isForeign: false, fxRate: 1, payMyrSen: 40000, full: false });
  assert.deepEqual(r, { ok: true, bookedSen: 40000, bankSen: 40000, fxDiffSen: 0 });
});

test("computeAlloc — MYR over outstanding → error", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 30000, isForeign: false, fxRate: 1, payMyrSen: 40000, full: false });
  assert.equal(r.ok, false);
});

test("computeAlloc — foreign partial: 300 USD @ book 4.5 / pay 4.6 → loss 30", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 450000, isForeign: true, fxRate: 4.5, foreignSen: 30000, payRate: 4.6, full: false });
  assert.deepEqual(r, { ok: true, bookedSen: 135000, bankSen: 138000, fxDiffSen: -3000 });
});

test("computeAlloc — foreign FULL settle uses outstanding for booked (no cent residue)", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 450000, isForeign: true, fxRate: 4.5, foreignSen: 100000, payRate: 4.6, full: true });
  assert.equal(r.ok, true);
  assert.equal(r.bookedSen, 450000);
  assert.equal(r.bankSen, 460000);
  assert.equal(r.fxDiffSen, -10000);
});

test("computeAlloc — foreign requires payRate>0", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 450000, isForeign: true, fxRate: 4.5, foreignSen: 30000, payRate: 0, full: false });
  assert.equal(r.ok, false);
});

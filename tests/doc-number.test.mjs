import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/doc-number.ts")).href);

test("ymFromDate — YYMM from ISO date (voucher date, not today)", () => {
  assert.equal(m.ymFromDate("2026-06-15"), "2606");
  assert.equal(m.ymFromDate("2026-05-01"), "2605");
  assert.equal(m.ymFromDate("2025-12-31"), "2512");
});

test("formatDocNo — prefix-YYMM-NNN, pad 3, grow past 999", () => {
  assert.equal(m.formatDocNo("HPV", "2606", 1), "HPV-2606-001");
  assert.equal(m.formatDocNo("HPV", "2606", 42), "HPV-2606-042");
  assert.equal(m.formatDocNo("HOR", "2606", 7), "HOR-2606-007");
  assert.equal(m.formatDocNo("HPV", "2606", 1000), "HPV-2606-1000");
});

test("resolveDocPrefix — configured wins, else default by direction", () => {
  const cfg = { "310-0010": { out: "HPV", in: "HOR" }, "320-0000": { out: "CPV", in: "COR" } };
  assert.equal(m.resolveDocPrefix(cfg, "310-0010", "out"), "HPV");
  assert.equal(m.resolveDocPrefix(cfg, "310-0010", "in"), "HOR");
  assert.equal(m.resolveDocPrefix(cfg, "320-0000", "out"), "CPV");
  assert.equal(m.resolveDocPrefix(cfg, "999-9999", "out"), "PV");
  assert.equal(m.resolveDocPrefix(cfg, "999-9999", "in"), "OR");
  assert.equal(m.resolveDocPrefix({}, "310-0010", "out"), "PV");
});

// Multi-company (Phase 2) — company selector query-suffix helper.
//
// The ADDITIVE guarantee is: on the DEFAULT "All companies (group)" option
// (value ""), the report fetch URL is byte-identical to today (no orgId
// param appended). Only an explicit company code appends `&orgId=<code>`.
// This test locks that contract so a future refactor can't silently start
// scoping the default (group) view.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(
  pathToFileURL(resolve(process.cwd(), "src/pages/accounting/shared.ts")).href
);

test("orgIdParam — group default ('') appends NOTHING (byte-identical URL)", () => {
  assert.equal(m.orgIdParam(""), "");
});

test("orgIdParam — a company code appends &orgId=<code>", () => {
  assert.equal(m.orgIdParam("hookka"), "&orgId=hookka");
  assert.equal(m.orgIdParam("ohana"), "&orgId=ohana");
});

test("orgIdParam — URL-encodes the code", () => {
  assert.equal(m.orgIdParam("hk mfg"), "&orgId=hk%20mfg");
});

test("orgIdParam — a base report URL stays unchanged on the group view", () => {
  const base = "/api/accounting/pl?period=2026-07";
  assert.equal(base + m.orgIdParam(""), base);
  assert.equal(base + m.orgIdParam("ohana"), base + "&orgId=ohana");
});

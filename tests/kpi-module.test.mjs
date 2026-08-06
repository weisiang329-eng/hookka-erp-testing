// ---------------------------------------------------------------------------
// The KPI module — scoring rules and who can see what.
//
// Owner 2026-08-06: "直接 assign 到他的户口，只有他自己可以看得到 … 这部分只有
// Super Admin 可以操作", settled monthly.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  KPI_CATALOG, GATE_FAIL_CAP, attainment, kpiByKey, kpisForRole,
} from "../src/api/lib/kpi-catalog.ts";

const ROUTE = readFileSync(resolve(process.cwd(), "src/api/routes/kpi.ts"), "utf8");

test("the customer's delivery date is a gate, not a percentage", () => {
  // Owner: "顾客的日期绝对不可以 overdue … 这是最低原则". Scoring it as a ratio
  // would say the opposite — that a few percent late is acceptable.
  const g = kpiByKey("customer_delivery_date");
  assert.equal(g.shape, "GATE");
  assert.equal(g.defaultTarget, 0);
  assert.equal(g.defaultWeight, 0, "a gate caps the score, it does not earn points");
  assert.ok(GATE_FAIL_CAP > 0 && GATE_FAIL_CAP < 100);
});

test("attainment is capped and floored", () => {
  const up = { direction: "HIGHER_IS_BETTER" };
  const down = { direction: "LOWER_IS_BETTER" };
  assert.equal(attainment(up, 95, 95), 100);
  assert.equal(attainment(up, 95, 31), 32.6);
  // Capped: one runaway metric must not paper over a failure elsewhere.
  assert.equal(attainment(up, 10, 100), 120);
  // Floored: a bad month cannot produce negative points.
  assert.equal(attainment(up, 95, 0), 0);
  // Fewer problems than target is full marks, not extra credit.
  assert.equal(attainment(down, 40, 10), 100);
  assert.equal(attainment(down, 40, 80), 50);
  assert.equal(attainment(up, 95, NaN), 0);
});

test("every KPI is measurable — there is no subjective type", () => {
  // Owner 2026-08-06: "每一个 KPI 都必须是可以量化的，员工怎么去达成、做到什么
  // 程度能拿多少分 … 全部都要有明确、可衡量的标准." A score assigned by
  // impression at month end cannot be worked towards, so it is not a KPI.
  for (const k of KPI_CATALOG) {
    assert.ok(
      k.scoring === "AUTO" || k.scoring === "CHECKLIST",
      `${k.key} has scoring ${k.scoring} — only AUTO and CHECKLIST are measurable`,
    );
    assert.ok(k.available, `${k.key} must be computable; express it as a checklist if the data is missing`);
  }
});

test("a checklist states its items up front", () => {
  // The employee has to know what earns the marks BEFORE the month, and the
  // denominator lives in code so nobody can raise a score by shortening it.
  for (const k of KPI_CATALOG.filter((k) => k.scoring === "CHECKLIST")) {
    assert.ok(Array.isArray(k.checklistItems) && k.checklistItems.length >= 3,
      `${k.key} needs a real list of actions`);
    for (const item of k.checklistItems) {
      assert.ok(item.length > 12, `${k.key}: "${item}" is too vague to tick honestly`);
    }
  }
});

test("every KPI explains how it is calculated", () => {
  // Owner: "系统会提供一个完整的清单给员工，让他们清清楚楚地知道自己的 KPI
  // 是如何计算和获取的."
  for (const k of KPI_CATALOG) {
    assert.ok(k.formula && k.formula.length > 25, `${k.key} has no readable formula`);
  }
});

test("every AUTO KPI can be drilled into", () => {
  // A number nobody can click is a number nobody trusts. A checklist is its
  // own drill-down — the items ARE the detail.
  for (const k of KPI_CATALOG.filter((k) => k.scoring === "AUTO")) {
    assert.ok(k.drillPath, `${k.key} has no drill-down`);
  }
});

test("my own card can never be asked for as someone else's", () => {
  const me = ROUTE.slice(ROUTE.indexOf('app.get("/me"'), ROUTE.indexOf('app.get("/users/:id"'));
  assert.match(me, /ctxGet\(c, "userId"\)/, "/me must read the caller's id from the context");
  assert.doesNotMatch(me, /c\.req\.(param|query)\(\s*["']userId/, "/me must never take a user id from the request");
});

test("every cross-user route is SUPER_ADMIN", () => {
  for (const route of ['app.get("/users/:id"', 'app.get("/catalog"', 'app.get("/assignments/:id"', 'app.put("/assignments/:id"']) {
    const i = ROUTE.indexOf(route);
    assert.ok(i > 0, `${route} missing`);
    const body = ROUTE.slice(i, i + 260);
    assert.match(body, /requireSuperAdmin\(c\)/, `${route} is not gated`);
  }
});

test("a settled month is served as stored, not recomputed", () => {
  // Otherwise editing a target retroactively moves a score that was already
  // agreed — and the whole thing becomes unarguable.
  assert.match(ROUTE, /lockedAt IS NOT NULL/);
  assert.match(ROUTE, /if \(isLocked\)/);
});

test("a person is scored on what they were assigned, not on the whole catalogue", () => {
  assert.match(ROUTE, /if \(!a \|\| a\.isActive === false\) continue;/);
  assert.ok(kpisForRole("OFFICE").length >= 4);
  assert.equal(kpisForRole("NOT_A_ROLE").length, 0);
});

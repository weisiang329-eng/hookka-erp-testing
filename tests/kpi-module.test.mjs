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

test("nothing caps the score — every assigned KPI is simply weighted", () => {
  // This once capped the month at 60 when the promised date was missed. Owner
  // 2026-08-06: "我还是可以 assign，assign 是 assign 啊，为什么你要 cap 呢？应该
  // 说我 assign 这个东西给那个人，那个人就要顾." Assigning it already makes it
  // theirs; capping punishes twice for one miss and makes the other five KPIs
  // pointless in a month where it happened.
  const g = kpiByKey("customer_delivery_date");
  assert.equal(g.defaultTarget, 0, "the target is still zero late");
  assert.ok(g.defaultWeight > 0, "it earns points now, like every other KPI");

  const route = readFileSync(resolve(process.cwd(), "src/api/routes/kpi.ts"), "utf8");
  assert.doesNotMatch(route, /Math\.min\(GATE_FAIL_CAP/, "the cap must not be applied");
  assert.match(route, /const gateFailed = false;/);
  // Every line with points counts towards the total — none are filtered out
  // for being a gate.
  assert.match(route, /lines\.filter\(\(l\) => l\.points !== null\)/);
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

test("a KPI is measurable unless it provably cannot be", () => {
  // Owner 2026-08-06: "每一个 KPI 都必须是可以量化的 … 全部都要有明确、可衡量的
  // 标准." Owner 2026-08-07, drawing the line one step further out: "Auto：也就
  // 是 measurable 的 … Checklist：肯定也是 measurable 的 … 而这一个就不是
  // measurable 的，它是属于人工评分的."
  //
  // So MANUAL exists, but it is the exception and has to earn its place. The
  // guard is no longer "no subjective type" — it is that a subjective type
  // still tells the employee in advance what earns what.
  for (const k of KPI_CATALOG) {
    assert.ok(
      ["AUTO", "CHECKLIST", "SURVEY", "MANUAL"].includes(k.scoring),
      `${k.key} has an unknown scoring type ${k.scoring}`,
    );
    assert.ok(k.available, `${k.key} must be computable, ticked, surveyed or rated`);
  }

  // Most of the catalogue must still come out of the data. If MANUAL ever
  // becomes the easy answer, the whole thing decays into opinion with numbers
  // on it — which is what the 2026-08-06 ruling was protecting against.
  const manual = KPI_CATALOG.filter((k) => k.scoring === "MANUAL");
  assert.ok(
    manual.length * 3 <= KPI_CATALOG.length,
    `${manual.length} of ${KPI_CATALOG.length} KPIs are hand-rated — too many to still call this measured`,
  );
});

test("a rated KPI publishes its bands before the month starts", () => {
  // A supervisor's score is only fair if the employee could read, in advance,
  // what a 90 looks like and what a 40 looks like.
  for (const k of KPI_CATALOG.filter((k) => k.scoring === "MANUAL")) {
    assert.equal(k.curve, "MANUAL_SCORE", `${k.key} must score on the rating itself`);
    assert.ok(
      Array.isArray(k.ratingGuide) && k.ratingGuide.length >= 3,
      `${k.key} needs a written guide — a bare number cannot be worked towards`,
    );
    assert.ok(
      k.measurement.some((m) => /supervisor/i.test(m)),
      `${k.key} must say plainly that a human scores it`,
    );
  }
});

test("invoicing lag costs 10 points per document-day", () => {
  // Owner 2026-08-07: "dispatch 了之后三天内要看到 invoice，迟一天扣10分 … 5张单
  // 1天就50分." Five documents one day late is the same as one document five
  // days late — the unit is the document-day, not the document.
  const d = kpiByKey("documents_not_stuck");
  assert.equal(d.penaltyPerUnit, 10);
  assert.equal(d.graceDays, 3, "invoiced within 3 days of dispatch is not late");

  // The half-score the metric computes before blending.
  const half = (days) => Math.max(0, Math.min(100, 100 - days * d.penaltyPerUnit));
  assert.equal(half(0), 100, "everything billed inside 3 days");
  assert.equal(half(1), 90, "one document, one day late");
  assert.equal(half(5), 50, "five documents one day late each — or one, five days late");
  assert.equal(half(10), 0);
  assert.equal(half(40), 0, "cannot go negative");
});

test("the invoicing and exception KPIs are merged into one, with no double count", () => {
  // Owner 2026-08-07: "这两个要结合" — uninvoiced deliveries were scored by the
  // invoicing KPI AND counted again inside the daily exception total.
  assert.equal(
    kpiByKey("exceptions_cleared"),
    undefined,
    "the separate exception KPI is retired, not left alongside the merged one",
  );
  const d = kpiByKey("documents_not_stuck");
  assert.equal(d.curve, "COMPOSITE", "the metric blends the halves and hands back a score");
  assert.equal(attainment(d, 100, 73.5), 73.5, "a composite passes straight through");
  assert.equal(attainment(d, 100, 0), 0);

  // Both halves have to be described, or the employee cannot tell which half
  // cost them the marks.
  const text = d.measurement.join(" ");
  assert.match(text, /HALF ONE/, "the invoicing half must be spelled out");
  assert.match(text, /HALF TWO/, "the exception half must be spelled out");
  assert.match(
    text,
    /EXCLUDING the uninvoiced buckets/,
    "the exception half must say it drops what the invoicing half already scored",
  );

  // The retired key must not still be assignable to anyone.
  const src = readFileSync(resolve(process.cwd(), "src/api/lib/ensure-kpi-tables.ts"), "utf8");
  assert.match(
    src,
    /DELETE FROM kpi_assignments WHERE kpi_key = 'exceptions_cleared'/,
    "existing assignments on the retired key must be migrated, not orphaned",
  );
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

// ── Payout ──────────────────────────────────────────────────────────────────
// Owner 2026-08-06: "75 分未必是拿到 75% 的钱，可能 75 分拿到的是 60%。如果是
// 50 分的话，是不是就直接拿不到了?" Yes to both — banded, with nothing below
// the lowest rung.

test("the ladder is banded, not straight-line", async () => {
  const { payoutSen, bandFor, DEFAULT_PAYOUT_BANDS } = await import("../src/api/lib/kpi-catalog.ts");
  const pot = 100000; // RM 1,000
  const pay = (score) =>
    payoutSen(score, { mode: "MONTHLY_CASH", amountSen: pot, bands: DEFAULT_PAYOUT_BANDS }) / 100;

  assert.equal(pay(75), 600, "75 pays the 60% band, not 75%");
  assert.equal(pay(50), 0, "below the lowest rung pays nothing");
  assert.equal(pay(100), 1000);
  assert.equal(pay(60), 400, "the bottom rung still pays");
  assert.equal(pay(59), 0, "one point below it does not");

  // The cliff IS the mechanism — it is what makes 79 worth pushing to 80.
  assert.equal(pay(79), 600);
  assert.equal(pay(80), 800);
  assert.equal(bandFor(79, DEFAULT_PAYOUT_BANDS).payPct, 60);
  assert.equal(bandFor(80, DEFAULT_PAYOUT_BANDS).payPct, 80);
  assert.equal(bandFor(12, DEFAULT_PAYOUT_BANDS), null);
});

test("score-only pays nothing, whatever the score", async () => {
  const { payoutSen, DEFAULT_PAYOUT_BANDS } = await import("../src/api/lib/kpi-catalog.ts");
  // The score still exists — it is settled at year end, outside this system.
  assert.equal(payoutSen(100, { mode: "SCORE_ONLY", amountSen: 100000, bands: DEFAULT_PAYOUT_BANDS }), 0);
});

test("a broken payout config never silently zeroes someone's pay", async () => {
  const { payoutSen, bandFor } = await import("../src/api/lib/kpi-catalog.ts");
  // No bands configured falls back to the standard ladder rather than paying 0.
  assert.equal(payoutSen(95, { mode: "MONTHLY_CASH", amountSen: 100000, bands: [] }) / 100, 1000);
  assert.equal(bandFor(95, []).payPct, 100);
  // No pot means no money regardless — that is a deliberate setting, not a bug.
  assert.equal(payoutSen(95, { mode: "MONTHLY_CASH", amountSen: 0, bands: [] }), 0);
  assert.equal(payoutSen(null, { mode: "MONTHLY_CASH", amountSen: 100000, bands: [] }), 0);
});

test("a rung can pay a share of the pot OR a flat sum", async () => {
  // Owner 2026-08-06: "can by amount also can by %". Both are in real use — a
  // percentage scales when the pot is reviewed, a flat sum is what people
  // actually negotiate ("hit 80 and you get RM 800").
  const { payoutSen, bandValueSen } = await import("../src/api/lib/kpi-catalog.ts");
  const flat = [
    { minScore: 90, payPct: 0, payAmountSen: 120000 },
    { minScore: 80, payPct: 0, payAmountSen: 80000 },
    { minScore: 70, payPct: 0, payAmountSen: 50000 },
  ];
  // A flat ladder needs NO pot behind it — that is the point of pinning a rung.
  assert.equal(payoutSen(95, { mode: "MONTHLY_CASH", amountSen: 0, bands: flat }) / 100, 1200);
  assert.equal(payoutSen(75, { mode: "MONTHLY_CASH", amountSen: 0, bands: flat }) / 100, 500);
  assert.equal(payoutSen(65, { mode: "MONTHLY_CASH", amountSen: 0, bands: flat }), 0);

  // A flat rung wins over the percentage on the same row, so one rung can be
  // pinned without disturbing the others.
  const mixed = [{ minScore: 80, payPct: 80, payAmountSen: 99900 }];
  assert.equal(payoutSen(85, { mode: "MONTHLY_CASH", amountSen: 100000, bands: mixed }) / 100, 999);

  assert.equal(bandValueSen({ minScore: 80, payPct: 80 }, 100000) / 100, 800);
  assert.equal(bandValueSen({ minScore: 80, payPct: 0, payAmountSen: 75000 }, 100000) / 100, 750);
});


test("late delivery is scored per percentage point, not per order", async () => {
  // Owner 2026-08-06: "如果有 1% 的订单延迟送货，就会扣 10 分 … 如果达到 10%
  // 延迟，最多也就扣完这 100% 的分数." A ratio against a target of 0 divides by
  // zero; this needs its own curve.
  const { attainment, kpiByKey } = await import("../src/api/lib/kpi-catalog.ts");
  const d = kpiByKey("customer_delivery_date");
  assert.equal(d.curve, "PENALTY_PER_PCT");
  assert.equal(d.penaltyPerPct, 10);
  assert.equal(d.unit, "%", "the actual must be a percentage — 9 of 41 and 9 of 400 are different failures");

  assert.equal(attainment(d, 0, 0), 100);
  assert.equal(attainment(d, 0, 1), 90);
  assert.equal(attainment(d, 0, 5), 50);
  assert.equal(attainment(d, 0, 10), 0);
  assert.equal(attainment(d, 0, 25), 0, "worse than 10% cannot go negative");
});

test("the survey scores five 1–5 answers out of 100", async () => {
  // Owner: "如果是四个 5 分和一个 4 分 … 总分就是 96 分."
  const { attainment, kpiByKey } = await import("../src/api/lib/kpi-catalog.ts");
  const q = kpiByKey("customer_satisfaction");
  assert.equal(q.scoring, "SURVEY");
  assert.equal(q.surveyQuestions.length, 5, "five questions, 20 points each");
  for (const question of q.surveyQuestions) {
    assert.ok(question.endsWith("?"), `"${question}" should be a question`);
    assert.ok(question.length > 40, "each question has to be specific enough to answer honestly");
  }

  const score = (answers) => (answers.reduce((a, b) => a + b, 0) / 25) * 100;
  assert.equal(score([5, 5, 5, 5, 5]), 100);
  assert.equal(score([5, 5, 5, 5, 4]), 96);
  // Attainment is the survey mean itself, so weight 20 on a 96 earns 19.2.
  assert.equal(attainment(q, 90, 96), 96);
  assert.equal(Math.round((attainment(q, 90, 96) / 100) * 20 * 10) / 10, 19.2);
});

test("production efficiency: 100% is full marks, 80% is the floor, 75% is nothing", () => {
  // Owner 2026-08-07: "达到 80%：基本上还能拿得到 60 分 … 低于 80%（可能在 75%
  // 之下）：直接 0 分 … 最低要求最少都要达到 80%，最好是 90% 以上，通常都是 100%."
  const d = kpiByKey("production_efficiency");
  assert.equal(d.curve, "EFFICIENCY_BANDS");
  assert.equal(d.efficiencyFloorPct, 80);
  assert.equal(d.efficiencyFloorScore, 60);
  assert.equal(d.efficiencyZeroPct, 75);

  assert.equal(attainment(d, 100, 100), 100, "the normal month scores full marks");
  assert.equal(attainment(d, 100, 120), 100, "no bonus above standard — that means the standard is wrong");
  assert.equal(attainment(d, 100, 90), 80, "the ideal target");
  assert.equal(attainment(d, 100, 85), 70);
  assert.equal(attainment(d, 100, 80), 60, "the floor");
  assert.equal(attainment(d, 100, 78), 36, "below the floor it falls away fast");
  assert.equal(attainment(d, 100, 76), 12);
  assert.equal(attainment(d, 100, 75), 0);
  assert.equal(attainment(d, 100, 50), 0);

  // Monotonic: more efficiency can never score less.
  let prev = -1;
  for (let e = 60; e <= 105; e += 0.5) {
    const s = attainment(d, 100, e);
    assert.ok(s >= prev, `score fell going from just under ${e}% to ${e}%`);
    prev = s;
  }
});

test("pending time-adjustment requests are a daily-report exception", () => {
  // Owner 2026-08-07: "either reject or approve 而不是 hanging 在那边."
  const src = readFileSync(resolve(process.cwd(), "src/api/lib/compliance-report.ts"), "utf8");
  assert.match(src, /pendingTimeAdjustments: number;/, "it must be a counted category");
  assert.match(src, /pendingTimeAdjustments: pendingTimeAdjustments\.length/,
    "it must be in the counts block");
  // Parse the total expression rather than matching on position — see the note
  // in cogs-integrity.test.mjs for why the positional form is a trap.
  const total = src.match(/total:\s*\n([\s\S]*?);/)?.[1] ?? "";
  assert.ok(
    total.includes("pendingTimeAdjustments.length"),
    "and inside the total, or the KPI's burn-down will never see it",
  );
  // The columns this reads are real ones — worker_nonprod_requests stores
  // hours and worker_id, not minutes and workerName. The first draft asked for
  // the wrong two and would have logged an error and returned an empty list.
  assert.match(src, /SELECT id, workerId, departmentCode, hours, kind, date, createdAt/);
});

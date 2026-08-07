// ---------------------------------------------------------------------------
// The PUBLIC customer satisfaction survey — the link you actually send someone.
//
// Owner 2026-08-07: "这些是发顾客一个类似 google form submit 选择的，直接评分."
// Until now only the Super-Admin-keys-it-in endpoint existed.
//
// This is a public WRITE endpoint with no human on our side of it, so the
// tests below drive the real Hono app against an in-memory database and assert
// BEHAVIOUR — what a caller can actually do — rather than what the source text
// looks like. The two failures that would matter most in the wild:
//
//   • a spent link being REPLAYED (one happy customer submitted twenty times
//     is not a measurement, it is whatever the office wanted it to say), and
//   • an OUT-OF-RANGE answer landing (a 9, a 0, a 3.5 or four answers all
//     quietly move the mean and nothing looks wrong).
// ---------------------------------------------------------------------------
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import surveyApp from "../src/api/routes/public-kpi-survey.ts";
import { _resetKpiTablesMemoForTests } from "../src/api/lib/ensure-kpi-tables.ts";
import { kpiByKey } from "../src/api/lib/kpi-catalog.ts";
import {
  newSurveyToken,
  surveyLinkUrl,
  surveyTokenState,
  validateAnswers,
  clampTokenDays,
  SURVEY_TOKEN_RE,
} from "../src/api/lib/kpi-survey-token.ts";

// ---------------------------------------------------------------------------
// A tiny stand-in for the DB. It understands only the handful of statements
// this route issues, which is the point: anything the route starts doing that
// is NOT one of these (a second table, a join, a customer lookup) fails loudly
// here instead of passing silently.
// ---------------------------------------------------------------------------
function makeDb() {
  const tokens = new Map(); // token -> row
  const responses = []; // kpi_survey_responses rows
  const seen = []; // every statement, so we can assert what was NOT run
  let failNextInsert = false;

  function exec(sql, args) {
    seen.push(sql.replace(/\s+/g, " ").trim());
    const s = sql.replace(/\s+/g, " ").trim();

    // The runtime self-apply (CREATE TABLE / CREATE INDEX / ALTER / UPDATE …
    // kpi_assignments). Accepted and ignored — this fake IS the schema.
    if (/^(CREATE|ALTER)\b/i.test(s)) return { rows: [], changes: 0 };
    if (/^(UPDATE|DELETE)\b.*kpi_assignments/i.test(s)) return { rows: [], changes: 0 };

    if (/^SELECT .*FROM kpi_survey_tokens/i.test(s)) {
      const row = tokens.get(args[0]);
      return { rows: row ? [{ ...row }] : [], changes: 0 };
    }

    if (/^UPDATE kpi_survey_tokens SET usedAt = \? WHERE token = \? AND usedAt IS NULL/i.test(s)) {
      const row = tokens.get(args[1]);
      if (!row || row.usedAt) return { rows: [], changes: 0 };
      row.usedAt = args[0];
      return { rows: [], changes: 1 };
    }

    if (/^UPDATE kpi_survey_tokens SET usedAt = NULL WHERE token = \?/i.test(s)) {
      const row = tokens.get(args[0]);
      if (row) row.usedAt = null;
      return { rows: [], changes: row ? 1 : 0 };
    }

    if (/^INSERT INTO kpi_survey_responses/i.test(s)) {
      if (failNextInsert) {
        failNextInsert = false;
        throw new Error("simulated DB failure");
      }
      const [id, userId, kpiKey, period, customerId, customerName,
        q1, q2, q3, q4, q5, comment, orgId] = args;
      if (responses.some((r) => r.id === id)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      responses.push({ id, userId, kpiKey, period, customerId, customerName,
        q1, q2, q3, q4, q5, comment, orgId });
      return { rows: [], changes: 1 };
    }

    throw new Error(`unexpected SQL in the public survey route: ${s}`);
  }

  const DB = {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...args) { bound = args; return stmt; },
        async run() {
          const r = exec(sql, bound);
          return { success: true, meta: { changes: r.changes } };
        },
        async first() {
          const r = exec(sql, bound);
          return r.rows[0] ?? null;
        },
        async all() {
          const r = exec(sql, bound);
          return { results: r.rows };
        },
      };
      return stmt;
    },
  };

  return {
    DB,
    tokens,
    responses,
    seen,
    failInsertOnce() { failNextInsert = true; },
    mint(over = {}) {
      const token = newSurveyToken();
      tokens.set(token, {
        token,
        userId: "usr_office_1",
        kpiKey: "customer_satisfaction",
        period: "2026-08",
        customerId: "cust_9",
        customerName: "Acme Bedding Sdn Bhd",
        usedAt: null,
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        orgId: "hookka",
        ...over,
      });
      return token;
    },
  };
}

// Drive the REAL subapp, wrapped in the same DB-binding middleware worker.ts
// applies in production. There is no auth middleware here on purpose — that is
// exactly the condition this endpoint ships under.
function mount(db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db.DB);
    await next();
  });
  parent.route("/", surveyApp);
  return parent;
}

function call(db, method, token, body) {
  return mount(db).request(`/${token}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The route memoises "tables applied" at module level — reset between cases so
// each test exercises the self-apply the way a cold isolate would.
beforeEach(() => _resetKpiTablesMemoForTests());

// ── The form a customer is served ───────────────────────────────────────────

test("the link serves the five questions and the five NAMED rungs", async () => {
  const db = makeDb();
  const token = db.mint();
  const res = await call(db, "GET", token);
  assert.equal(res.status, 200);
  const j = await res.json();

  const def = kpiByKey("customer_satisfaction");
  assert.deepEqual(j.data.questions, def.surveyQuestions,
    "the questions must come from the catalogue, not a copy");
  assert.deepEqual(j.data.scale, def.surveyScale,
    "the named 1-5 scale must come from the catalogue, not a copy");
  assert.equal(j.data.scale.length, 5);
  // Index 0 is a 1. A customer who picks the bottom rung must score 1, not 5.
  assert.match(j.data.scale[0], /^Poor/);
  assert.match(j.data.scale[4], /^Excellent/);
});

test("the form tells the customer NOTHING about who is being scored", async () => {
  // The whole payload is inspected, not just the fields we remembered to
  // check: anything beyond questions + scale is a leak, whatever it is called.
  const db = makeDb();
  const token = db.mint();
  const body = await (await call(db, "GET", token)).json();
  assert.deepEqual(Object.keys(body.data).sort(), ["questions", "scale"]);

  const text = JSON.stringify(body);
  for (const secret of [
    "usr_office_1",       // the employee being measured
    "cust_9",             // the customer's internal id
    "Acme Bedding",       // the customer's name
    "2026-08",            // which month this counts for
    "customer_satisfaction", // the internal KPI key
    "hookka",             // the tenant
  ]) {
    assert.ok(!text.includes(secret), `the public form leaked ${secret}`);
  }
});

// ── Single use — the one that matters ───────────────────────────────────────

test("a used link cannot be replayed", async () => {
  const db = makeDb();
  const token = db.mint();

  const first = await call(db, "POST", token, { answers: [5, 4, 5, 3, 4] });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).success, true);
  assert.equal(db.responses.length, 1, "the first reply is stored");

  // Same link, same answers, straight away — the shape of a double-tap or a
  // replayed request.
  const second = await call(db, "POST", token, { answers: [5, 5, 5, 5, 5] });
  assert.equal(second.status, 410, "a spent link is Gone, not a 500 or a silent 200");
  const j = await second.json();
  assert.equal(j.success, false);
  assert.equal(j.state, "USED");
  assert.match(j.error, /already been used/i);
  assert.ok(!/stack|Error:|at Object|undefined/.test(j.error),
    "a customer must never be shown a trace");

  assert.equal(db.responses.length, 1, "the replay must not add a second reply");
  assert.deepEqual(
    [db.responses[0].q1, db.responses[0].q2, db.responses[0].q3,
     db.responses[0].q4, db.responses[0].q5],
    [5, 4, 5, 3, 4],
    "and it must not overwrite the answers that were actually given",
  );

  // Re-OPENING a spent link is just as closed as re-submitting it.
  const reopened = await call(db, "GET", token);
  assert.equal(reopened.status, 410);
});

test("two submissions racing on the same link produce exactly one reply", async () => {
  const db = makeDb();
  const token = db.mint();
  const results = await Promise.all([
    call(db, "POST", token, { answers: [5, 5, 5, 5, 5] }),
    call(db, "POST", token, { answers: [1, 1, 1, 1, 1] }),
  ]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 410], "exactly one of the two wins the claim");
  assert.equal(db.responses.length, 1);
});

test("an expired link is closed, plainly", async () => {
  const db = makeDb();
  const token = db.mint({
    expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
  });

  const get = await call(db, "GET", token);
  assert.equal(get.status, 410);
  assert.match((await get.json()).error, /expired/i);

  const post = await call(db, "POST", token, { answers: [5, 5, 5, 5, 5] });
  assert.equal(post.status, 410);
  assert.equal(db.responses.length, 0, "an expired link must not write a reply");
});

test("an unknown or malformed token gets a plain 404, never a trace", async () => {
  const db = makeDb();
  for (const bad of [
    "not-a-token",
    "x",
    "%2E%2E%2Fetc%2Fpasswd",
    "a".repeat(63),
    "a".repeat(65),
    "z".repeat(64), // right length, not hex
    `${newSurveyToken().slice(0, 63)}'`, // a quote where a hex digit should be
  ]) {
    const res = await call(db, "GET", bad);
    assert.equal(res.status, 404, `${bad} should 404`);
    const j = await res.json();
    assert.equal(j.success, false);
    assert.ok(!/stack|SQL|SELECT|Error:/i.test(j.error), "no internals in the message");
  }
  // Well-formed but never minted.
  const res = await call(db, "GET", newSurveyToken());
  assert.equal(res.status, 404);
  assert.equal(db.responses.length, 0);
});

// ── Validation — nothing but five whole numbers, 1 to 5 ────────────────────

test("out-of-range answers are rejected and do NOT burn the link", async () => {
  const db = makeDb();
  const token = db.mint();

  const rejected = [
    [5, 5, 5, 5, 6],        // above the top rung
    [0, 5, 5, 5, 5],        // below the bottom rung
    [-1, 5, 5, 5, 5],
    [5, 5, 5, 5, 3.5],      // not a whole rung
    [5, 5, 5, 5],           // four answers
    [5, 5, 5, 5, 5, 5],     // six answers
    [],
    [5, 5, 5, 5, null],
    [5, 5, 5, 5, "five"],
    [5, 5, 5, 5, true],
    [5, 5, 5, 5, NaN],
    [5, 5, 5, 5, Infinity],
    "55555",                // not an array at all
    { q1: 5 },
    undefined,
  ];
  for (const answers of rejected) {
    const res = await call(db, "POST", token, { answers });
    assert.equal(res.status, 400, `${JSON.stringify(answers)} should be rejected`);
    const j = await res.json();
    assert.equal(j.success, false);
    assert.ok(!/stack|SQL|Error:/i.test(j.error));
  }
  assert.equal(db.responses.length, 0, "nothing was written");

  // The link is still LIVE — a bad submission must not cost the customer
  // their one chance to answer.
  assert.equal(db.tokens.get(token).usedAt, null);
  const ok = await call(db, "POST", token, { answers: [4, 4, 4, 4, 4] });
  assert.equal(ok.status, 200);
  assert.equal(db.responses.length, 1);
});

test("the reply is written against the TOKEN's person, KPI and month — never the body's", async () => {
  const db = makeDb();
  const token = db.mint();
  // A tampered body naming a different employee, month and tenant.
  const res = await call(db, "POST", token, {
    answers: [5, 5, 5, 5, 5],
    userId: "usr_someone_else",
    period: "2026-12",
    kpiKey: "production_efficiency",
    orgId: "other_tenant",
    customerName: "Injected",
    q1: 1,
  });
  assert.equal(res.status, 200);
  const row = db.responses[0];
  assert.equal(row.userId, "usr_office_1");
  assert.equal(row.period, "2026-08");
  assert.equal(row.kpiKey, "customer_satisfaction");
  assert.equal(row.orgId, "hookka");
  assert.equal(row.customerName, "Acme Bedding Sdn Bhd");
  assert.equal(row.q1, 5);
});

test("a comment is optional, trimmed and capped", async () => {
  const db = makeDb();
  const a = db.mint();
  await call(db, "POST", a, { answers: [3, 3, 3, 3, 3] });
  assert.equal(db.responses[0].comment, null, "no comment stores null, not ''");

  const b = db.mint();
  await call(db, "POST", b, { answers: [3, 3, 3, 3, 3], comment: "   " });
  assert.equal(db.responses[1].comment, null);

  const c = db.mint();
  await call(db, "POST", c, {
    answers: [3, 3, 3, 3, 3],
    comment: `  ${"x".repeat(5000)}  `,
  });
  assert.equal(db.responses[2].comment.length, 2000, "capped at 2000 chars");
});

test("a failed write gives the link BACK instead of eating the customer's one chance", async () => {
  const db = makeDb();
  const token = db.mint();
  db.failInsertOnce();

  const bad = await call(db, "POST", token, { answers: [5, 4, 3, 2, 1] });
  assert.equal(bad.status, 500);
  const j = await bad.json();
  assert.ok(!/simulated DB failure|stack|INSERT/i.test(j.error),
    "the customer sees a sentence, not the underlying error");
  assert.equal(db.tokens.get(token).usedAt, null, "the claim must be released");

  const retry = await call(db, "POST", token, { answers: [5, 4, 3, 2, 1] });
  assert.equal(retry.status, 200);
  assert.equal(db.responses.length, 1);
});

test("the route touches nothing but the token and the reply", async () => {
  // A public endpoint that grows a customers/users/products read is how a
  // "harmless" form becomes a data leak. The fake throws on anything else, but
  // pin the tables explicitly so the intent is on the record.
  const db = makeDb();
  const token = db.mint();
  await call(db, "GET", token);
  await call(db, "POST", token, { answers: [5, 5, 5, 5, 5] });
  const dml = db.seen.filter((s) => /^(SELECT|INSERT|UPDATE|DELETE)/i.test(s));
  for (const s of dml) {
    assert.ok(
      /kpi_survey_tokens|kpi_survey_responses|kpi_assignments/.test(s),
      `the public survey route read or wrote something it should not: ${s}`,
    );
  }
  for (const banned of ["customers", "users", "sales_orders", "invoices"]) {
    assert.ok(
      !db.seen.some((s) => new RegExp(`\\b(FROM|JOIN|INTO)\\s+${banned}\\b`, "i").test(s)),
      `the public survey route must never touch ${banned}`,
    );
  }
});

// ── The link itself ─────────────────────────────────────────────────────────

test("tokens are unguessable and the URL is the /s/ public page", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = newSurveyToken();
    assert.match(t, SURVEY_TOKEN_RE, "64 hex chars — two UUIDs' worth of entropy");
    assert.ok(!seen.has(t), "tokens must not repeat");
    seen.add(t);
  }
  const t = newSurveyToken();
  assert.equal(surveyLinkUrl("https://erp.hookka.com", t), `https://erp.hookka.com/s/${t}`);
  // The legacy prod host is canonicalised; staging keeps its own origin so the
  // link resolves against the DB that minted it.
  assert.equal(
    surveyLinkUrl("https://hookka-erp-testing.pages.dev", t),
    `https://erp.hookka.com/s/${t}`,
  );
  assert.equal(
    surveyLinkUrl("https://staging.hookka-erp-testing.pages.dev", t),
    `https://staging.hookka-erp-testing.pages.dev/s/${t}`,
  );
});

test("a lifetime is always bounded", () => {
  assert.equal(clampTokenDays(undefined), 30, "the default is one month");
  assert.equal(clampTokenDays(7), 7);
  assert.equal(clampTokenDays(9999), 90, "nothing lives longer than 90 days");
  assert.equal(clampTokenDays(0), 30);
  assert.equal(clampTokenDays(-5), 30);
  assert.equal(clampTokenDays("abc"), 30);
});

test("a token with no readable expiry is treated as expired, not as open", () => {
  const base = {
    token: "t", userId: "u", kpiKey: "customer_satisfaction", period: "2026-08",
    customerId: null, customerName: null, usedAt: null, orgId: "hookka",
  };
  assert.equal(surveyTokenState({ ...base, expiresAt: null }), "EXPIRED");
  assert.equal(surveyTokenState({ ...base, expiresAt: "not a date" }), "EXPIRED");
  // A bare Postgres timestamp with no zone is read as UTC, not as local time —
  // 8 hours of skew either way would round-trip a link into the wrong month.
  const soon = new Date(Date.now() + 3600_000).toISOString().replace("Z", "").replace("T", " ");
  assert.equal(surveyTokenState({ ...base, expiresAt: soon }), "LIVE");
  const past = new Date(Date.now() - 3600_000).toISOString().replace("Z", "").replace("T", " ");
  assert.equal(surveyTokenState({ ...base, expiresAt: past }), "EXPIRED");
  // Used beats everything.
  assert.equal(
    surveyTokenState({ ...base, usedAt: "2026-08-07T00:00:00Z",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    "USED",
  );
});

test("validateAnswers is the single gate, and it is strict", () => {
  assert.deepEqual(validateAnswers([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
  assert.deepEqual(validateAnswers(["1", "2", "3", "4", "5"]), [1, 2, 3, 4, 5],
    "a form posts strings — whole-number strings are still valid rungs");
  for (const bad of [
    null, undefined, [], [1, 2, 3, 4], [1, 2, 3, 4, 5, 5],
    [1, 2, 3, 4, 0], [1, 2, 3, 4, 6], [1, 2, 3, 4, 4.5],
    ["", 2, 3, 4, 5], [true, 2, 3, 4, 5], ["4abc", 2, 3, 4, 5],
  ]) {
    assert.equal(validateAnswers(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

// ── The mint endpoint stays behind Super Admin ──────────────────────────────

test("only Super Admin can mint a link", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const route = readFileSync(resolve(process.cwd(), "src/api/routes/kpi.ts"), "utf8");
  const at = route.indexOf('app.post("/survey/:kpiKey/link"');
  assert.ok(at > 0, "the mint endpoint must exist");
  const block = route.slice(at, at + 400);
  assert.match(block, /requireSuperAdmin\(c\)/, "minting must be Super-Admin only");
  // And the PUBLIC route must never be able to mint one.
  const pub = readFileSync(
    resolve(process.cwd(), "src/api/routes/public-kpi-survey.ts"), "utf8");
  assert.ok(!/newSurveyToken/.test(pub),
    "the public route must only RESOLVE tokens, never create them");
});

test("a TIMESTAMPTZ expiry arrives as a Date, and must not read as expired", async () => {
  // The bug that made this feature dead on arrival. `kpi_survey_tokens` uses
  // TIMESTAMPTZ where the other KPI tables use TIMESTAMP, and the driver hands
  // those back as Date objects. parseTs stringified the Date, saw no trailing
  // Z, appended one, and produced something Date.parse cannot read — so every
  // live link reported EXPIRED and no customer could ever answer.
  //
  // The whole suite passed while this was broken: the in-memory harness stores
  // strings and never produces a Date. That is the gap this case closes.
  const { parseTs, surveyTokenState } = await import("../src/api/lib/kpi-survey-token.ts");

  const inThirtyDays = new Date(Date.now() + 30 * 86400_000);
  assert.equal(parseTs(inThirtyDays), inThirtyDays.getTime(), "a Date must survive intact");
  assert.equal(parseTs(inThirtyDays.getTime()), inThirtyDays.getTime(), "and so must an epoch");

  const live = { usedAt: null, expiresAt: inThirtyDays };
  assert.equal(surveyTokenState(live), "LIVE", "a link with 30 days left is LIVE");

  const gone = { usedAt: null, expiresAt: new Date(Date.now() - 86400_000) };
  assert.equal(surveyTokenState(gone), "EXPIRED");
  assert.equal(surveyTokenState({ usedAt: new Date(), expiresAt: inThirtyDays }), "USED");

  // Strings still work — both zoned and bare-UTC.
  assert.equal(surveyTokenState({ usedAt: null, expiresAt: inThirtyDays.toISOString() }), "LIVE");
  assert.equal(
    surveyTokenState({ usedAt: null, expiresAt: inThirtyDays.toISOString().replace("T", " ").replace("Z", "") }),
    "LIVE",
    "a bare UTC timestamp must not be read as local time",
  );

  // Unreadable still fails CLOSED — a link whose lifetime cannot be established
  // is not one to accept a score through.
  assert.equal(parseTs("not a date"), null);
  assert.equal(surveyTokenState({ usedAt: null, expiresAt: "not a date" }), "EXPIRED");
});

// ---------------------------------------------------------------------------
// public-kpi-survey.ts — PUBLIC (no-login) customer satisfaction survey.
//
// Owner 2026-08-07: "这些是发顾客一个类似 google form submit 选择的，直接评分."
// A customer opens a link on their phone, picks one of five NAMED ratings for
// each of five questions, taps submit, and is done. No account, no ERP shell.
//
//   GET  /api/public/survey/:token   → { questions, scale }
//   POST /api/public/survey/:token   → { answers: [1-5 ×5], comment? }
//
// Security model (this is a public WRITE endpoint — the tightest surface in
// the module):
//   • The 64-hex token IS the credential, minted ONLY by the Super-Admin
//     endpoint POST /api/kpi/survey/:kpiKey/link. This route never mints.
//   • SINGLE USE. The claim is one atomic UPDATE … WHERE used_at IS NULL, so
//     a double-tap or a replayed request loses the race and is told the link
//     is spent. Without it, one link could stuff a month's average.
//   • TIME LIMITED. An August link must not answer into December's mean.
//   • It TELLS THE CALLER NOTHING. The response carries the questions and the
//     named 1–5 scale — both straight out of the code catalogue — and nothing
//     else. No employee name, no customer name or id, no period, no user id,
//     no customer list. The token's row supplies all of that server-side, so
//     a tampered body cannot re-point a reply at a different person or month.
//   • A dead link gets a plain sentence and an HTTP status, never a trace.
//   • Auth bypass is via PUBLIC_PREFIXES ("/api/public/survey/") in
//     lib/auth-middleware.ts; the shared apiRateLimit middleware still applies
//     (keyed by client IP) with the tightened public override
//     { perMinute: 30, perHour: 300 } in lib/api-rate-limit-config.ts.
//   • The token is NEVER logged — it is the credential.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { ensureKpiTables } from "../lib/ensure-kpi-tables";
import { kpiByKey } from "../lib/kpi-catalog";
import {
  SURVEY_TOKEN_RE,
  surveyTokenState,
  validateAnswers,
  type SurveyTokenRow,
} from "../lib/kpi-survey-token";

const app = new Hono<Env>();

/** Longest free-text comment we store. Past this it is not feedback, it is a payload. */
const MAX_COMMENT = 2000;

// A link that never existed, or whose KPI has since been retired. 404 with a
// sentence a customer can read — never an error object, never a stack.
const unknownLink = (c: Context<Env>) =>
  c.json(
    {
      success: false,
      error:
        "This feedback link is not valid. Please ask your Hookka contact to send a new one.",
    },
    404,
  );

// A link that WAS valid: already answered, or past its date. 410 Gone, same
// plain register. Kept separate from 404 purely so the page can say "thank
// you, we already have your answers" instead of "broken link" — it reveals
// nothing to anyone who is not already holding the token.
const spentLink = (c: Context<Env>, state: "USED" | "EXPIRED") =>
  c.json(
    {
      success: false,
      state,
      error:
        state === "USED"
          ? "This feedback link has already been used. Thank you — we have your answers."
          : "This feedback link has expired. Please ask your Hookka contact to send a new one.",
    },
    410,
  );

/**
 * Resolve the token to its own row. The ONLY lookup in this file, and it is by
 * token — nothing here ever takes an id, a period or a user from the request.
 */
async function resolveToken(
  db: D1Database,
  token: string,
): Promise<SurveyTokenRow | null> {
  return db
    .prepare(
      // QUOTED aliases, not bare column names. Bare `expiresAt` is translated
      // to `expires_at`, and Postgres hands the column back under THAT name —
      // so `row.expiresAt` read undefined, `parseTs(undefined)` returned null,
      // and surveyTokenState called every freshly-minted link EXPIRED. Verified
      // on prod 2026-08-07: a token minted seconds earlier, expiring in 30 days,
      // 410'd on its first open. Quoting is what makes the JS side match.
      //
      // It failed CLOSED, which is the only reason this was a dead feature and
      // not an open door: with usedAt unreadable too, a spent link would also
      // have read EXPIRED rather than LIVE.
      `SELECT token       AS "token",
              userId      AS "userId",
              kpiKey      AS "kpiKey",
              period      AS "period",
              customerId  AS "customerId",
              customerName AS "customerName",
              usedAt      AS "usedAt",
              expiresAt   AS "expiresAt",
              orgId       AS "orgId"
         FROM kpi_survey_tokens
        WHERE token = ? LIMIT 1`,
    )
    .bind(token)
    .first<SurveyTokenRow>();
}

/**
 * The questions and the named rungs, read from the CODE catalogue — never
 * copied. Index 0 of surveyScale is a 1 ("Poor"), so the page can render the
 * options in whatever order it likes and still score them right.
 */
function formOf(kpiKey: string): { questions: string[]; scale: string[] } | null {
  const def = kpiByKey(kpiKey);
  if (!def || def.scoring !== "SURVEY") return null;
  const questions = def.surveyQuestions ?? [];
  const scale = def.surveyScale ?? [];
  if (questions.length !== 5 || scale.length !== 5) return null;
  return { questions, scale };
}

// ---------------------------------------------------------------------------
// GET /api/public/survey/:token — the form.
//
// Returns the five questions and the five named ratings. Deliberately NOTHING
// else: whose KPI this is, which customer it went to and which month it counts
// for are all none of the browser's business.
// ---------------------------------------------------------------------------
app.get("/:token", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!SURVEY_TOKEN_RE.test(token)) return unknownLink(c);
  try {
    await ensureKpiTables(c.var.DB);
    const row = await resolveToken(c.var.DB, token);
    if (!row) return unknownLink(c);
    const form = formOf(row.kpiKey);
    if (!form) return unknownLink(c);
    const state = surveyTokenState(row);
    if (state !== "LIVE") return spentLink(c, state);
    return c.json({ success: true, data: form });
  } catch (err) {
    console.error("[GET /api/public/survey/:token] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not open this form. Please try again in a moment.",
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/public/survey/:token — the reply.
//
// Reads EXACTLY TWO body fields: answers (five integers 1–5) and an optional
// comment. Everything else is ignored — userId, period, customerName and org
// all come off the token's own row, so no request body can move a score onto
// another person or another month.
// ---------------------------------------------------------------------------
app.post("/:token", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!SURVEY_TOKEN_RE.test(token)) return unknownLink(c);

  const body = (await c.req.json().catch(() => ({}))) as {
    answers?: unknown;
    comment?: unknown;
  };
  // Validate BEFORE the token is claimed — a malformed submission must not
  // burn the customer's one link.
  const answers = validateAnswers(body.answers);
  if (!answers) {
    return c.json(
      {
        success: false,
        error: "Please answer all five questions before sending.",
      },
      400,
    );
  }
  const comment =
    typeof body.comment === "string"
      ? body.comment.trim().slice(0, MAX_COMMENT) || null
      : null;

  try {
    await ensureKpiTables(c.var.DB);
    const row = await resolveToken(c.var.DB, token);
    if (!row) return unknownLink(c);
    if (!formOf(row.kpiKey)) return unknownLink(c);
    const state = surveyTokenState(row);
    if (state !== "LIVE") return spentLink(c, state);

    // CLAIM FIRST, atomically. Two submissions racing on a flaky phone
    // connection: exactly one UPDATE reports a changed row and gets to write
    // the reply; the other is told the link is spent. A read-then-write here
    // would let both through and count the same customer twice.
    const claim = await c.var.DB.prepare(
      `UPDATE kpi_survey_tokens SET usedAt = ? WHERE token = ? AND usedAt IS NULL`,
    )
      .bind(new Date().toISOString(), token)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) return spentLink(c, "USED");

    try {
      await c.var.DB.prepare(
        `INSERT INTO kpi_survey_responses
           (id, userId, kpiKey, period, customerId, customerName,
            q1, q2, q3, q4, q5, comment, orgId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          // Derived from the token, so the row is unique per link and a replay
          // can never produce a second reply even if the latch were bypassed.
          `ksr_${token.slice(0, 32)}`,
          row.userId, row.kpiKey, row.period,
          row.customerId, row.customerName,
          answers[0], answers[1], answers[2], answers[3], answers[4],
          comment, row.orgId || "hookka",
        )
        .run();
    } catch (err) {
      // The link was claimed but the reply did not land. Give the link back —
      // otherwise the customer's one chance is gone to a transient DB error.
      await c.var.DB.prepare(
        `UPDATE kpi_survey_tokens SET usedAt = NULL WHERE token = ?`,
      )
        .bind(token)
        .run()
        .catch(() => {});
      throw err;
    }

    return c.json({ success: true });
  } catch (err) {
    console.error("[POST /api/public/survey/:token] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not send your answers. Please try again in a moment.",
      },
      500,
    );
  }
});

export default app;

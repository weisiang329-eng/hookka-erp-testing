// ---------------------------------------------------------------------------
// kpi-survey-token.ts — the one-time link a customer opens to rate us.
//
// Owner 2026-08-07: "这些是发顾客一个类似 google form submit 选择的，直接评分."
// The office does NOT key the answers in — the customer does, on their own
// phone, with no login. So the URL itself is the whole credential, and it has
// to behave like one:
//
//   • UNGUESSABLE — two UUIDs = 64 hex chars (~244 bits). A short id would let
//     anyone walk the space and stuff a colleague's KPI with 5s.
//   • SINGLE USE — one link, one reply. Without this, one happy customer can
//     be re-submitted twenty times and the mean is whatever the office wants.
//     The claim is an atomic UPDATE … WHERE used_at IS NULL, not a read then a
//     write, so two taps on a flaky phone connection cannot both win.
//   • TIME LIMITED — a link minted for August must not be answerable in
//     December and land in December's average. (This is NOT the "QR expiry"
//     the owner declined for stickers: a sticker has to stay scannable for the
//     life of the goods; a survey link is one month's measurement.)
//
// The token carries WHO is being measured, WHICH KPI and WHICH month. The
// public page never sees any of it — it is read off the token's own row on the
// server so the reply cannot be pointed at a different person by editing a
// request body.
// ---------------------------------------------------------------------------

import { canonicalizeOrigin } from "../../lib/app-origin";

/** 64 hex chars, exactly — anything else is rejected before touching the DB. */
export const SURVEY_TOKEN_RE = /^[0-9a-f]{64}$/i;

/** One link per customer per month, so a month is the natural lifetime. */
export const DEFAULT_SURVEY_TOKEN_DAYS = 30;
export const MAX_SURVEY_TOKEN_DAYS = 90;

/** Same shape as the DO / packing-sticker QR tokens (two UUIDs, dashes out). */
export function newSurveyToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}

/**
 * The link the office sends the customer.
 *
 * Origin comes from the live request so staging links resolve against staging
 * (each site reads its OWN DB — see HOOKKA-GOTCHAS), canonicalised so a link
 * generated on the legacy prod pages.dev host still reads erp.hookka.com.
 */
export function surveyLinkUrl(origin: string, token: string): string {
  return `${canonicalizeOrigin(origin).replace(/\/+$/, "")}/s/${token}`;
}

export type SurveyTokenRow = {
  token: string;
  userId: string;
  kpiKey: string;
  period: string;
  customerId: string | null;
  customerName: string | null;
  usedAt: string | Date | null;
  expiresAt: string | Date | null;
  orgId: string | null;
};

export type SurveyTokenState = "LIVE" | "USED" | "EXPIRED";

/**
 * Parse a timestamp read back out of Postgres.
 *
 * A bare `2026-09-06T12:00:00` (no offset) is parsed as LOCAL time by
 * Date.parse, which on a Malaysian phone is 8 hours off. Everything we write
 * is UTC, so a string with no zone marker gets one.
 */
export function parseTs(raw: unknown): number | null {
  // A Date or an epoch arrives already resolved. `expires_at` is TIMESTAMPTZ —
  // unlike the TIMESTAMP columns on the other KPI tables — and the driver hands
  // those back as Date objects, not strings.
  //
  // The first version went straight to String(raw), which turned a Date into
  // "Wed Sep 06 2026 11:09:50 GMT+0800 (…)", saw no trailing Z, appended one,
  // and produced a string Date.parse cannot read. parseTs returned null,
  // surveyTokenState reads a null expiry as EXPIRED, and so EVERY freshly
  // minted link 410'd on the customer's first tap. Found on prod 2026-08-07 by
  // opening a link minted seconds earlier; the whole unit suite passed, because
  // the in-memory harness stores strings and never produces a Date.
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Everything we write is UTC, so a string with no zone marker gets one — a
  // bare `2026-09-06T12:00:00` would otherwise parse as LOCAL time, which on a
  // Malaysian phone is 8 hours off.
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
    ? s
    : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * LIVE / USED / EXPIRED for a token row.
 *
 * An unparseable expiry counts as EXPIRED: a link whose lifetime cannot be
 * established is not a link we should accept a score through.
 */
export function surveyTokenState(
  row: SurveyTokenRow,
  now: number = Date.now(),
): SurveyTokenState {
  // Dual-keyed, as CLAUDE.md requires of every row read. The query aliases
  // these properly now, but a single unquoted SELECT somewhere else would
  // otherwise turn every live link into an expired one, silently.
  const r = row as SurveyTokenRow & { used_at?: string | null; expires_at?: string | null };
  if (r.usedAt ?? r.used_at) return "USED";
  const expires = parseTs(r.expiresAt ?? r.expires_at);
  if (expires === null || expires <= now) return "EXPIRED";
  return "LIVE";
}

/** Clamp a requested lifetime to something sane. Junk falls back to default. */
export function clampTokenDays(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SURVEY_TOKEN_DAYS;
  return Math.min(n, MAX_SURVEY_TOKEN_DAYS);
}

/**
 * The five answers, validated.
 *
 * Exactly five, each a whole number 1–5. Returns null on anything else — a
 * public write endpoint takes nothing on trust, and "3.5" or "6" or four
 * answers would all quietly skew the mean.
 */
export function validateAnswers(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const out: number[] = [];
  for (const v of raw) {
    // Reject "" / null / true / "4abc" before Number() turns them into
    // something plausible.
    if (typeof v !== "number" && typeof v !== "string") return null;
    if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    out.push(n);
  }
  return out;
}

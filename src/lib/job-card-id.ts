// ---------------------------------------------------------------------------
// job-card-id — THE single definition of the job_card id / Code 128 token.
//
// Pure (zero imports) so BOTH the worker backend (production-builder, jobcard-
// sync, scan-lookup) AND the dashboard frontend (production schedule print,
// the /worker scanner) can share it without dragging server-only deps into the
// browser bundle. `bom-wip-breakdown` re-exports these so existing backend
// imports keep working.
//
// Why short ids: the old id embedded the 60+-char BOM wipKey (template tokens),
// so the printed Code 128 was ~5x too dense to scan. The id now hashes the
// natural key instead — see deriveJobCardId.
// ---------------------------------------------------------------------------

// One 32-bit FNV-1a pass with a seed. Two passes (different seeds) concatenated
// give a ~14-char, effectively-64-bit token whose collision odds are negligible
// across the lifetime card count (birthday ~50% only at ~5e9 distinct keys).
function fnv1a32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

// Short, deterministic hash of any natural key → 14 fixed base36 chars.
export function shortKeyHash(key: string): string {
  const a = fnv1a32(key, 2166136261);
  const b = fnv1a32(key, 0x811c9dc5 ^ 0x9e3779b9);
  return a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0");
}

// Two-digit department codes (Wei Siang 2026-06-16: "Framing 叫 01 之类的") — the
// id carries "07" instead of "UPHOLSTERY", shaving ~8 chars off the barcode.
// Order follows the production line (SEED_DEPARTMENTS dept-1..8). Unknown depts
// fall through to their own code so the id stays unique for non-production cards.
export const DEPT_CODE2: Record<string, string> = {
  FAB_CUT: "01",
  FAB_SEW: "02",
  WOOD_CUT: "03",
  // FOAM_CUTTING sits between WOOD_CUT and FOAM in the line order but keeps a
  // free 2-digit code ("14") — the numeric codes are identity tokens, NOT the
  // line sequence, so existing codes 01-08 stay pinned to their depts.
  FOAM_CUTTING: "14",
  FOAM: "04",
  FRAMING: "05",
  WEBBING: "06",
  UPHOLSTERY: "07",
  PACKING: "08",
};
const CODE2_DEPT: Record<string, string> = Object.fromEntries(
  Object.entries(DEPT_CODE2).map(([k, v]) => [v, k]),
);
export function deptCode2(deptCode: string): string {
  return DEPT_CODE2[deptCode] ?? deptCode;
}
// Reverse of deptCode2 for the 2-digit production codes ("07" → "UPHOLSTERY").
// Returns null for anything that isn't one of the 8 mapped codes, so the scanner
// can tell a real token's dept segment from noise.
export function deptFromCode2(code2: string): string | null {
  return CODE2_DEPT[code2] ?? null;
}

// THE job_card id / barcode-token formula (one definition — do NOT re-implement
// elsewhere): `jc-<hash>-<deptNN>`, where <hash> = shortKeyHash(`<poId>::<wipKey>`)
// (FG cards pass wipKey "FG", folded into the same hash) and <deptNN> is the
// 2-digit dept code. ~20 chars total — short enough that the Code 128 prints at
// a scannable X-dimension. Sanitised to id-safe chars, ≤128. The hash already
// encodes poId + wipKey, so uniqueness per (poId, wipKey, dept) holds.
export function deriveJobCardId(
  poId: string,
  wipKey: string,
  deptCode: string,
): string {
  return `jc-${shortKeyHash(`${poId}::${wipKey}`)}-${deptCode2(deptCode)}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 128);
}

// Does a string look like a short derived token (jc-<14 base36>-<2 digits>)?
// Lets the scanner tell a NEW short id / re-derived old-card token apart from a
// legacy long PK so it only runs the (bounded) re-derivation fallback when it
// could actually help.
const SHORT_JC_RE = /^jc-[0-9a-z]{14}-\d{2}$/;
export function isShortJobCardToken(s: string): boolean {
  return SHORT_JC_RE.test(s);
}

// ---------------------------------------------------------------------------
// NUMERIC Code 128 barcode token (Wei Siang: a 1D code MUST be short + fat or a
// phone can't read the bars). `<deptNN><8-digit hash of the JOB CARD ID>` = 10
// DIGITS, so Code 128 uses Set C (2 digits/symbol) → roughly half the bars of
// the old 10-char alphanumeric token, i.e. ~double the printed X-dimension.
//
// This is NOT a primary key — it carries no global-uniqueness guarantee. It's
// resolved ONLY by re-deriving across the department's OPEN cards (the dept is
// the 2 digits), a set of at most current WIP for one dept, where a 32-bit hash
// collision is negligible. The `b` sentinel + strict shape keep a stray courier
// barcode from being mistaken for ours.
// ---------------------------------------------------------------------------
// 2026-06-17: the token is now ALL DIGITS — `<deptNN><8-digit hash>` = 10
// digits. Code 128 auto-switches to Set C (packs 2 digits per symbol), so a
// 10-digit code is ~half the bars of the old 10-char alphanumeric one. At the
// same printed width that ~doubles the X-dimension (narrowest bar) from ~0.3mm
// to ~0.5mm — above the threshold a phone camera can resolve, which is what
// made the old code unscannable on the production schedule (Wei Siang: "barcode
// 還是 scan 不到, 徹底解決"). 10 digits also can't be confused with EAN-8 (8) or
// EAN-13 (13) couriers, and the leading 2 digits still carry the dept.
const BARCODE_RE = /^\d{10}$/;
export function deriveBarcodeToken(jobCardId: string, deptCode: string): string {
  // Hash the STABLE job_card id (the PK) — NOT (poId, wipKey). The schedule
  // grid's wipKey can differ from the row stored in job_cards, so re-deriving
  // from (poId, wipKey) mismatched and the scan said "Not found" (Wei Siang
  // 2026-06-17). The id is identical on the print side (grid.jobCardId) and the
  // lookup side (job_cards.id), so the token always round-trips.
  const h = (fnv1a32(jobCardId, 2166136261) % 100_000_000)
    .toString()
    .padStart(8, "0");
  return `${deptCode2(deptCode)}${h}`;
}
export function isBarcodeToken(s: string): boolean {
  // 10 digits AND a real dept code in the leading 2 — so a stray courier /
  // product barcode is never mistaken for one of ours.
  return BARCODE_RE.test(s) && deptFromCode2(s.slice(0, 2)) !== null;
}
// The department a barcode token belongs to (from its 2 digits), or null.
export function deptOfBarcodeToken(token: string): string | null {
  return BARCODE_RE.test(token) ? deptFromCode2(token.slice(0, 2)) : null;
}

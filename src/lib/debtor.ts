// ---------------------------------------------------------------------------
// Debtor (AR sub-account) code rules.
//
// `customers.code` IS the debtor sub-account code (the UI labels it
// "Creditor Code", e.g. "300-H", "305-2"). It is NOT a chart_of_accounts
// row — it rolls up to a debtor CONTROL account, which is the COA account
// whose code is "<prefix>-0000" and whose special_account_type = 'SDC'
// (e.g. 300-0000 TRADE DEBTORS, 305-0000 OTHER DEBTOR).
//
// This module is the single source of the FORMAT + control-code derivation
// rule, imported by BOTH the customers create/edit Save handler (frontend)
// and the customers POST/PUT route (backend) so the reject is identical on
// both sides (repo rule: no backend-only reject — it 422s the operator
// after a round-trip with no inline hint). The backend ADDITIONALLY checks
// that the derived control account actually exists & is SDC and that the
// code is unique — those need the DB and stay server-side.
// ---------------------------------------------------------------------------

/** "<3-digit control prefix>-<debtor suffix>", e.g. 300-H, 305-2, 300-12. */
export const DEBTOR_CODE_RE = /^(\d{3})-[A-Za-z0-9]+$/;

export type DebtorParse =
  | { ok: true; prefix: string; controlCode: string }
  | { ok: false; error: string };

/**
 * Validate a debtor code's format and derive its control-account code.
 * Pure — no DB. The control account's existence + SDC flag is checked
 * server-side in the customers route.
 */
export function parseDebtorCode(code: string | null | undefined): DebtorParse {
  const v = (code ?? "").trim();
  if (!v) return { ok: false, error: "Creditor Code is required" };
  const m = v.match(DEBTOR_CODE_RE);
  if (!m) {
    return {
      ok: false,
      error:
        'Creditor Code must look like "300-X" — a 3-digit control prefix, a dash, then the debtor suffix.',
    };
  }
  return { ok: true, prefix: m[1], controlCode: `${m[1]}-0000` };
}

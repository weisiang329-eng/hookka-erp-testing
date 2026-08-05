// ---------------------------------------------------------------------------
// _db.mjs — where the ops scripts get their connection string.
//
// Until 2026-08-05 all 110 scripts under scripts/ carried the live Supabase
// password as a literal. Moving it here does NOT make the old one safe — it is
// in git history and stays there. The fix is to ROTATE the password in
// Supabase; this file is what stops 110 scripts breaking when you do.
//
// Usage:
//   import { prodUrl } from "./_db.mjs";
//   const sql = postgres(prodUrl(), { ssl: "require", max: 1 });
//
// Set before running:
//   export HOOKKA_PROD_DB_URL='postgresql://postgres:...@db.vpwdqt....supabase.co:5432/postgres'
//   export HOOKKA_STAGING_DB_URL='postgresql://postgres:...@db.zaxygx....supabase.co:5432/postgres'
//
// Fails loudly rather than defaulting. A script that silently connected to the
// wrong database would be worse than one that refuses to start — several of
// these scripts write.
// ---------------------------------------------------------------------------

function need(varName, which) {
  const v = (process.env[varName] ?? "").trim();
  if (!v) {
    console.error(
      `\n✗ ${varName} is not set — refusing to guess which database to open.\n` +
        `\n  export ${varName}='postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres'\n` +
        `\n  (${which} — find it in Supabase → Project Settings → Database → Connection string)\n`,
    );
    process.exit(1);
  }
  return v;
}

/** The live database. Most scripts here read it; some write it. */
export function prodUrl() {
  return need("HOOKKA_PROD_DB_URL", "production");
}

/** The staging database. */
export function stagingUrl() {
  return need("HOOKKA_STAGING_DB_URL", "staging");
}

/**
 * The same production database through Supabase's connection POOLER
 * (port 6543, `postgres.<ref>` user). A different host, a different user form
 * and — as found on 2026-08-05 — a different, far weaker password than the
 * direct connection. Rotate it separately; they are not the same secret.
 */
export function prodPoolerUrl() {
  return need("HOOKKA_PROD_POOLER_URL", "production, via the connection pooler");
}

// ============================================================================
// sanitize-staging.mjs
//
// Scrubs personal, payroll, credential and outbound-contact data from the
// STAGING database after it has been cloned from prod by sync-staging.yml.
//
// WHY THIS EXISTS
// ---------------
// `sync-staging.yml` restores a verbatim pg_dump of prod into staging. Before
// this script existed (added 2026-08-15) that left staging holding, in the
// clear: 42 workers' bank accounts / passport numbers / salaries, 138 full
// payslips, 17 users' PBKDF2 password hashes and TOTP secrets, ~4,200 live
// auth tokens, every customer and supplier email + phone + address, ~3,200 real
// business emails, and 482 real outbound recipient addresses. The same
// workflow then sets every worker PIN to 123456. Staging is also a public-
// internet Cloudflare Pages site.
//
// Two concrete hazards, not hypotheticals:
//   1. DISCLOSURE — anyone with staging access reads real payroll and real
//      customer contact details.
//   2. EGRESS — an outbox row on staging carries a REAL customer address, so a
//      test click can email a real customer from a test system.
//
// DESIGN
// ------
// * Deterministic. Fake values derive from sha256(table:id) so the same row
//   gets the same fake value on every refresh. Reports stay comparable across
//   refreshes and the data-analysis work is reproducible.
// * Internally consistent. Payslips are REBUILT (gross = basic + allowances;
//   net = gross - employee deductions) rather than blanked, so the payroll
//   module still exercises real arithmetic on fake numbers.
// * Idempotent. Re-running changes nothing further.
// * Fail-closed. Refuses to run against anything that is not the staging
//   project, and refuses on an unrecognised URL rather than guessing.
//
// WHAT IS DELIBERATELY *NOT* SCRUBBED (and why)
// ---------------------------------------------
// * Company / customer / supplier / worker NAMES. Testers must recognise the
//   data to spot a wrong join or a mis-grouped report. Contact details — the
//   part that lets someone actually reach a real person — are destroyed.
//   Pass --scrub-names to mask these too.
// * job_cards.qr_token / packing_lists.qrtoken / delivery_orders.qrtoken.
//   Keeping them means a real printed sticker can be scanned against staging,
//   which is how the floor team tests. The trade-off is stated plainly: these
//   tokens are then shared between prod and staging, so anyone who can read
//   the staging DB learns prod's scan tokens. They identify a document; they
//   are not login credentials. Pass --rotate-qr to regenerate them instead.
//
// USAGE
//   node scripts/sanitize-staging.mjs                 # report only, no writes
//   node scripts/sanitize-staging.mjs --apply         # perform the scrub
//   node scripts/sanitize-staging.mjs --apply --scrub-names --rotate-qr
//
// Reads STAGING_DATABASE_URL from the environment.
// ============================================================================

import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const SCRUB_NAMES = process.argv.includes("--scrub-names");
const ROTATE_QR = process.argv.includes("--rotate-qr");

// The staging Supabase project ref. Both the direct host
// (db.<ref>.supabase.co) and the session pooler (user postgres.<ref>@...)
// carry the ref, so one check covers both URL shapes.
const STAGING_REF = "zaxygxwadidiqcphibma";
const PROD_REF = "vpwdqtsxexpiqxzweivd";

// The shared staging password. Staging is a test system; every user gets the
// same known password so the team can log in as anyone to reproduce a report.
// This is intentional and is the reason the scrub must never run on prod.
const STAGING_PASSWORD = process.env.STAGING_TEST_PASSWORD || "Staging#2026";

const url = process.env.STAGING_DATABASE_URL;
if (!url) {
  console.error("STAGING_DATABASE_URL is not set. Refusing to run.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Guard. Three independent checks, all of which must pass. The cost of a false
// negative here is scrubbing production payroll, so this is deliberately
// paranoid: it asserts staging POSITIVELY rather than merely asserting
// "not prod", and it bails on anything it does not recognise.
// ---------------------------------------------------------------------------
if (url.includes(PROD_REF)) {
  console.error(
    `REFUSING: STAGING_DATABASE_URL contains the PRODUCTION project ref (${PROD_REF}).`,
  );
  process.exit(1);
}
if (!url.includes(STAGING_REF)) {
  console.error(
    `REFUSING: STAGING_DATABASE_URL does not contain the known staging project ref (${STAGING_REF}).\n` +
      `If the staging project was recreated, update STAGING_REF in this file — do NOT relax the check.`,
  );
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
  idle_timeout: 20,
  connect_timeout: 30,
});

console.log(`host          : ${url.match(/@([^:/]+)/)?.[1] ?? "?"}`);
console.log(`mode          : ${APPLY ? "APPLY (writes)" : "REPORT ONLY (no writes)"}`);
console.log(`scrub names   : ${SCRUB_NAMES}`);
console.log(`rotate QR     : ${ROTATE_QR}`);
console.log("");

// ---------------------------------------------------------------------------
// Deterministic fake values. sha256(seed) so a given row keeps its fake value
// across refreshes.
// ---------------------------------------------------------------------------
const h = (seed) => createHash("sha256").update(String(seed)).digest();
const hInt = (seed, mod) => h(seed).readUInt32BE(0) % mod;

const fakePhone = (seed) =>
  `+601${hInt(seed + ":p", 10)}${String(hInt(seed + ":q", 10 ** 7)).padStart(7, "0")}`;
const fakeEmail = (table, id) => `${table}-${id}@staging.invalid`;
const fakeAddress = (seed) =>
  `Lot ${hInt(seed + ":a", 900) + 100}, Jalan Staging ${hInt(seed + ":b", 40) + 1}, 00000 Test City, Selangor`;
const fakeBank = (seed) => `XXXXXX${String(hInt(seed + ":bank", 10000)).padStart(4, "0")}`;
const fakePassport = (seed) =>
  `T${String(hInt(seed + ":pp", 10 ** 7)).padStart(7, "0")}`;
const fakeName = (seed) => `Party ${String(hInt(seed + ":n", 9000) + 1000)}`;

// Basic monthly salary in sen, banded RM 1,500 – RM 6,000.
const fakeSalarySen = (seed) => (150000 + hInt(seed + ":sal", 451) * 100) | 0;

// ---------------------------------------------------------------------------
// Schema helpers — every statement is guarded on the column actually existing,
// so a schema drift on prod degrades to a skipped step with a printed note
// instead of aborting the whole scrub half-done.
// ---------------------------------------------------------------------------
const existing = new Map();
async function cols(table) {
  if (existing.has(table)) return existing.get(table);
  const r = await sql`
    SELECT column_name AS c
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}`;
  const set = new Set(r.map((x) => x.c));
  existing.set(table, set);
  return set;
}
async function tableExists(table) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ${table} AND table_type = 'BASE TABLE'`;
  return r.length > 0;
}
async function count(table) {
  try {
    return (await sql.unsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`))[0].n;
  } catch {
    return 0;
  }
}

const steps = [];
const record = (what, n, note = "") => {
  steps.push({ what, n, note });
  console.log(`${String(n).padStart(7)}  ${what}${note ? `   (${note})` : ""}`);
};

// ===========================================================================
// 1. CREDENTIALS — purge outright.
//    Sessions and tokens cloned from prod are live prod-issued credentials.
//    Nothing about them needs to survive into a test system.
// ===========================================================================
console.log("--- 1. credentials / live tokens (purged) ---");
for (const t of [
  "user_sessions",
  "worker_tokens",
  "password_reset_tokens",
  "user_invites",
  "kpi_survey_tokens",
]) {
  if (!(await tableExists(t))) {
    record(t, 0, "table absent");
    continue;
  }
  const n = await count(t);
  if (APPLY && n) await sql.unsafe(`DELETE FROM "${t}"`);
  record(t, n, "deleted");
}

// ===========================================================================
// 2. USERS — one shared staging password, TOTP removed.
//    Emails are KEPT: login is by email, so rewriting them would lock the
//    owner out of his own staging site. These are 17 internal staff
//    addresses, not customer data.
// ===========================================================================
console.log("\n--- 2. users ---");
{
  const c = await cols("users");
  const n = await count("users");
  if (APPLY && n) {
    // Reproduce src/api/lib/password.ts exactly:
    //   pbkdf2-sha256$100000$<hex-salt>$<hex-hash>, SHA-256, 16-byte salt,
    //   32-byte key. Uses the same WebCrypto API the Worker uses, so the
    //   hash is verified by the real verifyPassword() at login.
    const salt = new Uint8Array(randomBytes(16));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(STAGING_PASSWORD),
      { name: "PBKDF2" },
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
      key,
      32 * 8,
    );
    const hex = (b) =>
      [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    const stored = `pbkdf2-sha256$100000$${hex(salt)}$${hex(bits)}`;

    const sets = [`password_hash = '${stored}'`];
    if (c.has("totp_secret")) sets.push("totp_secret = NULL");
    if (c.has("totp_recovery_hashes")) sets.push("totp_recovery_hashes = NULL");
    if (c.has("totp_enrolled_at")) sets.push("totp_enrolled_at = NULL");
    if (c.has("must_change_password")) sets.push("must_change_password = false");
    await sql.unsafe(`UPDATE users SET ${sets.join(", ")}`);
  }
  record("users", n, `password → "${STAGING_PASSWORD}", TOTP cleared, emails kept for login`);
}

// ===========================================================================
// 3. PAYROLL — rebuilt, not blanked.
//    Blanking payroll makes the payroll module untestable. Instead every
//    worker gets a deterministic fake basic salary and each payslip is
//    recomputed from it with real Malaysian statutory rates, so the module
//    still exercises genuine arithmetic and the totals still reconcile.
// ===========================================================================
console.log("\n--- 3. payroll (rebuilt on fake salaries) ---");
{
  const c = await cols("workers");
  const rows = await sql`SELECT id FROM workers`;
  if (APPLY) {
    for (const w of rows) {
      const sets = [];
      if (c.has("basic_salary_sen"))
        sets.push(`basic_salary_sen = ${fakeSalarySen(`worker:${w.id}`)}`);
      if (c.has("efficiency_allowance_sen"))
        sets.push(`efficiency_allowance_sen = ${hInt(`worker:${w.id}:allw`, 30) * 1000}`);
      if (c.has("bank_account"))
        sets.push(`bank_account = '${fakeBank(`worker:${w.id}`)}'`);
      if (c.has("passport_number"))
        sets.push(`passport_number = '${fakePassport(`worker:${w.id}`)}'`);
      if (c.has("phone")) sets.push(`phone = '${fakePhone(`worker:${w.id}`)}'`);
      if (sets.length)
        await sql.unsafe(`UPDATE workers SET ${sets.join(", ")} WHERE id = $1`, [w.id]);
    }
  }
  record("workers", rows.length, "salary / bank / passport / phone faked");
}

if (await tableExists("worker_salary_history")) {
  const c = await cols("worker_salary_history");
  const key = c.has("worker_id") ? "worker_id" : c.has("workerId") ? "workerId" : null;
  const rows = await sql.unsafe(`SELECT id${key ? `, "${key}" AS wid` : ""} FROM worker_salary_history`);
  if (APPLY) {
    for (const r of rows) {
      // Tie history to the SAME fake basic as the worker's current salary so
      // a "salary changed on <date>" report still tells a coherent story.
      const v = fakeSalarySen(`worker:${r.wid ?? r.id}`);
      await sql.unsafe(`UPDATE worker_salary_history SET basic_salary_sen = $1 WHERE id = $2`, [v, r.id]);
    }
  }
  record("worker_salary_history", rows.length, "aligned to the worker's fake basic");
}

if (await tableExists("payslips")) {
  const c = await cols("payslips");
  const rows = await sql`SELECT id FROM payslips`;
  if (APPLY) {
    for (const p of rows) {
      const basic = fakeSalarySen(`payslip:${p.id}`);
      const allow = hInt(`payslip:${p.id}:allw`, 40) * 1000;
      const gross = basic + allow;
      // Statutory rates: EPF 11% employee / 13% employer, SOCSO ~0.5% / 1.75%,
      // EIS 0.2% each. Rounded to whole sen.
      const epfEe = Math.round(basic * 0.11);
      const epfEr = Math.round(basic * 0.13);
      const socEe = Math.round(basic * 0.005);
      const socEr = Math.round(basic * 0.0175);
      const eisEe = Math.round(basic * 0.002);
      const eisEr = Math.round(basic * 0.002);
      const net = gross - epfEe - socEe - eisEe;
      const set = {
        basic_salary_sen: basic,
        allowances_sen: allow,
        gross_pay_sen: gross,
        epf_employee_sen: epfEe,
        epf_employer_sen: epfEr,
        socso_employee_sen: socEe,
        socso_employer_sen: socEr,
        eis_employee_sen: eisEe,
        eis_employer_sen: eisEr,
        net_pay_sen: net,
      };
      const sets = Object.entries(set)
        .filter(([k]) => c.has(k))
        .map(([k, v]) => `${k} = ${v}`);
      if (c.has("bank_account")) sets.push(`bank_account = '${fakeBank(`payslip:${p.id}`)}'`);
      if (c.has("bank_name")) sets.push(`bank_name = 'Staging Bank'`);
      await sql.unsafe(`UPDATE payslips SET ${sets.join(", ")} WHERE id = $1`, [p.id]);
    }
  }
  record("payslips", rows.length, "gross = basic + allowances; net = gross − EPF/SOCSO/EIS");
}

// ===========================================================================
// 4. CONTACT DETAILS — destroy every way to reach a real person.
//    This is the step that prevents a test click from emailing or calling a
//    real customer.
// ===========================================================================
console.log("\n--- 4. contact details ---");
const CONTACT_TABLES = {
  customers: { email: ["email"], phone: ["phone"], addr: ["company_address"], name: ["contact_name"] },
  customer_hubs: { email: ["pic_email"], phone: [], addr: ["delivery_address"], name: [] },
  delivery_hubs: { email: ["email"], phone: ["phone"], addr: ["address"], name: ["contact_name"] },
  suppliers: {
    email: ["email"],
    phone: ["phone", "phone2", "mobile"],
    addr: ["address", "address_line1", "address_line2", "address_line3", "address_line4"],
    name: [],
  },
  drivers: { email: [], phone: ["phone"], addr: [], name: [] },
  other_parties: { email: ["email"], phone: ["phone"], addr: ["address"], name: [] },
  sales_leads: { email: ["email"], phone: ["phone"], addr: [], name: [] },
  organisations: { email: ["email"], phone: ["phone"], addr: ["address"], name: [] },
  three_pl_drivers: { email: [], phone: ["phone"], addr: [], name: [] },
  three_pl_providers: { email: [], phone: ["phone"], addr: [], name: [] },
  delivery_orders: {
    email: [],
    phone: ["contact_phone", "driver_phone"],
    addr: ["delivery_address"],
    name: [],
  },
  invoices: { email: [], phone: ["customer_phone"], addr: ["customer_address"], name: [] },
  consignment_notes: { email: [], phone: ["driver_phone"], addr: [], name: [] },
  other_party_payments: { email: [], phone: [], addr: [], bank: ["bank_account"] },
};

for (const [t, spec] of Object.entries(CONTACT_TABLES)) {
  if (!(await tableExists(t))) {
    record(t, 0, "table absent");
    continue;
  }
  const c = await cols(t);
  const rows = await sql.unsafe(`SELECT id FROM "${t}"`);
  const touched = [];
  for (const group of ["email", "phone", "addr", "name", "bank"]) {
    for (const col of spec[group] ?? []) if (c.has(col)) touched.push([group, col]);
  }
  if (APPLY && touched.length) {
    for (const r of rows) {
      // Values are bound as parameters, never interpolated — a supplier
      // address with an apostrophe would otherwise break the statement.
      const params = [];
      const assigns = touched.map(([g, col]) => {
        const seed = `${t}:${r.id}:${col}`;
        const v =
          g === "email"
            ? fakeEmail(t, r.id)
            : g === "phone"
              ? fakePhone(seed)
              : g === "addr"
                ? fakeAddress(seed)
                : g === "bank"
                  ? fakeBank(seed)
                  : fakeName(seed);
        params.push(v);
        // A NULL contact column stays NULL — filling it would invent data prod
        // does not have and skew every completeness report built on staging.
        return `"${col}" = CASE WHEN "${col}" IS NULL THEN NULL ELSE $${params.length} END`;
      });
      params.push(r.id);
      await sql.unsafe(
        `UPDATE "${t}" SET ${assigns.join(", ")} WHERE id = $${params.length}`,
        params,
      );
    }
  }
  record(t, rows.length, touched.map(([, c2]) => c2).join(", ") || "nothing to scrub");
}

// Optional: mask the business names too.
if (SCRUB_NAMES) {
  console.log("\n--- 4b. business names (--scrub-names) ---");
  for (const [t, col] of [
    ["customers", "name"],
    ["suppliers", "name"],
    ["other_parties", "name"],
    ["workers", "name"],
  ]) {
    if (!(await tableExists(t))) continue;
    const c = await cols(t);
    if (!c.has(col)) continue;
    const rows = await sql.unsafe(`SELECT id FROM "${t}"`);
    if (APPLY)
      for (const r of rows)
        await sql.unsafe(`UPDATE "${t}" SET "${col}" = $1 WHERE id = $2`, [
          fakeName(`${t}:${r.id}`),
          r.id,
        ]);
    record(`${t}.${col}`, rows.length, "masked");
  }
}

// ===========================================================================
// 5. EMAIL — the egress hazard. Addresses are redirected to an unroutable
//    sink domain (.invalid is reserved by RFC 2606 and can never resolve), and
//    message bodies are redacted because they are real customer
//    correspondence, not test fixtures.
// ===========================================================================
console.log("\n--- 5. email (bodies redacted, addresses sunk to .invalid) ---");
{
  if (await tableExists("email_messages")) {
    const c = await cols("email_messages");
    const n = await count("email_messages");
    if (APPLY && n) {
      const sets = [];
      if (c.has("from_address")) sets.push(`from_address = 'from-' || id || '@staging.invalid'`);
      if (c.has("to_addresses")) sets.push(`to_addresses = 'to-' || id || '@staging.invalid'`);
      if (c.has("cc_addresses")) sets.push(`cc_addresses = NULL`);
      if (c.has("subject")) sets.push(`subject = 'Redacted subject #' || id`);
      if (c.has("text_body")) sets.push(`text_body = '[redacted on staging]'`);
      if (c.has("html_body")) sets.push(`html_body = '<p>[redacted on staging]</p>'`);
      await sql.unsafe(`UPDATE email_messages SET ${sets.join(", ")}`);
    }
    record("email_messages", n, "addresses + subject + body");
  }
  if (await tableExists("email_threads")) {
    const c = await cols("email_threads");
    const n = await count("email_threads");
    if (APPLY && n) {
      const sets = [];
      if (c.has("counterparty_email"))
        sets.push(`counterparty_email = 'cp-' || id || '@staging.invalid'`);
      if (c.has("mailbox_address"))
        sets.push(`mailbox_address = 'mailbox-' || id || '@staging.invalid'`);
      if (c.has("subject")) sets.push(`subject = 'Redacted thread #' || id`);
      if (c.has("last_snippet")) sets.push(`last_snippet = '[redacted on staging]'`);
      await sql.unsafe(`UPDATE email_threads SET ${sets.join(", ")}`);
    }
    record("email_threads", n, "addresses + subject + snippet");
  }
  if (await tableExists("email_addresses")) {
    const n = await count("email_addresses");
    if (APPLY && n)
      await sql.unsafe(`UPDATE email_addresses SET address = 'box-' || id || '@staging.invalid'`);
    record("email_addresses", n, "mailbox addresses");
  }
  if (await tableExists("outbox_emails")) {
    const n = await count("outbox_emails");
    // Queued outbound mail is deleted, not rewritten. A rewritten row is still
    // a row the sender will try to deliver; an absent row cannot be sent at
    // all. This is the single highest-consequence table in the scrub.
    if (APPLY && n) await sql.unsafe(`DELETE FROM outbox_emails`);
    record("outbox_emails", n, "DELETED — queued outbound mail must not survive into a test system");
  }
}

// ===========================================================================
// 6. MISC
// ===========================================================================
console.log("\n--- 6. misc ---");
if (await tableExists("audit_events")) {
  const c = await cols("audit_events");
  const n = await count("audit_events");
  if (APPLY && n && c.has("ip_address"))
    await sql.unsafe(`UPDATE audit_events SET ip_address = '0.0.0.0' WHERE ip_address IS NOT NULL`);
  record("audit_events.ip_address", n, "masked");
}

if (ROTATE_QR) {
  for (const [t, col] of [
    ["job_cards", "qr_token"],
    ["packing_lists", "qrtoken"],
    ["delivery_orders", "qrtoken"],
  ]) {
    if (!(await tableExists(t))) continue;
    const c = await cols(t);
    if (!c.has(col)) continue;
    const n = await count(t);
    if (APPLY && n)
      await sql.unsafe(
        `UPDATE "${t}" SET "${col}" = encode(gen_random_bytes(16), 'hex') WHERE "${col}" IS NOT NULL`,
      );
    record(`${t}.${col}`, n, "rotated — printed stickers will NOT scan on staging");
  }
} else {
  console.log(
    "      job_cards.qr_token / packing_lists.qrtoken / delivery_orders.qrtoken KEPT\n" +
      "      so real printed stickers scan on staging. They are therefore shared with\n" +
      "      prod. Pass --rotate-qr to break that link.",
  );
}

// ===========================================================================
// VERIFY — read back and prove the scrub actually landed. An UPDATE that
// reports success is not evidence; a query that finds zero survivors is.
// ===========================================================================
console.log("\n--- verification (post-conditions) ---");
if (APPLY) {
  const checks = [];
  const chk = async (label, query, expectZero = true) => {
    try {
      const n = (await sql.unsafe(query))[0].n;
      const ok = expectZero ? Number(n) === 0 : Number(n) > 0;
      checks.push(ok);
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} = ${n}`);
    } catch (e) {
      checks.push(false);
      console.log(`  FAIL  ${label} — ${e.message}`);
    }
  };
  await chk("live sessions remaining", `SELECT COUNT(*)::int n FROM user_sessions`);
  await chk("worker tokens remaining", `SELECT COUNT(*)::int n FROM worker_tokens`);
  await chk("queued outbound emails remaining", `SELECT COUNT(*)::int n FROM outbox_emails`);
  await chk(
    "users still holding a TOTP secret",
    `SELECT COUNT(*)::int n FROM users WHERE totp_secret IS NOT NULL`,
  );
  await chk(
    "email rows still addressed off .invalid",
    `SELECT COUNT(*)::int n FROM email_messages WHERE to_addresses NOT LIKE '%@staging.invalid'`,
  );
  await chk(
    "customer emails not sunk",
    `SELECT COUNT(*)::int n FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@staging.invalid'`,
  );
  await chk(
    "payslips whose gross does not equal basic + allowances",
    `SELECT COUNT(*)::int n FROM payslips WHERE gross_pay_sen <> basic_salary_sen + allowances_sen`,
  );
  await chk(
    "payslips still present (data kept, not deleted)",
    `SELECT COUNT(*)::int n FROM payslips`,
    false,
  );
  const failed = checks.filter((x) => !x).length;
  console.log(
    failed === 0
      ? "\nAll post-conditions passed."
      : `\n${failed} post-condition(s) FAILED — staging is NOT safe to hand out.`,
  );
  await sql.end();
  process.exit(failed === 0 ? 0 : 1);
} else {
  console.log("  (skipped — report-only run made no changes)");
  console.log("\nRe-run with --apply to perform the scrub.");
}

await sql.end();

// ============================================================================
// fix-rbac-mail-and-readonly.mjs
//
// Two RBAC corrections, measured on prod 2026-08-19.
//
// 1. MAIL-CENTER — the seed granted all four actions (read/create/update/
//    delete) to ALL TWELVE roles, including WORKER (factory floor) and
//    READ_ONLY (an external party). `create` is the SEND action: it backs
//    POST /compose and POST /threads/:id/reply. So every role in the system
//    could send mail from an @hookka.com address.
//
//    This applies a per-role matrix instead. Note what each action really
//    covers, because the names mislead:
//      read   — read threads / outbox / addresses / labels
//      create — SEND and REPLY (and create a label)
//      update — star / mark read / trash, plus edit a label
//      delete — delete a LABEL. It does NOT delete mail. Labels are a shared
//               catalogue, so one person deleting one affects everybody.
//
//    Mailbox VISIBILITY is a separate layer (mail_user_scope) and is left
//    alone: it has no rows, so everyone defaults to 'personal' — own mailbox
//    only. That layer is already safe. SUPER_ADMIN bypasses both layers by
//    design, and the owner has decided to leave the seven super admins as
//    they are (2026-08-19), so this script does not touch them.
//
// 2. READ_ONLY — held 69 read permissions covering payroll, payslips,
//    workers, users, accounting, cash-flow, cost-ledger, supplier prices and
//    stock value: effectively the whole company's books. Its only member is
//    jess@carresofficial.com — a person at a DIFFERENT company (Carress is
//    customer cust-2). Despite the name it also held create/update/delete on
//    mail-center and settings.
//
//    The owner's instruction (2026-08-19): "jess 完全不可以看到 他只是外人
//    viewer". So the role is stripped to nothing and the account deactivated.
//    Granting an outside viewer specific things later is an additive decision
//    the owner makes explicitly, one resource at a time — not a default.
//
//    This is safe to do bluntly: the account has NEVER been used. Zero rows in
//    user_sessions, zero audit events — and it is ALREADY is_active = 0, so
//    Jess cannot log in today. The live risk is not her; it is the ROLE. Anyone
//    put into READ_ONLY inherits payroll and the company books, and the name
//    invites exactly that mistake. Stripping the role is the real fix; the
//    deactivate is belt and braces.
//
// USAGE
//   node scripts/fix-rbac-mail-and-readonly.mjs                 # report only
//   node scripts/fix-rbac-mail-and-readonly.mjs --apply --i-understand
//
// Reads DATABASE_URL. Prints the host and asserts liveness before writing.
// ============================================================================

import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const ACK = process.argv.includes("--i-understand");
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is not set. Refusing to run.");
  process.exit(1);
}
if (APPLY && !ACK) {
  console.error(
    "--apply also requires --i-understand. This changes who can do what in a\n" +
      "live system; it should not be possible to trigger it with one flag.",
  );
  process.exit(1);
}

// Which roles may do what in Mail Center. A role absent from a list loses that
// action. `create` is the send switch and is the reason this file exists.
const MAIL_MATRIX = {
  // Everyone who legitimately corresponds with people outside the company.
  create: [
    "role_super_admin",
    "role_office",
    "role_sales",
    "role_finance",
    "role_procurement",
    "role_hr",
  ],
  // Anyone who works a mailbox can read it and tidy it. Visibility is still
  // capped to their own mailbox by mail_user_scope.
  read: [
    "role_super_admin",
    "role_office",
    "role_sales",
    "role_finance",
    "role_procurement",
    "role_hr",
    "role_rd",
    "role_qa",
    "role_production",
    "role_warehouse",
  ],
  update: [
    "role_super_admin",
    "role_office",
    "role_sales",
    "role_finance",
    "role_procurement",
    "role_hr",
    "role_rd",
    "role_qa",
    "role_production",
    "role_warehouse",
  ],
  // Deleting a label affects every user, so keep it with the admins.
  delete: ["role_super_admin", "role_office"],
};

// Roles that lose Mail Center entirely.
//   role_worker    — the factory phone portal. Clocking in and reading a job
//                    card is the whole job; there is no reason for it to reach
//                    a company mailbox, let alone send from one.
//   role_read_only — an external party. See the header.
const MAIL_REMOVED_ROLES = ["role_worker", "role_read_only"];

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
  idle_timeout: 20,
  connect_timeout: 30,
});

console.log(`host  : ${url.match(/@([^:/]+)/)?.[1] ?? "?"}`);
console.log(`mode  : ${APPLY ? "APPLY (writes)" : "REPORT ONLY (no writes)"}`);

const live = await sql`SELECT MAX(date) AS d FROM attendance_records`;
console.log(`live  : latest attendance ${live[0].d}\n`);

// --- current state -----------------------------------------------------------
const before = await sql`
  SELECT rp.role_id, p.action
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
   WHERE p.resource = 'mail-center'
   ORDER BY rp.role_id, p.action`;

const beforeByRole = {};
for (const r of before) (beforeByRole[r.role_id] ??= []).push(r.action);

console.log("--- mail-center: now → after ---");
const allRoles = (await sql`SELECT id FROM roles ORDER BY id`).map((r) => r.id);
for (const role of allRoles) {
  const now = (beforeByRole[role] ?? []).sort();
  const after = MAIL_REMOVED_ROLES.includes(role)
    ? []
    : Object.entries(MAIL_MATRIX)
        .filter(([, roles]) => roles.includes(role))
        .map(([action]) => action)
        .sort();
  const same = now.join(",") === after.join(",");
  console.log(
    `  ${role.padEnd(20)} ${(now.join(",") || "(none)").padEnd(28)} → ${after.join(",") || "(none)"}${same ? "   [unchanged]" : ""}`,
  );
}

const roCount = await sql`
  SELECT COUNT(*)::int AS n FROM role_permissions WHERE role_id = 'role_read_only'`;
const jess = await sql`
  SELECT id, display_name, email, is_active FROM users WHERE role = 'READ_ONLY'`;

console.log(`\n--- READ_ONLY ---`);
console.log(`  permissions now: ${roCount[0].n}  → after: 0`);
for (const u of jess) {
  console.log(
    `  member: ${u.display_name} <${u.email}>  is_active=${u.is_active} → false`,
  );
}

if (!APPLY) {
  console.log("\nReport only — nothing was written.");
  console.log("Re-run with --apply --i-understand to make these changes.");
  await sql.end();
  process.exit(0);
}

// --- apply -------------------------------------------------------------------
console.log("\n--- applying ---");

await sql.begin(async (tx) => {
  // 1. Wipe every mail-center grant, then re-insert exactly the matrix. A
  //    delete-then-insert rather than a diff: the matrix above becomes the
  //    single readable statement of the intended state, and a role added to
  //    the system later starts with nothing instead of inheriting a stale row.
  const removed = await tx`
    DELETE FROM role_permissions
     WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'mail-center')
    RETURNING role_id`;
  console.log(`  removed ${removed.length} mail-center grants`);

  let added = 0;
  for (const [action, roles] of Object.entries(MAIL_MATRIX)) {
    for (const role of roles) {
      if (MAIL_REMOVED_ROLES.includes(role)) continue;
      const perm = await tx`
        SELECT id FROM permissions WHERE resource = 'mail-center' AND action = ${action} LIMIT 1`;
      if (!perm.length) {
        throw new Error(`permission mail-center:${action} does not exist`);
      }
      await tx`
        INSERT INTO role_permissions (role_id, permission_id)
        VALUES (${role}, ${perm[0].id})
        ON CONFLICT DO NOTHING`;
      added++;
    }
  }
  console.log(`  inserted ${added} mail-center grants`);

  // 2. READ_ONLY holds nothing. Not "read-only" — nothing. The name was the
  //    problem: it read as a safe default while carrying payroll and users.
  const stripped = await tx`
    DELETE FROM role_permissions WHERE role_id = 'role_read_only' RETURNING role_id`;
  console.log(`  stripped ${stripped.length} permissions from role_read_only`);

  // 3. Deactivate the account. Reversible with one flag if the owner decides
  //    what this viewer should actually see.
  // is_active is an INTEGER column, not a boolean — passing `false` fails with
  // 42804 and takes the whole transaction down with it. Write 0.
  const deact = await tx`
    UPDATE users SET is_active = 0 WHERE role = 'READ_ONLY' RETURNING email`;
  console.log(`  deactivated ${deact.length} account(s): ${deact.map((u) => u.email).join(", ")}`);
});

// --- verify ------------------------------------------------------------------
// Re-query rather than trust the writes. A successful UPDATE is not evidence.
console.log("\n--- verification ---");
let failed = 0;
const check = async (label, query, ok) => {
  const rows = await query;
  const pass = ok(rows);
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
  return rows;
};

await check(
  "no role outside the matrix can send mail",
  sql`SELECT rp.role_id FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE p.resource = 'mail-center' AND p.action = 'create'`,
  (rows) =>
    rows.every((r) => MAIL_MATRIX.create.includes(r.role_id)) &&
    rows.length === MAIL_MATRIX.create.length,
);
await check(
  "role_worker has no mail-center grant at all",
  sql`SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE p.resource = 'mail-center' AND rp.role_id = 'role_worker'`,
  (rows) => rows.length === 0,
);
await check(
  "role_read_only holds nothing",
  sql`SELECT 1 FROM role_permissions WHERE role_id = 'role_read_only'`,
  (rows) => rows.length === 0,
);
await check(
  "the external account is deactivated",
  sql`SELECT is_active FROM users WHERE role = 'READ_ONLY'`,
  // is_active comes back as 0/1 from this column, not a JS boolean — compare
  // on truthiness, not identity, or a correct row reads as a failure.
  (rows) => rows.every((r) => !r.is_active),
);
await check(
  "mailbox visibility was NOT touched — still empty, so everyone stays 'personal'",
  sql`SELECT 1 FROM mail_user_scope`,
  (rows) => rows.length === 0,
);
await check(
  "no other resource lost grants (only mail-center and read_only changed)",
  sql`SELECT COUNT(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE p.resource <> 'mail-center' AND rp.role_id <> 'role_read_only'`,
  (rows) => rows[0].n > 0,
);

console.log(
  failed === 0
    ? "\nAll post-conditions passed."
    : `\n${failed} post-condition(s) FAILED — inspect before trusting this.`,
);

await sql.end();
process.exit(failed === 0 ? 0 : 1);

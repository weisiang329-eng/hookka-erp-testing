// ---------------------------------------------------------------------------
// security-posture-red-proof.mjs — proves the three security suites actually
// FAIL when the bugs they guard are put back.
//
// Not a `.test.mjs`: it mutates source files on disk, so it must never run as
// part of `npm test`. Run it by hand:
//
//     node tests/security-posture-red-proof.mjs
//
// Why this file exists. A guard nobody has watched fail is not a guard —
// BUG-CLASSES C8 and C15 both record assertions that passed happily while the
// bug was still in the tree. Worse, this repo has had THREE silently-failed
// mutations this week, twice because a CRLF file did not match an LF anchor and
// the "mutation" changed nothing at all, so the suite passed and was read as
// proof. So every mutation here:
//
//   • matches through a regex in which every newline is `\r?\n`, and writes
//     back using the FILE'S OWN dominant line ending — so it does not matter
//     what any given checkout produced. Do NOT "simplify" this to plain string
//     matching: the files it edits were CRLF on the machine this was written
//     on, `core.autocrlf` decides that per checkout, and a literal `\n` anchor
//     matches nothing in a CRLF file while looking perfectly reasonable;
//   • asserts the expected number of occurrences BEFORE replacing;
//   • asserts the file's BYTES ON DISK changed after writing, and that they are
//     byte-identical to the original again after restoring.
//
// A mutation that does not change bytes is reported as a HARNESS FAILURE, not
// as a passing test.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ORG_ROUTE = "src/api/routes/organisations.ts";
const ORG_TEST = "tests/organisations-registry-projection.test.mjs";
const CRM_ROUTE = "src/api/routes/customer-crm.ts";
const CRM_TEST = "tests/customer-crm-quote-recipient.test.mjs";
const TOTP_ROUTE = "src/api/routes/auth-totp.ts";
const TOTP_LIB = "src/api/lib/totp-pending.ts";
const AUTH_ROUTE = "src/api/routes/auth.ts";
const TOTP_TEST = "tests/totp-login-password-gate.test.mjs";
const PDF = "src/lib/generate-purchase-order-pdf.ts";
const LETTERHEAD = "src/lib/org-letterhead-row.ts";


/**
 * Each case: reintroduce ONE bug, then require `testFile` to fail.
 * `from` must appear exactly `count` times (default 1).
 */
const CASES = [
  {
    name: "organisations GET: drop the permission check (everyone gets the full registry)",
    file: ORG_ROUTE,
    from:
      '  const full =\n    (await hasPermission(c, "organisations", "read")) ||\n' +
      '    (await hasPermission(c, "purchase-orders", "read"));',
    to: "  const full = true;",
    testFile: ORG_TEST,
  },
  {
    name: "organisations: drop the tenant predicate from every by-id resolve",
    file: ORG_ROUTE,
    from: "WHERE id = ? AND org_id = ?",
    to: "WHERE id = ?",
    count: 9,
    testFile: ORG_TEST,
  },
  {
    name: "organisations POST: hard-code the tenant again",
    file: ORG_ROUTE,
    from: "        orgId,\n        code,",
    to: '        "hookka",\n        code,',
    testFile: ORG_TEST,
  },
  {
    name: "organisations POST: dedupe across every tenant again",
    file: ORG_ROUTE,
    from: '      "SELECT id FROM organisations WHERE code = ? AND org_id = ?",',
    to: '      "SELECT id FROM organisations WHERE code = ?",',
    testFile: ORG_TEST,
  },
  {
    name: "letterhead: treat a row with no details as printable (C16)",
    file: LETTERHEAD,
    from: "  if (!org) return false;",
    to: "  if (!org) return true;",
    testFile: ORG_TEST,
  },
  {
    name: "letterhead: short-circuit the guard out of the PDF branch",
    file: PDF,
    from: "  if (org && org.name && hasLetterheadDetails(org)) {",
    to: "  if (org && org.name) {",
    testFile: ORG_TEST,
  },
  {
    name: "organisations GET: drop the purchase-orders key (blank Reg/TIN on POs for QA)",
    file: ORG_ROUTE,
    from: '    (await hasPermission(c, "organisations", "read")) ||\n    (await hasPermission(c, "purchase-orders", "read"));',
    to: '    await hasPermission(c, "organisations", "read");',
    testFile: ORG_TEST,
  },
  {
    name: "send-quote: stop checking the recipient against the customer",
    file: CRM_ROUTE,
    from: "  if (!allowed.has(to.toLowerCase())) {",
    to: "  if (false) {",
    testFile: CRM_TEST,
  },
  {
    name: "send-quote: fall through when the customer has no email on file",
    file: CRM_ROUTE,
    from: "  if (allowed.size === 0) {",
    to: "  if (false) {",
    testFile: CRM_TEST,
  },
  {
    name: "send-quote: drop the tenant predicate on the customer lookup",
    file: CRM_ROUTE,
    from: '    "SELECT email FROM customers WHERE id = ? AND org_id = ?",',
    to: '    "SELECT email FROM customers WHERE id = ?",',
    testFile: CRM_TEST,
  },
  {
    name: "login-verify: stop requiring the pending-2FA token (the original hole)",
    file: TOTP_ROUTE,
    from: "  if (!pending.ok) {",
    to: "  if (false) {",
    testFile: TOTP_TEST,
  },
  {
    name: "login-verify: stop burning the pending token (replayable)",
    file: TOTP_ROUTE,
    from: "  await consumePendingTotpToken(c.var.DB, userId);",
    to: "  void 0;",
    testFile: TOTP_TEST,
  },
  {
    name: "pending token: stop binding it to the user it was minted for",
    file: TOTP_LIB,
    from: '  if (rowUserId !== userId) return { ok: false, reason: "wrong-user" };',
    to: "  void rowUserId;",
    testFile: TOTP_TEST,
  },
  {
    name: "pending token: stop expiring it",
    file: TOTP_LIB,
    from: "  if (!Number.isFinite(expMs) || expMs <= nowMs) {",
    to: "  if (false) {",
    testFile: TOTP_TEST,
  },
  {
    name: "/login: stop returning the pending token (step 2 becomes unreachable-or-open)",
    file: AUTH_ROUTE,
    from: "      userId: user.id,\n      pendingToken,\n",
    to: "      userId: user.id,\n",
    testFile: TOTP_TEST,
  },
];

/** A regex that matches `literal` under EITHER line ending. */
function eolAgnostic(literal) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\r?\n/g, "\\r?\\n"), "g");
}

/** The file's own dominant line ending, so the mutation does not mix them. */
function dominantEol(text) {
  return (text.match(/\r\n/g) || []).length > 0 ? "\r\n" : "\n";
}

function run(testFile) {
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx/esm", "--test", testFile],
      { stdio: "pipe", encoding: "utf8" },
    );
    return { failed: false };
  } catch (e) {
    return { failed: true, out: String(e.stdout || "") };
  }
}

let harnessErrors = 0;
let notRed = 0;

// Sanity: the suites must be GREEN before anything is mutated. Otherwise a
// "the test went red" result proves nothing.
for (const t of [ORG_TEST, CRM_TEST, TOTP_TEST]) {
  const base = run(t);
  if (base.failed) {
    console.error(`HARNESS FAILURE: ${t} is already failing before any mutation`);
    harnessErrors++;
  }
}

for (const cse of CASES) {
  const path = resolve(process.cwd(), cse.file);
  const originalBytes = readFileSync(path);
  const original = originalBytes.toString("utf8");
  const want = cse.count ?? 1;
  const re = eolAgnostic(cse.from);
  const found = (original.match(re) || []).length;

  if (found !== want) {
    console.error(
      `HARNESS FAILURE [${cse.name}]: anchor found ${found}× in ${cse.file}, expected ${want}`,
    );
    harnessErrors++;
    continue;
  }

  const eol = dominantEol(original);
  const replacement = cse.to.replace(/\n/g, eol);
  writeFileSync(path, original.replace(eolAgnostic(cse.from), replacement), "utf8");

  const mutatedBytes = readFileSync(path);
  if (Buffer.compare(originalBytes, mutatedBytes) === 0) {
    // The exact failure mode this harness is written to catch.
    console.error(`HARNESS FAILURE [${cse.name}]: the file's bytes did not change`);
    harnessErrors++;
    writeFileSync(path, originalBytes);
    continue;
  }

  const res = run(cse.testFile);

  writeFileSync(path, originalBytes);
  const restored = readFileSync(path);
  if (Buffer.compare(originalBytes, restored) !== 0) {
    console.error(`HARNESS FAILURE [${cse.name}]: ${cse.file} was not restored byte-for-byte`);
    harnessErrors++;
  }

  if (res.failed) {
    console.log(`RED   ✔  ${cse.name}`);
  } else {
    console.error(`GREEN ✖  ${cse.name}  ← the guard did NOT catch this`);
    notRed++;
  }
}

console.log(
  `\n${CASES.length} mutations · ${CASES.length - notRed} went red · ` +
    `${notRed} did not · ${harnessErrors} harness failure(s)`,
);
process.exit(notRed > 0 || harnessErrors > 0 ? 1 : 0);

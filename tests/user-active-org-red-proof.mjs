// ---------------------------------------------------------------------------
// user-active-org-red-proof.mjs — proves tests/user-active-org.test.mjs really
// FAILS when BUG-2026-08-13-097 (global active organisation) is put back.
//
// Not a `.test.mjs`: it mutates source files on disk, so it must never run as
// part of `npm test`. Run it by hand:
//
//     node tests/user-active-org-red-proof.mjs
//
// Same discipline as security-posture-red-proof.mjs, which this is modelled on:
//
//   • every anchor matches through a regex where each newline is `\r?\n`, and
//     is written back with the FILE'S OWN dominant line ending. These files are
//     CRLF; a literal `\n` anchor matches nothing while looking perfectly
//     reasonable, and that exact failure has produced a false all-clear three
//     times this week;
//   • the expected occurrence count is asserted BEFORE replacing;
//   • the file's BYTES ON DISK are compared before/after the write, and again
//     after restoring. A mutation that changed nothing is a HARNESS FAILURE,
//     never a passing test.
//
// One thing this adds over the older harness: each case names the SPECIFIC
// test that must go red. "the file failed" is not proof that the assertion you
// care about is the one doing the work — another test in the same file failing
// would read identically.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROUTE = "src/api/routes/organisations.ts";
const TEST = "tests/user-active-org.test.mjs";

/**
 * Each case reintroduces ONE facet of the bug.
 * `expect` = substrings of the test names that MUST appear as failures.
 */
const CASES = [
  {
    name: "the original bug: write the singleton instead of the user's row",
    from:
      '      .prepare("UPDATE users SET active_org_id = ? WHERE id = ?")\n' +
      "      .bind(body.orgId, actorId)",
    to:
      '      .prepare("UPDATE inter_company_config SET active_org_id = ? WHERE id = 1")\n' +
      "      .bind(body.orgId)",
    expect: [
      "one user switching company does NOT move another user's switcher",
      "the switch writes users, and NEVER the inter_company_config singleton",
      "no route writes inter_company_config.active_org_id any more",
    ],
  },
  {
    name: "GET ignores the user's own pick and reads only the global row",
    from: "    userPick,\n    cfg?.activeOrgId ?? null,",
    to: "    null,\n    cfg?.activeOrgId ?? null,",
    expect: [
      "two users reading the SAME database get their OWN active organisation",
      "the response shape is unchanged for BOTH projections",
    ],
  },
  {
    name: "the switch is persisted against a fixed user, not the caller",
    from: "      .bind(body.orgId, actorId)",
    to: '      .bind(body.orgId, "user-b")',
    expect: [
      "one user switching company does NOT move another user's switcher",
      "the switch writes users, and NEVER the inter_company_config singleton",
    ],
  },
  {
    name: "drop the legacy fallback (every mid-session user snaps to org #1 on deploy)",
    from: "  if (legacyGlobal && visible.has(legacyGlobal)) return legacyGlobal;",
    to: "  void legacyGlobal;",
    expect: [
      "a user who has never switched still sees the legacy global value",
      "a user with no row at all still gets a usable active org",
      "GET degrades to the legacy value when the column has not been self-applied yet",
      "a pick pointing at a company this caller cannot see is not used",
    ],
  },
  {
    name: "trust a stale/foreign pick without checking it is visible",
    from: "  if (userPick && visible.has(userPick)) return userPick;",
    to: "  if (userPick) return userPick;",
    expect: ["a pick pointing at a company this caller cannot see is not used"],
  },
  {
    name: "let the per-user read reject (drops the whole GET into FALLBACK_ORGS)",
    from:
      "    return row?.activeOrgId ?? row?.active_org_id ?? null;\n" +
      "  } catch {\n    return null;\n  }",
    to:
      "    return row?.activeOrgId ?? row?.active_org_id ?? null;\n" +
      "  } catch (e) {\n    throw e;\n  }",
    expect: [
      "GET degrades to the legacy value when the column has not been self-applied yet",
    ],
  },
  {
    name: "stop awaiting the self-apply (migrations are inert — the column never lands)",
    from: "    await ensureUserActiveOrgColumn(c.var.DB);",
    to: "    void ensureUserActiveOrgColumn;",
    expect: [
      "the column is self-applied BEFORE the first write, not only in a migration",
    ],
  },
  {
    name: "report a switch that was never stored (no user context)",
    from:
      '      return c.json({ error: "No user context for the active organisation" }, 401);',
    to: "      return c.json({ activeOrgId: body.orgId, organisation: rowToOrg(org) });",
    expect: ["a caller with a role but no user identity cannot silently 'switch'"],
  },
  {
    name: "the switcher stops scoping its lookup to the caller's tenant",
    from: "      .bind(body.orgId, tenantId)",
    to: '      .bind(body.orgId, "tenant-b")',
    expect: ["PUT / still refuses to switch to another tenant's organisation"],
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
    execFileSync(process.execPath, ["--import", "tsx/esm", "--test", testFile], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return { failed: false, out: "" };
  } catch (e) {
    return { failed: true, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

/** Test names reported as failing, read out of the runner's summary block. */
function failedTestNames(out) {
  const names = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(?:✖|not ok \d+ -)\s*(.+?)(?:\s+\([\d.]+ms\))?\s*$/.exec(line);
    if (m) names.add(m[1].trim());
  }
  return names;
}

let harnessErrors = 0;
let notRed = 0;

const path = resolve(process.cwd(), ROUTE);

// Sanity: the suite must be GREEN before anything is mutated, or "it went red"
// proves nothing at all.
{
  const base = run(TEST);
  if (base.failed) {
    console.error(`HARNESS FAILURE: ${TEST} is already failing before any mutation`);
    console.error(base.out.slice(-2000));
    harnessErrors++;
  }
}

for (const cse of CASES) {
  const originalBytes = readFileSync(path);
  const original = originalBytes.toString("utf8");
  const want = cse.count ?? 1;
  const found = (original.match(eolAgnostic(cse.from)) || []).length;

  if (found !== want) {
    console.error(
      `HARNESS FAILURE [${cse.name}]: anchor found ${found}x in ${ROUTE}, expected ${want}`,
    );
    harnessErrors++;
    continue;
  }

  const eol = dominantEol(original);
  const replacement = cse.to.replace(/\n/g, eol);
  writeFileSync(path, original.replace(eolAgnostic(cse.from), replacement), "utf8");

  const mutatedBytes = readFileSync(path);
  if (Buffer.compare(originalBytes, mutatedBytes) === 0) {
    // The exact failure mode this harness exists to catch.
    console.error(`HARNESS FAILURE [${cse.name}]: the file's bytes did not change`);
    harnessErrors++;
    writeFileSync(path, originalBytes);
    continue;
  }

  const res = run(TEST);

  writeFileSync(path, originalBytes);
  if (Buffer.compare(originalBytes, readFileSync(path)) !== 0) {
    console.error(`HARNESS FAILURE [${cse.name}]: ${ROUTE} was not restored byte-for-byte`);
    harnessErrors++;
  }

  if (!res.failed) {
    console.error(`GREEN x  ${cse.name}  <- the guard did NOT catch this`);
    notRed++;
    continue;
  }

  const failed = failedTestNames(res.out);
  const missed = cse.expect.filter((n) => ![...failed].some((f) => f.includes(n)));
  if (missed.length > 0) {
    console.error(
      `WRONG x  ${cse.name}\n         the file failed, but NOT via:\n` +
        missed.map((m) => `           - ${m}`).join("\n") +
        `\n         actually failed: ${[...failed].join(" | ") || "(none parsed)"}`,
    );
    notRed++;
    continue;
  }
  console.log(`RED   ok  ${cse.name}  (${cse.expect.length} named test(s))`);
}

console.log(
  `\n${CASES.length} mutations - ${CASES.length - notRed} went red via the named test(s) - ` +
    `${notRed} did not - ${harnessErrors} harness failure(s)`,
);
process.exit(notRed > 0 || harnessErrors > 0 ? 1 : 0);

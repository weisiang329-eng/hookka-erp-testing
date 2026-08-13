// ---------------------------------------------------------------------------
// record-load-failure-class.test.mjs — class C15: a record that could not be
// LOADED reported as a record that does not EXIST.
//
// BUG-2026-08-13-016 / audit finding D3. `api-client.ts` aborts every `/api/*`
// call at 30 s; `cached-fetch.ts` swallowed the abort with no error set, so a
// consumer was handed `data = null, loading = false, error = null` — byte-for-
// byte the state a successful "there is nothing here" produces. Eleven screens
// printed "…not found", four hung on "Loading…", and one QR page headlined
// "Unit not found" at a delivery.
//
// This file is the ENUMERATION that keeps the class from being fixed a second
// and third time (see BUG-CLASSES.md's opening table — three classes here have
// each been "fixed" three times because each pass repaired one instance).
//
// Part 1 pins the PRIMITIVE: the hook must not swallow an abort, and the
//        classifier must exist and be used.
// Part 2 pins every KNOWN consumer, each with the guard it uses.
// Part 3 is the GROWTH guard: any file that reads through the cache layer and
//        prints "…not found" must be in the map, or the test fails. A new page
//        cannot join the class silently.
//
// Behaviour (as opposed to source shape) is proved in
// tests/cached-fetch-result.test.mjs, which runs the real fetch wrapper for all
// three outcomes.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Part 1 — the primitive
// ---------------------------------------------------------------------------

test("useCachedJson does NOT swallow an abort — the bug's exact line is gone", () => {
  const src = read("src/lib/cached-fetch.ts");
  assert.ok(
    !/if \(isAbortError\(err\)\) return;/.test(src),
    "the swallowed-abort `if (isAbortError(err)) return;` is the bug itself " +
      "(BUG-2026-08-13-016). An abort that reaches a consumer which did not " +
      "cancel is the 30 s timeout, and it must set a failure.",
  );
  assert.ok(
    /classifyFetchFailure\(err\)/.test(src),
    "the hook's catch must classify, not discard",
  );
  assert.ok(
    /return \{ data, loading, error, failure, refresh \}/.test(src),
    "the hook must expose `failure` so consumers can tell absence from silence",
  );
});

test("cancellation stays silent — an unmounting consumer is not an error", () => {
  const src = read("src/lib/cached-fetch.ts");
  // The `cancelled` early-return must still be the FIRST thing in the catch:
  // making unmount/URL-change noisy would be a new bug.
  const catchBody = src.slice(src.indexOf(".catch((err) => {"));
  const guard = catchBody.indexOf("if (cancelled) return;");
  const classify = catchBody.indexOf("classifyFetchFailure(err)");
  assert.ok(guard > -1, "the cancelled guard must survive");
  assert.ok(
    guard < classify,
    "cancellation must be checked BEFORE classifying, or an unmount would " +
      "raise an error the user never caused",
  );
});

test("only a 404 licenses the words 'not found'", () => {
  const src = read("src/lib/cached-fetch.ts");
  assert.match(
    src,
    /return failure != null && failure\.kind !== "notFound";/,
    "isUnknownOutcome is the single decision every consumer rests on",
  );
  assert.match(
    src,
    /status === 404[\s\S]{0,120}kind: "notFound"/,
    "notFound must be derived from the HTTP status, never guessed",
  );
});

test("the 30 s cap itself is untouched — this is about honesty, not masking", () => {
  const src = read("src/lib/api-client.ts");
  assert.match(
    src,
    /const API_TIMEOUT_MS = 30_000;/,
    "weakening or removing the cap would trade a lie for a hang",
  );
});

// ---------------------------------------------------------------------------
// Part 2 — every consumer in the class, and how each one tells the two apart.
//
// `guard` is the token that must appear in the file. Two shapes are legitimate:
//   "isUnknownOutcome"  — the explicit guard + a RecordLoadError card
//   "hook-error-gate"   — the file already gated its "not found" branch on the
//                         hook's `error`, which is now SET on a timeout, so the
//                         branch became unreachable on failure the moment the
//                         primitive was fixed. Listed, not exempt: the reason
//                         is written down and the file is still tracked.
// ---------------------------------------------------------------------------
const CONSUMERS = [
  // --- printed a false absence -------------------------------------------
  ["src/pages/sales/detail.tsx", "isUnknownOutcome", '"Order not found"'],
  ["src/pages/sales/edit.tsx", "isUnknownOutcome", "eternal Loading + Order not found"],
  ["src/pages/consignment/detail.tsx", "isUnknownOutcome", '"Order not found"'],
  ["src/pages/consignment/edit.tsx", "isUnknownOutcome", "eternal Loading"],
  ["src/pages/delivery/detail.tsx", "isUnknownOutcome", '"Delivery order not found"'],
  ["src/pages/delivery-returns/detail.tsx", "isUnknownOutcome", '"Delivery return not found."'],
  ["src/pages/invoices/detail.tsx", "isUnknownOutcome", '"Invoice not found"'],
  ["src/pages/procurement/detail.tsx", "isUnknownOutcome", '"Purchase order not found."'],
  ["src/pages/procurement/grn-detail.tsx", "isUnknownOutcome", '"GRN not found."'],
  ["src/pages/procurement/PurchaseInvoiceDetail.tsx", "isUnknownOutcome", '"Purchase invoice not found."'],
  ["src/pages/suppliers/detail.tsx", "isUnknownOutcome", '"Supplier not found."'],
  ["src/pages/rd/detail.tsx", "isUnknownOutcome", '"Project not found."'],
  ["src/pages/products/bom.tsx", "isUnknownOutcome", '"Product not found" (cachedFetchJson path)'],
  ["src/pages/products/documents.tsx", "isUnknownOutcome", '"Product not found." (cachedFetchJson path)'],
  ["src/pages/track/index.tsx", "fetchFailure", 'public QR page headlined "Unit not found"'],
  // --- hung on Loading, never said anything -------------------------------
  ["src/pages/service-cases/detail.tsx", "isUnknownOutcome", "eternal Loading…"],
  ["src/pages/service-orders/detail.tsx", "isUnknownOutcome", "eternal Loading…"],
  ["src/pages/m/screens/LineItemDetailScreen.tsx", "failure", '"Line item not found."'],
  // --- asserted an empty child set ----------------------------------------
  ["src/components/ui/document-chain-map.tsx", "failure", '"No job cards on this production order yet."'],
  // --- already gated on the hook's error; correct the moment the primitive
  //     stopped swallowing the abort. Tracked, not exempt.
  ["src/pages/m/screens/SalesDetailScreen.tsx", "hook-error-gate", '"Order not found."'],
  ["src/pages/m/screens/ProductionDetailScreen.tsx", "hook-error-gate", '"Production order not found."'],
  ["src/pages/m/screens/MailCenterScreen.tsx", "hook-error-gate", '"Thread not found."'],
  ["src/pages/m/screens/DocumentDetailScreen.tsx", "hook-error-gate", '"Document not found."'],
  ["src/pages/mail-center/detail.tsx", "hook-error-gate", '"Thread not found."'],
  ["src/pages/mail-center/index.tsx", "hook-error-gate", '"Email not found."'],
];

for (const [file, guard, symptom] of CONSUMERS) {
  test(`${file} distinguishes failure from absence (${symptom})`, () => {
    const src = read(file);
    if (guard === "hook-error-gate") {
      // The "not found" line must sit behind a check on the hook's error.
      assert.ok(
        /!error\b|\berror\s*&&|\berror\s*\n?\s*\?/.test(src),
        `${file}: its "not found" branch must be gated on the hook's error, ` +
          `which is now set on a 30 s timeout`,
      );
      assert.ok(
        /useCachedJson/.test(src),
        `${file}: must still read through the hook that classifies failures`,
      );
    } else if (guard === "isUnknownOutcome") {
      // Importing the guard is not using it. Require the CALL to sit in a
      // condition that renders the honest card — an earlier draft of this
      // test only looked for the identifier, and passed happily while the
      // guard had been short-circuited out of the branch.
      assert.match(
        src,
        /if \([\s\S]{0,160}isUnknownOutcome\([\s\S]{0,400}?<RecordLoadError/,
        `${file}: \`isUnknownOutcome(...)\` must GATE the RecordLoadError ` +
          `branch, not merely be imported`,
      );
    } else {
      // The remaining shapes render their own copy; require the failure to be
      // read in a condition rather than just mentioned.
      assert.match(
        src,
        new RegExp(`\\b${guard}\\b\\s*(\\)|\\?|&&)`),
        `${file}: \`${guard}\` must be tested in a condition — the record's ` +
          `existence is unknown unless the server answered 404`,
      );
    }
  });
}

test("every RecordLoadError call site says which record, and offers a retry", () => {
  for (const [file, guard] of CONSUMERS) {
    if (guard !== "isUnknownOutcome") continue;
    const src = read(file);
    assert.ok(
      src.includes("<RecordLoadError"),
      `${file}: the honest branch must render the shared card`,
    );
    assert.ok(
      /subject=/.test(src) && /onRetry=/.test(src),
      `${file}: RecordLoadError needs a subject and a retry`,
    );
  }
});

test("the shared card never asserts non-existence", () => {
  const src = read("src/components/ui/record-load-error.tsx");
  assert.match(
    src,
    /is not a\s*\n?\s*statement that the \{subject\} does not exist/,
    "the sentence that makes the card honest must stay",
  );
  assert.match(src, /Retry/, "the operator needs a way forward");
});

// ---------------------------------------------------------------------------
// Part 3 — growth guard. A NEW page cannot join this class silently.
// ---------------------------------------------------------------------------

// Files that mention "not found" but are NOT in the class, with the reason.
const NOT_IN_CLASS = new Map([
  ["src/lib/cached-fetch.ts", "the primitive itself"],
  ["src/components/ui/record-load-error.tsx", "the fix"],
  ["src/pages/employees.tsx", "prose in a help string, not a load state"],
  ["src/pages/admin/health.tsx", "an HTTP-status legend table"],
  ["src/pages/procurement/index.tsx", "a toast for a deep-link param, not a page gate"],
  ["src/pages/m/config/modules.ts", "a comment explaining a dead-end that was removed"],
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("no page prints '…not found' over a cached read without being in the map", () => {
  const known = new Set(CONSUMERS.map(([f]) => f));
  const strays = [];
  for (const rel of walk("src")) {
    // Server code is out of scope, and cannot be otherwise: useCachedJson /
    // cachedFetchJson are BROWSER primitives (src/lib/cached-fetch.ts reads
    // window.localStorage), so no route handler can call one. A route's
    // `{ success: false, error: "Order not found" }` IS a genuine 404 — it is
    // the honest answer this whole class exists to restore, not an instance of
    // the bug. Without this skip the scan matches any route file that merely
    // NAMES the hook in a comment, which is a false positive of exactly the
    // kind HOOKKA-GOTCHAS §1 warns about (a grep for a symbol is not a call
    // site). Frontend coverage is unchanged — every real consumer is under
    // src/pages or src/components.
    if (rel.startsWith("src/api/")) continue;
    const src = read(rel);
    if (!/useCachedJson|cachedFetchJson/.test(src)) continue;
    if (!/not found/i.test(src)) continue;
    if (known.has(rel) || NOT_IN_CLASS.has(rel)) continue;
    strays.push(rel);
  }
  assert.deepEqual(
    strays,
    [],
    "These files read through the cache layer AND print '…not found'. Each " +
      "one must either guard on isUnknownOutcome / the hook's error and be " +
      "added to CONSUMERS, or be listed in NOT_IN_CLASS with a reason. " +
      "Fixing only the instance in front of you is how this repo produced " +
      "four thrice-fixed bug classes.",
  );
});

test("no consumer in the class has quietly gone back to ignoring the failure", () => {
  for (const [file, guard] of CONSUMERS) {
    const src = read(file);
    assert.ok(
      /useCachedJson|cachedFetchJsonResult/.test(src),
      `${file}: must read through a primitive that reports failures — ` +
        `cachedFetchJson (plain) returns null on failure and cannot`,
    );
    if (guard === "isUnknownOutcome") {
      assert.ok(
        !/\bcachedFetchJson</.test(src),
        `${file}: cachedFetchJson<> collapses failure into null — use ` +
          `cachedFetchJsonResult or the hook`,
      );
    }
  }
});

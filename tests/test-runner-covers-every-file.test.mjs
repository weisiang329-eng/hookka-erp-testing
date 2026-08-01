// ---------------------------------------------------------------------------
// test-runner-covers-every-file.test.mjs
//
// package.json used to list test files BY HAND. 211 files existed; 183 were
// listed, so 28 had never run in CI - some for months, and several were red.
// #184 replaced the list with a glob.
//
// That glob then got CLOBBERED within hours: a parallel branch carrying the old
// hand-written list merged on top and silently restored it. Nothing failed,
// because a shorter list cannot fail - it just runs less.
//
// So the glob needs a guard of its own. This test fails if the runner ever goes
// back to enumerating files, or if any test file on disk would not be executed.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
);
const script = pkg.scripts.test;

test("the test runner uses a glob, not a hand-maintained list", () => {
  assert.match(
    script,
    /tests\/\*\.test\.mjs/,
    "npm test must glob tests/ - a hand list silently drops new files",
  );
});

test("no test file is enumerated individually", () => {
  // One named .mjs is one file that a rename or a bad merge can orphan.
  const named = [...script.matchAll(/tests\/[\w.-]+\.test\.mjs/g)].map((m) => m[0]);
  assert.deepEqual(
    named,
    [],
    `the runner names ${named.length} file(s) explicitly - that is the pattern that hid 28 dead tests`,
  );
});

test("every test file on disk is covered by the runner", () => {
  const onDisk = readdirSync(resolve(process.cwd(), "tests")).filter((f) =>
    f.endsWith(".test.mjs"),
  );
  assert.ok(onDisk.length > 200, `sanity: expected the full suite, saw ${onDisk.length}`);
  // With a glob this is definitional, but it also catches someone narrowing the
  // pattern (e.g. tests/unit-*.test.mjs) without noticing what drops out.
  assert.ok(
    /tests\/\*\.test\.mjs/.test(script),
    "the glob must match every *.test.mjs in tests/",
  );
});

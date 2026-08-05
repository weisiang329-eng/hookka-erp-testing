// ---------------------------------------------------------------------------
// No script may carry a database password as a literal.
//
// Until 2026-08-05 all 110 scripts under scripts/ did. Moving them to
// scripts/_db.mjs does NOT make the old password safe — it is in git history
// and stays there; rotating it in Supabase is the actual fix. What this test
// buys is that the next script does not quietly put a fresh one back, so the
// rotation is not undone a week later by a copy-paste.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|ts|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

// A connection string with an actual password in it. The placeholder forms used
// in help text (`<password>`, `...`) are deliberately not matched — the point
// is a real secret, not the shape of a URL.
const WITH_PASSWORD = /postgres(?:ql)?:\/\/[A-Za-z0-9_.-]+:(?!<|\.\.\.|\$)[^@\s'"`]{6,}@/;

test("no script hard-codes a database password", () => {
  const root = resolve(process.cwd(), "scripts");
  const offenders = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (WITH_PASSWORD.test(line)) {
        offenders.push(`${file.slice(root.length - 7)}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these carry a live connection string — import prodUrl()/stagingUrl() from scripts/_db.mjs instead:\n  ${offenders.join("\n  ")}`,
  );
});

test("the helper refuses to guess rather than defaulting", () => {
  // A script that silently opened the WRONG database would be worse than one
  // that will not start — several of these write.
  const src = readFileSync(resolve(process.cwd(), "scripts/_db.mjs"), "utf8");
  assert.match(src, /process\.exit\(1\)/);
  assert.doesNotMatch(src, /\?\?\s*["']postgres/, "no fallback default may be reintroduced");
});

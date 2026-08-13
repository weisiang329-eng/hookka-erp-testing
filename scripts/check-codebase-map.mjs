#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-codebase-map — verify the map actually points where it says.
//
// WHY THIS EXISTS
// Nobody reads 500k lines. 805 files / 511k lines / 2.35M words is ~6,000 A4
// pages; a competent engineer needs 6-12 months to hold it all, and no one has
// ever read it linearly. So the map is not a convenience — it IS the mental
// model every future reader starts from. A wrong pointer in it is worse than a
// missing one: a gap makes someone look, a wrong line number makes them
// confident. That is the mechanism behind "ask the same question three times,
// get three different answers".
//
// Measured 2026-08-13: of the last 60 commits, 35 touched src/ and 20 of those
// (57%) never touched the map. `docs/SYMBOLS.md` had already decayed to ~75%
// wrong file:line before it was retired. Prose review cannot catch this —
// nobody re-checks 361 references by hand.
//
// WHAT IT CHECKS
//   1. PATHS    every `path/to/file.ts` the map names still exists
//   2. LINES    every `file.ts:123` is inside the file
//   3. ANCHORS  when the map names a symbol next to a line ref, that symbol is
//               actually defined near that line (the check with real teeth —
//               a path can survive while the line drifts 400 lines away)
//   4. COVERAGE every route/page module is mentioned somewhere in the map
//
// Deliberately NOT checked: `~L2449` refs. The tilde means "approximately" —
// the author already flagged them as drifting, and holding an explicit
// approximation to an exact standard would train people to delete the hint
// rather than keep it honest.
//
// USAGE
//   node scripts/check-codebase-map.mjs           # fail on broken refs
//   node scripts/check-codebase-map.mjs --fix     # rewrite drifted line refs
//   node scripts/check-codebase-map.mjs --coverage
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MAP = "docs/CODEBASE-MAP.md";
const ANCHOR_SLACK = 12; // a symbol may sit a few lines off its ref and still be findable

const args = process.argv.slice(2);
const doFix = args.includes("--fix");
const coverageOnly = args.includes("--coverage");

const src = readFileSync(MAP, "utf8");
const lines = src.split(/\r?\n/);

const fileCache = new Map();
const readLines = (p) => {
  if (!fileCache.has(p)) {
    try {
      fileCache.set(p, readFileSync(p, "utf8").split(/\r?\n/));
    } catch {
      fileCache.set(p, null);
    }
  }
  return fileCache.get(p);
};

let failed = false;
const problems = { paths: [], lines: [], anchors: [], coverage: [] };

const walkAll = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
};
const allFiles = [...walkAll("src"), ...walkAll("tests"), ...walkAll("scripts"), ...walkAll("migrations")];

// A ref looks like `src/api/routes/x.ts:945` or bare `src/pages/y.tsx`.
// Struck-through entries (~~`path`~~) document DELETED files on purpose — a
// tombstone is information, not rot, so a missing file there is expected.
const REF_RE = /`([a-zA-Z0-9/._-]+\.(?:ts|tsx|mjs|json))(?::(\d+))?`/g;

const fixes = [];

const TOMBSTONE_WORDS = /\b(deleted|struck through|removed|retired|no longer exists)\b/i;

// The contiguous run of non-blank lines containing `li`. Markdown table rows are
// their own paragraph in practice (each row is one line), so this widens scope
// only for wrapped prose — which is exactly where the false positives were.
const paragraphCache = new Map();
function paragraphOf(li) {
  if (paragraphCache.has(li)) return paragraphCache.get(li);
  let a = li;
  let b = li;
  while (a > 0 && lines[a - 1].trim() !== "") a--;
  while (b < lines.length - 1 && lines[b + 1].trim() !== "") b++;
  const text = lines.slice(a, b + 1).join("\n");
  for (let i = a; i <= b; i++) paragraphCache.set(i, text);
  return text;
}

lines.forEach((line, li) => {
  // A map line may legitimately name a file that is GONE — that is a tombstone,
  // and tombstones are the most valuable rows in the map: they stop the next
  // reader hunting for a page that was deleted on purpose. Two forms count:
  // strikethrough (~~`path`~~) and plain prose ("was deleted 2026-08-13").
  // Demanding those files exist would delete the institutional memory.
  //
  // Scope is the PARAGRAPH, not the line: the map's prose wraps, so "struck
  // through below:" can sit on one line while the paths it refers to sit on the
  // next two. Judging line-by-line reads those continuations as fresh claims.
  const tombstone = /~~`/.test(line) || TOMBSTONE_WORDS.test(paragraphOf(li));
  for (const m of line.matchAll(REF_RE)) {
    const [, path, lineNoRaw] = m;
    // The map writes references at whatever depth reads well in prose:
    // `purchase-invoices.ts:945`, `consignment/note.tsx`, `src/pages/x.tsx`.
    // All three are legitimate; resolve the short forms before judging them,
    // or the checker invents failures the map never had.
    let p = path;
    if (!existsSync(p)) {
      const hits = allFiles.filter((f) => f === p || f.endsWith("/" + p));
      if (hits.length === 1) {
        p = hits[0];
      } else if (hits.length > 1) {
        // `index.tsx`, `_helpers.ts`, `detail.tsx` — the map uses these as prose
        // shorthand inside a row that already names its module. They are not
        // navigable references, and guessing which one is meant would invent
        // failures. Only a line number makes such a ref checkable.
        if (!lineNoRaw) continue;
        problems.paths.push(
          `${MAP}:${li + 1}  →  \`${p}:${lineNoRaw}\` is ambiguous (${hits.length} files match); write the full path so the line number can be checked`,
        );
        continue;
      } else {
        if (!tombstone) problems.paths.push(`${MAP}:${li + 1}  →  ${p} (does not exist)`);
        continue;
      }
    }

    const content = readLines(p);
    if (!content) {
      if (!tombstone) problems.paths.push(`${MAP}:${li + 1}  →  ${p} (does not exist)`);
      continue;
    }
    if (!lineNoRaw) continue;

    const want = Number(lineNoRaw);
    if (want > content.length) {
      problems.lines.push(`${MAP}:${li + 1}  →  ${p}:${want} but file has ${content.length} lines`);
      continue;
    }

    // ANCHORS: the symbol named immediately before the ref on this line.
    const before = line.slice(0, m.index);
    const sym = [...before.matchAll(/`([A-Za-z_$][\w$]*)`/g)].pop()?.[1];
    // Not every backticked word before a ref is a symbol. Commit SHAs
    // (`b3b42b6c`) and SQL keywords (`LIMIT`) sit there too, and demanding they
    // be "defined at" a line produces noise that buries the real drift.
    const notASymbol =
      !sym ||
      /^[0-9a-f]{7,40}$/.test(sym) ||
      /^[A-Z_]+$/.test(sym) ||
      sym.length < 4;
    if (notASymbol) continue;

    const at = content[want - 1] ?? "";
    if (at.includes(sym)) continue;

    const near = content
      .slice(Math.max(0, want - 1 - ANCHOR_SLACK), want - 1 + ANCHOR_SLACK)
      .some((l) => l.includes(sym));
    if (near) continue;

    // Symbol is nowhere near. Where does it actually live?
    const defRe = new RegExp(
      `(?:function|const|let|class|export|async)\\s+.*\\b${sym}\\b|\\b${sym}\\s*[:=]\\s*(?:async\\s*)?\\(`,
    );
    const realIdx = content.findIndex((l) => defRe.test(l));
    const real = realIdx >= 0 ? realIdx + 1 : null;

    problems.anchors.push(
      `${MAP}:${li + 1}  →  ${p}:${want} claims \`${sym}\`` +
        (real ? `, but it is defined at :${real} (drift ${Math.abs(real - want)})` : `, which is not in that file at all`),
    );
    if (real) fixes.push({ mapLine: li, from: `${path}:${want}`, to: `${path}:${real}` });
  }
});

// ---- COVERAGE ------------------------------------------------------------
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
};

const modules = [...walk("src/api/routes"), ...walk("src/pages")];
const BIG = 400; // only demand a map entry for modules big enough to get lost in
for (const p of modules) {
  if (src.includes(p)) continue;
  const n = readLines(p)?.length ?? 0;
  if (n >= BIG) problems.coverage.push(`${p} (${n} lines) — never mentioned in the map`);
}

// ---- FIX -----------------------------------------------------------------
if (doFix && fixes.length) {
  let out = lines.slice();
  for (const f of fixes) out[f.mapLine] = out[f.mapLine].split(f.from).join(f.to);
  writeFileSync(MAP, out.join("\n"));
  console.log(`--fix: rewrote ${fixes.length} drifted line ref(s). Re-run to confirm.`);
  process.exit(0);
}

// ---- REPORT --------------------------------------------------------------
const report = (title, arr, fatal = true, limit = 30) => {
  if (!arr.length) return;
  if (fatal) failed = true;
  console.log(`\n${fatal ? "FAIL" : "advisory"} — ${title}: ${arr.length}`);
  arr.slice(0, limit).forEach((x) => console.log(`  ${x}`));
  if (arr.length > limit) console.log(`  … and ${arr.length - limit} more`);
};

if (!coverageOnly) {
  report("map points at files that do not exist", problems.paths);
  report("line refs past end of file", problems.lines);
  report("line refs whose named symbol has moved", problems.anchors);
}
report("large modules missing from the map", problems.coverage, false);

console.log(
  failed
    ? `\ncheck-codebase-map: FAIL — run with --fix to rewrite drifted line refs, then re-read the surrounding claim (a moved symbol often means the CLAIM changed too, not just the number).\n`
    : "\ncheck-codebase-map: OK\n",
);
process.exit(failed ? 1 : 0);

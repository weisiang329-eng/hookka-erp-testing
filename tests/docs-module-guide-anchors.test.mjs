// ---------------------------------------------------------------------------
// docs-module-guide-anchors.test.mjs — the 15 module guides' `file:line`
// anchors are gated, because the guides' own instruction depends on them.
//
// WHY THIS EXISTS
// Every `docs/modules/*.md` opens with the same line:
//
//     "Never grep the whole repo — use the file:line below."
//
// That instruction is only safe while the offsets are right. `grep` is banned
// on this repo because it times out on 2,122 files, so a reader who follows the
// guide has NO cheap way to notice that an anchor now lands 200 lines away from
// the thing it names. A wrong anchor is therefore worse here than in an
// ordinary doc: the doc has removed the reader's fallback.
//
// The anchors rot on ordinary commits — inserting 40 lines near the top of a
// route file silently moves every anchor below it — and nothing caught it:
//   · `scripts/check-codebase-map.mjs` only reads `docs/CODEBASE-MAP.md`
//   · `tests/docs-required-reading-truth.test.mjs` (2026-08-14) added the five
//     required-reading docs, but not the 15 module guides
//
// The second prose-audit pass (2026-08-14, `docs/DOCS-VS-CODE-AUDIT.md` Part 3)
// measured the damage across all fifteen guides at once and found the drift was
// not occasional but systemic — including anchors that had moved while the
// guide was being restamped `Last verified` the same day. That is the shape
// this file exists to make impossible: a FRESH stamp on a WRONG pointer.
//
// The audit's open question J8 asked whether to re-derive these on a schedule
// or stop hand-carrying them at all. This is the third answer: keep them, and
// let CI hold them to the source, so they cannot rot silently between passes.
//
// WHAT IT CHECKS
// Every row of a guide's "Key functions / sections" table that carries a repo
// path with a `:LINE` must name something the source actually has within
// ±WINDOW lines of that offset — either the identifier, or, for a row naming an
// HTTP handler, that handler's own registration.
//
// EOL NOTE: these are CRLF files on this machine. Every read is normalised
// before matching — a literal "\n" anchor against CRLF bytes matches NOTHING
// and has produced five false all-clears this week.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// How far an anchor may sit from the thing it names. Anchors are hand-written
// and a few lines of slack is normal and harmless; 200 lines is not, and that
// is the failure this catches.
const WINDOW = 8;

const GUIDES = readdirSync(join(ROOT, "docs/modules"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `docs/modules/${f}`)
  .sort();

const SRC_RE = /((?:src|tests|scripts|functions)\/[A-Za-z0-9_.\-/]+\.(?:tsx|ts|mjs|js))/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const srcCache = new Map();
function srcLines(rel) {
  if (!srcCache.has(rel)) {
    srcCache.set(rel, existsSync(join(ROOT, rel)) ? read(rel).split("\n") : null);
  }
  return srcCache.get(rel);
}

// A symbol cell is one of:
//   `foo`                        → identifier
//   `foo` / `bar`                → two identifiers (paired with two offsets)
//   `app.post("/:id/confirm")`   → route registration
//   `GET /compliance.json`       → route registration, bare form
//   `POST /clock` / `POST /x`    → two route registrations
function parseSymbol(raw) {
  const s = raw.trim();
  let m = s.match(/app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]*)["'`]/i);
  if (m) return { kind: "route", method: m[1].toLowerCase(), path: m[2] };
  m = s.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/);
  if (m) return { kind: "route", method: m[1].toLowerCase(), path: m[2] };
  const id = s.replace(/\(.*$/, "").replace(/[^A-Za-z0-9_$]/g, "");
  return id.length > 2 ? { kind: "id", name: id } : null;
}

function matches(sym, window) {
  if (sym.kind === "route") {
    return new RegExp(
      `\\.${sym.method}\\(\\s*["'\`]${esc(sym.path)}["'\`]`,
    ).test(window);
  }
  // Substring, not word-boundary: the guides use a legitimate shorthand that
  // folds a family into one cell (`exportReportCsv/Xlsx/Pdf` for three
  // functions), and the parts of it are suffixes, not standalone words.
  return window.includes(sym.name);
}

/** Every anchored row of every guide, as {doc, docLine, file, line, symbols}. */
function collectRows() {
  const rows = [];
  for (const doc of GUIDES) {
    read(doc)
      .split("\n")
      .forEach((L, i) => {
        if (!L.startsWith("|")) return;
        const cells = L.split("|").map((c) => c.trim());
        if (cells.length < 4) return;
        const fileM = cells[2].match(SRC_RE);
        if (!fileM) return;
        const offsets = [...cells[2].matchAll(/:(\d+)/g)].map((m) => +m[1]);
        if (!offsets.length) return;
        const raw = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        // `a / b` and `aCsv/Xlsx/Pdf` inside ONE backtick pair are several
        // symbols — but never split a route form, whose path is made of
        // slashes of its own.
        const parts = raw.flatMap((x) =>
          /app\.|^(GET|POST|PUT|PATCH|DELETE)\s/.test(x) ? [x] : x.split("/"),
        );
        const symbols = parts.map(parseSymbol).filter(Boolean);
        if (!symbols.length) return;
        rows.push({ doc, docLine: i + 1, file: fileM[1], offsets, symbols });
      });
  }
  return rows;
}

test("module guides: every anchored table row cites a file that exists", () => {
  const missing = [];
  for (const r of collectRows()) {
    if (!srcLines(r.file)) missing.push(`${r.doc}:${r.docLine} → ${r.file}`);
  }
  assert.deepEqual(
    missing,
    [],
    `module guides cite ${missing.length} path(s) that do not exist:\n  ` +
      missing.join("\n  "),
  );
});

test("module guides: no anchor points past the end of its file", () => {
  const past = [];
  for (const r of collectRows()) {
    const s = srcLines(r.file);
    if (!s) continue;
    for (const ln of r.offsets) {
      if (ln > s.length) past.push(`${r.doc}:${r.docLine} → ${r.file}:${ln} (file has ${s.length})`);
    }
  }
  assert.deepEqual(
    past,
    [],
    `${past.length} module-guide anchor(s) point past end-of-file:\n  ` +
      past.join("\n  "),
  );
});

test(`module guides: every anchor lands within ${WINDOW} lines of the symbol it names`, () => {
  const drifted = [];
  for (const r of collectRows()) {
    const s = srcLines(r.file);
    if (!s) continue;
    r.offsets.forEach((ln, k) => {
      if (ln > s.length) return; // reported by the past-EOF test
      const window = s.slice(Math.max(0, ln - 1 - WINDOW), ln - 1 + WINDOW).join("\n");
      // When the row pairs N symbols with N offsets, hold each to its own.
      const cands =
        r.symbols.length === r.offsets.length ? [r.symbols[k]] : r.symbols;
      if (!cands.some((sym) => matches(sym, window))) {
        const named = cands
          .map((c) => (c.kind === "route" ? `${c.method.toUpperCase()} ${c.path}` : c.name))
          .join(" / ");
        drifted.push(`${r.doc}:${r.docLine} → ${r.file}:${ln} does not name ${named}`);
      }
    });
  }
  assert.deepEqual(
    drifted,
    [],
    `${drifted.length} module-guide anchor(s) have drifted off the symbol they name.\n` +
      `Re-derive the offset from the source and restamp the guide:\n  ` +
      drifted.join("\n  "),
  );
});

// ---------------------------------------------------------------------------
// pcb-not-fabricated.test.mjs — the SOURCE guard for BUG-2026-08-13-121.
//
// C15 in docs/BUG-CLASSES.md: a figure that reads as measured and is not. PCB
// was `pcbOn ? 0 : 0` in `calcStatutory` — the toggle was read and both
// branches returned nothing — and that zero was printed on the office grid, in
// the CSV, on the printed payslip and on the worker's phone, under captions
// that name PCB as a deduction included in net pay.
//
// Nothing at runtime can catch this class: 0 is a valid number and
// `pcbOn ? 0 : 0` is valid TypeScript. Only reading the source catches it,
// which is why every fix in this class ships a structural guard.
//
// Two things are pinned here:
//
//   1. The CALCULATION exists and stays in one place. `calcStatutory` must
//      call `resolvePcb`; nothing may re-hardcode a PCB figure; no second tax
//      engine may grow beside src/lib/pcb.ts.
//   2. Every screen that PRINTS a PCB amount gates it on `pcbHasFigure`, so a
//      zero that was never computed renders "—" rather than "RM 0.00". The
//      site list is enumerated from disk, and a NEW file that formats a PCB
//      figure fails this test until it is added — the growth mechanism the
//      class's sixth corollary says a word-matching guard does not have.
//
// EOL-agnostic on purpose: the working tree is CRLF, and a literal "\n" anchor
// silently matches nothing here.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Read a source file with CRLF normalised away, so every pattern below can be
 *  written with plain "\n" and still match. */
function src(rel) {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------------
// 1. The calculation
// ---------------------------------------------------------------------------

test("calcStatutory no longer returns the same PCB on both branches", () => {
  const s = src("src/api/routes/payslips.ts");
  // The exact shape that shipped, and the shapes it would come back as.
  assert.equal(
    /pcb\s*:\s*pcbOn\s*\?\s*0\s*:\s*0/.test(s),
    false,
    "`pcb: pcbOn ? 0 : 0` is back in calcStatutory",
  );
  // Scoped to calcStatutory's own body: `pcb: 0` is legitimate elsewhere in
  // this file (the YTD reducer seeds its accumulator with it), and a guard
  // that flags a correct line gets muted — which protects nothing.
  const fn = s.slice(s.indexOf("export function calcStatutory"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(body.length > 100, "could not isolate calcStatutory");
  assert.equal(
    /\bpcb\s*:\s*(?:\w+\s*\?\s*)?-?\d+\s*[,}]/.test(body),
    false,
    "a literal PCB figure is being returned from calcStatutory",
  );
});

test("calcStatutory computes PCB through the engine, and the engine gets the real inputs", () => {
  const s = src("src/api/routes/payslips.ts");
  const fn = s.slice(s.indexOf("export function calcStatutory"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(body.length > 100, "could not isolate calcStatutory");
  assert.match(body, /resolvePcb\(/, "calcStatutory must call resolvePcb");
  // The four inputs whose absence would silently change the answer.
  for (const field of [
    "pcbEnabled",
    "currentRemunerationSen",
    "currentEpfSen",
    "ytdPcbSen",
  ]) {
    assert.ok(
      new RegExp(`${field}\\s*:`).test(body),
      `calcStatutory must pass ${field} to resolvePcb`,
    );
  }
  // The per-worker toggle must reach the engine, not be re-implemented here.
  assert.equal(
    /pcbEnabled\s*!==\s*false/.test(body),
    false,
    "the toggle is the engine's decision; re-reading it here is how the two drift apart",
  );
});

test("both payroll paths hand PCB the same remuneration basis and the same year-to-date", () => {
  const s = src("src/api/routes/payslips.ts");
  // `= calcStatutory(` so the declaration itself is not counted as a caller.
  const calls = [...s.matchAll(/=\s*calcStatutory\(/g)];
  assert.equal(calls.length, 2, "expected exactly two callers (projected + generate)");
  // Each call site must supply the context. A call with three arguments would
  // not compile, but a call that quietly passes a zeroed context would — so
  // check the real values are wired.
  // Isolate each call site's argument block and read the basis out of it, so
  // the type declarations and the helper's own field names further up the file
  // cannot be mistaken for call sites.
  const bases = calls.map((m) => {
    const block = s.slice(m.index, s.indexOf("\n    );", m.index) + 7);
    const hit = /(?<![A-Za-z])remunerationSen:\s*([^,\n]+)/.exec(block);
    assert.ok(hit, "a calcStatutory call site does not set remunerationSen");
    return hit[1].trim();
  });
  assert.equal(bases.length, 2);
  assert.equal(
    bases[0],
    bases[1],
    "the estimate and the generated payslip must price PCB off the same basis",
  );
  assert.match(
    bases[0],
    /labor\.payroll\.grossSen/,
    "PCB must be priced off the month's earned pay, not a literal or the raw salary",
  );
  assert.equal(
    /ytdRemunerationSen:\s*ytd\.remunerationSen/.test(s) &&
      /ytdPcbSen:\s*ytd\.pcbSen/.test(s),
    true,
    "the year-to-date figures must come from loadYtdPcbInputs, not from literals",
  );
  assert.equal(
    (s.match(/loadYtdPcbInputs\(/g) ?? []).length,
    3,
    "loadYtdPcbInputs must be defined once and called by both payroll paths",
  );
});

test("a year-to-date read failure refuses instead of restarting the projection at zero", () => {
  const s = src("src/api/routes/payslips.ts");
  const fn = s.slice(s.indexOf("async function loadYtdPcbInputs"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  const c = body.indexOf("} catch");
  assert.ok(c > 0, "the read is wrapped in a try/catch");
  // Scoped to the catch BLOCK, not "everything after it": the function's own
  // successful `return out;` sits further down, and letting it leak in here
  // made the return-check assert against the wrong statement.
  const open = body.indexOf("{", c + 2) + 1;
  const close = body.indexOf("\n  }\n", open);
  assert.ok(close > open, "could not isolate the catch block");
  const caught = body.slice(open, close);
  // The THROW must be the catch's first act. Merely *containing* a `throw`
  // is not enough — this assertion passed happily with the throw sitting
  // behind an `if (0)`, which is the whole failure mode: a swallowed read
  // restarts the year's projection at January and UNDER-withholds silently,
  // with no error anywhere.
  assert.match(
    caught,
    /^\s*(?:\/\/[^\n]*\n\s*)*throw new Error\(/,
    "the catch must rethrow immediately; anything else swallows the failure",
  );
  assert.equal(
    /return\s+out\s*;/.test(caught),
    false,
    "returning an empty year-to-date on failure is the silent under-withholding",
  );
});

test("the figure and its provenance travel in ONE statement", () => {
  // C20's lesson: a value written without the column that interprets it is a
  // measurement thrown away at the moment of capture. A pcb_sen stored with no
  // pcb_status is a zero nobody can read.
  const s = src("src/api/routes/payslips.ts");
  const insert = s.slice(s.indexOf("INSERT OR IGNORE INTO payslips"));
  const stmt = insert.slice(0, insert.indexOf("`,"));
  assert.match(stmt, /\bpcbSen\b/, "the INSERT writes pcbSen");
  assert.match(stmt, /\bpcb_status\b/, "…and must write pcb_status in the same statement");
});

test("the schema self-applies at runtime, because migrations are inert on deploy", () => {
  const s = src("src/api/lib/payroll-tax-columns.ts");
  for (const col of [
    "tax_residency",
    "tax_category",
    "tax_child_relief_sen",
    "pcb_status",
  ]) {
    assert.ok(
      new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`).test(s),
      `${col} must be self-applied`,
    );
  }
  // Memoised as a BOOLEAN, never as the in-flight promise (bug class C9).
  assert.match(s, /let _applied = false/);
  assert.equal(/Promise<void>\s*\|\s*null/.test(s), false, "C9: never cache the promise");
  // Callers must AWAIT it before the writes/reads that name the columns.
  for (const [file, count] of [
    ["src/api/routes/payslips.ts", 2],
    ["src/api/routes/workers.ts", 2],
    ["src/api/routes/worker.ts", 1],
  ]) {
    const calls = (src(file).match(/await ensurePayrollTaxColumns\(/g) ?? []).length;
    assert.ok(
      calls >= count,
      `${file} must await ensurePayrollTaxColumns at least ${count}x (found ${calls})`,
    );
  }
});

test("no tax-profile column is given a DEFAULT — NULL has to stay distinguishable", () => {
  // A DEFAULT here would be the bug wearing a schema hat: every undeclared
  // employee would silently acquire a tax profile, and the payslip would print
  // a withholding computed from it.
  for (const rel of [
    "src/api/lib/payroll-tax-columns.ts",
    "migrations-postgres/0229_pcb_tax_profile.sql",
  ]) {
    const s = src(rel);
    for (const line of s.split("\n")) {
      if (!/tax_residency|tax_category|tax_child_relief_sen|pcb_status/.test(line)) continue;
      if (!/ADD COLUMN/.test(line)) continue;
      assert.equal(
        /\bDEFAULT\b/i.test(line),
        false,
        `${rel}: a tax-profile column must not carry a DEFAULT — ${line.trim()}`,
      );
      assert.equal(
        /NOT NULL/i.test(line),
        false,
        `${rel}: a tax-profile column must stay nullable — ${line.trim()}`,
      );
    }
  }
});

test("the workers route refuses to coerce a blank declaration into a value", () => {
  const s = src("src/api/routes/workers.ts");
  for (const fn of [
    "function normalizeTaxResidency",
    "function normalizeTaxCategory",
    "function normalizeChildReliefSen",
  ]) {
    const i = s.indexOf(fn);
    assert.ok(i > 0, `${fn} missing`);
    const body = s.slice(i, s.indexOf("\n}\n", i) + 2);
    assert.match(body, /:\s*null|return null/, `${fn} must be able to return null`);
  }
  // The classic ?? "" / ?? 0 flattening, which would make "not declared"
  // indistinguishable from a declaration.
  assert.equal(
    /taxResidency:\s*row\.taxResidency\s*\?\?\s*""/.test(s) ||
      /taxCategory:\s*row\.taxCategory\s*\?\?\s*""/.test(s) ||
      /taxChildReliefSen:\s*row\.taxChildReliefSen\s*\?\?\s*0/.test(s),
    false,
    "an undeclared tax profile must not be flattened to '' / 0",
  );
});

test("the camelCase names used in route SQL are in the rename map", () => {
  // A camelCase column in route SQL without a map entry silently 400s.
  const map = JSON.parse(src("src/api/lib/column-rename-map.json"));
  assert.equal(map.pcbStatus, "pcb_status");
  assert.equal(map.taxResidency, "tax_residency");
  assert.equal(map.taxCategory, "tax_category");
  assert.equal(map.taxChildReliefSen, "tax_child_relief_sen");
});

// ---------------------------------------------------------------------------
// 2. The screens
// ---------------------------------------------------------------------------

/**
 * Every file that formats a PCB figure for a human, and what it must do about
 * a figure that was never computed. ADD A FILE HERE when a new screen prints
 * PCB — the sweep below fails until you do.
 */
const RENDER_SITES = {
  "src/pages/employees.tsx": {
    what: "office Payroll grid, expanded row, print columns, CSV export, totals",
    minGates: 5,
  },
  "src/lib/generate-payslip-pdf.ts": {
    // TWO gates, and both are load-bearing: one decides whether the Deductions
    // table prints an amount, the other decides whether the slip carries the
    // footnote saying net pay includes no tax withholding. Requiring only one
    // let the amount go back to ungated while the footnote kept the count up.
    what: "the printed payslip — the PCB line AND the net-pay caveat",
    minGates: 2,
  },
  "src/pages/m/config/modules.ts": {
    what: "the worker's phone payslip",
    minGates: 1,
  },
};

test("every screen that prints a PCB amount gates it on pcbHasFigure", () => {
  for (const [rel, spec] of Object.entries(RENDER_SITES)) {
    const s = src(rel);
    assert.match(
      s,
      /from "@\/lib\/pcb"/,
      `${rel} (${spec.what}) must read the status through src/lib/pcb.ts`,
    );
    const gates = (s.match(/pcbHasFigure\(/g) ?? []).length;
    assert.ok(
      gates >= spec.minGates,
      `${rel} (${spec.what}) has ${gates} pcbHasFigure gates, expected at least ${spec.minGates}`,
    );
    // Every gate must be fed a NORMALISED status. Reading the raw column would
    // treat a legacy NULL — a payslip issued before PCB existed — as a valid
    // status, which is the same "0 is an answer" mistake one level up. The
    // status may be normalised inline or hoisted into a local, but it may
    // never be the raw property.
    assert.match(
      s,
      /normalizeStoredPcbStatus\(/,
      `${rel}: the status must go through normalizeStoredPcbStatus`,
    );
    assert.equal(
      /pcbHasFigure\(\s*[A-Za-z_$][\w$]*\.(pcbStatus|pcb_status)/.test(s),
      false,
      `${rel}: pcbHasFigure is being handed a RAW column value`,
    );
  }
});

test("a PCB total is not printed as complete when one of its inputs was never computed", () => {
  const s = src("src/pages/employees.tsx");
  assert.match(
    s,
    /const pcbTotalComplete = useMemo\(/,
    "the page must decide whether the PCB column adds up",
  );
  const i = s.indexOf("const pcbTotalComplete");
  const body = s.slice(i, s.indexOf("[payslipData],", i));
  assert.match(body, /every\(/, "completeness is an ALL, not an ANY");
  assert.match(body, /pcbHasFigure\(/);
  // …and it must actually be consulted everywhere the total is printed.
  assert.ok(
    (s.match(/pcbTotalComplete/g) ?? []).length >= 5,
    "pcbTotalComplete is computed but barely used — every printed total must consult it",
  );
});

test("no NEW file formats a PCB figure without being enumerated above", () => {
  // The growth mechanism. Scans the whole front-end for a PCB value passed to
  // one of this codebase's money formatters — the exact shape that puts
  // "RM 0.00" under a PCB caption.
  const MONEY = "(?:formatCurrency|printMoney|fmtSen|money|rm2|senToRM)";
  const PCB_ARG = "[A-Za-z_$][\\w$.?]*\\.pcb\\b|\\bpcbSen\\b|\\bstat\\.pcb\\b";
  const re = new RegExp(`${MONEY}\\(\\s*(?:${PCB_ARG})`);
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const rel = full.slice(ROOT.length).replace(/\\/g, "/").replace(/^\/+/, "");
      if (rel in RENDER_SITES) continue;
      // The engine and the API shape PCB; they do not format it for a human.
      if (rel === "src/lib/pcb.ts") continue;
      const body = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
      if (re.test(body)) offenders.push(rel);
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual(
    offenders,
    [],
    `these files print a PCB amount but are not in RENDER_SITES (add them, and gate them on pcbHasFigure): ${offenders.join(", ")}`,
  );
});

test("the demo/seed helper carries no second tax calculation and no invented tax claim", () => {
  const s = src("src/lib/mock-data.ts");
  // The old comment asserted a tax fact nobody had computed — and had it
  // backwards (a NON-RESIDENT foreign worker is withheld a flat 30% of gross).
  assert.equal(
    /0 for foreign workers at this salary range/.test(s),
    false,
    "the fabricated tax claim is back in mock-data.ts",
  );
  const i = s.indexOf("export function calcStatutory");
  const body = s.slice(i, s.indexOf("\n}\n", i) + 2);
  assert.match(
    body,
    /pcbStatus:\s*"UNKNOWN"/,
    "seed rows must be stamped as not-computed so the screens render a dash",
  );
  assert.equal(
    /pcb\s*:\s*Math\.round|pcb\s*:\s*basicSalarySen\s*\*/.test(body),
    false,
    "mock-data must never grow its own PCB formula — resolvePcb is the only engine",
  );
});

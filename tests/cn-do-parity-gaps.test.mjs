// ---------------------------------------------------------------------------
// cn-do-parity-gaps.test.mjs — pin the last DO↔CN parity gaps (2026-06-12).
//
//   Gap 1: CN list search auto-jumps to the matching record's status tab —
//          the CN twin of the DO page's unified searchJumpIndex
//          (src/pages/delivery/index.tsx). PO-side tabs (Planning /
//          Pending CN) stay out of the jump set, exactly as DO excludes
//          its Planning tab.
//   Gap 2: global Ctrl+K palette finds CN records — /api/consignment-notes
//          grows an optional ?search= (noteNumber/customerName/branchName,
//          no-search SQL path byte-identical), the palette gains a
//          Consignment Notes category with a ?focus= deep link, and the CN
//          page consumes ?focus one-shot (hop to status tab + open Detail
//          + clear the param).
//   Gap 3: the three bulk Mark buttons gate on RAW backend status sets
//          that mirror CN_VALID_TRANSITIONS — RETURNED rows (displayed as
//          Delivered) are counted as skipped instead of PUT into a
//          transition the backend rejects.
//
// Style: structural regex pins on source (cn-packing-list.test.mjs
// pattern), plus a REAL import of CN_VALID_TRANSITIONS so the bulk
// eligibility sets are compared against the live transition table rather
// than a hand-copied snapshot of it.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const { CN_VALID_TRANSITIONS } = await import(
  "../src/api/lib/consignment-note-shared.ts"
);

const PAGE_SRC = readFileSync(
  new URL("../src/pages/consignment/note.tsx", import.meta.url),
  "utf8",
);
const ROUTE_SRC = readFileSync(
  new URL("../src/api/routes/consignment-notes.ts", import.meta.url),
  "utf8",
);
const SEARCH_SRC = readFileSync(
  new URL("../src/components/layout/global-search.tsx", import.meta.url),
  "utf8",
);

// Source slice between a start marker and the first later occurrence of an
// end marker — bounds one declaration well enough for the pins.
function sliceBetween(src, startMarker, endMarker) {
  const at = src.indexOf(startMarker);
  assert.notEqual(at, -1, `${startMarker} must exist in source`);
  const end = src.indexOf(endMarker, at);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return src.slice(at, end + endMarker.length);
}

// ---------------------------------------------------------------------------
// Gap 1 — CN list search auto-jump
// ---------------------------------------------------------------------------

test("gap1: tab-for-status map is DERIVED from TAB_CN_STATUSES (no second map to drift)", () => {
  const body = sliceBetween(
    PAGE_SRC,
    "const TAB_FOR_CN_STATUS",
    "})();",
  );
  assert.match(
    body,
    /Object\.entries\(TAB_CN_STATUSES\)/,
    "reverse map must be computed from the one forward map (DO's TAB_FOR_STATUS pattern)",
  );
});

test("gap1: grid search spans every status so cross-tab records are findable", () => {
  assert.match(
    PAGE_SRC,
    /if \(cnGridSearch\.trim\(\)\) return cnSearchResults;/,
    "while a search term is active, filteredCNs must return the SERVER search results (cnSearchResults), not the loaded page — so a CN on any page is findable (mirrors DO's server-side search; BUG-2026-06-27)",
  );
});

test("gap1: jump index covers CN rows only — PO-side tabs stay out of the jump set", () => {
  const body = sliceBetween(
    PAGE_SRC,
    "const searchJumpIndex = useMemo(",
    "}, [cnList, cnSearchResults, cnGridSearch]);",
  );
  assert.match(
    body,
    /for \(const cn of cnSource\)/,
    "index must walk the active CN source (server results while searching, else the loaded list)",
  );
  assert.match(
    body,
    /TAB_FOR_CN_STATUS\[cn\.status\]/,
    "each CN row must map to its status tab",
  );
  for (const poSource of ["readyPOs", "planningPOs"]) {
    assert.ok(
      !body.includes(poSource),
      `${poSource} must NOT feed the jump index (Planning / Pending CN are excluded like DO's planning tab)`,
    );
  }
});

test("gap1: auto-jump hops only when every match lives on ONE tab, and respects manual tab clicks", () => {
  const body = sliceBetween(
    PAGE_SRC,
    "// Follow the record to its tab",
    "}, [cnGridSearch, searchJumpIndex]);",
  );
  assert.match(body, /tabsHit\.size === 1/, "single-tab guard must exist");
  assert.match(
    body,
    /if \(only !== activeTab\) setActiveTab\(only\);/,
    "jump must go through setActiveTab",
  );
  assert.match(
    body,
    /activeTab intentionally excluded/,
    "activeTab must stay OUT of the effect deps so a manual tab click during a search is respected (DO nuance)",
  );
});

test("gap1: CN DataGrid feeds the jump; PO grids only carry the term", () => {
  assert.match(
    PAGE_SRC,
    /onSearchChange=\{setCnGridSearch\}/,
    "CN grid must report its search box into cnGridSearch",
  );
  const occurrences = PAGE_SRC.match(/initialSearch=\{cnGridSearch\}/g) || [];
  assert.equal(
    occurrences.length,
    3,
    "all three grids (CN + Planning + Pending CN) must seed from cnGridSearch",
  );
  assert.equal(
    (PAGE_SRC.match(/onSearchChange=\{setCnGridSearch\}/g) || []).length,
    1,
    "only the CN grid may FEED the jump — PO-side grids have no onSearchChange",
  );
});

// ---------------------------------------------------------------------------
// Gap 2 — global Ctrl+K palette finds CN records
// ---------------------------------------------------------------------------

test("gap2: CN list endpoint filters noteNumber/customerName/branchName only when ?search= present", () => {
  assert.match(
    ROUTE_SRC,
    /const q = \(c\.req\.query\("search"\) \|\| c\.req\.query\("q"\) \|\| ""\)\.trim\(\);/,
    "search param must follow the repo's search||q convention",
  );
  assert.match(
    ROUTE_SRC,
    /if \(q\) \{\s*clauses\.push\("\(noteNumber ILIKE \? OR customerName ILIKE \? OR branchName ILIKE \?\)"\);/,
    "search clause must cover noteNumber + customerName + branchName and only fire when ?search= is present",
  );
});

test("gap2: no-search list SQL path is unchanged (legacy query + legacy pagination contract)", () => {
  assert.match(
    ROUTE_SRC,
    /let listSql = `SELECT \* FROM consignment_notes \$\{where\} ORDER BY noteNumber DESC`;/,
    "base list SQL must stay byte-identical",
  );
  assert.match(
    ROUTE_SRC,
    /if \(q && limit !== null && page === null\) page = 1;/,
    "page may only default when a search is active — limit-without-page keeps its legacy no-op for non-search callers",
  );
});

test("gap2: consignment notes stay findable + ?focus deep-link after the unified-search move", () => {
  // The palette no longer fans out a per-endpoint CN fetch — it calls
  // /api/search once (see feat/palette-unified-search). The behaviour this
  // test protects is unchanged: CN is a search source, it deep-links to
  // /consignment/note?focus=<id>, and it maps to the consignment_notes group
  // with the ClipboardList icon. The assertions moved to where those now live.
  const CATALOGUE = readFileSync("src/api/lib/search-sources.ts", "utf8");

  // The server catalogue carries the CN source with the ?focus deep link.
  const cnSource = sliceBetween(
    CATALOGUE,
    'kind: "consignment_note"',
    "},",
  );
  assert.match(cnSource, /table: "consignment_notes"/, "CN source must query consignment_notes");
  assert.match(cnSource, /note_number/, "CN label/search must use note_number");
  assert.match(
    cnSource,
    /hrefPrefix: "\/consignment\/note\?focus="/,
    "CN results must deep-link to /consignment/note?focus=<id>",
  );

  // The palette maps the server `consignment_note` kind to the existing group.
  assert.match(
    SEARCH_SRC,
    /consignment_note: \{ category: "consignment_notes", icon: ClipboardList \}/,
    "palette must map the consignment_note kind to the consignment_notes group",
  );
  assert.match(
    SEARCH_SRC,
    /consignment_notes: \{ label: "Consignment Notes", icon: ClipboardList \}/,
    "category config must label the group Consignment Notes with the ClipboardList icon",
  );
  // The previously-covered six categories keep their original relative order;
  // the new modules append after consignment_notes.
  const orderMatch = SEARCH_SRC.match(
    /const categoryOrder: ResultCategory\[\] = (\[[\s\S]*?\]);/,
  );
  assert.ok(orderMatch, "categoryOrder must exist");
  const order = new Function(`return ${orderMatch[1]};`)();
  assert.deepEqual(
    order.slice(0, 8),
    [
      "pages",
      "actions",
      "sales_orders",
      "delivery_orders",
      "invoices",
      "customers",
      "products",
      "consignment_notes",
    ],
    "the original eight keep their order; new modules append after",
  );
});

test("gap2: CN page consumes ?focus one-shot — open Detail, hop tab, clear the param", () => {
  const body = sliceBetween(
    PAGE_SRC,
    'searchParams.get("focus")',
    "}, [searchParams, cnList, setUrlBatch]);",
  );
  assert.match(
    body,
    /setDetailCN\(focusRow\)/,
    "found CN must open the Detail dialog",
  );
  assert.match(
    body,
    /TAB_FOR_CN_STATUS\[focusRow\.status\]/,
    "found CN must hop to its status tab",
  );
  // Both branches clear the param atomically via useUrlBatch — including
  // the deleted-id branch, which must land without erroring.
  const clears = body.match(/focus: null/g) || [];
  assert.equal(
    clears.length,
    2,
    "both found and not-found branches must clear ?focus from the URL",
  );
  assert.ok(
    !body.includes("toast.error"),
    "a deleted/unknown id lands silently — no error toast",
  );
});

// ---------------------------------------------------------------------------
// Gap 3 — bulk eligibility mirrors CN_VALID_TRANSITIONS, by raw status
// ---------------------------------------------------------------------------

function extractBulkSets() {
  const m = PAGE_SRC.match(
    /const BULK_ELIGIBLE_RAW_STATUSES[^=]*=\s*(\{[\s\S]*?\});/,
  );
  assert.ok(m, "BULK_ELIGIBLE_RAW_STATUSES must exist in note.tsx");
  return new Function(`return ${m[1]};`)();
}

test("gap3: bulk sets carry exactly the owner-approved forward edges", () => {
  assert.deepEqual(extractBulkSets(), {
    PARTIALLY_SOLD: ["ACTIVE"],
    FULLY_SOLD: ["PARTIALLY_SOLD", "IN_TRANSIT"],
    CLOSED: ["FULLY_SOLD"],
  });
});

test("gap3: every bulk edge is a legal edge of the IMPORTED CN_VALID_TRANSITIONS table", () => {
  const sets = extractBulkSets();
  for (const [target, froms] of Object.entries(sets)) {
    for (const from of froms) {
      assert.ok(
        (CN_VALID_TRANSITIONS[from] ?? []).includes(target),
        `${from} → ${target} must be allowed by the backend transition table`,
      );
    }
  }
});

test("gap3: RETURNED is bulk-ineligible everywhere — and the backend table proves why", () => {
  const sets = extractBulkSets();
  for (const [target, froms] of Object.entries(sets)) {
    assert.ok(
      !froms.includes("RETURNED"),
      `RETURNED must not be eligible for bulk → ${target}`,
    );
  }
  // The exact slip-through this gap fixes: RETURNED displays as Delivered,
  // but the backend only allows RETURNED → ACTIVE.
  assert.deepEqual(CN_VALID_TRANSITIONS.RETURNED, ["RETURNED", "ACTIVE"]);
});

test("gap3: all three bulk handlers gate on the RAW status via the shared sets", () => {
  assert.match(
    PAGE_SRC,
    /BULK_ELIGIBLE_RAW_STATUSES\.PARTIALLY_SOLD\.includes\(c\.rawStatus\)/,
    "Mark Dispatched must gate on rawStatus",
  );
  assert.match(
    PAGE_SRC,
    /BULK_ELIGIBLE_RAW_STATUSES\.FULLY_SOLD\.includes\(c\.rawStatus\)/,
    "Mark Delivered must gate on rawStatus",
  );
  assert.match(
    PAGE_SRC,
    /BULK_ELIGIBLE_RAW_STATUSES\.CLOSED\.includes\(c\.rawStatus\)/,
    "Mark Acknowledged must gate on rawStatus",
  );
  // No bulk handler may fall back to the folded display status.
  assert.ok(
    !/eligible = selected\.filter\(\(c\) => c\.status ===/.test(PAGE_SRC),
    "display-status eligibility filters must be gone",
  );
  assert.match(
    PAGE_SRC,
    /rawStatus: cn\.status,/,
    "the row VM must carry the raw backend status straight from the API row",
  );
});

// Root-cause guard (BUG-2026-06-27): the "Pending Delivery" / "ready for CN" /
// Command-Center stage classification MUST be computed from the COMPLETE
// "already on a DO/CN" set served by the dedicated /linked-po-ids endpoints —
// never from a page-capped DO/CN list. A capped fetch (page 1, limit 200)
// silently re-surfaced already-delivered orders (e.g. SO-2603-157) once total
// volume passed one page, and made the Command Center / Delivery / CN numbers
// disagree. These pins fail loudly if anyone reverts a consumer to building the
// exclusion set from the loaded (capped) list via buildLinkedPOIds(...).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// Strip comments so an explanatory comment that MENTIONS the old buildLinkedPOIds
// pattern (e.g. "was buildLinkedPOIds(dos)…") doesn't trip the negative checks.
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("delivery Pending Delivery sources exclusion from the complete /linked-po-ids endpoint", () => {
  const src = read("src/pages/delivery/index.tsx");
  assert.match(
    src,
    /\/api\/delivery-orders\/linked-po-ids/,
    "delivery page must fetch the complete linked-po-ids set",
  );
  assert.ok(
    !/buildLinkedPOIds\s*\(/.test(stripComments(src)),
    "delivery page must NOT rebuild the exclusion set from the page-capped DO list",
  );
});

test("Command Center derives Pending Delivery from the complete /linked-po-ids set", () => {
  const src = read("src/pages/dashboard-b/index.tsx");
  assert.match(
    src,
    /\/api\/delivery-orders\/linked-po-ids/,
    "dashboard-b must fetch the complete linked-po-ids set",
  );
  assert.ok(
    !/buildLinkedPOIds\s*\(/.test(stripComments(src)),
    "dashboard-b must NOT rebuild the exclusion set from the capped 200-DO page",
  );
});

test("CN ready list sources exclusion from the complete /linked-po-ids endpoint", () => {
  const src = read("src/pages/consignment/note.tsx");
  assert.match(
    src,
    /\/api\/consignment-notes\/linked-po-ids/,
    "CN note page must fetch the complete linked-po-ids set",
  );
});

test("both /linked-po-ids endpoints exist server-side", () => {
  const doSrc = read("src/api/routes/delivery-orders.ts");
  const cnSrc = read("src/api/routes/consignment-notes.ts");
  assert.match(doSrc, /app\.get\(\s*["'`]\/linked-po-ids/, "DO endpoint must exist");
  assert.match(cnSrc, /app\.get\(\s*["'`]\/linked-po-ids/, "CN endpoint must exist");
});

// ---------------------------------------------------------------------------
// document-chain-map.test.mjs — pins the relationship map that replaced the old
// SoDocumentRelationship / DocumentFlowDiagram pair on the sales-chain pages.
//
// The map exists to answer ONE question the old diagram could not: "which part
// isn't produced yet, and whose hands is it in?" Three properties carry that
// answer, and all three are easy to regress silently because they are cosmetic
// until you need them:
//
//   1. A missing document renders GREY *with a caption saying when it arrives*.
//      Drop the caption and a not-yet-invoiced order looks like a failed fetch.
//   2. The driver rides on the DO node. It is the "whose hands" half of the
//      question; buried on the DO page it may as well not exist.
//   3. Job cards are fetched PER production order, only when that order is
//      expanded. A SO can carry several POs of 6-8 cards; hoisting the fetch
//      to page load is the obvious "simplification" that would cost more than
//      the strip shows.
//
// Plus the wiring itself: every detail page in the chain must render the map,
// since "open any document and see how it connects" is the whole premise.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MAP = "src/components/ui/document-chain-map.tsx";
const map = readFileSync(MAP, "utf8");

const read = (f) => readFileSync(f, "utf8");

// --- wiring ----------------------------------------------------------------

test("every sales-chain detail page renders DocumentChainMap", () => {
  // soId anchors the chain; currentDocNo highlights the node you're on. Each
  // page must pass a value that is actually in scope there — the pairs below
  // are the props those pages have.
  const pages = [
    {
      file: "src/pages/sales/detail.tsx",
      render: /<DocumentChainMap\s+soId=\{order\.id\}\s+currentDocNo=\{order\.companySOId\}\s*\/>/,
    },
    {
      file: "src/pages/delivery/detail.tsx",
      // Consolidated DOs carry no salesOrderId, hence the resolved `anchor`.
      render: /<DocumentChainMap\s+soId=\{anchor\}\s+currentDocNo=\{order\.doNo\}\s*\/>/,
    },
    {
      file: "src/pages/invoices/detail.tsx",
      render: /<DocumentChainMap\s+soId=\{invoice\.salesOrderId \|\| invoice\.companySOId\}\s+currentDocNo=\{invoice\.invoiceNo\}\s*\/>/,
    },
    {
      file: "src/pages/service-cases/detail.tsx",
      // A case is not itself a node in the chain, so it passes no currentDocNo
      // — nothing on this page is "the document you're looking at".
      render: /<DocumentChainMap\s+soId=\{chainAnchorSoId\}\s*\/>/,
    },
  ];
  for (const { file, render } of pages) {
    const src = read(file);
    assert.match(
      src,
      /import \{ DocumentChainMap \} from "@\/components\/ui\/document-chain-map"/,
      `${file} must import DocumentChainMap`,
    );
    assert.match(src, render, `${file} must render DocumentChainMap with in-scope props`);
    assert.doesNotMatch(
      src,
      /SoDocumentRelationship|DocumentFlowDiagram/,
      `${file} must not fall back to the superseded diagram`,
    );
  }
});

test("the Service Case page resolves a real sales_orders id to anchor on", () => {
  const src = read("src/pages/service-cases/detail.tsx");
  // SV service orders ARE sales_orders rows, so the live repair is the best
  // anchor; the source SO is the fallback before anything is spawned. Both are
  // ids /api/sales-orders/:id can resolve — a CO- or EXTERNAL-sourced case
  // resolves to "" and the map renders nothing rather than 404ing.
  assert.match(src, /const chainAnchorSoId = useMemo\(/);
  assert.match(src, /\.find\(\(o\) => o\.isSv\)/, "prefer the spawned SV order");
  assert.match(
    src,
    /caseDetail\?\.sourceType === "SO" && caseDetail\.sourceId/,
    "fall back to the source SO only when the source really is an SO",
  );
  assert.match(src, /return "";/, "no anchor must yield an empty id, never a CO id");
});

test("Consignment Orders are deliberately NOT wired — they have no SO id", () => {
  // consignment_orders is a parallel chain: its POs are written with
  // salesOrderId NULL / consignmentOrderId set, so /api/sales-orders/:id
  // cannot resolve a CO. This test is the record of that decision — if the
  // CO ever gains a sales-order link, wire the page and delete this.
  const route = read("src/api/routes/consignment-orders.ts");
  assert.match(
    route,
    /consignmentOrderId set\s*\n\/\/ and salesOrderId NULL\./,
    "if COs stop being SO-less, revisit the consignment detail page",
  );
  assert.doesNotMatch(
    read("src/pages/consignment/detail.tsx"),
    /DocumentChainMap/,
    "the CO page must not be forced onto a chain it cannot anchor",
  );
});

// --- 1. grey means "not yet", and says when ---------------------------------

test("every pending node carries a caption explaining when it arrives", () => {
  // Grey with no caption reads as "failed to load". Each downstream node's
  // pending branch names the event that creates it.
  for (const [kind, caption] of [
    ["DO", "After confirmation"],
    ["INV", "On delivery"],
    ["PAY", "On settlement"],
  ]) {
    const node = map.match(new RegExp(`kind: "${kind}",[\\s\\S]{0,1600}?\\n      \\},`));
    assert.ok(node, `${kind} node not found — did the node list change shape?`);
    assert.match(
      node[0],
      new RegExp(`: "${caption}"`),
      `the ${kind} node's pending branch must say when it will exist`,
    );
  }
  // And the panel states the rule once, so the colour is self-explaining.
  assert.match(
    map,
    /Grey means not created yet — the caption says when it will be\./,
    "the header must state the grey rule",
  );
  assert.match(map, /Not created yet/, "the legend must name the pending state");
  // A pending node has nothing to open, so it must not be a link.
  assert.match(
    map,
    /node\.href && node\.state !== "pending"/,
    "pending nodes must never render as clickable links",
  );
});

// --- 2. the driver is on the DO node ----------------------------------------

test("the delivery driver shows on the DO node itself", () => {
  const doNode = map.match(/kind: "DO",[\s\S]{0,1600}?\n      \},/);
  assert.ok(doNode, "DO node not found");
  assert.match(
    doNode[0],
    /\[dos\[0\]\.status, dos\[0\]\.driverName\]\.filter\(Boolean\)\.join\(" · "\)/,
    'the DO node caption must combine status and driverName ("whose hands")',
  );
  // Extra drops ship on their own DOs — those carry the driver too.
  assert.match(
    map,
    /\[d\.status, d\.driverName\]\.filter\(Boolean\)\.join\(" · "\)/,
    "further deliveries must show their driver as well",
  );
  // driverName has to survive the round trip from the API.
  assert.match(
    map,
    /linkedDOs\?: \{ id: string; doNo: string; status: string; driverName\?: string \| null \}\[\]/,
    "the payload type must keep driverName",
  );
  assert.match(
    read("src/api/routes/sales-orders.ts"),
    /driverName: d\.driverName \?\? null,/,
    "/api/sales-orders/:id must keep returning driverName on linked DOs",
  );
});

// --- 3. job cards are lazy, per production order ----------------------------

test("job cards are fetched per production order, only when expanded", () => {
  // One fetch per PO, keyed by that PO's id.
  assert.match(
    map,
    /useCachedJson<\{ success\?: boolean; data\?: \{ jobCards\?: JobCard\[\] \} \}>\(\s*`\/api\/production-orders\/\$\{poId\}`,/,
    "StationStrip must fetch its own production order by id",
  );
  // The strip only mounts while the PO row is open — that is what makes the
  // fetch lazy. Hoisting it above the guard would fire every PO on page load.
  assert.match(
    map,
    /\{open && <StationStrip poId=\{po\.id\} \/>\}/,
    "the strip must be mounted behind the expand guard",
  );
  // The top-level component pulls the chain and nothing else; no bulk
  // job-card / production-order list fetch may creep in beside it.
  const topFetches = map.match(/useCachedJson<[\s\S]*?>\(\s*[^)]*?`?\/api\/[^`"]*/g) ?? [];
  assert.equal(topFetches.length, 2, "exactly two fetches: the chain and the per-PO strip");
  assert.doesNotMatch(
    map,
    /\/api\/production-orders\?/,
    "no list-wide production-order fetch — that would defeat the per-PO laziness",
  );
  assert.match(
    map,
    /soId \? `\/api\/sales-orders\/\$\{soId\}` : null/,
    "the chain fetch must stay conditional on having an SO to anchor on",
  );
});

test("a station that ran over its estimate is only flagged once it finished", () => {
  // An in-progress station hasn't had its chance yet — flagging it would cry
  // wolf on every job the moment it starts. The rule is unchanged since
  // 2026-08-01; only the operands moved, from one job card to the DEPARTMENT
  // roll-up that replaced it (see tests/job-card-stations.test.mjs).
  assert.match(
    map,
    /s\.state === "linked" && s\.estMinutes > 0 && s\.actualMinutes > s\.estMinutes/,
    "the over-estimate flag must require a completed station",
  );
});

// --- clickable nodes (owner: 「还可以点的 点的就会直接跳到那边去」) ----------

test("a real document navigates; a node with nothing to open explains itself", () => {
  const src = readFileSync("src/components/ui/document-chain-map.tsx", "utf8");
  // Houzs SCM's rule, adopted: 「每個點了都要有反應可以看到文件的」. A linked
  // document opens. Anything else must SAY why rather than sit dead — silence
  // reads as a broken link.
  assert.match(src, /if \(node\.href && node\.state !== "pending"\) \{/);
  assert.match(src, /title=\{`Open \$\{node\.docNo\}`\}/);
  // The fallback is a button carrying the explanation, NOT an anchor — a
  // pending step still must not look like a live link.
  assert.match(src, /onClick=\{\(\) => node\.why && window\.alert\(node\.why\)\}/);
  // Every downstream node states the event that will create it.
  for (const phrase of [
    "is the customer's own reference",
    "No delivery order yet",
    "No invoice yet",
    "No payment recorded yet",
  ]) {
    assert.ok(src.includes(phrase), `missing explanation: ${phrase}`);
  }
});

test("the production order number navigates, the chevron only expands", () => {
  const src = readFileSync("src/components/ui/document-chain-map.tsx", "utf8");
  assert.match(src, /href=\{`\/production\/\$\{po\.id\}`\}/);
  assert.match(src, /aria-label=\{open \? "Collapse stations" : "Expand stations"\}/);
  // They must be two separate elements: if the whole row were the link, trying
  // to see the stations would navigate away instead.
  const rowIsButton = /onClick=\{\(\) =>\s*setOpenPOs[\s\S]{0,120}className="flex w-full/.test(src);
  assert.ok(!rowIsButton, "the whole row must not be the toggle");
});

test("each station card opens its production order", () => {
  const src = readFileSync("src/components/ui/document-chain-map.tsx", "utf8");
  // Job cards have no detail page of their own, so the order is the closest
  // real destination.
  assert.match(src, /href=\{`\/production\/\$\{poId\}`\}/);
});

// --- layout (owner: 「这个排版也是不好看啊」) --------------------------------

test("a long worker list can never crush the production order number", () => {
  const src = readFileSync("src/components/ui/document-chain-map.tsx", "utf8");
  // A finished order carries a dozen names. On one row that list was
  // flex-shrink-0, so it took the space and wrapped `SO-2607-231-01` down four
  // lines. The identity line is unbreakable; the names sit on their own row.
  assert.match(
    src,
    /flex-shrink-0 whitespace-nowrap text-sm font-semibold/,
    "the PO number must never wrap",
  );
  assert.match(
    src,
    /min-w-0 flex-1 truncate text-xs/,
    "the product name is what gives way — and needs min-w-0 for truncate to engage",
  );
  const headerAt = src.indexOf("Open production order");
  const namesAt = src.indexOf("line-clamp-2");
  assert.ok(
    headerAt > 0 && namesAt > headerAt,
    "the worker list must render BELOW the identity line, not inside it",
  );
});

test("stations lay out as an even grid, not ragged chips", () => {
  const src = readFileSync("src/components/ui/document-chain-map.tsx", "utf8");
  assert.match(src, /grid grid-cols-2 gap-1\.5 px-3 pb-3 sm:grid-cols-3/);
  assert.doesNotMatch(
    src,
    /flex flex-wrap gap-1\.5 px-3 pb-3/,
    "the ragged flex-wrap strip must not return",
  );
});

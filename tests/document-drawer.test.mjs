// ---------------------------------------------------------------------------
// document-drawer.test.mjs — behaviour tests for the document detail drawer
// (src/lib/document-drawer.ts + its one wired document type, the Delivery
// Order workbench at src/pages/delivery/index.tsx).
//
// These assert what the SCREEN promises, not how it is built:
//
//   • the drawer shows the row you clicked — its full-page link and its action
//     bar are built from THAT document, not the last one opened;
//   • the sticky action bar offers only the moves that document's status
//     allows, because it filters the grid's own row menu — a DRAFT delivery
//     order is offered "Mark Dispatched" and NOT "Mark Delivered (DO Signed)";
//     a dispatched one is offered the sign-back and not the dispatch;
//   • the one-line variant/spec description is the SHARED formatter the printed
//     DO uses (buildSpec, src/lib/doc-line-format.ts), not a local copy that
//     can drift from the paperwork.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on newer Node.
}

const {
  DRAWER_DOC_CONFIG,
  drawerActionBar,
  drawerDocLabel,
  drawerFullPagePath,
  drawerLineSpec,
  isPrimaryDrawerAction,
} = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/document-drawer.ts")).href
);

const { buildSpec } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/doc-line-format.ts")).href
);

const deliveryPageSrc = readFileSync(
  resolve(process.cwd(), "src/pages/delivery/index.tsx"),
  "utf8",
);

// ── The Delivery Order row menu, as src/pages/delivery/index.tsx computes it ──
// Same labels and the same `disabled` predicates as getContextMenuItems, so a
// change to the status rules there shows up here as a failing expectation
// rather than as a drawer that quietly offers an illegal move.
function doRowMenu(status) {
  return [
    { label: "View Details" },
    { label: "Print DO" },
    { label: "Print Packing List" },
    { label: "QR — Driver Scan" },
    { label: "", separator: true },
    { label: "Mark Dispatched", disabled: status !== "DRAFT" },
    { label: "Reverse to Pending Dispatch", disabled: status !== "LOADED" },
    {
      label: "Mark Out for Delivery (In Transit)",
      disabled: status !== "LOADED",
    },
    {
      label: "Mark Delivered (DO Signed)",
      disabled: status !== "LOADED" && status !== "IN_TRANSIT",
    },
    { label: "Transfer to Invoice", disabled: status !== "DELIVERED" },
    {
      label: "Resend invoice email",
      disabled: status !== "DELIVERED" && status !== "INVOICED",
    },
    {
      label: "Convert to Delivery Return",
      disabled: status !== "DELIVERED" && status !== "INVOICED",
    },
    { label: "", separator: true },
    { label: "Cancel Delivery Order", danger: true, disabled: status === "CANCELLED" },
    { label: "", separator: true },
    { label: "Refresh" },
  ];
}

const barLabels = (status) =>
  drawerActionBar("DELIVERY_ORDER", doRowMenu(status)).map((i) => i.label);

// ── The drawer shows the document whose row was clicked ─────────────────────

test("the drawer's full page link points at the row's own document", () => {
  assert.equal(drawerFullPagePath("DELIVERY_ORDER", "do-1"), "/delivery/do-1");
  assert.equal(drawerFullPagePath("DELIVERY_ORDER", "do-2"), "/delivery/do-2");
  assert.equal(drawerDocLabel("DELIVERY_ORDER"), "Delivery Order");
});

test("an id that needs escaping still produces a usable route", () => {
  assert.equal(
    drawerFullPagePath("DELIVERY_ORDER", "do/1 2"),
    "/delivery/do%2F1%202",
  );
});

test("the delivery page opens the drawer without navigating away from the list", () => {
  // Row click / eye button / row menu all set state; none of them navigate, so
  // the list keeps its rows, filters and scroll position underneath.
  assert.match(deliveryPageSrc, /onDoubleClick=\{\(row\) => setDetailDO\(row\)\}/);
  assert.match(deliveryPageSrc, /action: \(\) => setDetailDO\(row\)/);
  assert.ok(
    !/navigate\(`\/delivery\/\$\{[^}]*\}`\)/.test(deliveryPageSrc),
    "opening the detail must not push a route",
  );
});

// ── The action bar follows the document's real state ────────────────────────

test("a DRAFT delivery order is offered dispatch, not sign-back", () => {
  const labels = barLabels("DRAFT");
  assert.ok(labels.includes("Mark Dispatched"));
  assert.ok(!labels.includes("Mark Delivered (DO Signed)"));
  assert.ok(!labels.includes("Transfer to Invoice"));
  assert.ok(!labels.includes("Reverse to Pending Dispatch"));
});

test("a dispatched delivery order is offered the sign-back, not the dispatch", () => {
  const labels = barLabels("LOADED");
  assert.ok(labels.includes("Mark Delivered (DO Signed)"));
  assert.ok(labels.includes("Mark Out for Delivery (In Transit)"));
  assert.ok(labels.includes("Reverse to Pending Dispatch"));
  assert.ok(!labels.includes("Mark Dispatched"));
  assert.ok(!labels.includes("Transfer to Invoice"));
});

test("a delivered delivery order is offered billing and the return path", () => {
  const labels = barLabels("DELIVERED");
  assert.deepEqual(labels, [
    "Transfer to Invoice",
    "Resend invoice email",
    "Convert to Delivery Return",
    "Cancel Delivery Order",
  ]);
});

test("a cancelled delivery order is offered nothing to do", () => {
  assert.deepEqual(barLabels("CANCELLED"), []);
});

test("the bar carries lifecycle moves only — print / QR / refresh stay in the menu", () => {
  for (const status of ["DRAFT", "LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"]) {
    const labels = barLabels(status);
    for (const utility of ["View Details", "Print DO", "QR — Driver Scan", "Refresh"]) {
      assert.ok(
        !labels.includes(utility),
        `${utility} must not reach the ${status} action bar`,
      );
    }
    assert.ok(!labels.includes(""), "separators must never become buttons");
  }
});

test("the bar renders in the type's configured order, whatever order the menu is in", () => {
  const shuffled = [...doRowMenu("LOADED")].reverse();
  assert.deepEqual(
    drawerActionBar("DELIVERY_ORDER", shuffled).map((i) => i.label),
    [
      "Reverse to Pending Dispatch",
      "Mark Out for Delivery (In Transit)",
      "Mark Delivered (DO Signed)",
      "Cancel Delivery Order",
    ],
  );
});

test("forward moves are the filled buttons; undo and cancel are not", () => {
  assert.ok(isPrimaryDrawerAction("DELIVERY_ORDER", "Mark Dispatched"));
  assert.ok(isPrimaryDrawerAction("DELIVERY_ORDER", "Transfer to Invoice"));
  assert.ok(!isPrimaryDrawerAction("DELIVERY_ORDER", "Cancel Delivery Order"));
  assert.ok(!isPrimaryDrawerAction("DELIVERY_ORDER", "Reverse to Pending Dispatch"));
  // Every primary must actually be offered on the bar.
  const cfg = DRAWER_DOC_CONFIG.DELIVERY_ORDER;
  for (const label of cfg.primaryActionLabels) {
    assert.ok(
      cfg.actionBarLabels.includes(label),
      `${label} is marked primary but never reaches the bar`,
    );
  }
});

test("the action bar is filtered from the grid's own row menu, not re-derived", () => {
  assert.match(
    deliveryPageSrc,
    /drawerActionBar\("DELIVERY_ORDER",\s*getContextMenuItems\(detailLive\)\)/,
  );
});

// ── The variant line is the shared formatter, not a fourth copy ─────────────

const specCases = [
  {
    name: "bedframe with divan, leg, gap and total height",
    item: { fabricCode: "PC151-01", sizeLabel: "Queen" },
    extra: {
      itemCategory: "BEDFRAME",
      divanHeightInches: 8,
      legHeightInches: 1,
      gapInches: 12,
      totalHeightInches: 21,
      specialOrder: null,
    },
  },
  {
    name: "sofa keeps its size and leg",
    item: { fabricCode: "CG-001", sizeLabel: "3 Seater" },
    extra: {
      itemCategory: "SOFA",
      divanHeightInches: null,
      legHeightInches: 6,
      gapInches: null,
      totalHeightInches: null,
      specialOrder: null,
    },
  },
  {
    name: "special order is appended",
    item: { fabricCode: "BF-01", sizeLabel: "King" },
    extra: {
      itemCategory: "BEDFRAME",
      divanHeightInches: 10,
      legHeightInches: null,
      gapInches: null,
      totalHeightInches: null,
      specialOrder: "Headboard Only",
    },
  },
  {
    name: "no extras at all still shows the fabric",
    item: { fabricCode: "A201-7", sizeLabel: "Super King" },
    extra: undefined,
  },
];

for (const c of specCases) {
  test(`the drawer's spec line comes from the shared buildSpec — ${c.name}`, () => {
    assert.equal(drawerLineSpec(c.item, c.extra), buildSpec(c.item, c.extra));
  });
}

test("the spec line renders the axes the owner asked to see on one line", () => {
  const line = drawerLineSpec(
    { fabricCode: "PC151-01", sizeLabel: "Queen" },
    {
      itemCategory: "BEDFRAME",
      divanHeightInches: 8,
      legHeightInches: 1,
      gapInches: 12,
      totalHeightInches: 21,
      specialOrder: "DIVAN CURVE",
    },
  );
  assert.equal(
    line,
    'PC151-01 / DIVAN 8" + 1" LEG / GAP 12" / T.Heights 21" / DIVAN CURVE',
  );
  assert.ok(!line.includes("\n"), "the spec must be ONE line");
});

test("a null/blank line degrades to an empty spec rather than junk", () => {
  assert.equal(drawerLineSpec({ fabricCode: "", sizeLabel: "" }, null), "");
  assert.equal(drawerLineSpec({}, undefined), "");
});

test("the delivery page uses the shared spec formatter and keeps no local variant hack", () => {
  assert.match(deliveryPageSrc, /drawerLineSpec\(item, ext\?\.items\?\.\[item\.id\]\)/);
  // The old "Variant" column sliced the product code at the first dash and
  // called the remainder a variant. It is gone; nothing may bring it back.
  assert.ok(
    !/c\.slice\(i \+ 1\)/.test(deliveryPageSrc),
    "the product-code slice masquerading as a variant must stay deleted",
  );
});

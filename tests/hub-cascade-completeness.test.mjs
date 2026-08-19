// ---------------------------------------------------------------------------
// hub-cascade-completeness.test.mjs — guards against the recurring class of
// bug where a new hub-derived denormalized column is added to a downstream
// table (DO / invoice / CN / PO / credit-note / debit-note) but the
// PATCH /:id/hub cascade in sales-orders.ts or consignment-orders.ts is
// not extended to refresh it.
//
// Class of bug (already hit 3 times — BUG-2026-05-30-004/005/006):
//   * Initial cascade (e79c5d57) wrote hubId+hubName to production_orders
//     but the column didn't exist -> runtime failure rolled back the PATCH.
//   * 2138c139 fixed PO + added the DO / invoice contact block.
//   * Wei Siang then saw production_orders.customerState stale after
//     changing SO hub PG->KL because production_orders has no hub_id but
//     DOES have customerState as a denormalized snapshot — BUG-006.
//
// What this test does:
//   1. Parse migrations-postgres/*.sql for every (table, column) pair where
//      column is one of the known hub-derived names. The list of names is
//      hardcoded — it's the same set the parent session audited:
//        hub_id, hub_name, customer_state, customer_address,
//        delivery_address, contact_person, contact_phone, attention,
//        customer_phone, branch_name
//   2. Filter out tables we deliberately exclude:
//        * sales_orders         — it IS the source; not cascaded TO itself
//        * consignment_orders   — likewise (CO has its own PATCH endpoint)
//        * production_orders_archive — archives are immutable by policy
//        * sales_orders_archive      — likewise
//        * service_cases        — parallel entity, not downstream of SO/CO
//        * suppliers            — `attention` here is for purchase letterhead,
//                                  not for customer hub denormalization
//        * drivers              — `contact_person` is the driver contact, not customer
//   3. Read the two cascade source files (sales-orders.ts +
//      consignment-orders.ts) and verify each downstream (table, column)
//      pair appears in at least one UPDATE block inside the PATCH /:id/hub
//      handler in either file.
//
// What this test will NOT catch:
//   * A cascade that targets the right column but binds the wrong value
//     (e.g. binds hub.shortName to customerState by mistake). The schema-
//     parsing here is shape-only.
//   * A new downstream table that uses a hub-derived field with a NAME
//     not in the hardcoded list above. If we ever invent a new denorm
//     column name (e.g. `branch_state`), update the HUB_DERIVED_COLUMNS
//     set below — the test will then start enforcing coverage for it.
//
// To extend coverage to a new column name: just add it to
// HUB_DERIVED_COLUMNS. To exclude a table: add it to EXCLUDED_TABLES with
// a comment explaining why.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Hub-derived denormalized column names. These are populated at create-time
// from delivery_hubs (hub_id, hub_name, customer/delivery_address,
// contact_person, contact_phone, attention, customer_phone, branch_name,
// customer_state) and become stale when the parent SO/CO hub changes.
const HUB_DERIVED_COLUMNS = new Set([
  "hub_id",
  "hub_name",
  "customer_state",
  "customer_address",
  "delivery_address",
  "contact_person",
  "contact_phone",
  "attention",
  "customer_phone",
  "branch_name",
]);

// Tables we intentionally don't cascade TO (they're sources / parallel /
// archive / unrelated). The audit must surface only true downstream gaps.
const EXCLUDED_TABLES = new Map([
  ["sales_orders", "Source table — header of SO cascade, not a downstream target."],
  ["consignment_orders", "Source table — header of CO cascade, not a downstream target."],
  ["production_orders_archive", "Archive table — immutable by archival policy."],
  ["sales_orders_archive", "Archive table — immutable by archival policy."],
  ["sales_order_items_archive", "Archive table — immutable by archival policy."],
  ["job_cards_archive", "Archive table — immutable by archival policy."],
  ["service_cases", "Parallel entity (service tracking), not a downstream snapshot of SO/CO hub."],
  ["suppliers", "`attention` is purchase-letterhead recipient, NOT a customer hub field."],
  ["drivers", "`contact_person` is the driver's emergency contact, NOT customer hub."],
  ["customer_hubs", "Hub master table — `delivery_address` is the hub's own address, the SOURCE of all downstream hub denormalizations."],
  ["three_pl_providers", "3PL provider master — `contact_person` is the carrier's contact, not a customer hub field."],
  ["other_parties", "Finance Phase 1 — non-trade debtor/creditor registry; `contact_person` is the party's own contact, never derived from a customer hub."],
]);

// camelCase form of the column names — the route source uses these in the
// SQL (Hookka convention: snake_case in migrations, camelCase in the
// runtime SQL via the column-rename map).
function snakeToCamel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Step 1 — schema parse. Scan every migration file for table+column pairs.
// ---------------------------------------------------------------------------
function parseSchemaForHubDerivedColumns() {
  const migrationsDir = resolve(process.cwd(), "migrations-postgres");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // table -> Set<column>. Both CREATE TABLE column defs and ALTER TABLE
  // ADD COLUMN forms contribute.
  const tableColumns = new Map();

  for (const file of files) {
    const path = resolve(migrationsDir, file);
    const sql = readFileSync(path, "utf8");

    // Scan CREATE TABLE blocks. Naive but sufficient — each CREATE TABLE
    // body lasts until the matching ");" at column 0.
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*(?:\(|AS\s+SELECT)/gi;
    let m;
    while ((m = createRe.exec(sql)) !== null) {
      const tableName = m[1];
      // Body extends from the opening paren after the match. Find the
      // matching close paren at start-of-line (";" or ");"). Good enough
      // for the Hookka migration style.
      const start = sql.indexOf("(", m.index + m[0].length - 1);
      if (start < 0) continue;
      // Walk to find matching close — track parens.
      let depth = 1;
      let i = start + 1;
      while (i < sql.length && depth > 0) {
        const ch = sql[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (depth === 0) break;
        i += 1;
      }
      if (depth !== 0) continue;
      const body = sql.slice(start + 1, i);
      // Find every column declaration in the body. The Hookka style is
      // "  col_name TYPE …" at the start of a line.
      const colRe = /^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/gim;
      let cm;
      while ((cm = colRe.exec(body)) !== null) {
        const col = cm[1].toLowerCase();
        if (HUB_DERIVED_COLUMNS.has(col)) {
          if (!tableColumns.has(tableName)) tableColumns.set(tableName, new Set());
          tableColumns.get(tableName).add(col);
        }
      }
    }

    // Scan ALTER TABLE ... ADD COLUMN (... IF NOT EXISTS)? forms.
    // ALTER TABLE foo
    //   ADD COLUMN IF NOT EXISTS bar TEXT,
    //   ADD COLUMN ...
    // We pick up both single-statement and multi-column variants.
    const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(\w+)\s+([\s\S]*?);/gi;
    while ((m = alterRe.exec(sql)) !== null) {
      const tableName = m[1];
      const body = m[2];
      const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      let am;
      while ((am = addRe.exec(body)) !== null) {
        const col = am[1].toLowerCase();
        if (HUB_DERIVED_COLUMNS.has(col)) {
          if (!tableColumns.has(tableName)) tableColumns.set(tableName, new Set());
          tableColumns.get(tableName).add(col);
        }
      }
    }
  }

  return tableColumns;
}

// ---------------------------------------------------------------------------
// Step 2 — route parse. Extract every "UPDATE <table> SET …" referenced
// inside the PATCH /:id/hub handler body of each cascade route.
// ---------------------------------------------------------------------------
function extractCascadeWrites(routePath, endpointMarker) {
  const src = readFileSync(routePath, "utf8");

  // The PATCH /:id/hub handler in both files starts with the
  // marker `app.patch("/:id/hub", async (c) => {` and runs until the
  // matching `});` at column 0. Sufficient for the Hookka style.
  const startIdx = src.indexOf(endpointMarker);
  if (startIdx < 0) {
    throw new Error(`Could not find endpoint marker in ${routePath}: ${endpointMarker}`);
  }
  // Find end of this handler — first `\n});\n` after the marker that
  // closes the arrow function. Brace counting from the opening `{`.
  const handlerOpen = src.indexOf("{", startIdx);
  let depth = 1;
  let i = handlerOpen + 1;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces in handler at ${routePath}`);
  }
  const handlerBody = src.slice(handlerOpen, i);

  // table -> Set<column-camelCase> for every UPDATE inside this handler.
  // Match `UPDATE <table>` then capture everything up to WHERE.
  const updates = new Map();
  const updateRe = /UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)\s+WHERE/gi;
  let m;
  while ((m = updateRe.exec(handlerBody)) !== null) {
    const tableName = m[1].toLowerCase();
    const setBody = m[2];
    // SET col1 = ?, col2 = ?, col3 = ? — column names are the bareword
    // before ` = `. Extract every identifier followed by ` = `.
    const colRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*/g;
    let cm;
    if (!updates.has(tableName)) updates.set(tableName, new Set());
    while ((cm = colRe.exec(setBody)) !== null) {
      updates.get(tableName).add(cm[1]);
    }
  }
  return updates;
}

// ---------------------------------------------------------------------------
// Step 3 — the actual assertion. For every (table, column) the schema says
// exists, fail if the cascade routes don't cover it.
// ---------------------------------------------------------------------------
test(
  "hub-cascade: every downstream table with hub-derived columns is covered " +
    "by SO or CO PATCH /:id/hub cascade",
  () => {
    const schema = parseSchemaForHubDerivedColumns();
    const soWrites = extractCascadeWrites(
      resolve(process.cwd(), "src/api/routes/sales-orders.ts"),
      'app.patch("/:id/hub"',
    );
    const coWrites = extractCascadeWrites(
      resolve(process.cwd(), "src/api/routes/consignment-orders.ts"),
      'app.patch("/:id/hub"',
    );

    const gaps = [];
    for (const [table, cols] of schema.entries()) {
      if (EXCLUDED_TABLES.has(table)) continue;
      for (const snakeCol of cols) {
        const camelCol = snakeToCamel(snakeCol);
        const inSO =
          soWrites.has(table) && soWrites.get(table).has(camelCol);
        const inCO =
          coWrites.has(table) && coWrites.get(table).has(camelCol);
        if (!inSO && !inCO) {
          gaps.push(`${table}.${snakeCol} (camel: ${camelCol})`);
        }
      }
    }

    if (gaps.length > 0) {
      const msg =
        "Hub-cascade gap detected — these downstream table.column pairs " +
        "exist in the schema but no UPDATE was found inside either " +
        "PATCH /:id/hub handler. Either add them to the cascade in " +
        "sales-orders.ts / consignment-orders.ts, or add the table to " +
        "EXCLUDED_TABLES in tests/hub-cascade-completeness.test.mjs " +
        "with a comment explaining why. Gaps:\n  - " +
        gaps.join("\n  - ");
      assert.fail(msg);
    }
  },
);

// ---------------------------------------------------------------------------
// Sanity check on the schema parser itself — we should at minimum find
// the 4 tables the parent session manually audited. If the parser regresses
// (e.g. changes to the CREATE TABLE format break the column extractor),
// we'd get a misleading "all green" without this guard.
// ---------------------------------------------------------------------------
test("hub-cascade: schema parser still finds the known anchor tables", () => {
  const schema = parseSchemaForHubDerivedColumns();
  const required = [
    "sales_orders",
    "consignment_orders",
    "production_orders",
    "delivery_orders",
    "invoices",
    "credit_notes",
    "debit_notes",
    "consignment_notes",
  ];
  const missing = required.filter((t) => !schema.has(t));
  assert.deepEqual(
    missing,
    [],
    `Schema parser is broken — these tables should have hub-derived columns but were not detected: ${missing.join(", ")}. ` +
      "Either the migration files changed shape (update parseSchemaForHubDerivedColumns) " +
      "or these columns really were removed (highly unlikely).",
  );
});

// ---------------------------------------------------------------------------
// BUG-2026-08-19-157 — the blind spot in the test above.
//
// Everything before this line checks ONE handler: PATCH /:id/hub. That is where
// the earlier three bugs lived, so that is where the guard was pointed. But the
// field can be moved from FIVE handlers across two route files, and the guard
// never looked at the other four. Measured 2026-08-19, three of the five did not
// cascade to `fg_units.customerHub`:
//
//   sales-orders  POST /backfill-hub-by-state   no cascade
//   sales-orders  PATCH /:id/hub                no cascade  ← the guarded one
//   consignment-orders  PUT /:id                no cascade
//
// PATCH /:id/hub is the sharpest of them: it faithfully cascades to SEVEN
// downstream tables and misses the one the warehouse actually reads off the box.
//
// Why fg_units specifically. The packing sticker prints `fg_units.customerHub`
// AS STORED — `POST /api/fg-units/generate/:poId` returns the rows verbatim with
// no join back to the order. (The list endpoint at fg-units.ts:596 does compute
// a live `COALESCE(so.hubName, co.hubName)`, which is why the divergence is
// invisible on screen and shows up only on the printed label.) So an order whose
// hub moves without this cascade prints the OLD hub on the box while the order
// shows the new one — which is exactly what the owner reported on 2026-08-19.
//
// A test scoped to one handler proves that handler correct and says nothing
// about the field. This one is scoped to the FIELD.
// ---------------------------------------------------------------------------
test("every handler that moves an order's hub also cascades to fg_units", () => {
  const FILES = [
    "src/api/routes/sales-orders.ts",
    "src/api/routes/consignment-orders.ts",
  ];

  const offenders = [];
  let handlersChecked = 0;

  for (const f of FILES) {
    const lines = readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n");

    // Handler boundaries: each `app.<verb>("<path>"` starts one, and runs to the
    // next one (or EOF). Crude, but these files declare handlers top-level and
    // never nest them.
    const starts = [];
    lines.forEach((l, i) => {
      const m = l.match(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/);
      if (m) starts.push({ line: i, verb: m[1].toUpperCase(), path: m[2] });
    });
    assert.ok(starts.length > 5, `${f}: handler scan found only ${starts.length} routes — the parser is broken`);

    for (let i = 0; i < starts.length; i++) {
      const body = lines
        .slice(starts[i].line, i + 1 < starts.length ? starts[i + 1].line : lines.length)
        .join("\n");

      const movesHub =
        /UPDATE\s+(sales_orders|consignment_orders)[\s\S]{0,400}?hubName\s*=\s*\?/i.test(body);
      if (!movesHub) continue;
      handlersChecked++;

      if (!/UPDATE\s+fg_units\s+SET\s+customerHub/i.test(body)) {
        offenders.push(`${f} → ${starts[i].verb} ${starts[i].path}`);
      }
    }
  }

  // Guard the guard: if the regex stops matching, this test silently passes on
  // zero handlers — the same shape of failure it exists to catch.
  assert.ok(
    handlersChecked >= 5,
    `only ${handlersChecked} hub-moving handlers were found; expected at least 5. ` +
      "The scan is broken, not the code — fix the parser before trusting a pass.",
  );

  assert.deepEqual(
    offenders,
    [],
    "These handlers move an order's hub but never update fg_units.customerHub, " +
      "so the packing sticker will keep printing the old hub:\n  " +
      offenders.join("\n  "),
  );
});

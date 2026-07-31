// ---------------------------------------------------------------------------
// co-status-changes-table.test.mjs — the co_status_changes audit table is
// created lazily at runtime (migrations are inert on deploy, and unlike
// so_status_changes it had NO self-apply). On prod (2026-08-01) this surfaced
// as GET /api/consignment-orders/status-changes → 500 "relation
// co_status_changes does not exist", and every CO cascade's batched
// INSERT+status-UPDATE failed silently (COs never auto-advanced). Structural
// pins: an idempotent ensure helper exists, all four CO cascades call it before
// writing, and the reader ensures the table + spells columns snake_case (coId
// is NOT in the rename map) + guards so it degrades to [] rather than 500.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const helpers = readFileSync(
  resolve(process.cwd(), "src/api/routes/production-orders/_helpers.ts"),
  "utf8",
);
const co = readFileSync(
  resolve(process.cwd(), "src/api/routes/consignment-orders.ts"),
  "utf8",
);

test("ensureCoStatusChangesTable creates the table idempotently, snake_case", () => {
  assert.match(helpers, /export function ensureCoStatusChangesTable\(/);
  assert.match(helpers, /CREATE TABLE IF NOT EXISTS co_status_changes/);
  // physical columns the writers + reader depend on
  for (const col of ["co_id", "from_status", "to_status", "changed_by", "auto_actions"]) {
    assert.ok(helpers.includes(col), `schema must declare ${col}`);
  }
  // memoized like the sibling ensure helpers (one DDL per isolate)
  assert.match(helpers, /coStatusChangesTableEnsured/);
});

test("all four CO cascades ensure the table before their batched write", () => {
  for (const fn of [
    "cascadeUpholsteryToCO",
    "cascadePoCompletionToCO",
    "cascadeCNCompletionToCO",
    "cascadeCNReversalToCO",
  ]) {
    const start = helpers.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${fn} must exist`);
    // the INSERT into co_status_changes must be preceded by an ensure call
    // within the same function body
    const bodyStart = start;
    const nextFn = helpers.indexOf("\nexport async function ", start + 1);
    const body = helpers.slice(bodyStart, nextFn === -1 ? undefined : nextFn);
    assert.ok(
      body.includes("ensureCoStatusChangesTable(db)"),
      `${fn} must call ensureCoStatusChangesTable before writing`,
    );
    assert.ok(
      body.indexOf("ensureCoStatusChangesTable(db)") <
        body.indexOf("INSERT INTO co_status_changes"),
      `${fn} must ensure the table BEFORE the INSERT`,
    );
  }
});

test("the reader ensures the table, uses snake_case columns, and cannot 500", () => {
  assert.match(co, /import \{ ensureCoStatusChangesTable \} from "\.\/production-orders\/_helpers"/);
  const h = co.indexOf('app.get("/status-changes"');
  assert.ok(h >= 0, "status-changes handler must exist");
  const handler = co.slice(h, h + 1600);
  assert.ok(
    handler.includes("ensureCoStatusChangesTable(c.var.DB)"),
    "reader must ensure the table",
  );
  // snake_case column names — coId is NOT in column-rename-map.json, so a
  // camelCase spelling would fold to `coid` and 500 even with the table present
  assert.match(handler, /SELECT id, co_id, from_status, to_status, changed_by/);
  // the SELECT column list itself must NOT carry the unmapped camelCase coId
  const selectLine = handler.slice(
    handler.indexOf("SELECT id,"),
    handler.indexOf("FROM co_status_changes"),
  );
  assert.doesNotMatch(selectLine, /coId/, "SELECT must use co_id, not coId");
  // wrapped so a still-missing table degrades to [] instead of 500
  assert.match(handler, /try \{[\s\S]*co_status_changes[\s\S]*\} catch \{/);
});

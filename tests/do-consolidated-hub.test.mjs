// ---------------------------------------------------------------------------
// do-consolidated-hub.test.mjs — the DO header must take its hub from the SO
// LINES, not from the customer's default hub. BUG-CLASSES.md C3, row 4.
//
// A consolidated DO (many SOs, one DO) has no single salesOrderId, so the hub
// resolution used to fall through to `ORDER BY isDefault DESC LIMIT 1` = Houzs
// KL. On prod that stamped "Houzs KL" on 15 post-guard DOs whose lines were
// 100% Penang / Sarawak / Sabah — the printed address was right, the header
// label was wrong, and every hub/state report saw KL.
//
// Structural test: the create path must derive the hub from the DO's SO lines
// before it reaches the default-hub fallback, and must only accept it when the
// SOs agree on ONE hub (the composition guard's invariant — never guess).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/delivery-orders.ts"),
  "utf8",
);

test("the DO hub is derived from the SO lines before the default-hub fallback", () => {
  const deriveAt = SRC.indexOf("SELECT DISTINCT hubId FROM sales_orders");
  assert.ok(deriveAt >= 0, "must read the distinct hub across the DO's SOs");

  const fallbackAt = SRC.indexOf(
    "SELECT id, shortName, address FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC",
  );
  assert.ok(fallbackAt >= 0, "the default-hub fallback still exists as a last resort");
  assert.ok(
    deriveAt < fallbackAt,
    "the line-derived hub must be resolved BEFORE the default-hub fallback, " +
      "or a consolidated DO keeps taking the customer's default (Houzs KL).",
  );
});

test("the derived hub is accepted only when the SOs agree on exactly one", () => {
  const block = SRC.slice(
    SRC.indexOf("SELECT DISTINCT hubId FROM sales_orders") - 400,
    SRC.indexOf("SELECT DISTINCT hubId FROM sales_orders") + 400,
  );
  assert.match(
    block,
    /distinctHubs\.length === 1/,
    "must require a single distinct hub — more than one means the composition " +
      "guard was bypassed, and we must not guess which branch to bill/route.",
  );
});

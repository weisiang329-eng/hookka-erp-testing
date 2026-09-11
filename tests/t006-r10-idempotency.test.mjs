// T-006 R10 — six create/convert handlers had no idempotency protection: a
// retried request (network blip on the round-trip) could mint a duplicate
// DO, GRN, PI, CN-conversion invoice, or return. sales-orders.ts already had
// the pattern (readIdempotencyKey + withIdempotency, no-op when the client
// sends no Idempotency-Key header) — this just wraps the same six handlers
// the same way. Mechanical, done last per the fix plan's own sequencing.
// Source-static.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TARGETS = [
  { file: "src/api/routes/delivery-orders.ts", resource: "delivery-orders", route: 'app.post("/", async (c) => {' },
  { file: "src/api/routes/grn.ts", resource: "grn", route: 'app.post("/", async (c) => {' },
  { file: "src/api/routes/purchase-invoices.ts", resource: "purchase-invoices", route: 'app.post("/", async (c) => {' },
  { file: "src/api/routes/consignment-notes.ts", resource: "consignment-notes", route: 'app.post("/:id/convert-to-invoice", async (c) => {' },
  { file: "src/api/routes/delivery-returns.ts", resource: "delivery-returns", route: 'app.post("/", async (c) => {' },
  { file: "src/api/routes/purchase-returns.ts", resource: "purchase-returns", route: 'app.post("/", async (c) => {' },
];

for (const { file, resource, route } of TARGETS) {
  const src = readFileSync(file, "utf8");

  test(`${file}: imports the idempotency helpers`, () => {
    assert.match(src, /import \{ readIdempotencyKey, withIdempotency \} from "\.\.\/lib\/idempotency";/);
  });

  test(`${file}: the create/convert handler is wrapped with withIdempotency("${resource}", ...)`, () => {
    const routeIdx = src.indexOf(route);
    assert.ok(routeIdx !== -1, `route "${route}" must exist`);
    const after = src.slice(routeIdx, routeIdx + 1400);
    assert.match(after, /const idemKey = readIdempotencyKey\(c\);/);
    assert.match(
      after,
      new RegExp(`return withIdempotency\\(c, "${resource}", idemKey, async \\(\\) => \\{`),
    );
  });
}

test("withIdempotency is a no-op when the client sends no Idempotency-Key", () => {
  const lib = readFileSync("src/api/lib/idempotency.ts", "utf8");
  assert.match(lib, /if \(!key\) return handler\(\);/);
});

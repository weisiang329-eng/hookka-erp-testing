// ---------------------------------------------------------------------------
// scan-delivery-order-no.test.mjs — an invoice cites its D/O too.
//
// Owner 2026-08-04, on the ADD WOOD invoice: "为什么他的 Supplier DO 也是没有
// 出来？"
//
// Because there was nowhere to put it. The extraction carried ONE `docNo`, and
// the wizard routed it by docType — INVOICE filled Supplier Invoice No.,
// DELIVERY_NOTE filled Supplier DO No. That document prints both:
//
//     INVOICE    : 549389
//     Our D/O No : 549389
//
// so the D/O reference was read past and the DO field could never fill on an
// invoice. It is the only field tying an invoice to the goods actually
// received, which makes it exactly the one worth capturing.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");
const ENGINE = read("src/api/lib/scan-engine.ts");
const MODAL = read("src/components/scan-supplier-modal.tsx");

test("the extractor is asked for the D/O reference as its own field", () => {
  assert.match(ENGINE, /- deliveryOrderNo: the supplier's DELIVERY ORDER number/);
  assert.match(ENGINE, /"deliveryOrderNo": string\|null/);
});

test("it is told to capture it even when it repeats docNo", () => {
  // On this invoice both numbers are 549389; a "skip the duplicate" reading
  // would drop precisely the field that was missing.
  assert.match(ENGINE, /capture it even when it is identical to docNo/);
});

test("the field survives normalisation", () => {
  assert.match(ENGINE, /deliveryOrderNo: str\(raw\.deliveryOrderNo\)/);
});

test("an INVOICE now fills the DO field from it", () => {
  // The old routing left supDoNo empty for docType INVOICE, whatever else the
  // document printed.
  assert.match(MODAL, /if \(!supDoNo && doNo\) supDoNo = doNo;/);
  assert.match(MODAL, /const doNo = \(ex\.deliveryOrderNo \?\? ""\)\.trim\(\);/);
});

test("a delivery note still falls back to its own number", () => {
  // A DN's docNo IS its D/O number — that path must not regress.
  assert.match(
    MODAL,
    /const supDoNo = \(ex\.deliveryOrderNo \?\? ""\)\.trim\(\) \|\| docNo;/,
  );
  assert.match(MODAL, /else if \(dt === "DELIVERY_NOTE"\) supDoNo = docNo;/);
});

test("the type carries it so both wizards can read it", () => {
  assert.match(MODAL, /deliveryOrderNo\?: string \| null;/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVouchersDocument } from "../src/lib/print-voucher.ts";

const spec = (docNo, name) => ({
  title: "PAYMENT VOUCHER",
  company: { name: "Hookka Industries", addressLines: ["A"], regNo: "R", tin: "T", phone: "P", email: "E" },
  docNo, date: "2026-06-01", partyLabel: "Pay To", partyName: name,
  columns: [{ label: "Account" }, { label: "Amount", align: "right" }],
  lines: [{ cells: ["500-0000", "RM 100.00"] }],
  signatures: [{ label: "Prepared by" }], printedOn: "2026-06-25",
});

test("buildVouchersDocument — one .sheet per spec, all docNos present", () => {
  const html = buildVouchersDocument([spec("PV-1", "Alice"), spec("PV-2", "Bob")]);
  assert.equal((html.match(/class="sheet"/g) || []).length, 2);
  assert.ok(html.includes("PV-1") && html.includes("PV-2"));
  assert.ok(html.includes("Alice") && html.includes("Bob"));
  assert.ok(/page-break-after\s*:\s*always/.test(html), "has page-break style");
  assert.equal((html.match(/<html/g) || []).length, 1, "single document");
});

test("buildVouchersDocument — escapes party names", () => {
  const html = buildVouchersDocument([spec("PV-1", "<script>x</script>")]);
  assert.ok(!html.includes("<script>x"), "raw script not present");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("buildVouchersDocument — empty list is a valid empty document", () => {
  const html = buildVouchersDocument([]);
  assert.ok(html.includes("<html") && html.includes("</html>"));
  assert.equal((html.match(/class="sheet"/g) || []).length, 0);
});

// ---------------------------------------------------------------------------
// intercompany-mirror.test.mjs — Multi-Company Phase 3 dual-identity + mirror
// decision. Pure-function tests (no DB) that pin the ADDITIVE guarantees:
//
//   • dual-identity flag: resolveGroupOrgCode / readGroupOrgCode default OFF
//     ('' = a normal external party) and only turn on for a real code;
//   • the mirror fires ONLY for a flagged SISTER group-company counterparty;
//   • an EXTERNAL PO (supplier not a group company) creates NO mirror;
//   • a PO raised on the buyer entity itself does NOT mirror onto itself;
//   • the global auto-create-mirror config OFF suppresses the mirror entirely.
//
// The idempotency guard (no dup mirror on retry) is enforced at the DB layer
// via intercompany_mirror_log's UNIQUE (source_type, source_id) +
// INSERT ... ON CONFLICT DO NOTHING in intercompany-mirror-create.ts; the
// pure decision here is what gates whether we ever reach that DB path.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping handles it on Node 22+.
}

let m;
try {
  m = await import(
    pathToFileURL(resolve(process.cwd(), "src/lib/intercompany-mirror.ts")).href
  );
} catch (err) {
  console.warn(
    "[intercompany-mirror.test] Could not import module. " +
      `tsx loader registered: ${loaderRegistered}.`,
  );
  console.warn("[intercompany-mirror.test] Error:", err?.message ?? err);
  throw err;
}

const GROUP_ORGS = [
  { code: "HOOKKA", name: "Hookka Industries Sdn Bhd" },
  { code: "OHANA", name: "Ohana Marketing Sdn Bhd" },
  { code: "HOUZS", name: "Houzs Century" },
  { code: "HKMFG", name: "HK Manufacturing" },
];

// ---------------------------------------------------------------------------
// Dual-identity flag — default OFF, only a real code turns it on.
// ---------------------------------------------------------------------------
test("resolveGroupOrgCode: omitted/blank/non-string → '' (external, default off)", () => {
  assert.equal(m.resolveGroupOrgCode(undefined), "");
  assert.equal(m.resolveGroupOrgCode(null), "");
  assert.equal(m.resolveGroupOrgCode(""), "");
  assert.equal(m.resolveGroupOrgCode("   "), "");
  assert.equal(m.resolveGroupOrgCode(123), "");
  assert.equal(m.resolveGroupOrgCode({}), "");
});

test("resolveGroupOrgCode: a real code is trimmed + uppercased", () => {
  assert.equal(m.resolveGroupOrgCode("houzs"), "HOUZS");
  assert.equal(m.resolveGroupOrgCode("  OhAnA  "), "OHANA");
});

test("readGroupOrgCode: camel wins, then snake, then '' ", () => {
  assert.equal(m.readGroupOrgCode("HOUZS", "OHANA"), "HOUZS");
  assert.equal(m.readGroupOrgCode(null, "OHANA"), "OHANA");
  assert.equal(m.readGroupOrgCode(undefined, undefined), "");
  assert.equal(m.readGroupOrgCode("", ""), "");
});

// ---------------------------------------------------------------------------
// resolveSupplierSisterOrg — who is a mirror-eligible sister.
// ---------------------------------------------------------------------------
test("sister resolves from an explicit group_org_code", () => {
  assert.equal(
    m.resolveSupplierSisterOrg({ isGroupCompany: true, groupOrgCode: "HOUZS" }),
    "HOUZS",
  );
  // explicit code even without isGroupCompany still counts (the code IS the flag)
  assert.equal(
    m.resolveSupplierSisterOrg({ isGroupCompany: false, groupOrgCode: "ohana" }),
    "OHANA",
  );
});

test("sister falls back to NAME match when flagged group but no code", () => {
  assert.equal(
    m.resolveSupplierSisterOrg({
      isGroupCompany: true,
      groupOrgCode: "",
      supplierName: "Houzs Century Sdn Bhd",
      groupOrgs: GROUP_ORGS,
    }),
    "HOUZS",
  );
});

test("sister is '' when NOT flagged and no code (a normal external supplier)", () => {
  assert.equal(
    m.resolveSupplierSisterOrg({
      isGroupCompany: false,
      groupOrgCode: "",
      supplierName: "Some Random Trading Sdn Bhd",
      groupOrgs: GROUP_ORGS,
    }),
    "",
  );
});

test("sister is '' when the supplier IS the buyer entity (no self-mirror)", () => {
  assert.equal(
    m.resolveSupplierSisterOrg({
      isGroupCompany: true,
      groupOrgCode: "HOOKKA",
      buyerOrgCode: "HOOKKA",
    }),
    "",
  );
});

// ---------------------------------------------------------------------------
// decidePurchaseOrderMirror — the full gate.
// ---------------------------------------------------------------------------
test("mirror FIRES for a flagged sister-company supplier (Houzs)", () => {
  const d = m.decidePurchaseOrderMirror({
    autoCreateMirrorDocs: true,
    purchaseOrgCode: "HOOKKA",
    supplier: { isGroupCompany: true, groupOrgCode: "HOUZS", name: "Houzs Century" },
    groupOrgs: GROUP_ORGS,
  });
  assert.equal(d.mirror, true);
  assert.equal(d.sisterOrgCode, "HOUZS");
  assert.equal(d.buyerOrgCode, "HOOKKA");
});

test("mirror does NOT fire for an EXTERNAL supplier (byte-identical to before)", () => {
  const d = m.decidePurchaseOrderMirror({
    autoCreateMirrorDocs: true,
    purchaseOrgCode: "HOOKKA",
    supplier: { isGroupCompany: false, groupOrgCode: "", name: "ABC Timber Sdn Bhd" },
    groupOrgs: GROUP_ORGS,
  });
  assert.equal(d.mirror, false);
});

test("mirror does NOT fire when the global config is OFF", () => {
  const d = m.decidePurchaseOrderMirror({
    autoCreateMirrorDocs: false,
    purchaseOrgCode: "HOOKKA",
    supplier: { isGroupCompany: true, groupOrgCode: "HOUZS", name: "Houzs Century" },
    groupOrgs: GROUP_ORGS,
  });
  assert.equal(d.mirror, false);
});

test("mirror does NOT fire for a PO booked on the buyer's own supplier record", () => {
  const d = m.decidePurchaseOrderMirror({
    autoCreateMirrorDocs: true,
    purchaseOrgCode: "HOOKKA",
    supplier: { isGroupCompany: true, groupOrgCode: "HOOKKA", name: "Hookka Industries" },
    groupOrgs: GROUP_ORGS,
  });
  assert.equal(d.mirror, false);
});

test("mirror fires with a legacy row flagged only via isGroupCompany (name match)", () => {
  const d = m.decidePurchaseOrderMirror({
    autoCreateMirrorDocs: true,
    purchaseOrgCode: "HOOKKA",
    supplier: { isGroupCompany: true, groupOrgCode: "", name: "Ohana Marketing Sdn Bhd" },
    groupOrgs: GROUP_ORGS,
  });
  assert.equal(d.mirror, true);
  assert.equal(d.sisterOrgCode, "OHANA");
});

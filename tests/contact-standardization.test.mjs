// ---------------------------------------------------------------------------
// contact-standardization.test.mjs — CRM redesign slice 4 (owner 2026-07-30):
// system-wide standardisation of phone, email, and delivery-hub state.
//
//   · PhoneInput  — country dial-code picker (default +60) + local number.
//   · isValidEmail — one shared email-shape validator.
//   · StateSelect — the canonical hub state-CODE picker (KL/SGR/PG…), which is
//     what the 3PL rate + transit-day engine keys on (NOT a full state name).
// Applied across Leads (add/detail/convert) and Customers (add/edit/hub forms).
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = resolve(process.cwd(), "src/lib/contact-format.ts");
const PHONE = resolve(process.cwd(), "src/components/ui/phone-input.tsx");
const STATE = resolve(process.cwd(), "src/components/ui/state-select.tsx");
const LEADS = resolve(process.cwd(), "src/pages/leads/index.tsx");
const CUST = resolve(process.cwd(), "src/pages/customers.tsx");

const read = (p) => readFileSync(p, "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

// ===========================================================================
// Shared helpers + components
// ===========================================================================

test("contact-format: +60 default, phone split/join, email, hub codes", async () => {
  const mod = await import(pathToFileURL(resolve(process.cwd(), "src/lib/contact-format.ts")).href);
  assert.equal(mod.DEFAULT_DIAL_CODE, "+60");
  assert.ok(mod.COUNTRY_DIAL_CODES.some((c) => c.code === "+60"));
  assert.ok(mod.COUNTRY_DIAL_CODES.length > 5, "must offer international codes");
  // Legacy free-text falls under +60; a +65 prefix is recognised.
  assert.deepEqual(mod.splitPhone("011-6151 1613"), { dial: "+60", local: "011-6151 1613" });
  assert.deepEqual(mod.splitPhone("+65 9123 4567"), { dial: "+65", local: "9123 4567" });
  assert.equal(mod.joinPhone("+60", "12-345 6789"), "+60 12-345 6789");
  assert.equal(mod.joinPhone("+60", ""), "", "blank number stays blank, not a bare dial code");
  assert.equal(mod.isValidEmail(""), true);
  assert.equal(mod.isValidEmail("a@b.co"), true);
  assert.equal(mod.isValidEmail("nope"), false);
  // Hub state stays a CODE list (rate/transit engine), never full names.
  assert.ok(mod.HUB_STATE_CODES.includes("SGR"));
  assert.ok(!mod.HUB_STATE_CODES.some((s) => /selangor/i.test(s)));
});

test("PhoneInput + StateSelect components exist", () => {
  assert.match(flat(PHONE), /export function PhoneInput/);
  assert.match(flat(PHONE), /COUNTRY_DIAL_CODES\.map/);
  assert.match(flat(STATE), /export function StateSelect/);
  assert.match(flat(STATE), /HUB_STATE_CODES\.map/);
});

// ===========================================================================
// Applied across the forms
// ===========================================================================

test("Leads use the shared inputs (add form, detail drawer, convert)", () => {
  const f = flat(LEADS);
  assert.match(f, /import \{ PhoneInput \} from "@\/components\/ui\/phone-input"/);
  assert.match(f, /import \{ StateSelect \} from "@\/components\/ui\/state-select"/);
  assert.match(f, /import \{ isValidEmail \} from "@\/lib\/contact-format"/);
  assert.match(f, /<PhoneInput value=\{form\.phone\}/, "add form phone");
  assert.match(f, /<PhoneInput value=\{draft\.phone\}/, "drawer phone");
  assert.match(f, /<PhoneInput value=\{f\.phone\}/, "convert PIC phone");
  assert.match(f, /<StateSelect value=\{f\.hubState\}/, "convert hub state");
  // The email validator delegates to the shared one (single source of truth).
  assert.match(f, /function emailValid\(v: string\): boolean \{ return isValidEmail\(v\); \}/);
});

test("Customers page uses the shared inputs; inline hub-state array is gone", () => {
  const f = flat(CUST);
  assert.match(f, /import \{ PhoneInput \} from "@\/components\/ui\/phone-input"/);
  assert.match(f, /import \{ StateSelect \} from "@\/components\/ui\/state-select"/);
  assert.match(f, /<PhoneInput value=\{addForm\.phone\}/, "add customer phone");
  assert.match(f, /<PhoneInput value=\{editCustForm\.phone\}/, "edit customer phone");
  assert.match(f, /<PhoneInput value=\{hubForm\.phone\}/, "hub phone");
  assert.match(f, /<StateSelect value=\{hubForm\.state\}/, "hub state");
  // The duplicated inline code arrays were removed in favour of StateSelect.
  assert.doesNotMatch(f, /\["KL","SGR","PG","JB","SRW","SBH","IPH","MLK","KCH","KB","KT"\]/);
});

test("Supplier form uses the shared phone input + email validation", () => {
  const f = readFileSync(resolve(process.cwd(), "src/pages/procurement/supplier-form-dialog.tsx"), "utf8").replace(/\s+/g, " ");
  assert.match(f, /import \{ PhoneInput \} from "@\/components\/ui\/phone-input"/);
  assert.match(f, /import \{ isValidEmail \} from "@\/lib\/contact-format"/);
  assert.match(f, /<PhoneInput value=\{phone\}/);
  // Malformed email blocks save.
  assert.match(f, /if \(!isValidEmail\(email\)\) return;/);
});

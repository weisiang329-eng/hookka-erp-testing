// Importing a bought contact list without wrecking anything.
//
// Every rule here came from running the planner over the real file the owner
// supplied — SSM DATA Penang.xlsx, 1,029 rows scraped from Google Maps across
// four industry sheets — and looking at what came out. The examples below are
// verbatim rows from it, kept as the test data on purpose: a synthetic
// "Test Company Sdn Bhd" would not have caught the keyword-stuffed titles or
// the tracking suffix, because nobody writes those by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone,
  normalizeCompany,
  cleanWebsite,
  cleanCompanyName,
  cleanLocation,
  planImport,
  makeBatchLabel,
} from "../src/lib/lead-import.ts";

test("one phone number spelled four ways is one lead", () => {
  const key = normalizePhone("+60 10-248 6699");
  assert.equal(key, "60102486699");
  for (const variant of ["010-2486699", "0102486699", "+60102486699", "0060102486699"]) {
    assert.equal(normalizePhone(variant), key, variant);
  }
});

test("a fragment is not a phone number and must not become one", () => {
  // A scraped cell can hold an opening-hours string or a house number. Those
  // must read as "no phone", not as a short key that collides with every other
  // short key and silently merges unrelated businesses.
  for (const junk of ["", null, undefined, "—", "12345", "Mon-Fri"]) {
    assert.equal(normalizePhone(junk), "", String(junk));
  }
});

test("the Google Maps tracking suffix is stripped from the website", () => {
  // The cell holds a LITERAL backslash-u sequence, not a decoded "=".
  assert.equal(
    cleanWebsite("https://www.beezstorybabyhouse.com/&opi\\u003d79508299"),
    "https://www.beezstorybabyhouse.com/",
  );
  assert.equal(
    cleanWebsite("https://www.facebook.com/golden9090&opi=79508299"),
    "https://www.facebook.com/golden9090",
  );
  assert.equal(cleanWebsite("https://plain.example.com/"), "https://plain.example.com/");
  assert.equal(cleanWebsite(null), null);
});

test("a keyword-stuffed listing title is reduced to the business name", () => {
  assert.equal(
    cleanCompanyName(
      "Meiko Upholstery Specialist, Sofa Repair, Customize, baik pulih, Penang, Malaysia",
    ),
    "Meiko Upholstery Specialist",
  );
});

test("an ordinary name with a comma is left completely alone", () => {
  // The cut only applies to titles that actually look stuffed. Over-trimming
  // would be worse than not trimming: a salesperson cannot ring a name that
  // has been mangled.
  for (const name of [
    "CT Perabot Bandar Berda",
    "ABC Trading, Penang",
    "Carte Kitchen Cabinet Specialist (Bayan Lepas Showroom)",
  ]) {
    assert.equal(cleanCompanyName(name), name, name);
  }
});

test("the address does not repeat the company name back at you", () => {
  assert.equal(
    cleanLocation("Meiko Upholstery Specialist, Sofa Repair, Penang", "Meiko Upholstery Specialist"),
    "Sofa Repair, Penang",
  );
  assert.equal(cleanLocation("Bukit Mertajam", "Beez Story Baby House"), "Bukit Mertajam");
  assert.equal(cleanLocation("", "Anything"), null);
});

test("a row nobody can contact is skipped, not imported as a dead name", () => {
  const plan = planImport([
    { company: "No Phone Co" },
    { phone: "+60 12-345 6789" },
    { company: "Good Co", phone: "+60 12-345 6789" },
  ]);
  assert.equal(plan.summary.insert, 1);
  assert.equal(plan.summary.noPhone, 1);
  assert.equal(plan.summary.noCompany, 1);
  assert.equal(plan.insert[0].company, "Good Co");
});

test("two branches sharing a phone collapse, but the other branch is recorded", () => {
  // Verbatim from the Penang file. One phone is one conversation, so these
  // become one lead — but "we also saw a Bukit Mertajam showroom" is real
  // information and must survive the merge.
  const plan = planImport([
    { company: "Carte Kitchen Cabinet Specialist (Bayan Lepas Showroom)", phone: "+60 11-1111 1111" },
    { company: "Carte Kitchen Cabinet Specialist (Bukit Mertajam Showroom)", phone: "011-11111111" },
  ]);
  assert.equal(plan.summary.insert, 1);
  assert.equal(plan.summary.duplicateInFile, 1);
  assert.deepEqual(plan.insert[0].alsoListedAs, [
    "Carte Kitchen Cabinet Specialist (Bukit Mertajam Showroom)",
  ]);
});

test("re-importing an overlapping list does not create a second copy", () => {
  // The second import of a bought list is where duplicates really come from.
  const first = planImport([{ company: "Meiko", phone: "+60 10-248 6699" }]);
  const second = planImport(
    [{ company: "Meiko Upholstery", phone: "010-2486699" }],
    first.insert.map((r) => r.phoneKey),
  );
  assert.equal(second.summary.insert, 0);
  assert.equal(second.summary.alreadyInSystem, 1);
});

test("the summary counts how many arrive with no email, because this list is all of them", () => {
  const plan = planImport([
    { company: "A", phone: "+60 11-1111 1111" },
    { company: "B", phone: "+60 12-2222 2222", email: "b@example.com" },
  ]);
  assert.equal(plan.summary.withoutEmail, 1);
});

test("planning writes nothing — the operator sees the damage before agreeing to it", () => {
  const rows = [{ company: "A", phone: "+60 11-1111 1111" }];
  const snapshot = JSON.stringify(rows);
  planImport(rows);
  assert.equal(JSON.stringify(rows), snapshot, "planImport mutated its input");
});

test("every import carries a batch label so a bad list can be removed whole", () => {
  assert.equal(makeBatchLabel("Penang", "2026-08-19T10:00:00Z"), "penang-2026-08-19");
  assert.equal(makeBatchLabel("SSM DATA Penang", "2026-08-19"), "ssm-data-penang-2026-08-19");
  assert.equal(makeBatchLabel("", "2026-08-19"), "2026-08-19");
});

test("normalizeCompany ignores the suffixes that make one shop look like two", () => {
  assert.equal(
    normalizeCompany("Soon Seng Rattan Sdn Bhd"),
    normalizeCompany("soon seng rattan"),
  );
});

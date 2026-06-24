import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/amount-in-words.ts")).href);

test("amountInWords — ringgit + sen (owner's sample)", () => {
  // 123450 sen = RM 1,234.50
  assert.equal(
    m.amountInWords(123450),
    "Ringgit One Thousand Two Hundred And Thirty Four And Sen Fifty Only",
  );
});

test("amountInWords — whole ringgit drops the sen clause", () => {
  assert.equal(m.amountInWords(100000), "Ringgit One Thousand Only");
  assert.equal(m.amountInWords(500), "Ringgit Five Only");
  assert.equal(m.amountInWords(1200), "Ringgit Twelve Only");
});

test("amountInWords — exact thousands", () => {
  assert.equal(m.amountInWords(1000000), "Ringgit Ten Thousand Only");
  assert.equal(m.amountInWords(2500000), "Ringgit Twenty Five Thousand Only");
  // 100 thousand exactly
  assert.equal(m.amountInWords(10000000), "Ringgit One Hundred Thousand Only");
});

test("amountInWords — sen only", () => {
  assert.equal(m.amountInWords(50), "Ringgit Zero And Sen Fifty Only");
  assert.equal(m.amountInWords(5), "Ringgit Zero And Sen Five Only");
  assert.equal(m.amountInWords(99), "Ringgit Zero And Sen Ninety Nine Only");
});

test("amountInWords — zero", () => {
  assert.equal(m.amountInWords(0), "Ringgit Zero Only");
});

test("amountInWords — large (millions) with sen", () => {
  // 123456789 sen = RM 1,234,567.89
  assert.equal(
    m.amountInWords(123456789),
    "Ringgit One Million Two Hundred And Thirty Four Thousand Five Hundred And Sixty Seven And Sen Eighty Nine Only",
  );
});

test("amountInWords — hundreds joined with 'And'", () => {
  // 23400 sen = RM 234.00
  assert.equal(m.amountInWords(23400), "Ringgit Two Hundred And Thirty Four Only");
  // 20000 sen = RM 200.00 (no tens/units after hundred)
  assert.equal(m.amountInWords(20000), "Ringgit Two Hundred Only");
  // 10100 sen = RM 101.00 (hundred + one, no tens)
  assert.equal(m.amountInWords(10100), "Ringgit One Hundred And One Only");
});

test("amountInWords — teens and tens", () => {
  assert.equal(m.amountInWords(1500), "Ringgit Fifteen Only");
  assert.equal(m.amountInWords(2000), "Ringgit Twenty Only");
  assert.equal(m.amountInWords(4200), "Ringgit Forty Two Only");
});

test("amountInWords — rounds fractional sen and handles negatives", () => {
  assert.equal(m.amountInWords(123450.4), "Ringgit One Thousand Two Hundred And Thirty Four And Sen Fifty Only");
  assert.equal(m.amountInWords(-100000), "Minus Ringgit One Thousand Only");
});

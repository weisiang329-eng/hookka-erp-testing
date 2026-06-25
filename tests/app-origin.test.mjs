// canonicalizeOrigin — the ONE rule for which origin gets baked into a QR /
// printed link. Owner 2026-06-26: the legacy prod pages.dev domain is old; show
// erp.hookka.com where possible. Staging/preview/custom/localhost MUST be left
// untouched or a QR would point at the wrong site/DB.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping on newer Node.
}

const { canonicalizeOrigin } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/app-origin.ts")).href
);

test("prod fallback pages.dev → the official erp.hookka.com", () => {
  assert.equal(
    canonicalizeOrigin("https://hookka-erp-testing.pages.dev"),
    "https://erp.hookka.com",
  );
});

test("the official custom domain is unchanged", () => {
  assert.equal(
    canonicalizeOrigin("https://erp.hookka.com"),
    "https://erp.hookka.com",
  );
});

test("STAGING is unchanged (its QRs must resolve against staging's own DB)", () => {
  assert.equal(
    canonicalizeOrigin("https://staging.hookka-erp-testing.pages.dev"),
    "https://staging.hookka-erp-testing.pages.dev",
  );
});

test("a preview deploy host is unchanged", () => {
  assert.equal(
    canonicalizeOrigin("https://abc1234.hookka-erp-testing.pages.dev"),
    "https://abc1234.hookka-erp-testing.pages.dev",
  );
});

test("localhost is unchanged", () => {
  assert.equal(canonicalizeOrigin("http://localhost:5173"), "http://localhost:5173");
});

test("garbage / empty origin is returned as-is (never throws)", () => {
  assert.equal(canonicalizeOrigin(""), "");
  assert.equal(canonicalizeOrigin("not a url"), "not a url");
});

// ---------------------------------------------------------------------------
// humanize-error.test.mjs — locks the operator-safe error translator.
// Owner rule: never show an HTTP code, raw backend exception, DB field name,
// or stack noise. Keep a clean backend sentence; replace anything technical.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const { humanizeError } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/humanize-error.ts")).href
);

const noTech = (s) => {
  assert.doesNotMatch(s, /HTTP\s*\d|\b\d{3}\b|constraint|NOT NULL|violates|_id\b|\/api\/|TypeError|undefined/i, `leaked tech: ${s}`);
};

test("keeps a clean human backend message", () => {
  assert.equal(
    humanizeError({ status: 409, message: "Order already confirmed" }),
    "Order already confirmed",
  );
  assert.equal(
    humanizeError({ status: 422, message: "Customer name is required" }),
    "Customer name is required",
  );
});

test("HTTP-code fallback message is replaced (500 → our-side line, not the code)", () => {
  const out = humanizeError({ status: 500, message: "HTTP 500 from /api/orders" });
  noTech(out);
  assert.match(out, /our side/i);
});

test("specific status beats a generic caller fallback (409 → linked-records line)", () => {
  const out = humanizeError(
    { status: 409, message: "HTTP 409 from /api/x" },
    "Delete failed",
  );
  noTech(out);
  assert.match(out, /linked to other records/i);
});

test("403 with no message → not-allowed line", () => {
  const out = humanizeError({ status: 403 }, "Save failed");
  noTech(out);
  assert.match(out, /not allowed/i);
});

test("postgres constraint / duplicate-key text is never shown", () => {
  const out = humanizeError({
    message: 'duplicate key value violates unique constraint "ux_invoices_invoice_no"',
  });
  noTech(out);
});

test("bare DB column name is never shown", () => {
  noTech(humanizeError("vehicle_id"));
  noTech(humanizeError({ message: "job_cards.pic1Id" }));
});

test("JS TypeError / stack noise is never shown", () => {
  noTech(humanizeError(new TypeError("Cannot read properties of undefined (reading 'x')")));
  noTech(humanizeError({ message: "boom at handler (app.ts:42:9)" }));
});

test("network error (status 0) → connection line", () => {
  const out = humanizeError({ status: 0, message: "Network error while requesting /api/x" });
  noTech(out);
  assert.match(out, /network|connection/i);
});

test("recovers status from a raw 'HTTP 503' string (no status field)", () => {
  const out = humanizeError(new Error("HTTP 503 Service Unavailable"));
  noTech(out);
  assert.match(out, /our side/i);
});

test("caller fallback is used when no clean message and no specific status", () => {
  assert.equal(humanizeError(undefined, "Couldn't load the page"), "Couldn't load the page");
  assert.equal(
    humanizeError({ status: 500, message: "Invalid JSON from /api/x" }, "Couldn't save the order"),
    "Couldn't save the order",
  );
});

test("total junk with no context → safe generic line", () => {
  const out = humanizeError(null);
  noTech(out);
  assert.match(out, /try again/i);
});

test("schema-mismatch internal text is never shown", () => {
  noTech(humanizeError({ status: 200, message: "Response shape from /api/x did not match schema" }, "Couldn't load"));
});

// ── False-positive guards: now that this runs on EVERY error toast, legit
// human messages (with numbers / ordinary words) must survive untouched. ──
test("keeps a clean message that merely contains a number", () => {
  assert.equal(humanizeError("Order #500 not found in this batch"), "Order #500 not found in this batch");
  assert.equal(humanizeError("Only 3 units left in stock"), "Only 3 units left in stock");
});

test("keeps a plain 'Failed to load X' fallback (not the bare browser error)", () => {
  assert.equal(humanizeError("Failed to load orders"), "Failed to load orders");
  assert.equal(humanizeError("Couldn't delete — this customer has open orders"), "Couldn't delete — this customer has open orders");
});

test("bare browser network message → connection line", () => {
  const out = humanizeError("Failed to fetch");
  noTech(out);
  assert.match(out, /network|connection/i);
});

test("'X does not exist' without postgres quoting is kept (only column/relation \"..\" is stripped)", () => {
  assert.equal(humanizeError("This product no longer exists"), "This product no longer exists");
  noTech(humanizeError('column "vehicle_id" does not exist'));
});

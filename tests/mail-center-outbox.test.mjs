// ---------------------------------------------------------------------------
// mail-center-outbox.test.mjs
//
// Locks the "Auto-sent emails" visibility surface (owner 2026-06-24: the
// customer DO/Invoice notices go out from noreply@, so there was no way to SEE
// whether they actually sent — "因為是 noreply 所以看到不到"). We added a
// READ-ONLY view of the durable notification outbox (outbox_emails) inside the
// Mail Center.
//
// These are source-assertion tests (same style as
// production-list-cache-invalidate.test.mjs): cheap, deterministic, and they
// pin the contract so a refactor can't silently drop the endpoint, leak the
// attachment blobs, or remove the org scoping.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTE = readFileSync(
  resolve(process.cwd(), "src/api/routes/mail-center.ts"),
  "utf8",
);
const PAGE = readFileSync(
  resolve(process.cwd(), "src/pages/mail-center/index.tsx"),
  "utf8",
);

test("mail-center exposes read-only auto-sent outbox endpoints", () => {
  assert.match(
    ROUTE,
    /app\.get\("\/outbox",/,
    "GET /outbox (list) endpoint must exist",
  );
  assert.match(
    ROUTE,
    /app\.get\("\/outbox\/:id",/,
    "GET /outbox/:id (detail) endpoint must exist",
  );
  assert.match(
    ROUTE,
    /FROM\s+outbox_emails/,
    "the endpoint must read the durable notification outbox (outbox_emails)",
  );
  // Org-scoped read — the detail SELECT is keyed on org_id AND id.
  assert.match(
    ROUTE,
    /WHERE org_id = \? AND id = \? LIMIT 1/,
    "the outbox detail read must be org-scoped",
  );
});

test("the outbox read never ships attachment base64 to the client", () => {
  const start = ROUTE.indexOf("function outboxAttachmentNames");
  assert.ok(start >= 0, "outboxAttachmentNames helper must exist");
  const helper = ROUTE.slice(start, start + 500);
  assert.match(helper, /filename/, "must surface attachment filenames");
  assert.doesNotMatch(
    helper,
    /contentBase64/,
    "must NOT surface the base64 attachment blobs (names only)",
  );
});

test("Mail Center FE has the Auto-sent folder backed by the outbox panel", () => {
  assert.match(PAGE, /"autosent"/, "the Folder union must include 'autosent'");
  assert.match(
    PAGE,
    /label="Auto-sent"/,
    "the left rail must render an Auto-sent folder button",
  );
  assert.match(
    PAGE,
    /function OutboxPanel\(/,
    "the OutboxPanel component must exist",
  );
  assert.match(
    PAGE,
    /\/api\/mail-center\/outbox/,
    "OutboxPanel must fetch the outbox endpoint",
  );
  // The reader renders the saved email in a sandboxed iframe. Links may open,
  // but message scripts must never execute.
  assert.match(
    PAGE,
    /sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"/,
    "the body must render in the approved sandbox",
  );
  assert.doesNotMatch(
    PAGE,
    /sandbox="[^"]*allow-scripts[^"]*"/,
    "the body sandbox must never allow message scripts",
  );
});

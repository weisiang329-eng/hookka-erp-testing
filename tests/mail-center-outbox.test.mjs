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
  // The reader renders the saved email in a SANDBOXED iframe.
  //
  // 2026-08-01: this asserted the exact string sandbox="" (maximum lockdown).
  // The attribute later gained allow-same-origin so the onLoad handler can read
  // contentWindow.document.body.scrollHeight and auto-size the frame - and the
  // test went red unnoticed, because it was never registered in `npm test`.
  //
  // Asserting an exact attribute string was the wrong test. What actually keeps
  // this safe is that scripts cannot run: `allow-same-origin` is only dangerous
  // when paired with `allow-scripts`, which would let framed content reach the
  // parent origin. So pin THAT property instead - it is the invariant that
  // matters and it survives future additions to the allow-list.
  assert.match(PAGE, /sandbox="[^"]*"/, "the body must render in a sandboxed iframe");
  const sandboxAttrs = [...PAGE.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(sandboxAttrs.length > 0, "sanity: at least one sandboxed iframe");
  for (const attr of sandboxAttrs) {
    assert.ok(
      !/allow-scripts/.test(attr),
      `sandbox must never grant allow-scripts (got "${attr}") - with allow-same-origin that lets email HTML reach the parent origin`,
    );
  }
});

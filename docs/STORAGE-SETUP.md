# R2 File Storage — Admin Runbook

**Status:** Scaffold landed 2026-04-25. The `[[r2_buckets]]` binding in
`wrangler.toml` is commented out; the route layer
(`src/api/routes-d1/files.ts`) is gated to return `503 service
unavailable` until the binding is live, so the build is green today and
the file API activates the moment the admin provisions the bucket.

This doc is the step-by-step the admin runs to take Phase B.4 ("R2 file
storage") from scaffold to live.

---

## What this delivers

A first-class file storage path for the ERP. Today, attachments
(invoice PDFs, BOM technical drawings, SO supporting docs) have no
durable home — they're either inlined in DB blobs or live on someone's
desktop. With R2 wired:

* `POST /api/files` accepts multipart uploads tied to a
  `(resourceType, resourceId)` pair.
* `GET /api/files/:id/download` 302-redirects to a 5-minute presigned
  URL — no Worker bandwidth burnt streaming the file.
* `DELETE /api/files/:id` removes both the DB row and the R2 object.
* Multi-tenant safe: every key is prefixed with `<orgId>/...` so a
  bucket walk can't surface another tenant's files.

---

## Step 1 — Provision the bucket

```bash
wrangler r2 bucket create hookka-files
```

Verify:

```bash
wrangler r2 bucket list
```

`hookka-files` should appear.

Optional but recommended:

```bash
# Lifecycle: auto-delete files older than 7 years (compliance retention)
wrangler r2 bucket lifecycle add hookka-files \
  --rule '{"id":"expire-7y","filter":{"prefix":""},"action":{"expire":{"days":2555}}}'

# CORS so the SPA can do direct-upload presigned PUTs in a future phase
wrangler r2 bucket cors put hookka-files \
  --origins "https://hookka-erp-testing.pages.dev" \
  --methods GET,HEAD,PUT \
  --headers "*"
```

---

## Step 2 — Apply the migration

The D1 + Postgres mirror migrations are `0055_file_assets.sql`. Run:

```bash
# D1 (hookka-erp-db)
wrangler d1 migrations apply hookka-erp-db --remote

# Postgres / Supabase
node scripts/apply-postgres-migrations.mjs
```

---

## Step 3 — Uncomment the binding in `wrangler.toml`

In the repo root, edit `wrangler.toml` and remove the leading `# ` from
the `[[r2_buckets]]` block under the *"Phase B.4"* heading:

```toml
[[r2_buckets]]
binding = "FILES"
bucket_name = "hookka-files"
```

Commit, push, let the deploy workflow promote.

---

## Step 4 — Mount the route in `worker.ts`

Add to `src/api/worker.ts` alongside the other route imports + mounts:

```ts
import files from "./routes-d1/files";
// ...
app.route("/api/files", files);
```

Commit, push, redeploy.

---

## Step 5 — Smoke test

```bash
TOKEN="<an admin bearer token>"

# Upload an invoice PDF
curl -X POST https://hookka-erp-testing.pages.dev/api/files \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./test.pdf" \
  -F "resourceType=invoice" \
  -F "resourceId=INV-12345"

# Returns { success: true, data: { id: "fa-...", r2Key: "...", ... } }

# Download it (follows the 302 to a presigned URL)
curl -L https://hookka-erp-testing.pages.dev/api/files/fa-XXX/download \
  -H "Authorization: Bearer $TOKEN" -o downloaded.pdf

# Delete it
curl -X DELETE https://hookka-erp-testing.pages.dev/api/files/fa-XXX \
  -H "Authorization: Bearer $TOKEN"
```

If any step returns `503 file storage unavailable`, the binding isn't
wired — re-check Steps 1 and 3.

---

## Step 6 — Rollback

If something goes wrong, comment the `[[r2_buckets]]` block back out
and redeploy. The route returns 503 cleanly. To delete the bucket
entirely:

```bash
# Empty first
wrangler r2 object delete hookka-files --prefix=""

# Then delete the bucket
wrangler r2 bucket delete hookka-files
```

---

## What ships next (out of scope for this scaffold)

* Direct-upload presigned PUTs so the browser uploads to R2 without
  proxying through the Worker (current ceiling: 50 MB).
* Virus scanning (ClamAV via a Worker Durable Object) before serving
  downloads.
* Versioning: keep prior N versions of an attachment and surface a
  history UI.
* Per-org access control: today the orgId-prefix prevents cross-tenant
  leaks at the bucket layer; the route layer additionally enforces
  `orgId = ?` on every query so this is defense-in-depth.

See `docs/ROADMAP-PHASE-C.md` and `docs/ENTERPRISE-ERP-ARCHITECTURE.md`
for the broader file-handling roadmap.

# Supabase Storage — Admin Runbook

> **Last verified: 2026-08-13** against `src/api/lib/supabase-storage.ts` (`SupabaseStorageNotConfiguredError`, `DEFAULT_BUCKET = "hookka-files"`, `signedDownloadUrl` default TTL 300s), `src/api/routes/files.ts:223,358-359` (503 gating), `migrations-postgres/0055_file_assets.sql`, and `wrangler.toml`.
> Corrected 2026-08-13: `wrangler secret put` → `wrangler pages secret put` (this is a Pages project); the migration command now points at the npm script; smoke-test URLs updated to the live domain.

**Status:** Originally landed 2026-04-25 as `R2-SETUP.md` against
Cloudflare R2; rewritten 2026-04-29 by the storage-supabase-migration to
target Supabase Storage. The route layer (`src/api/routes/files.ts`) is
gated to return `503 service unavailable` until the credentials are
live, so the build is green today and the file API activates the moment
the admin sets `SUPABASE_PROJECT_REF` + `SUPABASE_SERVICE_KEY`.

---

## What this delivers

**⚠️ Corrected 2026-08-14 — this section described a scaffold; `/api/files` is
live, shipped product.** It is consumed by **20 modules** under `src/pages` +
`src/components` — announcement media (`announcements.tsx`), product and customer
documents (`resource-documents.tsx`: list `:89`, upload `:137`, delete `:163`,
download `:246-278`), QC photos (`quality.tsx`), scanned supplier POs
(`scan-po-modal.tsx`, `scan-supplier-modal.tsx`), the `/m` screens, and more. The
old text said attachments *"have no durable home — they're either inlined in DB
blobs or live on someone's desktop"*, which also contradicted **this same document
at Step 4**, where it states `SUPABASE_PROJECT_REF` is *"already set on the
Cloudflare Pages dashboard for prod"*. Unsetting either credential is therefore an
**outage of every attachment surface**, not a clean rollback.

What the storage path gives the ERP (all of it 503s whenever the two credentials
are unset):

* `POST /api/files` accepts multipart uploads tied to a
  `(resourceType, resourceId)` pair.
* `GET /api/files/:id/download` 302-redirects to a 5-minute presigned
  URL — no Worker bandwidth burnt streaming the file.
* `DELETE /api/files/:id` removes both the DB row and the storage object.
* Multi-tenant safe: every key is prefixed with `<orgId>/...` so a
  bucket walk can't surface another tenant's files.

Why Supabase Storage instead of R2: we're already paying for Supabase
Pro (Postgres, Auth, Realtime). The plan includes 100 GB storage and
250 GB egress/month, easily covering daily pg_dump (~5 GB/mo) plus file
attachments (~3 GB/mo). One vendor instead of two.

---

## Step 1 — Provision the bucket (Supabase Dashboard, one-time)

1. Open **Supabase Dashboard → Storage → New bucket**.
2. **Name:** `hookka-files`
3. **Visibility:** Private (do NOT make it public — every download
   flows through the worker's auth layer or a signed URL).
4. Click **Create bucket**.

Verify:

* The bucket appears in the Storage list.
* Click into it; the file list is empty.

(Optional) Add a Storage policy if your project requires explicit RLS
even for service_role. Service_role bypasses RLS by default, but
explicit policies make audits cleaner:

* Storage → Policies → `hookka-files` → Add policy
* "Allow service_role to do anything", target = `service_role`,
  operations = SELECT/INSERT/UPDATE/DELETE.

---

## Step 2 — Apply the migration

The Postgres mirror migration is `migrations-postgres/0055_file_assets.sql`.
Run:

```bash
npm run db:migrate:supabase:dry   # preview pending files
npm run db:migrate:supabase       # apply (incremental, tracked, re-runnable)
```

The DB column is named `r2_key` (camelCase `r2Key` in the adapter
layer). It's an opaque string identifier — the underlying backend is
now Supabase Storage, but renaming the column would require a
data-migrating change out of scope for the storage swap.

---

## Step 3 — Set the runtime credentials

```bash
# Service-role key (NEVER paste this into chat or commit it):
wrangler pages secret put SUPABASE_SERVICE_KEY
```

`SUPABASE_PROJECT_REF` is **already set on the Cloudflare Pages dashboard**
for prod. Do NOT also add it to `wrangler.toml [vars]` — Cloudflare rejects
the deploy with `Binding name 'SUPABASE_PROJECT_REF' already in use` (this
caused the 2026-05-30 deploy failure; the line is deliberately left
commented in `wrangler.toml`).

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in both
values. The matching keys in code are `env.SUPABASE_PROJECT_REF` and
`env.SUPABASE_SERVICE_KEY` — see `src/api/lib/supabase-storage.ts`.

Redeploy after setting the secrets (Cloudflare Pages picks them up on
the next deploy).

---

## Step 4 — Smoke test

```bash
TOKEN="<an admin bearer token>"

# Upload an invoice PDF
curl -X POST https://erp.hookka.com/api/files \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./test.pdf" \
  -F "resourceType=invoice" \
  -F "resourceId=INV-12345"

# Returns { success: true, data: { id: "fa-...", r2Key: "...", ... } }
# (the r2Key field name is preserved for backward DB compatibility — it's
#  just an opaque storage object key now.)

# Download it (follows the 302 to a presigned URL)
curl -L https://erp.hookka.com/api/files/fa-XXX/download \
  -H "Authorization: Bearer $TOKEN" -o downloaded.pdf

# Delete it
curl -X DELETE https://erp.hookka.com/api/files/fa-XXX \
  -H "Authorization: Bearer $TOKEN"
```

If any step returns `503 file storage unavailable`, the credentials
aren't wired — re-check Step 3.

---

## Step 5 — Rollback

If something goes wrong, unset either secret and redeploy. The route
returns 503 cleanly. To wipe the bucket:

* Supabase Dashboard → Storage → `hookka-files` → select all → delete.
* Or via REST:
  ```bash
  curl -X DELETE \
    "https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/bucket/hookka-files" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
  ```
  (Bucket must be empty first.)

---

## What ships next (out of scope for this scaffold)

* Direct-upload presigned PUTs so the browser uploads to Storage
  without proxying through the Worker (current ceiling: 50 MB).
  Supabase Storage has a `POST /upload/sign/...` endpoint that returns
  a one-shot signed URL; wire it from `routes/files.ts` once the
  product needs it.
* Virus scanning before serving downloads.
* Versioning: keep prior N versions of an attachment and surface a
  history UI. Supabase Storage doesn't have native versioning; a key
  suffix scheme (`<id>-v<N>-<filename>`) would do it.
* Per-org access control: today the orgId-prefix prevents cross-tenant
  leaks at the bucket layer; the route layer additionally enforces
  `orgId = ?` on every query so this is defense-in-depth.

See `docs/ROADMAP-PHASE-C.md` and `docs/ENTERPRISE-ERP-ARCHITECTURE.md`
for the broader file-handling roadmap.

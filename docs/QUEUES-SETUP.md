# Cloudflare Queues — Admin Runbook

**Status:** Scaffold landed 2026-04-25. Bindings commented out in
`wrangler.toml`; the code path is shipped behind a runtime guard so the
build is green today and the queue activates the moment the binding is
provisioned.

This doc is the step-by-step the admin runs to take Phase C #3 quick-win
("PO emission queue") from scaffold to live.

---

## What this delivers

Today, `POST /api/sales-orders/:id/confirm` creates the cascaded POs
synchronously *and* fires the supplier email inline. A transient SMTP
failure during email send leaves the SO in "half-confirmed" state and
ops has to manually unstick it (~70% of stuck cascades per the Phase C
roadmap).

After this is wired, the SO confirm flow:

1. Inserts the POs synchronously (unchanged).
2. Pushes one message per PO onto `po-emission` queue.
3. Returns `200 OK` to the user immediately.

The consumer worker reads the queue, calls the existing
`notifySupplierPoSubmitted` helper for each message, and retries on
transient failure. After 3 retries a message dead-letters to
`po-emission-dlq` for manual inspection.

---

## Step 1 — Provision the queues

```bash
wrangler queues create po-emission
wrangler queues create po-emission-dlq
```

Verify:

```bash
wrangler queues list
```

Both queues should appear.

---

## Step 2 — Uncomment the bindings in `wrangler.toml`

In the repo root, edit `wrangler.toml` and remove the leading `# ` from
the two queue blocks under the *"Phase C #3 quick-win"* heading:

```toml
[[queues.producers]]
binding = "PO_EMISSION_QUEUE"
queue = "po-emission"

[[queues.consumers]]
queue = "po-emission"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "po-emission-dlq"
```

Commit, push, let the deploy workflow promote the change.

---

## Step 3 — Wire the consumer

> Cloudflare Pages Functions does **not** host queue consumers. The
> `[[queues.consumers]]` block needs a Worker entry point. There are
> two paths:

### Option A — Sibling Worker (recommended)

1. Create a new minimal Worker project (`wrangler init hookka-queues`).
2. Add the same `[[queues.consumers]]` and the same env bindings the
   consumer needs (`HYPERDRIVE`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`).
3. In its `src/index.ts`, re-export our consumer:
   ```ts
   import handler from "../../hookka-erp-testing/src/api/queues/po-emission-consumer";
   export default handler;
   ```
   (Or copy the file in if a cross-repo import is awkward.)
4. `wrangler deploy` the sibling Worker.

### Option B — Migrate the API to a standalone Worker

If/when the Phase B SDK split lands, the Hono app moves out of Pages
Functions into its own Worker. At that point, just add the consumer
handler as the Worker's default export's `queue` method:

```ts
import app from "./src/api/worker";
import poEmission from "./src/api/queues/po-emission-consumer";

export default {
  fetch: app.fetch,
  queue: poEmission.default.queue,
};
```

---

## Step 4 — Smoke test

After the consumer is deployed:

1. Confirm a draft SO via the UI.
2. Tail both halves:
   ```bash
   wrangler tail hookka-erp-testing            # producer side
   wrangler tail hookka-queues                 # consumer side
   ```
3. The producer log should show
   `[queue-po-emission] enqueued 1 message via=queue`
   and the consumer log should show the
   `[email stub] PO ... submitted to supplier ...` line within ~5s.

To force a transient failure for testing, temporarily revoke the
`RESEND_API_KEY` secret on the consumer Worker and confirm an SO. The
consumer will retry the message 3 times then dead-letter it. Inspect
the DLQ:

```bash
wrangler queues consumer add po-emission-dlq --type=worker
```

(Or just look at queue depth via the dashboard.)

---

## Step 5 — Rollback

If something goes wrong, comment the `[[queues.producers]]` block back
out and redeploy. The producer falls back to the inline notify path
automatically — no other code change needed. The queued messages
already in flight will still drain through the consumer.

To delete the queues entirely:

```bash
wrangler queues delete po-emission
wrangler queues delete po-emission-dlq
```

---

## What ships next (Phase C #3 finish — out of scope here)

* Migrate the rest of the cascade (JC scaffolding, DO release, invoice
  post, payment chase) to queues.
* Add a `workflow_runs` table + dashboard for "stuck > 1h" runs.
* Idempotency keys per `(workflow_run_id, step_name)` so a duplicated
  Queues redelivery never double-emits.

See `docs/ROADMAP-PHASE-C.md` §3 for the full plan.

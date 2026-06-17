# hookka-mail-inbound

Standalone Cloudflare **Email Worker**. It receives mail for the `hookka.com`
zone via Cloudflare Email Routing, parses each message with
[`postal-mime`](https://www.npmjs.com/package/postal-mime), and POSTs a
normalized JSON payload to the ERP's Mail Center inbound endpoint:

```
POST https://erp.hookka.com/api/mail-center/inbound
```

That endpoint is pre-auth and machine-to-machine: it is guarded by the
`x-mail-secret` header (must equal the ERP's `MAIL_INBOUND_SECRET`, ≥ 16 chars)
and **dedups by Message-ID**, so retries are safe.

This worker is **self-contained** — it does not touch the `hookka-erp-testing`
Pages app, `src/api/**`, or the root `wrangler.toml`. It lives in its own
directory and deploys as its own Cloudflare Worker.

---

## Owner setup steps

### (a) Install dependencies

```bash
cd mail-inbound-worker
npm i
```

### (b) Configure the account id, secret, and vars

1. **Account id** — open `wrangler.toml` and replace
   `REPLACE_WITH_HOOKKA_CLOUDFLARE_ACCOUNT_ID` with the Hookka Cloudflare
   account id (Cloudflare dashboard → Workers & Pages → right sidebar
   "Account ID", or run `wrangler whoami`). The ERP's Pages project doesn't pin
   an account id, so this Worker needs it set here (or via the
   `CLOUDFLARE_ACCOUNT_ID` env var).

2. **`MAIL_INBOUND_SECRET`** (secret — same value as on the Pages project):

   ```bash
   wrangler secret put MAIL_INBOUND_SECRET
   ```

   > ⚠️ This MUST be the **exact same value** as `MAIL_INBOUND_SECRET` on the
   > `hookka-erp-testing` Pages project. If the ERP doesn't have it set yet,
   > generate one (e.g. `openssl rand -hex 24`) and set it on **both** sides:
   > here, and on the Pages project via `wrangler pages secret put MAIL_INBOUND_SECRET`
   > (or the Cloudflare Pages dashboard → Settings → Variables and Secrets).
   > The ERP refuses inbound mail (503) until its secret is set and ≥ 16 chars.

3. **`ERP_INBOUND_URL`** — already set in `wrangler.toml` under `[vars]` to
   `https://erp.hookka.com/api/mail-center/inbound`. Change it only if the ERP
   moves.

4. **`FORWARD_TO`** (optional safety-net copy) — forwards a copy of every
   received message to another mailbox (e.g. a Gmail) so nothing is lost while
   you trust the new pipeline:

   ```bash
   wrangler secret put FORWARD_TO
   ```

   > The `FORWARD_TO` destination must be a **verified destination address** in
   > Cloudflare Email Routing (dashboard → Email Routing → Destination
   > addresses), otherwise the forward throws. Leave it unset to disable
   > forwarding entirely.

### (c) Deploy

```bash
npm run deploy
```

(That runs `wrangler deploy`.)

### (d) Enable Email Routing and route mail to this worker

In the Cloudflare dashboard:

1. Go to the **`hookka.com` zone → Email → Email Routing**.
2. **Enable** Email Routing (if not already on) and complete the verification.
3. Add a route whose action is **"Send to a Worker" → `hookka-mail-inbound`**:
   - **Catch-all** → route *every* address to the worker, **or**
   - **Per-address custom rules** (recommended — see below) → route only the
     addresses you want into the ERP (e.g. `support@`, `sales@`), one rule each.

### (e) Heads-up: enabling Email Routing changes the domain MX

Turning on Cloudflare Email Routing **repoints the `hookka.com` MX records to
Cloudflare** (off Hostinger). That means Cloudflare becomes the mail receiver
for the whole domain.

**Recommendation: use per-address rules, not catch-all.** Keep human mailboxes
(e.g. `finance@`, `hr@`, personal staff addresses) on **"Send to an email"**
rules that forward to their existing **Gmail** destinations, and only send the
shared/operational addresses (`support@`, `sales@`, …) to the
`hookka-mail-inbound` worker. This way the ERP ingests the addresses you care
about while everyone else keeps receiving mail in Gmail as before.

---

## Payload contract

The worker builds and POSTs exactly this JSON (matches the ERP's
`InboundEmailPayload` in `src/api/routes/mail-center.ts`):

```jsonc
{
  "from":       "sender@example.com",        // parsed From:, else SMTP envelope sender
  "fromName":   "Sender Name",               // optional
  "to":         ["support@hookka.com"],      // parsed To:, else envelope recipient
  "cc":         ["cc@example.com"],          // optional, omitted when empty
  "subject":    "Subject line",              // optional
  "text":       "plain-text body",           // optional
  "html":       "<p>html body</p>",          // optional
  "messageId":  "<abc@example.com>",         // dedup key on the ERP side
  "inReplyTo":  "<parent@example.com>",      // optional, for threading
  "references": ["<root@example.com>"],      // optional, for threading
  "date":       "2026-06-17T08:00:00.000Z"   // optional
}
```

`from` is the only field the ERP requires; everything else is optional. On a
non-2xx response the worker throws, and Cloudflare retries the `email()`
handler — safe because the ERP dedups by `messageId`.

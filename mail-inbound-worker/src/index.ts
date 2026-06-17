// ---------------------------------------------------------------------------
// hookka-mail-inbound — Cloudflare Email Worker
// ---------------------------------------------------------------------------
// Cloudflare Email Routing delivers each message for the hookka.com zone to the
// email() handler below. We parse the raw MIME with postal-mime, normalize it
// into the ERP's InboundEmailPayload shape, and POST it to the secret-guarded
// pre-auth endpoint POST /api/mail-center/inbound.
//
// The ERP endpoint dedups by Message-ID, so retries are safe. On any non-2xx
// response we THROW — Cloudflare Email Workers re-run email() on an
// unhandled rejection, giving us automatic retry/backoff for transient ERP
// outages without risk of duplicate ingestion.
//
// IMPORTANT — this is the exact body the ERP expects (see
// src/api/routes/mail-center.ts -> InboundEmailPayload / ingestInboundEmail):
//   { from, fromName?, to (string[]), cc? (string[]), subject?, text?, html?,
//     messageId?, inReplyTo?, references? (string[]), date? }
// `from` is the only required field; everything else is optional.
// ---------------------------------------------------------------------------

import PostalMime from "postal-mime";

// Minimal local shape of the Workers ExecutionContext, so this file type-checks
// without a hard dependency on @cloudflare/workers-types. (At runtime the real
// Workers ExecutionContext is passed in; only waitUntil is used here.)
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Bindings / vars provided by wrangler.toml + `wrangler secret put`.
interface Env {
  // Shared secret presented to the ERP as the `x-mail-secret` header. MUST
  // equal the ERP's MAIL_INBOUND_SECRET (>= 16 chars). Secret.
  MAIL_INBOUND_SECRET: string;
  // ERP inbound endpoint, e.g. https://erp.hookka.com/api/mail-center/inbound.
  ERP_INBOUND_URL: string;
  // Optional safety-net mailbox. When set, every message is also forwarded
  // here via Cloudflare Email Routing (destination must be a verified address).
  FORWARD_TO?: string;
}

// A postal-mime address is { name, address?, group? }. We only want the raw
// "user@host" string for the ERP payload.
interface ParsedAddress {
  name?: string;
  address?: string;
  group?: ParsedAddress[];
}

// The Email Worker message object. `raw` is a ReadableStream PROPERTY (not a
// method); `from`/`to` are the SMTP envelope sender/recipient strings.
interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

// The ERP InboundEmailPayload (kept in sync with src/api/routes/mail-center.ts).
interface InboundEmailPayload {
  from?: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: string;
}

// Pull bare "user@host" addresses out of postal-mime's address objects,
// flattening any group members and dropping entries without an address.
function addrList(list: ParsedAddress[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const a of list) {
    if (a?.address) out.push(a.address.trim());
    if (a?.group) out.push(...addrList(a.group));
  }
  return out.filter(Boolean);
}

export default {
  async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Parse the raw MIME stream. postal-mime accepts the ReadableStream
    // directly in the Workers runtime.
    const parsed = await PostalMime.parse(message.raw);

    // from: prefer the parsed header address (what the sender put in From:),
    // fall back to the SMTP envelope sender (message.from) so `from` is never
    // empty — the ERP rejects a payload with no from address.
    const from = parsed.from?.address?.trim() || message.from || "";
    const fromName = parsed.from?.name?.trim() || undefined;

    // to: prefer parsed To: addresses; fall back to the single envelope
    // recipient (message.to) so the ERP can still resolve which mailbox was
    // hit (it scans recipients for an @hookka.com / known-alias match).
    let to = addrList(parsed.to as ParsedAddress[] | undefined);
    if (to.length === 0 && message.to) to = [message.to];

    const cc = addrList(parsed.cc as ParsedAddress[] | undefined);

    // references: postal-mime returns the raw "References" header (a single
    // whitespace-separated string of <id> tokens). The ERP's toArray() splits
    // on commas/whitespace either way, but we hand it a clean array.
    const references =
      typeof parsed.references === "string"
        ? parsed.references.split(/\s+/).map((s) => s.trim()).filter(Boolean)
        : undefined;

    const payload: InboundEmailPayload = {
      from,
      fromName,
      to,
      cc: cc.length ? cc : undefined,
      subject: parsed.subject || undefined,
      text: parsed.text || undefined,
      html: parsed.html || undefined,
      messageId: parsed.messageId || undefined,
      inReplyTo: parsed.inReplyTo || undefined,
      references,
      // postal-mime gives `date` as an ISO-ish string; the ERP re-parses and
      // safely falls back to "now" if it can't.
      date: parsed.date || undefined,
    };

    // Best-effort safety-net copy. Forward BEFORE the POST and outside its
    // success path so a forward failure (e.g. unverified destination) never
    // blocks ingestion, and a later ERP retry doesn't re-forward duplicates.
    if (env.FORWARD_TO) {
      ctx.waitUntil(
        message.forward(env.FORWARD_TO).catch((err) => {
          console.error("[hookka-mail-inbound] forward failed:", err);
        }),
      );
    }

    // POST to the ERP. The secret goes in x-mail-secret; the ERP compares it
    // (constant-time) against MAIL_INBOUND_SECRET.
    const res = await fetch(env.ERP_INBOUND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mail-secret": env.MAIL_INBOUND_SECRET,
      },
      body: JSON.stringify(payload),
    });

    // Non-2xx => throw so Cloudflare retries email(). Idempotent on the ERP
    // side (dedup by Message-ID), so a retry can't double-insert.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `ERP inbound POST failed: ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }
  },
};

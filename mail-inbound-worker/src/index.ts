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

// One inbound attachment in the ERP payload (kept in sync with
// src/api/routes/mail-center.ts -> InboundAttachmentPayload). The ERP base64-
// decodes contentBase64 and uploads the bytes to Supabase Storage.
interface InboundAttachmentPayload {
  filename?: string;
  contentType?: string;
  contentId?: string;
  contentBase64?: string;
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
  attachments?: InboundAttachmentPayload[];
}

// A postal-mime attachment. `content` is an ArrayBuffer (or a view) of the raw
// decoded bytes in the Workers runtime.
interface ParsedAttachment {
  filename?: string;
  mimeType?: string;
  contentType?: string;
  contentId?: string;
  disposition?: string;
  content?: ArrayBuffer | ArrayBufferView | string;
}

// Per-file (~8 MB) and per-message (~15 MB) attachment caps. We base64-encode
// the bytes into the JSON POST, so cap individual files and the running total to
// keep the request body sane. Oversized files are dropped (logged); the email
// is still ingested without them.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Coerce a postal-mime attachment.content into a Uint8Array of raw bytes.
function attachmentBytes(
  content: ArrayBuffer | ArrayBufferView | string | undefined,
): Uint8Array | null {
  if (content == null) return null;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  if (typeof content === "string") return new TextEncoder().encode(content);
  return null;
}

// Standard base64-encode raw bytes (Workers has btoa but it takes a binary
// string). Chunk to stay under the argument-length limit for large files.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Build the ERP attachments array from postal-mime's parsed.attachments,
// enforcing the per-file + per-message size caps.
function toAttachments(
  list: ParsedAttachment[] | undefined,
): InboundAttachmentPayload[] | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out: InboundAttachmentPayload[] = [];
  let total = 0;
  for (const att of list) {
    const bytes = attachmentBytes(att?.content);
    if (!bytes || bytes.length === 0) continue;
    const filename = att?.filename || "attachment";
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `[hookka-mail-inbound] SKIP attachment "${filename}" — ${bytes.length} bytes > ${MAX_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    if (total + bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.warn(
        `[hookka-mail-inbound] SKIP attachment "${filename}" — message total would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    total += bytes.length;
    out.push({
      filename,
      contentType: att?.mimeType || att?.contentType || "application/octet-stream",
      contentId: att?.contentId || undefined,
      contentBase64: bytesToBase64(bytes),
    });
  }
  return out.length ? out : undefined;
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
      // Attachments — base64-encoded, size-capped. The ERP uploads them to
      // Supabase Storage and indexes them in email_attachments.
      attachments: toAttachments(
        parsed.attachments as ParsedAttachment[] | undefined,
      ),
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

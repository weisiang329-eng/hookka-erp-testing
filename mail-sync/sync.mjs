// ---------------------------------------------------------------------------
// hookka-mail-sync — Hostinger IMAP -> ERP inbound bridge
// ---------------------------------------------------------------------------
// The company @hookka.com mailboxes live on Hostinger. This script polls each
// mailbox over IMAP (READ-ONLY — it never alters \Seen, so the humans' unread
// counts are untouched) and POSTs every message to the ERP's secret-guarded
// endpoint POST /api/mail-center/inbound. That endpoint dedups by Message-ID,
// so re-fetching a recent window (or re-running a backfill) NEVER double-inserts.
//
// It is NOT part of the Cloudflare Worker bundle — it runs on a GitHub Actions
// cron (see ../.github/workflows/mail-sync.yml). The payload shape is kept in
// sync with mail-inbound-worker/src/index.ts (the Email-Routing path); both feed
// the same ingest, so receive works whichever path is active.
//
// Required env (GitHub Actions secrets — see README.md):
//   MAIL_INBOUND_SECRET        shared secret; MUST equal the ERP's MAIL_INBOUND_SECRET (>= 16 chars)
//   HOSTINGER_PW_<LOCALPART>   IMAP password per mailbox, e.g. HOSTINGER_PW_SUPPORT
// Optional env (sensible defaults):
//   ERP_INBOUND_URL   default https://staging.hookka-erp-testing.pages.dev/api/mail-center/inbound
//   MAILBOXES         comma-separated addresses (default: the 5 known boxes)
//   IMAP_HOST/IMAP_PORT  default imap.hostinger.com / 993
//   BACKFILL          "true"/"1" => fetch ALL history once; else incremental
//   SINCE_DAYS        incremental look-back window in days (default 3)
// ---------------------------------------------------------------------------

import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";

const ERP_INBOUND_URL =
  (process.env.ERP_INBOUND_URL || "").trim() ||
  "https://staging.hookka-erp-testing.pages.dev/api/mail-center/inbound";
const SECRET = (process.env.MAIL_INBOUND_SECRET || "").trim();
const IMAP_HOST = (process.env.IMAP_HOST || "").trim() || "imap.hostinger.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const BACKFILL = /^(1|true|yes)$/i.test(process.env.BACKFILL || "");
const SINCE_DAYS = Number(process.env.SINCE_DAYS || 3) || 3;
const MAILBOXES = (
  process.env.MAILBOXES ||
  "support@hookka.com,finance@hookka.com,hr@hookka.com,lim@hookka.com,violet@hookka.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (SECRET.length < 16) {
  console.error(
    "FATAL: MAIL_INBOUND_SECRET is unset or < 16 chars. Set it as a GitHub secret AND on the ERP (Cloudflare Pages) — the two MUST match.",
  );
  process.exit(1);
}

// support@hookka.com -> HOSTINGER_PW_SUPPORT
const pwEnvKey = (address) =>
  "HOSTINGER_PW_" +
  address.split("@")[0].toUpperCase().replace(/[^A-Z0-9]/g, "_");

// Flatten postal-mime address objects to bare "user@host" strings.
function addrList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (a && a.address) out.push(String(a.address).trim());
    if (a && a.group) out.push(...addrList(a.group));
  }
  return out.filter(Boolean);
}

// Per-attachment and per-message size caps. We base64-encode attachment bytes
// into the JSON POST, so we cap individual files at ~8 MB and the TOTAL across
// one message at ~15 MB to keep the request body sane. Anything over is dropped
// (logged) — the ERP stores the email regardless; only the oversized file is
// skipped. (e-invoices/photos are well under these limits in practice.)
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Coerce postal-mime's attachment.content (ArrayBuffer | Uint8Array | string)
// to a Node Buffer so we can size-check it and base64-encode it uniformly.
function attachmentBuffer(content) {
  if (content == null) return null;
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  if (typeof content === "string") return Buffer.from(content);
  try {
    return Buffer.from(content);
  } catch {
    return null;
  }
}

// Build the ERP attachments payload from postal-mime's parsed.attachments.
// Each item: { filename, contentType, contentId, contentBase64 }. Drops files
// over MAX_ATTACHMENT_BYTES or once the running total exceeds the message cap.
function toAttachments(parsed, sourceMailbox) {
  const list = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  if (list.length === 0) return undefined;
  const out = [];
  let total = 0;
  for (const att of list) {
    const buf = attachmentBuffer(att && att.content);
    if (!buf || buf.length === 0) continue;
    const filename =
      (att && (att.filename || att.fileName)) || "attachment";
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `  ${sourceMailbox} SKIP attachment "${filename}" — ${buf.length} bytes > ${MAX_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    if (total + buf.length > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.warn(
        `  ${sourceMailbox} SKIP attachment "${filename}" — message total would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    total += buf.length;
    out.push({
      filename,
      contentType:
        (att && (att.mimeType || att.contentType)) ||
        "application/octet-stream",
      contentId: (att && att.contentId) || undefined,
      contentBase64: buf.toString("base64"),
    });
  }
  return out.length ? out : undefined;
}

async function postToErp(payload) {
  const res = await fetch(ERP_INBOUND_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mail-secret": SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ERP POST ${res.status} ${res.statusText} ${detail}`.trim());
  }
  return res.json().catch(() => ({}));
}

// Build the ERP InboundEmailPayload. We PREPEND the mailbox we fetched this
// message FROM to `to`, guaranteeing it is the first @hookka.com recipient so
// the ERP attributes the thread to the correct mailbox even when the original
// To: was a list, a BCC, or a forward.
function toPayload(parsed, sourceMailbox) {
  const from = (parsed.from && parsed.from.address
    ? parsed.from.address
    : ""
  ).trim();
  const fromName =
    parsed.from && parsed.from.name ? parsed.from.name.trim() : undefined;
  const parsedTo = addrList(parsed.to);
  const to = [
    sourceMailbox,
    ...parsedTo.filter((x) => x.toLowerCase() !== sourceMailbox.toLowerCase()),
  ];
  const cc = addrList(parsed.cc);
  const references =
    typeof parsed.references === "string"
      ? parsed.references
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  return {
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
    date: parsed.date || undefined,
    attachments: toAttachments(parsed, sourceMailbox),
  };
}

async function syncMailbox(address) {
  const pass = process.env[pwEnvKey(address)];
  if (!pass) {
    console.warn(`SKIP ${address}: no password in ${pwEnvKey(address)}`);
    return;
  }
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: address, pass },
    logger: false,
  });
  let total = 0;
  let added = 0;
  let deduped = 0;
  let failed = 0;
  await client.connect();
  try {
    // readOnly (EXAMINE) + source uses BODY.PEEK[] — two layers of guarantee
    // that we never flip \Seen on the humans' mailbox.
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      let range = null;
      let useUid = false;
      if (BACKFILL) {
        range = "1:*"; // every message, one-time history import (sequence range)
      } else {
        const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
        const uids = await client.search({ since }, { uid: true });
        if (uids && uids.length) {
          range = uids;
          useUid = true;
        }
      }
      if (range) {
        for await (const msg of client.fetch(
          range,
          { source: true },
          useUid ? { uid: true } : {},
        )) {
          total++;
          try {
            if (!msg.source) {
              failed++;
              continue;
            }
            const parsed = await PostalMime.parse(msg.source);
            const payload = toPayload(parsed, address);
            if (!payload.from) {
              failed++;
              continue;
            }
            const r = await postToErp(payload);
            if (r && r.deduped) deduped++;
            else added++;
          } catch (e) {
            failed++;
            console.error(`  ${address} msg fail:`, (e && e.message) || e);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  console.log(
    `${address}: ${total} seen, ${added} new, ${deduped} dup, ${failed} failed`,
  );
}

let anyHardFail = false;
for (const address of MAILBOXES) {
  try {
    await syncMailbox(address);
  } catch (e) {
    anyHardFail = true;
    console.error(`MAILBOX ${address} FAILED:`, (e && e.message) || e);
  }
}
console.log(
  `Done. mode=${BACKFILL ? "BACKFILL(all)" : `incremental(${SINCE_DAYS}d)`} -> ${ERP_INBOUND_URL}`,
);
process.exit(anyHardFail ? 1 : 0);

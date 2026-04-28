// ---------------------------------------------------------------------------
// Resend email wrapper for the Workers runtime — no SDK, just fetch().
//
// The Resend SDK relies on node:stream, which is a pain to polyfill in
// Pages Functions. A single POST to https://api.resend.com/emails is all
// we need for transactional invites, so we hand-roll it here.
//
// Dev fallback: when RESEND_API_KEY is undefined/empty we short-circuit to
// `{ ok: false, error: ... }` without hitting the network. Route handlers
// should still succeed in that case and surface the invite link so the
// admin can copy / paste it manually.
// ---------------------------------------------------------------------------

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Supplier PO notification — wired to Resend 2026-04-26.
//
// Sends a plain transactional email to the supplier's on-file address with
// the PO number. No portal links yet (no supplier-side login UI exists);
// the supplier replies via email or phone. If the supplier has no email or
// the Resend key isn't configured, the function logs and returns
// `{ok:false, error:...}` — callers should NOT treat that as a hard fail
// (a missed email is not a reason to roll back the PO submission).
// ---------------------------------------------------------------------------

export async function notifySupplierPoSubmitted(
  env: {
    RESEND_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
    APP_URL?: string;
  },
  supplierEmail: string | null | undefined,
  args: {
    poNo: string;
    supplierName: string;
    supplierId: string;
  },
): Promise<SendEmailResult> {
  if (!supplierEmail) {
    console.log(
      `[email] PO ${args.poNo}: skipped — supplier ${args.supplierName} (${args.supplierId}) has no email on file`,
    );
    return { ok: false, error: "supplier has no email on file" };
  }
  if (!env.RESEND_API_KEY) {
    console.log(
      `[email] PO ${args.poNo}: skipped — RESEND_API_KEY not configured`,
    );
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const from =
    env.RESEND_FROM_EMAIL || "Hookka Manufacturing ERP <noreply@houzscentury.com>";
  const tpl = supplierPoEmailTemplate({
    poNo: args.poNo,
    supplierName: args.supplierName,
  });
  const result = await sendEmail(env.RESEND_API_KEY, from, {
    to: supplierEmail,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
  if (!result.ok) {
    console.warn(
      `[email] PO ${args.poNo} → ${supplierEmail}: send failed: ${result.error}`,
    );
  }
  return result;
}

export async function sendEmail(
  apiKey: string | undefined,
  from: string,
  args: SendEmailArgs,
): Promise<SendEmailResult> {
  if (!apiKey) {
    return {
      ok: false,
      error: "RESEND_API_KEY not configured — email not sent",
    };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${bodyText}` };
    }
    let id: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as { id?: string };
      id = parsed?.id;
    } catch {
      // Resend returns JSON, but don't die if the payload ever changes.
    }
    return { ok: true, id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown Resend error",
    };
  }
}

// ---------------------------------------------------------------------------
// Invite email template — inline styles, 600px container, system fonts.
// ---------------------------------------------------------------------------

export function inviteEmailTemplate(args: {
  appName: string;
  inviterName: string;
  inviteUrl: string;
  expiresInHours: number;
}): { subject: string; html: string; text: string } {
  const { appName, inviterName, inviteUrl, expiresInHours } = args;
  const subject = `You're invited to ${appName}`;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F0ECE9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F1D1B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F0ECE9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;border:1px solid #E2DDD8;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px;background-color:#1F1D1B;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#8B7A4E;font-weight:600;">${escapeHtml(appName)}</div>
                <div style="font-size:22px;font-weight:700;margin-top:8px;">You're invited</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Hi there,</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
                  <strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(appName)}</strong>.
                  Click the button below to set your password and get started.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
                  <tr>
                    <td align="center" bgcolor="#6B5C32" style="border-radius:8px;">
                      <a href="${escapeAttr(inviteUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                        Accept invitation
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6B7280;">
                  Or copy this link into your browser:
                </p>
                <p style="margin:0 0 16px;font-size:12px;line-height:1.5;word-break:break-all;">
                  <a href="${escapeAttr(inviteUrl)}" style="color:#6B5C32;">${escapeHtml(inviteUrl)}</a>
                </p>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6B7280;">
                  This invitation expires in <strong>${expiresInHours} hours</strong>. If you weren't expecting it, you can safely ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#F0ECE9;border-top:1px solid #E2DDD8;font-size:11px;line-height:1.5;color:#6B7280;text-align:center;">
                &copy; ${new Date().getFullYear()} ${escapeHtml(appName)}. Sent to you because an admin invited you.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `You're invited to ${appName}`,
    "",
    `${inviterName} has invited you to join ${appName}.`,
    "Accept the invitation by opening the link below:",
    "",
    inviteUrl,
    "",
    `This invitation expires in ${expiresInHours} hours.`,
    "If you weren't expecting it, you can ignore this email.",
  ].join("\n");

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Supplier PO notification template — same inline-styled pattern as the
// invite template. Subject and body are intentionally plain so suppliers
// see "PO XYZ" front-and-center without marketing fluff.
// ---------------------------------------------------------------------------

export function supplierPoEmailTemplate(args: {
  poNo: string;
  supplierName: string;
}): { subject: string; html: string; text: string } {
  const { poNo, supplierName } = args;
  const subject = `Purchase Order ${poNo} from Hookka`;

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F0ECE9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1F1D1B;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F0ECE9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;border:1px solid #E2DDD8;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px;background-color:#1F1D1B;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#8B7A4E;font-weight:600;">Hookka Purchase Order</div>
                <div style="font-size:22px;font-weight:700;margin-top:8px;">${escapeHtml(poNo)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Dear ${escapeHtml(supplierName)},</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
                  We have submitted Purchase Order <strong>${escapeHtml(poNo)}</strong> for your processing.
                  A signed copy of the PO will follow separately if your office requires one.
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
                  Please confirm receipt and let us know your expected ship date.
                </p>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6B7280;">
                  Reply to this email or contact our procurement team if you have any questions.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#F0ECE9;border-top:1px solid #E2DDD8;font-size:11px;line-height:1.5;color:#6B7280;text-align:center;">
                Hookka &middot; ${new Date().getFullYear()}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `Purchase Order ${poNo} from Hookka`,
    "",
    `Dear ${supplierName},`,
    "",
    `We have submitted Purchase Order ${poNo} for your processing.`,
    "Please confirm receipt and let us know your expected ship date.",
    "",
    "Reply to this email or contact our procurement team if you have any questions.",
  ].join("\n");

  return { subject, html, text };
}

// Tiny inline helpers — we don't pull in a full sanitiser for a single
// trusted template string. Good enough to stop the inviter's displayName
// from injecting tags.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

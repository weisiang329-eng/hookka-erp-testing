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
// Lightweight notification stubs — log only for now. Real Resend wiring can
// be added later without changing call sites.
// ---------------------------------------------------------------------------

export function notifySupplierPoSubmitted(args: {
  poNo: string;
  supplierName: string;
  supplierId: string;
}): void {
   
  console.log(
    `[email stub] PO ${args.poNo} submitted to supplier ${args.supplierName} (${args.supplierId})`,
  );
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

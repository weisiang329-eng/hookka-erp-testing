// ---------------------------------------------------------------------------
// /setup-2fa — protected page (RequireAuth gates the dashboard layout).
//
// Two-step flow:
//   Step 1 — POST /api/auth/totp/setup-start, render the returned QR code,
//             show the base32 secret for manual entry, ask the user to scan.
//   Step 2 — User types the 6-digit code their authenticator shows. We POST
//             /api/auth/totp/setup-confirm. On success, navigate to
//             /dashboard. On failure, surface the "Wrong code, try again"
//             error inline and let them retry.
//
// "Skip for now" — calls /api/auth/totp/dismiss-prompt (writes an audit row
// so the login flow knows not to re-prompt for 24h) and navigates to
// /dashboard. The Skip button is hidden when navigated to via
// location.state.severity === "hard" (the FE only sends hard severity for
// newly-minted super admins per the soft-enforcement policy).
//
// Recovery codes (2026-09-09). setup-confirm now returns eight single-use
// codes. They are shown ONCE, here, and the user must tick "I've saved these"
// before continuing — without them a lost authenticator means a lockout with
// no admin-side reset to fall back on.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type StartResponse =
  | {
      success: true;
      secret: string;
      otpauthUrl: string;
      qrCodeUrl: string;
    }
  | { success: false; error?: string };

type ConfirmResponse =
  | { success: true; enabledAt: string; recoveryCodes?: string[] }
  | { success: false; error?: string };

export default function Setup2FAPage() {
  const navigate = useNavigate();
  const location = useLocation();

  // Severity passed from login.tsx via navigate state. "hard" hides the Skip
  // link so newly-minted super admins can't bypass setup. Default "soft" for
  // direct navigation (e.g. user clicks "Set up 2FA" from a banner later).
  const severity =
    (location.state as { severity?: "soft" | "info" | "hard" } | null)
      ?.severity ?? "soft";

  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Set once setup-confirm succeeds. While non-null the page shows the codes
  // instead of the QR step — 2FA is already ON at this point, so there is no
  // "cancel"; the only way forward is to acknowledge them.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [acked, setAcked] = useState(false);
  const [copied, setCopied] = useState(false);

  // Step 1: kick off setup as soon as the page mounts. We fire-and-forget
  // the request — if it fails the user sees the error and can refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/totp/setup-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        const json = (await res.json()) as StartResponse;
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setLoadError(
            ("error" in json && json.error) ||
              "Could not start setup. Refresh the page to try again.",
          );
          return;
        }
        setQrUrl(json.qrCodeUrl);
        setSecret(json.secret);
      } catch {
        if (!cancelled) {
          setLoadError("Network error. Refresh the page to try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 2: user types the 6-digit code; we verify and on success bounce
  // to /dashboard. The api-client adds the CSRF header automatically for
  // POSTs (read from the hookka_csrf cookie set at login).
  async function handleConfirm(ev: React.FormEvent) {
    ev.preventDefault();
    setCodeError(null);
    const clean = code.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(clean)) {
      setCodeError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setConfirming(true);
    try {
      const res = await fetch("/api/auth/totp/setup-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: clean }),
      });
      const json = (await res.json()) as ConfirmResponse;
      if (!res.ok || !json.success) {
        setCodeError(
          ("error" in json && json.error) || "Wrong code, try again",
        );
        return;
      }
      // Codes are in this response and nowhere else. Show them rather than
      // navigating away — leaving now loses them permanently.
      if (json.recoveryCodes?.length) {
        setRecoveryCodes(json.recoveryCodes);
        return;
      }
      navigate("/dashboard", { replace: true });
    } catch {
      setCodeError("Network error. Try again in a moment.");
    } finally {
      setConfirming(false);
    }
  }

  // Skip — calls dismiss-prompt and goes to the dashboard. The endpoint
  // writes an audit row "totp-dismissed" so the login flow gives the user
  // a 24h cool-off before re-prompting. Hidden when severity = "hard".
  async function handleSkip() {
    try {
      await fetch("/api/auth/totp/dismiss-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
    } catch {
      // Best-effort — even if dismiss fails, take the user to the dashboard.
    }
    navigate("/dashboard", { replace: true });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ background: "#0F0E0C" }}
    >
      <div
        className="w-full max-w-lg rounded-lg p-8"
        style={{
          background: "rgba(35, 32, 27, 0.85)",
          border: "1px solid rgba(139, 122, 78, 0.2)",
        }}
      >
        {/* ---------------------------------------------------------------
            Recovery codes. Rendered INSTEAD of the setup flow once
            setup-confirm has returned them: 2FA is already enabled by this
            point, so there is nothing left to cancel, and navigating away
            without saving them is the failure we are trying to prevent.
            --------------------------------------------------------------- */}
        {recoveryCodes && (
          <div>
            <h1
              className="text-2xl font-semibold mb-2"
              style={{ color: "#F4EFE3" }}
            >
              Save your recovery codes
            </h1>
            <p
              className="text-sm mb-4"
              style={{ color: "rgba(244,239,227,0.65)" }}
            >
              Two-factor sign-in is now on. If you ever lose your phone, one of
              these codes gets you back in. Each works <strong>once</strong>.
            </p>
            <p
              className="text-sm mb-5 rounded p-3"
              style={{
                background: "rgba(220,38,38,0.12)",
                border: "1px solid rgba(220,38,38,0.35)",
                color: "#FCA5A5",
              }}
            >
              This is the only time they are shown. They are stored hashed —
              nobody, including an administrator, can retrieve them later.
            </p>

            <div
              className="grid grid-cols-2 gap-2 rounded p-4 mb-4"
              style={{
                background: "rgba(244,239,227,0.06)",
                border: "1px solid rgba(139,122,78,0.25)",
              }}
            >
              {recoveryCodes.map((rc) => (
                <code
                  key={rc}
                  className="text-sm tracking-wider select-all"
                  style={{ color: "#F4EFE3" }}
                >
                  {rc}
                </code>
              ))}
            </div>

            <div className="flex gap-3 mb-5">
              <button
                type="button"
                className="text-sm px-3 py-2 rounded"
                style={{
                  background: "rgba(244,239,227,0.08)",
                  color: "#F4EFE3",
                }}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(recoveryCodes.join("\n"))
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy all"}
              </button>
              <button
                type="button"
                className="text-sm px-3 py-2 rounded"
                style={{
                  background: "rgba(244,239,227,0.08)",
                  color: "#F4EFE3",
                }}
                onClick={() => {
                  // Blob + object URL rather than a data: URI so the file name
                  // is ours and the content is not size-capped by the URL.
                  const blob = new Blob(
                    [
                      "Hookka ERP — two-factor recovery codes\n" +
                        "Each code works once. Keep them somewhere safe and private.\n\n" +
                        recoveryCodes.join("\n") +
                        "\n",
                    ],
                    { type: "text/plain" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "hookka-recovery-codes.txt";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download
              </button>
            </div>

            <label
              className="flex items-start gap-2 text-sm mb-5 cursor-pointer"
              style={{ color: "rgba(244,239,227,0.75)" }}
            >
              <input
                type="checkbox"
                checked={acked}
                onChange={(e) => setAcked(e.target.checked)}
                className="mt-1"
              />
              <span>
                I have saved these codes somewhere I can get to without my
                phone.
              </span>
            </label>

            <button
              type="button"
              disabled={!acked}
              onClick={() => navigate("/dashboard", { replace: true })}
              className="w-full py-3 rounded font-medium"
              style={{
                background: acked ? "#8B7A4E" : "rgba(139,122,78,0.3)",
                color: acked ? "#0F0E0C" : "rgba(244,239,227,0.4)",
                cursor: acked ? "pointer" : "not-allowed",
              }}
            >
              Continue to dashboard
            </button>
          </div>
        )}

        {!recoveryCodes && (
        <>
        <h1
          className="text-2xl font-semibold mb-2"
          style={{ color: "#F4EFE3" }}
        >
          Add two-factor sign-in
        </h1>
        <p className="text-sm mb-6" style={{ color: "rgba(244,239,227,0.65)" }}>
          Scan the box below with Google Authenticator, 1Password, Authy, or
          any other authenticator app. Then type the 6-digit code it shows.
        </p>

        {loadError && (
          <div
            className="rounded p-3 mb-4 text-sm"
            style={{
              background: "rgba(220,38,38,0.12)",
              border: "1px solid rgba(220,38,38,0.35)",
              color: "#FCA5A5",
            }}
          >
            {loadError}
          </div>
        )}

        {qrUrl && (
          <div className="flex flex-col items-center mb-6">
            <img
              src={qrUrl}
              alt="Two-factor setup QR code"
              width={240}
              height={240}
              style={{
                background: "#fff",
                padding: 12,
                borderRadius: 8,
              }}
            />
            {secret && (
              <div
                className="mt-4 text-center"
                style={{ color: "rgba(244,239,227,0.6)" }}
              >
                <div className="text-xs mb-1">
                  Or type this into your app by hand:
                </div>
                <code
                  className="text-sm tracking-wider px-3 py-1 rounded select-all"
                  style={{
                    background: "rgba(244,239,227,0.06)",
                    color: "#F4EFE3",
                  }}
                >
                  {secret}
                </code>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleConfirm} className="space-y-4">
          <div>
            <label
              htmlFor="code"
              className="block text-sm mb-2"
              style={{ color: "rgba(244,239,227,0.75)" }}
            >
              6-digit code from your authenticator
            </label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full px-4 py-3 rounded text-lg tracking-[0.4em] text-center"
              style={{
                background: "rgba(244,239,227,0.06)",
                border: "1.5px solid rgba(139,122,78,0.35)",
                color: "#F4EFE3",
              }}
            />
          </div>

          {codeError && (
            <div
              className="rounded p-3 text-sm"
              style={{
                background: "rgba(220,38,38,0.12)",
                border: "1px solid rgba(220,38,38,0.35)",
                color: "#FCA5A5",
              }}
              role="alert"
            >
              {codeError}
            </div>
          )}

          <button
            type="submit"
            disabled={confirming || !qrUrl}
            className="w-full rounded font-semibold text-white py-3 transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg,#6B5C32,#8B7A4E)",
            }}
          >
            {confirming ? "Checking..." : "Turn on two-factor sign-in"}
          </button>

          {severity !== "hard" && (
            <button
              type="button"
              onClick={handleSkip}
              className="w-full text-sm bg-transparent border-0 cursor-pointer hover:underline"
              style={{ color: "rgba(244,239,227,0.55)" }}
            >
              Skip for now
            </button>
          )}
        </form>
        </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login page — email + password against POST /api/auth/login.
//
// Sprint 7: the session token is set by the server in a HttpOnly cookie
// (`hookka_session`) and never touches the response body. The body returns
// the public user blob + a CSRF token (the same value the server also set
// in a non-HttpOnly cookie for the api-client to read). We only persist the
// user blob via setAuth() so the sidebar/topbar can render — the cookie is
// the credential.
//
// On success we redirect to either the URL carried in location.state.from
// (set by <RequireAuth>) or /dashboard by default. Also honours ?next=<url>
// on the query string for the case where api-client.ts bounced here after
// a 401.
// ---------------------------------------------------------------------------
import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff, ArrowRight, Sun, Moon, Check } from "lucide-react";
import { setAuth, isAuthenticated, type AuthUser } from "@/lib/auth";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import LoginSnow from "@/components/login-snow";

// ============================================================
// MOBILE login design — ported 1:1 from the owner's design source
// (Hookka Main Login.dc.html). Desktop (>= lg / 1024px) keeps the
// premium split-panel below, UNCHANGED. The < 1024px branch renders
// this single-column dark-default screen instead: 64px grid, pulsing
// top radial glow, two-layer parallax SNOW (16 blurred back + 5 sharp
// front), a centered logo + "ERP · INDUSTRIES" hairline row, a
// circular Sun/Moon theme toggle (persisted to localStorage), and a
// frosted glass sheet holding the email + password fields, "Remember
// me" + "Forgot Password?" row, and the gold "Sign In" button.
//
// Both palettes (dark + light) are ported verbatim from the source's
// `T` theme object. The phone bezel / "9:41" status bar / notch from
// the source are dropped (the real phone provides them).
// ============================================================
type ThemeName = "dark" | "light";

const LOGIN_THEME_KEY = "hookka.erp.loginTheme";

type Palette = {
  screenBg: string;
  glow: string;
  logoFilter: string; // "" = no filter (dark logo as-is)
  portalColor: string;
  hair: string;
  sheetBg: string;
  sheetBorder: string;
  title: string;
  sub: string;
  label: string;
  fieldBg: string;
  fieldBorder: string;
  accent: string;
  input: string;
  canon: string; // muted icon (eye toggle)
  snowGlow: string;
  snowMul: number;
  snow: (op: number) => string;
  togBg: string;
  togBorder: string;
  togIcon: "sun" | "moon";
  togIconColor: string;
};

const LOGIN_PALETTE: Record<ThemeName, Palette> = {
  dark: {
    screenBg: "#16140F",
    glow: "rgba(168,138,82,.26)",
    logoFilter: "brightness(0) invert(1)",
    portalColor: "#C9A961",
    hair: "rgba(201,169,97,.7)",
    sheetBg: "rgba(28,24,18,.55)",
    sheetBorder: "rgba(201,169,97,.18)",
    title: "#fff",
    sub: "rgba(255,255,255,.5)",
    label: "rgba(255,255,255,.45)",
    fieldBg: "rgba(0,0,0,.28)",
    fieldBorder: "rgba(201,169,97,.28)",
    accent: "#C9A961",
    input: "#F0ECE9",
    canon: "#857A66",
    snowGlow: "rgba(255,255,255,.8)",
    snowMul: 1,
    snow: (op) => `rgba(255,255,255,${op.toFixed(2)})`,
    togBg: "rgba(255,255,255,.08)",
    togBorder: "rgba(201,169,97,.3)",
    togIcon: "sun",
    togIconColor: "#E8C77A",
  },
  light: {
    screenBg: "#FAF8F4",
    glow: "rgba(168,138,82,.16)",
    logoFilter: "", // dark logo as-is
    portalColor: "#8B7A4E",
    hair: "rgba(139,122,78,.8)",
    sheetBg: "rgba(255,255,255,.62)",
    sheetBorder: "rgba(236,230,221,.9)",
    title: "#1F1D1B",
    sub: "#6B7280",
    label: "#9A9082",
    fieldBg: "rgba(255,255,255,.72)",
    fieldBorder: "#E2DDD8",
    accent: "#8B7A4E",
    input: "#1F1D1B",
    canon: "#A89F8D",
    snowGlow: "rgba(40,36,28,.25)",
    snowMul: 1,
    snow: (op) => `rgba(40,36,28,${(op * 0.5).toFixed(2)})`,
    togBg: "rgba(31,29,27,.05)",
    togBorder: "#E2DDD8",
    togIcon: "moon",
    togIconColor: "#6B5C32",
  },
};

function readLoginTheme(): ThemeName {
  try {
    const v = localStorage.getItem(LOGIN_THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

// ---- Deterministic two-layer parallax snow ----
// The source uses Math.random over fixed ranges. We seed a small LCG
// once at module load and freeze the arrays so the flakes are stable
// across renders. Ranges (count / size / duration / delay / opacity /
// blur) match the source exactly.
type Flake = {
  left: number;
  sz: number;
  dur: number;
  delay: number;
  op: number;
  blur: number;
};

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // mulberry32
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _rng = makeRng(0x4d41_494e); // "MAIN"
const rnd = (a: number, b: number) => a + _rng() * (b - a);

// back = many, smaller, blurred, slower (depth, drifts behind sheet)
const SNOW_BACK: Flake[] = Array.from({ length: 16 }, () => {
  const sz = rnd(1.6, 3.6);
  return {
    left: rnd(0, 100),
    sz,
    dur: rnd(13, 22),
    delay: rnd(-22, 0),
    op: rnd(0.35, 0.7),
    blur: rnd(0.8, 1.8),
  };
});
// front = few, larger, sharp, faster (foreground parallax)
const SNOW_FRONT: Flake[] = Array.from({ length: 5 }, () => {
  const sz = rnd(3.5, 5.5);
  return {
    left: rnd(4, 96),
    sz,
    dur: rnd(8, 13),
    delay: rnd(-13, 0),
    op: rnd(0.55, 0.9),
    blur: 0,
  };
});

function SnowLayer({ flakes, p }: { flakes: Flake[]; p: Palette }) {
  return (
    <>
      {flakes.map((f, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: 0,
            left: `${f.left.toFixed(2)}%`,
            width: `${f.sz.toFixed(1)}px`,
            height: `${f.sz.toFixed(1)}px`,
            borderRadius: "50%",
            background: p.snow(f.op),
            boxShadow: `0 0 ${(f.sz * 1.5 * p.snowMul).toFixed(1)}px ${p.snowGlow}`,
            filter: `blur(${f.blur.toFixed(1)}px)`,
            animation: `hkSnow ${f.dur.toFixed(1)}s linear ${f.delay.toFixed(1)}s infinite`,
          }}
        />
      ))}
    </>
  );
}

type LoginResponse =
  | {
      success: true;
      data: {
        user: AuthUser;
        csrfToken: string;
        // 2026-05-27 soft 2FA prompt fields. Present only when the server's
        // computeTotpPrompt() returned a hint for this user. Absence is
        // treated as "no prompt" — backward-compat for any older response.
        totpPromptRequired?: boolean;
        severity?: "soft" | "info" | "hard";
      };
    }
  // 2FA hard-gate shape: success WITHOUT a `data` blob (the server returns just
  // userId, expecting a login-verify step that was never built — see
  // BUG-2026-08-04-006). Modelled so the handler must account for it instead of
  // blindly reading json.data.user and crashing.
  // `pendingToken` is the server's proof that the password step passed; the
  // step-2 screen (when it is finally built) must send it back to
  // /api/auth/totp/login-verify, which refuses without it. See
  // src/api/lib/totp-pending.ts (BUG-2026-08-13-101).
  | { success: true; totpRequired: true; userId: string; pendingToken?: string }
  | { success: false; error?: string };

export default function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { confirm } = useConfirm();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default ON: an unticked "Remember me" issues a SESSION cookie (no Max-Age)
  // + sessionStorage blob, both of which the browser drops on tab/window close
  // (brutal in incognito) → "mysteriously logged out" (owner 2026-06-27, staging).
  // Defaulting to a persistent 7-day session is the expected behaviour anyway.
  const [rememberMe, setRememberMe] = useState(true);

  // Mobile (< lg / 1024px) renders the owner's phone-first design; desktop
  // keeps the existing premium split-panel. Both share the SAME form state +
  // submit handler below — only the presentation differs.
  const isMobile = useMediaQuery("(max-width: 1023px)");
  const [theme, setTheme] = useState<ThemeName>(readLoginTheme);
  const [showPassword, setShowPassword] = useState(false);
  const p = LOGIN_PALETTE[theme];

  function toggleTheme() {
    setTheme((prev) => {
      const next: ThemeName = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(LOGIN_THEME_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Already signed-in? Send them to their own home, not everyone's.
  useEffect(() => {
    if (isAuthenticated()) {
      void landingPage().then((to) => navigate(to, { replace: true }));
    }
  }, [navigate]);

  function getRedirectTarget(): string {
    // 1. location.state.from (populated by <RequireAuth>)
    const state = location.state as { from?: string } | null;
    if (state?.from && typeof state.from === "string") return state.from;
    // 2. ?next=... query param (populated by api-client 401 handler)
    const params = new URLSearchParams(location.search);
    const next = params.get("next");
    if (next) return next;
    // 3. default — resolved from the server, see landingPage()
    return "";
  }

  /**
   * Where to land when nothing else said.
   *
   * `/dashboard` is no longer a safe default. Under the code RBAC policy it is
   * Management + Super Admin only, so sending a salesperson there drops them on
   * a page missing from their own menu whose every figure comes back 403 — the
   * restriction would read as a broken login. The server already computes each
   * role's front door alongside its permissions; ask it rather than guessing
   * here, so the landing page cannot disagree with the menu.
   */
  async function landingPage(): Promise<string> {
    const explicit = getRedirectTarget();
    if (explicit) return explicit;
    try {
      const res = await fetch("/api/auth/me/permissions", {
        credentials: "include",
      });
      const body = (await res.json()) as { home?: string };
      if (body?.home) return body.home;
    } catch {
      /* fall through */
    }
    // Everyone has Settings, so this is never a dead end.
    return "/settings";
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Email and password are required.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Cookies are set by the server on this response — `credentials:
        // 'include'` ensures they actually land. (The global api-client
        // shim adds this for /api/* but we're explicit here so a stripped-
        // down login page still works if main.tsx imports change.)
        credentials: "include",
        // `rememberMe` decides whether the server sets a persistent (on-disk,
        // survives browser restart) or session-only (cleared on browser close)
        // auth cookie. Checked → stay logged in across restarts; unchecked →
        // sign out when the browser closes. See src/api/routes/auth.ts.
        body: JSON.stringify({ email: trimmedEmail, password, rememberMe }),
      });
      const json = (await res.json()) as LoginResponse;
      if (!res.ok || !json.success) {
        setError(
          ("error" in json && json.error) ||
            "Login failed. Please check your credentials.",
        );
        return;
      }
      // 2FA hard-gate response ({ success:true, totpRequired, userId }) carries
      // no `data`. The login-verify step isn't built (BUG-2026-08-04-006), so
      // handle it explicitly instead of crashing on json.data.user. The server
      // gate is currently disabled, but a stale worker / future re-enable must
      // never white-screen the login page again.
      if ("totpRequired" in json || !("data" in json) || !json.data?.user) {
        setError(
          "Two-factor sign-in isn't available yet. Ask an admin to reset your 2FA, then sign in with your password.",
        );
        return;
      }
      // Sprint 7: only the user blob lands in client storage; the session
      // token stays in the HttpOnly cookie and the CSRF token is read off
      // its non-HttpOnly cookie sibling on each mutating request. `rememberMe`
      // routes the blob to localStorage (persistent) or sessionStorage
      // (cleared on browser close) to mirror the cookie's persistence.
      setAuth({ user: json.data.user, rememberMe });

      // 2026-05-27 — Soft 2FA prompt. The server flags SUPER_ADMIN logins
      // that haven't enrolled yet with a severity. We branch BEFORE the
      // normal redirect so the user lands on /setup-2fa (hard / soft) or
      // sees a one-time confirm prompt (soft) instead of going straight
      // to the dashboard. severity = "info" stays silent here — the
      // dashboard will render a small banner; that's the spec.
      if (json.data.totpPromptRequired) {
        const sev = json.data.severity ?? "soft";
        if (sev === "hard") {
          // Newly-minted super admin past the cutoff. Force setup —
          // /setup-2fa hides "Skip" when navigated with this state.
          navigate("/setup-2fa", { replace: true, state: { severity: "hard" } });
          return;
        }
        if (sev === "soft") {
          // Confirm dialog is the lightest possible UI without pulling in
          // a modal component — keeps this change small. "OK" goes to
          // setup, "Cancel" dismisses for 24h then continues to dashboard.
          const wantSetup = await confirm({
            title: "Enable two-factor sign-in?",
            message:
              "Make your account more secure with two-factor sign-in?\n\nClick Set up now to enable it, or Remind me later to continue.",
            confirmLabel: "Set up now",
            cancelLabel: "Remind me later",
          });
          if (wantSetup) {
            navigate("/setup-2fa", {
              replace: true,
              state: { severity: "soft" },
            });
            return;
          }
          // User chose Cancel → write the dismissal so we don't re-prompt
          // for 24h. Fire-and-forget so a slow audit write doesn't stall
          // navigation. CSRF header is added by the api-client interceptor.
          fetch("/api/auth/totp/dismiss-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({}),
          }).catch(() => {
            /* swallow — best-effort */
          });
          // Fall through to the normal redirect below.
        }
        // severity === "info" falls through to the normal redirect — the
        // dashboard banner is rendered by a future small enhancement; not
        // wiring it now keeps this PR focused.
      }

      navigate(await landingPage(), { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  // ----- MOBILE branch (< lg) — owner's phone-first design -----
  if (isMobile) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: p.screenBg,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <style>{`
          @keyframes hkGlow { 0%,100% { opacity:.55; } 50% { opacity:.85; } }
          @keyframes hkSnow {
            0% { transform:translateY(-8%) translateX(0); opacity:0; }
            8% { opacity:.85; }
            50% { transform:translateY(46vh) translateX(16px); }
            92% { opacity:.6; }
            100% { transform:translateY(94vh) translateX(-12px); opacity:0; }
          }
          .ml-input::placeholder { color: ${p.canon}; }
          .ml-btn-primary {
            height: 50px;
            width: 100%;
            border: none;
            border-radius: 12px;
            font-family: inherit;
            font-size: 15px;
            font-weight: 700;
            color: #fff;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
            background: linear-gradient(135deg, #6B5C32, #8B7A4E);
            box-shadow: 0 6px 16px rgba(107,92,50,.32);
            transition: opacity .2s ease;
          }
          .ml-btn-primary:hover { opacity: .92; }
          .ml-btn-primary:disabled { opacity: .5; cursor: default; }
        `}</style>

        {/* back snow — behind content + frosted sheet */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          <SnowLayer flakes={SNOW_BACK} p={p} />
        </div>

        {/* 64px grid */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(107,92,50,.05) 0 1px, transparent 1px 64px), " +
              "repeating-linear-gradient(90deg, rgba(107,92,50,.05) 0 1px, transparent 1px 64px)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />

        {/* top radial glow */}
        <div
          style={{
            position: "absolute",
            top: "-12%",
            left: "50%",
            width: "120%",
            height: "58%",
            transform: "translateX(-50%)",
            background: `radial-gradient(closest-side, ${p.glow}, rgba(168,138,82,0) 72%)`,
            pointerEvents: "none",
            animation: "hkGlow 6s ease-in-out infinite",
            zIndex: 1,
          }}
        />

        {/* front snow — sparse, sharp, parallax depth (in front of content) */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: 16,
          }}
        >
          <SnowLayer flakes={SNOW_FRONT} p={p} />
        </div>

        {/* theme toggle — safe-area aware (no fake bezel on a real phone) */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top, 0px) + 16px)",
            right: "20px",
            zIndex: 26,
            width: "40px",
            height: "40px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            background: p.togBg,
            border: `1px solid ${p.togBorder}`,
          }}
        >
          {p.togIcon === "sun" ? (
            <Sun size={17} color={p.togIconColor} />
          ) : (
            <Moon size={17} color={p.togIconColor} />
          )}
        </button>

        {/* content column */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            zIndex: 2,
            maxWidth: "440px",
            margin: "0 auto",
            width: "100%",
          }}
        >
          {/* header */}
          <div
            style={{
              position: "relative",
              flex: "none",
              padding: "calc(env(safe-area-inset-top, 0px) + 68px) 28px 22px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
            }}
          >
            <img
              src="/hookka-logo.png"
              alt="Hookka 合家"
              style={{
                height: "50px",
                width: "auto",
                display: "block",
                ...(p.logoFilter ? { filter: p.logoFilter } : {}),
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginTop: "18px",
              }}
            >
              <span
                style={{
                  width: "24px",
                  height: "1px",
                  background: `linear-gradient(90deg,transparent,${p.hair})`,
                }}
              />
              <span
                style={{
                  fontSize: "10.5px",
                  color: p.portalColor,
                  letterSpacing: "3px",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                ERP · INDUSTRIES
              </span>
              <span
                style={{
                  width: "24px",
                  height: "1px",
                  background: `linear-gradient(90deg,${p.hair},transparent)`,
                }}
              />
            </div>
          </div>

          {/* frosted sheet */}
          <form
            onSubmit={handleSubmit}
            style={{
              position: "relative",
              flex: 1,
              marginTop: "10px",
              background: p.sheetBg,
              backdropFilter: "blur(18px)",
              WebkitBackdropFilter: "blur(18px)",
              borderTop: `1px solid ${p.sheetBorder}`,
              borderRadius: "28px 28px 0 0",
              padding: "26px 24px 0",
              overflowY: "auto",
            }}
          >
            <h2
              style={{
                margin: "0 0 4px",
                fontSize: "22px",
                fontWeight: 800,
                color: p.title,
                letterSpacing: "-.3px",
              }}
            >
              Welcome back
            </h2>
            <p
              style={{
                margin: "0 0 22px",
                fontSize: "12.5px",
                color: p.sub,
                lineHeight: 1.5,
              }}
            >
              Sign in to your manufacturing intelligence platform
            </p>

            {/* Email Address */}
            <div style={{ marginBottom: "15px" }}>
              <div
                style={{
                  fontSize: "10.5px",
                  fontWeight: 600,
                  color: p.label,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  marginBottom: "7px",
                }}
              >
                Email Address
              </div>
              <div style={mlFieldStyle(p)}>
                <Mail size={18} color={p.accent} />
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@hookka.com.my"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="ml-input"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    fontFamily: "inherit",
                    fontSize: "14px",
                    fontWeight: 500,
                    color: p.input,
                  }}
                />
              </div>
            </div>

            {/* Password */}
            <div style={{ marginBottom: "18px" }}>
              <div
                style={{
                  fontSize: "10.5px",
                  fontWeight: 600,
                  color: p.label,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  marginBottom: "7px",
                }}
              >
                Password
              </div>
              <div style={mlFieldStyle(p)}>
                <Lock size={18} color={p.accent} />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="ml-input"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    fontFamily: "inherit",
                    fontSize: "14px",
                    color: p.input,
                    letterSpacing: showPassword ? "normal" : "2px",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    cursor: "pointer",
                  }}
                >
                  {showPassword ? (
                    <Eye size={18} color={p.canon} />
                  ) : (
                    <EyeOff size={18} color={p.canon} />
                  )}
                </button>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div
                style={{
                  borderRadius: "11px",
                  padding: "12px 14px",
                  fontSize: "13px",
                  marginBottom: "18px",
                  background: "rgba(220, 38, 38, 0.12)",
                  border: "1px solid rgba(220, 38, 38, 0.3)",
                  color: "#FCA5A5",
                }}
                role="alert"
              >
                {error}
              </div>
            )}

            {/* Remember me + Forgot password */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "22px",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  style={{
                    position: "absolute",
                    opacity: 0,
                    width: 0,
                    height: 0,
                  }}
                />
                <span
                  style={{
                    width: "17px",
                    height: "17px",
                    borderRadius: "5px",
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: rememberMe ? p.accent : "transparent",
                    border: rememberMe
                      ? `1px solid ${p.accent}`
                      : `1.5px solid ${p.fieldBorder}`,
                  }}
                >
                  {rememberMe && <Check size={12} color="#fff" />}
                </span>
                <span style={{ fontSize: "13px", color: p.sub }}>
                  Remember me
                </span>
              </label>
              <button
                type="button"
                onClick={() => navigate("/forgot-password")}
                style={{
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  cursor: "pointer",
                  fontSize: "13px",
                  color: p.accent,
                  fontWeight: 600,
                }}
              >
                Forgot Password?
              </button>
            </div>

            {/* Sign In */}
            <button
              type="submit"
              disabled={loading}
              className="ml-btn-primary"
            >
              {loading ? "Signing in..." : "Sign In"}
              {!loading && <ArrowRight size={19} color="#fff" />}
            </button>

            <div
              style={{
                height: "calc(env(safe-area-inset-bottom, 0px) + 28px)",
              }}
            />
          </form>
        </div>
      </div>
    );
  }

  // ----- DESKTOP branch (>= lg) — existing premium split-panel, unchanged -----
  return (
    <>
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes orbit1 {
          0% { transform: rotate(0deg) translateX(150px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(150px) rotate(-360deg); }
        }
        @keyframes orbit2 {
          0% { transform: rotate(0deg) translateX(225px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(225px) rotate(-360deg); }
        }
        @keyframes orbit3 {
          0% { transform: rotate(0deg) translateX(300px) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(300px) rotate(-360deg); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .btn-shimmer {
          position: relative;
          overflow: hidden;
        }
        .btn-shimmer::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255,255,255,0.15),
            transparent
          );
          transform: translateX(-100%);
        }
        .btn-shimmer:hover::after {
          animation: shimmer 1.5s ease-in-out;
        }
        .login-input:focus {
          border-color: #6B5C32 !important;
          box-shadow: 0 0 0 3px rgba(107,92,50,0.2);
          outline: none;
        }
        .orbit-dot {
          width: 6px;
          height: 6px;
          background: #6B5C32;
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
        }
      `}</style>

      <div className="flex min-h-screen">
        {/* Left Panel - Login Form */}
        <div
          className="flex w-full lg:w-1/2 items-center justify-center p-8 relative"
          style={{
            backgroundColor: "#1F1D1B",
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(107,92,50,.06) 0 1px, transparent 1px 60px), repeating-linear-gradient(90deg, rgba(107,92,50,.06) 0 1px, transparent 1px 60px)",
          }}
        >
          {/* Falling snow behind the card (owner 2026-06-27/28: snow on the main
              login, desktop + mobile). */}
          <LoginSnow />
          <div
            className="relative z-10 w-full max-w-md rounded-2xl p-10"
            style={{
              backgroundColor: "rgba(255,255,255,.04)",
              border: "1px solid rgba(107,92,50,.2)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
            }}
          >
            {/* Logo Row */}
            <div className="mb-10">
              <img
                src="/hookka-logo.png"
                alt="Hookka 合家"
                className="h-10 w-auto"
                style={{ filter: "brightness(0) invert(1)" }}
              />
            </div>

            {/* Title */}
            <h2 className="text-2xl font-bold text-white mb-1">Welcome back</h2>
            <p
              className="mb-8"
              style={{ color: "rgba(255,255,255,.45)", fontSize: "13px" }}
            >
              Sign in to your manufacturing intelligence platform
            </p>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="email"
                  className="block mb-2 uppercase font-medium"
                  style={{
                    color: "rgba(255,255,255,.5)",
                    fontSize: "12px",
                    letterSpacing: "0.05em",
                  }}
                >
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@hookka.com.my"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="login-input w-full rounded-lg px-4 py-3 text-white transition-all duration-200"
                  style={{
                    backgroundColor: "rgba(255,255,255,.06)",
                    border: "1.5px solid rgba(107,92,50,.3)",
                    fontSize: "14px",
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block mb-2 uppercase font-medium"
                  style={{
                    color: "rgba(255,255,255,.5)",
                    fontSize: "12px",
                    letterSpacing: "0.05em",
                  }}
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="login-input w-full rounded-lg px-4 py-3 text-white transition-all duration-200"
                  style={{
                    backgroundColor: "rgba(255,255,255,.06)",
                    border: "1.5px solid rgba(107,92,50,.3)",
                    fontSize: "14px",
                  }}
                />
              </div>

              {/* Error banner */}
              {error && (
                <div
                  className="rounded-lg px-4 py-3 text-sm"
                  style={{
                    backgroundColor: "rgba(220, 38, 38, 0.1)",
                    border: "1px solid rgba(220, 38, 38, 0.3)",
                    color: "#FCA5A5",
                  }}
                  role="alert"
                >
                  {error}
                </div>
              )}

              {/* Remember me + Forgot password */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded"
                    style={{ accentColor: "#6B5C32" }}
                  />
                  <span
                    style={{
                      color: "rgba(255,255,255,.45)",
                      fontSize: "13px",
                    }}
                  >
                    Remember me
                  </span>
                </label>
                {/* Self-service reset (added 2026-05-27). Navigates to
                    /forgot-password which posts to /api/auth/forgot-password
                    and emails a one-hour reset link. The old "ask a super
                    admin" helper text was removed at the same time. */}
                <button
                  type="button"
                  onClick={() => navigate("/forgot-password")}
                  className="hover:underline bg-transparent border-0 p-0 cursor-pointer"
                  style={{ color: "#8B7A4E", fontSize: "13px" }}
                >
                  Forgot Password?
                </button>
              </div>

              {/* Sign In Button */}
              <button
                type="submit"
                disabled={loading}
                className="btn-shimmer w-full rounded-lg font-semibold text-white transition-all duration-200 hover:opacity-90 disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, #6B5C32, #8B7A4E)",
                  padding: "14px",
                  fontSize: "15px",
                }}
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>
          </div>

          {/* Footer */}
          <div
            className="absolute bottom-6 left-0 right-0 text-center"
            style={{
              color: "rgba(255,255,255,.25)",
              fontSize: "11px",
              letterSpacing: "0.03em",
            }}
          >
            HOOKKA INDUSTRIES SDN BHD &bull; 202501060540 (1661946-X)
          </div>
        </div>

        {/* Right Panel - Brand Side */}
        <div
          className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden"
          style={{
            backgroundColor: "#1F1D1B",
            backgroundImage:
              "radial-gradient(ellipse at center, rgba(107,92,50,.08) 0%, transparent 70%)",
          }}
        >
          {/* Orbit Rings */}
          <div
            className="absolute rounded-full"
            style={{
              width: "300px",
              height: "300px",
              border: "1px solid rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: "450px",
              height: "450px",
              border: "1px solid rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: "600px",
              height: "600px",
              border: "1px dashed rgba(107,92,50,.08)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />

          {/* Orbit Dots */}
          <div
            className="absolute"
            style={{ top: "50%", left: "50%", width: 0, height: 0 }}
          >
            <div
              className="orbit-dot"
              style={{ animation: "orbit1 12s linear infinite" }}
            />
            <div
              className="orbit-dot"
              style={{ animation: "orbit2 18s linear infinite reverse" }}
            />
            <div
              className="orbit-dot"
              style={{ animation: "orbit3 25s linear infinite" }}
            />
          </div>

          {/* Center Content */}
          <div className="relative z-10 flex flex-col items-center text-center">
            <img
              src="/hookka-logo.png"
              alt="Hookka 合家"
              className="mb-6"
              style={{
                height: "140px",
                width: "auto",
                filter: "brightness(0) invert(1)",
              }}
            />

            <p
              className="uppercase mb-6"
              style={{ color: "#8B7A4E", fontSize: "13px", letterSpacing: "4px" }}
            >
              Manufacturing Intelligence Platform
            </p>

            <div
              className="mb-6"
              style={{
                width: "60px",
                height: "1px",
                background:
                  "linear-gradient(90deg, transparent, #6B5C32, transparent)",
              }}
            />

            <div
              className="px-4 py-1.5 rounded-full"
              style={{
                border: "1px solid rgba(107,92,50,.4)",
                color: "#8B7A4E",
                fontSize: "11px",
                letterSpacing: "3px",
              }}
            >
              INDUSTRY 4.0
            </div>

            {/* Stats panel (156 ACTIVE PO / 8 DEPARTMENTS / 99.7% UPTIME)
                removed 2026-05-27 per Wei Siang — they were hardcoded
                placeholders, not live. Better to show nothing than
                misleading numbers. */}
          </div>

          <div
            className="absolute"
            style={{
              top: "24px",
              left: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            HOOKKA INDUSTRIES
          </div>

          <div
            className="absolute flex items-center gap-2"
            style={{
              top: "24px",
              right: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            <span
              className="inline-block rounded-full"
              style={{
                width: "6px",
                height: "6px",
                backgroundColor: "#22c55e",
                animation: "blink 2s ease-in-out infinite",
              }}
            />
            SYSTEM ONLINE
          </div>

          <div
            className="absolute"
            style={{
              bottom: "24px",
              left: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            ERP v2.0 // 2026
          </div>

          <div
            className="absolute"
            style={{
              bottom: "24px",
              right: "24px",
              color: "rgba(107,92,50,.4)",
              fontSize: "10px",
              fontFamily: "'Courier New', monospace",
              letterSpacing: "0.08em",
            }}
          >
            ISO 9001:2015
          </div>
        </div>
      </div>
    </>
  );
}

// ----- mobile field wrapper (icon + input row), styled to the sheet -----
function mlFieldStyle(p: Palette): React.CSSProperties {
  return {
    background: p.fieldBg,
    border: `1.5px solid ${p.fieldBorder}`,
    borderRadius: "11px",
    padding: "13px 14px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  };
}

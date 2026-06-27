// ============================================================
// /worker/login — PIN sign-in for the mobile shop-floor portal
//
// Three screens share this page, swapped via local state:
//   1. mode = "login" — enter empNo + PIN (default)
//   2. mode = "setup" — empNo found but no PIN yet → create one
//   3. mode = "reset" — forgot PIN → verify with phone last-4
//
// The API's /login returns `needsSetup: true` (HTTP 200) when a
// worker has no PIN on record — we flip to setup mode on that.
//
// 2026-06-27 (owner: "logo 100% 一样, 全套新设计"): the SHELL + LOGO
// are now byte-identical to the ERP desktop login (src/pages/login.tsx)
// — same #1F1D1B grid background, glass card, brightness(0) invert(1)
// logo, gold gradient button + btn-shimmer, and the orbiting right-side
// brand panel. We render a `fixed inset-0` overlay so this page breaks
// out of WorkerLayout's max-w-md / black top-bar chrome and fills the
// whole screen exactly like the desktop login. ALL worker behaviour
// (3 modes, handlers, finalizeLogin, every t() i18n call) is unchanged.
//
// 2026-06-27 (owner: "Dark/Light mode toggle"): purely additive theming.
// A `theme` state ("dark" | "light"), persisted in localStorage, drives a
// single PALETTE object — every inline style, the logo <img filter>, the
// right brand panel and the PIN keypad colours read off it, so a single
// circular Sun/Moon toggle (top-right, type="button") flips everything
// cleanly. DARK = white logo on dark grid (Sun icon → go light). LIGHT =
// dark logo on a warm-cream bg (Moon icon → go dark). Gold accents + the
// gold "Sign In" gradient are identical in both modes. NO logic change.
// ============================================================
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sun, Moon } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import {
  WORKER_TOKEN_KEY,
  WORKER_ME_KEY,
  type WorkerMe,
} from "@/layouts/WorkerLayout";

type Mode = "login" | "setup" | "reset";
type ThemeName = "dark" | "light";

const THEME_KEY = "hookka.worker.theme";

// Shared grid (same line geometry both modes — only the line tint differs).
function gridImage(tint: string): string {
  return (
    `repeating-linear-gradient(0deg, ${tint} 0 1px, transparent 1px 60px), ` +
    `repeating-linear-gradient(90deg, ${tint} 0 1px, transparent 1px 60px)`
  );
}

// One palette per mode. Gold accents (#C9A961/#8B7A4E/#6B5C32) + the gold
// "Sign In" gradient stay IDENTICAL in both — only the bg/card/text/input
// surfaces flip. Every render site reads off this object.
type Palette = {
  screenBg: string;
  screenGridImage: string;
  cardBg: string;
  cardBorder: string;
  cardShadow: string;
  cardBlur: string;
  logoFilter: string; // "" = no filter (dark logo as-is)
  titleColor: string;
  subtitleColor: string;
  labelColor: string;
  footerColor: string;
  linkMuted: string; // "back" links
  inputBg: string;
  inputBorder: string;
  inputText: string;
  inputPlaceholder: string;
  brandPanelBg: string;
  brandPanelGlow: string;
  ringSolid: string;
  ringDashed: string;
  orbitDot: string;
  brandDivider: string;
  hudText: string;
  pinKeyBg: string;
  pinKeyBorder: string;
  pinKeyText: string;
  toggleBg: string;
  toggleBorder: string;
  toggleIcon: string;
};

const PALETTE: Record<ThemeName, Palette> = {
  dark: {
    screenBg: "#1F1D1B",
    screenGridImage: gridImage("rgba(107,92,50,.06)"),
    cardBg: "rgba(255,255,255,.04)",
    cardBorder: "1px solid rgba(107,92,50,.2)",
    cardShadow: "none",
    cardBlur: "blur(24px)",
    logoFilter: "brightness(0) invert(1)",
    titleColor: "#ffffff",
    subtitleColor: "rgba(255,255,255,.45)",
    labelColor: "rgba(255,255,255,.5)",
    footerColor: "rgba(255,255,255,.25)",
    linkMuted: "rgba(255,255,255,.45)",
    inputBg: "rgba(255,255,255,.06)",
    inputBorder: "1.5px solid rgba(107,92,50,.3)",
    inputText: "#ffffff",
    inputPlaceholder: "rgba(255,255,255,.35)",
    brandPanelBg: "#1F1D1B",
    brandPanelGlow:
      "radial-gradient(ellipse at center, rgba(107,92,50,.08) 0%, transparent 70%)",
    ringSolid: "1px solid rgba(107,92,50,.08)",
    ringDashed: "1px dashed rgba(107,92,50,.08)",
    orbitDot: "#6B5C32",
    brandDivider:
      "linear-gradient(90deg, transparent, #6B5C32, transparent)",
    hudText: "rgba(107,92,50,.4)",
    pinKeyBg: "rgba(255,255,255,.05)",
    pinKeyBorder: "1px solid rgba(107,92,50,.3)",
    pinKeyText: "#ffffff",
    toggleBg: "rgba(255,255,255,.08)",
    toggleBorder: "1px solid rgba(107,92,50,.35)",
    toggleIcon: "#C9A961",
  },
  light: {
    screenBg:
      "radial-gradient(circle at 50% 20%, #E8E1D5, #D2CABD)",
    screenGridImage: gridImage("rgba(107,92,50,.05)"),
    cardBg: "rgba(255,255,255,.9)",
    cardBorder: "1px solid rgba(31,29,27,.12)",
    cardShadow: "0 20px 50px rgba(31,29,27,.12)",
    cardBlur: "blur(24px)",
    logoFilter: "", // dark logo as-is
    titleColor: "#1F1D1B",
    subtitleColor: "rgba(31,29,27,.5)",
    labelColor: "rgba(31,29,27,.5)",
    footerColor: "rgba(31,29,27,.35)",
    linkMuted: "rgba(31,29,27,.5)",
    inputBg: "#faf9f5",
    inputBorder: "1.5px solid #E2DDD8",
    inputText: "#1F1D1B",
    inputPlaceholder: "rgba(31,29,27,.35)",
    brandPanelBg: "#E8E1D5",
    brandPanelGlow:
      "radial-gradient(ellipse at center, rgba(107,92,50,.1) 0%, transparent 70%)",
    ringSolid: "1px solid rgba(107,92,50,.18)",
    ringDashed: "1px dashed rgba(107,92,50,.18)",
    orbitDot: "#8B7A4E",
    brandDivider:
      "linear-gradient(90deg, transparent, #6B5C32, transparent)",
    hudText: "rgba(107,92,50,.6)",
    pinKeyBg: "#F0ECE9",
    pinKeyBorder: "1px solid #E2DDD8",
    pinKeyText: "#1F1D1B",
    toggleBg: "rgba(255,255,255,.7)",
    toggleBorder: "1px solid rgba(107,92,50,.35)",
    toggleIcon: "#8B7A4E",
  },
};

function readTheme(): ThemeName {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

type WorkerAuthSuccess = {
  success: true;
  token: string;
  worker: WorkerMe;
  needsSetup?: false;
};

type WorkerAuthNeedsSetup = {
  success: false;
  needsSetup: true;
  error?: string;
};

type WorkerAuthError = {
  success: false;
  error?: string;
  needsSetup?: false;
};

type WorkerAuthResponse = WorkerAuthSuccess | WorkerAuthNeedsSetup | WorkerAuthError;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asWorkerMe(v: unknown): WorkerMe | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  const empNo = asString(v.empNo);
  const name = asString(v.name);
  const departmentCode = asString(v.departmentCode);
  if (!id || !empNo || !name || !departmentCode) return null;
  return {
    id,
    empNo,
    name,
    departmentCode,
    position: asString(v.position),
    phone: asString(v.phone),
    nationality: asString(v.nationality),
  };
}

function asWorkerAuthResponse(v: unknown): WorkerAuthResponse | null {
  if (!isRecord(v)) return null;
  if (v.needsSetup === true) {
    return { needsSetup: true, success: false, error: asString(v.error) };
  }
  if (v.success === true && typeof v.token === "string") {
    const worker = asWorkerMe(v.worker);
    if (!worker) return null;
    return { success: true, token: v.token, worker };
  }
  if (v.success === false) {
    return { success: false, error: asString(v.error) };
  }
  return null;
}

export default function WorkerLoginPage() {
  const t = useT();
  const navigate = useNavigate();

  const [theme, setTheme] = useState<ThemeName>(readTheme);
  const p = PALETTE[theme];

  function toggleTheme() {
    setTheme((prev) => {
      const next: ThemeName = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const [mode, setMode] = useState<Mode>("login");
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ----- Login handler -----
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!empNo.trim()) {
      setError(t("common.error"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empNo: empNo.trim(), pin }),
      });
      const data = asWorkerAuthResponse(await res.json());
      if (!data) {
        setError(t("common.error"));
        return;
      }

      // Server says "no PIN on file yet" → swap to setup screen
      if (data.needsSetup) {
        setMode("setup");
        setPin("");
        setError(null);
        return;
      }
      if (!data.success) {
        setError(data.error || t("common.error"));
        return;
      }
      finalizeLogin(data);
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  // ----- First-time PIN setup -----
  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(pin)) {
      setError(t("common.error"));
      return;
    }
    if (pin !== pin2) {
      setError(t("login.pinMismatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empNo: empNo.trim(), firstTimePin: pin }),
      });
      const data = asWorkerAuthResponse(await res.json());
      if (!data || !data.success) {
        setError(data?.error || t("common.error"));
        return;
      }
      finalizeLogin(data);
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  // ----- PIN reset -----
  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(pin)) {
      setError(t("common.error"));
      return;
    }
    if (pin !== pin2) {
      setError(t("login.pinMismatch"));
      return;
    }
    if (!/^\d{4}$/.test(phoneLast4)) {
      setError(t("common.error"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/reset-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empNo: empNo.trim(),
          phoneLast4,
          newPin: pin,
        }),
      });
      const data = asWorkerAuthResponse(await res.json());
      if (!data || !data.success) {
        setError(data?.error || t("common.error"));
        return;
      }
      // After reset, fall back to login screen so the worker logs in
      // with the fresh PIN — keeps the flow deliberate.
      setMode("login");
      setPin("");
      setPin2("");
      setPhoneLast4("");
      setError(null);
    } catch {
      setError(t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  // Shared happy-path — store token + worker, go home
  function finalizeLogin(data: { token: string; worker: WorkerMe }) {
    try {
      localStorage.setItem(WORKER_TOKEN_KEY, data.token);
      localStorage.setItem(WORKER_ME_KEY, JSON.stringify(data.worker));
      window.dispatchEvent(new Event("storage"));
    } catch {
      /* ignore */
    }
    navigate("/worker", { replace: true });
  }

  // ----- Render -----
  // Heading + subtitle text per mode (all via t()).
  const heading =
    mode === "login"
      ? t("login.title")
      : mode === "setup"
        ? t("login.setupTitle")
        : t("login.resetTitle");
  const subtitle =
    mode === "setup"
      ? t("login.setupDesc")
      : mode === "reset"
        ? t("login.phoneLast4")
        : t("brand.title");

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
        .login-input::placeholder {
          color: var(--wl-input-ph);
        }
        .orbit-dot {
          width: 6px;
          height: 6px;
          background: var(--wl-orbit-dot);
          border-radius: 50%;
          position: absolute;
          top: 50%;
          left: 50%;
        }
        .login-cta {
          background: linear-gradient(135deg, #6B5C32, #8B7A4E);
          padding: 14px;
          font-size: 15px;
        }
        .pin-key {
          width: 56px;
          height: 56px;
          border-radius: 9999px;
          font-size: 20px;
          font-weight: 600;
          color: var(--wl-pin-text);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all .15s ease;
          border: var(--wl-pin-border);
          background: var(--wl-pin-bg);
        }
        .pin-key:active {
          background: linear-gradient(135deg, #6B5C32, #8B7A4E);
          color: #fff;
          transform: scale(.94);
        }
        .wl-theme-toggle:hover {
          opacity: 0.85;
        }
      `}</style>

      {/* fixed overlay so we break out of WorkerLayout's max-w-md / black
          top-bar chrome and fill the screen exactly like the desktop login.
          CSS vars feed the bits that live in the <style> block (placeholder,
          orbit dot, PIN keys) so they flip with the theme too. */}
      <div
        className="fixed inset-0 z-50 flex min-h-screen overflow-auto"
        style={
          {
            "--wl-input-ph": p.inputPlaceholder,
            "--wl-orbit-dot": p.orbitDot,
            "--wl-pin-text": p.pinKeyText,
            "--wl-pin-border": p.pinKeyBorder,
            "--wl-pin-bg": p.pinKeyBg,
          } as React.CSSProperties
        }
      >
        {/* Dark / Light toggle — circular, top-right (mockup placement; owner
            typed 左上角 / top-left — to move it left, swap right:20px → left:20px).
            type="button" so it never submits a form. */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="wl-theme-toggle"
          style={{
            position: "fixed",
            top: "20px",
            right: "20px",
            zIndex: 60,
            width: "40px",
            height: "40px",
            borderRadius: "9999px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: p.toggleBg,
            border: p.toggleBorder,
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            cursor: "pointer",
            transition: "all .2s ease",
          }}
        >
          {theme === "dark" ? (
            <Sun size={18} color={p.toggleIcon} />
          ) : (
            <Moon size={18} color={p.toggleIcon} />
          )}
        </button>

        {/* Left Panel - Login Form */}
        <div
          className="flex w-full lg:w-1/2 items-center justify-center p-8 relative"
          style={{
            background: p.screenBg,
            backgroundImage: p.screenGridImage,
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl p-10"
            style={{
              backgroundColor: p.cardBg,
              border: p.cardBorder,
              boxShadow: p.cardShadow,
              backdropFilter: p.cardBlur,
              WebkitBackdropFilter: p.cardBlur,
            }}
          >
            {/* Logo Row */}
            <div className="mb-10">
              <img
                src="/hookka-logo.png"
                alt="Hookka 合家"
                className="h-10 w-auto"
                style={p.logoFilter ? { filter: p.logoFilter } : undefined}
              />
            </div>

            {/* Title */}
            <h2
              className="text-2xl font-bold mb-1"
              style={{ color: p.titleColor }}
            >
              {heading}
            </h2>
            <p
              className="mb-8"
              style={{ color: p.subtitleColor, fontSize: "13px" }}
            >
              {subtitle}
            </p>

            {/* ----- mode = login ----- */}
            {mode === "login" && (
              <form onSubmit={handleLogin} className="space-y-5">
                <FieldLabel label={t("login.empNo")} palette={p}>
                  <input
                    type="text"
                    autoComplete="username"
                    value={empNo}
                    onChange={(e) => setEmpNo(e.target.value)}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="EMP-0001"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.pin")} palette={p}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="••••••"
                  />
                </FieldLabel>

                {/* Numeric PIN keypad — circular gold keys feed the same
                    `pin` state. Pure convenience on phones; the input above
                    still works for anyone who prefers typing. */}
                <PinPad
                  onDigit={(d) =>
                    setPin((p) => (p.length >= 6 ? p : p + d))
                  }
                  onDelete={() => setPin((p) => p.slice(0, -1))}
                />

                {error && <ErrorBanner>{error}</ErrorBanner>}

                <button type="submit" disabled={loading} className={btnPrimary}>
                  {loading ? t("common.loading") : t("login.submit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("reset");
                    setPin("");
                    setPin2("");
                    setError(null);
                  }}
                  className="w-full text-sm pt-2 hover:underline bg-transparent border-0 cursor-pointer"
                  style={{ color: "#8B7A4E" }}
                >
                  {t("login.forgotPin")}
                </button>
              </form>
            )}

            {/* ----- mode = setup ----- */}
            {mode === "setup" && (
              <form onSubmit={handleSetup} className="space-y-5">
                <FieldLabel label={t("login.empNo")} palette={p}>
                  <input
                    type="text"
                    value={empNo}
                    readOnly
                    className={inputCls}
                    style={{ ...inputStyleOf(p), opacity: 0.7 }}
                  />
                </FieldLabel>
                <FieldLabel label={t("login.newPin")} palette={p}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="••••••"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.confirmPin")} palette={p}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin2}
                    onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="••••••"
                  />
                </FieldLabel>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" disabled={loading} className={btnPrimary}>
                  {loading ? t("common.loading") : t("login.submit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setPin("");
                    setPin2("");
                    setError(null);
                  }}
                  className="w-full text-sm pt-2 bg-transparent border-0 cursor-pointer"
                  style={{ color: p.linkMuted }}
                >
                  {t("common.back")}
                </button>
              </form>
            )}

            {/* ----- mode = reset ----- */}
            {mode === "reset" && (
              <form onSubmit={handleReset} className="space-y-5">
                <FieldLabel label={t("login.empNo")} palette={p}>
                  <input
                    type="text"
                    value={empNo}
                    onChange={(e) => setEmpNo(e.target.value)}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="EMP-0001"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.phoneLast4")} palette={p}>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4}"
                    maxLength={4}
                    value={phoneLast4}
                    onChange={(e) =>
                      setPhoneLast4(e.target.value.replace(/\D/g, ""))
                    }
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="1234"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.newPin")} palette={p}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="••••••"
                  />
                </FieldLabel>
                <FieldLabel label={t("login.confirmPin")} palette={p}>
                  <input
                    type="password"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={pin2}
                    onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                    className={inputCls}
                    style={inputStyleOf(p)}
                    placeholder="••••••"
                  />
                </FieldLabel>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <button type="submit" disabled={loading} className={btnPrimary}>
                  {loading ? t("common.loading") : t("login.resetSubmit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setPin("");
                    setPin2("");
                    setPhoneLast4("");
                    setError(null);
                  }}
                  className="w-full text-sm pt-2 bg-transparent border-0 cursor-pointer"
                  style={{ color: p.linkMuted }}
                >
                  {t("common.back")}
                </button>
              </form>
            )}
          </div>

          {/* Footer */}
          <div
            className="absolute bottom-6 left-0 right-0 text-center"
            style={{
              color: p.footerColor,
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
            background: p.brandPanelBg,
            backgroundImage: p.brandPanelGlow,
          }}
        >
          {/* Orbit Rings */}
          <div
            className="absolute rounded-full"
            style={{
              width: "300px",
              height: "300px",
              border: p.ringSolid,
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
              border: p.ringSolid,
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
              border: p.ringDashed,
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
                ...(p.logoFilter ? { filter: p.logoFilter } : {}),
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
                background: p.brandDivider,
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
          </div>

          <div
            className="absolute"
            style={{
              top: "24px",
              left: "24px",
              color: p.hudText,
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
              color: p.hudText,
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
              color: p.hudText,
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
              color: p.hudText,
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

// ----- tiny UI helpers (re-skinned to match the desktop login) -----
const inputCls =
  "login-input w-full rounded-lg px-4 py-3 transition-all duration-200";
function inputStyleOf(p: Palette): React.CSSProperties {
  return {
    backgroundColor: p.inputBg,
    border: p.inputBorder,
    color: p.inputText,
    fontSize: "14px",
  };
}
const btnPrimary =
  "login-cta btn-shimmer w-full rounded-lg font-semibold text-white transition-all duration-200 hover:opacity-90 disabled:opacity-50";

function FieldLabel({
  label,
  children,
  palette,
}: {
  label: string;
  children: React.ReactNode;
  palette: Palette;
}) {
  return (
    <div>
      <label
        className="block mb-2 uppercase font-medium"
        style={{
          color: palette.labelColor,
          fontSize: "12px",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg px-4 py-3 text-sm"
      style={{
        backgroundColor: "rgba(220, 38, 38, 0.1)",
        border: "1px solid rgba(220, 38, 38, 0.3)",
        color: "#FCA5A5",
      }}
      role="alert"
    >
      {children}
    </div>
  );
}

// Numeric keypad for fast PIN entry on a phone. Buttons are type="button"
// so they never submit the form; they only mutate the shared `pin` state.
// Key colours come from the theme CSS vars set on the overlay wrapper.
function PinPad({
  onDigit,
  onDelete,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3 justify-items-center">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <button
          key={d}
          type="button"
          className="pin-key"
          onClick={() => onDigit(d)}
        >
          {d}
        </button>
      ))}
      <span />
      <button type="button" className="pin-key" onClick={() => onDigit("0")}>
        0
      </button>
      <button
        type="button"
        className="pin-key"
        onClick={onDelete}
        aria-label="Delete"
        style={{ fontSize: "16px" }}
      >
        ⌫
      </button>
    </div>
  );
}

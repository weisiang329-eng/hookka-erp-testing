// ============================================================
// /worker/login — PIN sign-in for the mobile shop-floor portal
//
// Three screens share this page, swapped via local state:
//   1. mode = "login" — enter empNo + PIN via the gold keypad (default)
//   2. mode = "setup" — empNo found but no PIN yet → create one
//   3. mode = "reset" — forgot PIN → verify with phone last-4
//
// The API's /login returns `needsSetup: true` (HTTP 200) when a
// worker has no PIN on record — we flip to setup mode on that.
//
// 2026-06-28 (owner: the REAL worker-login design): rebuilt 1:1 from the
// owner's design source (Hookka Worker Login.dc.html). This is a single
// centered phone-first column — NO desktop split panel, NO right brand
// panel. Dark-default screen (#16140F) with a 64px grid, a pulsing top
// radial glow, two-layer parallax SNOW (16 blurred "back" flakes behind
// the frosted sheet + 5 sharp "front" flakes in front), a centered logo
// + "— WORKER PORTAL —" hairline row, and a frosted glass sheet holding:
// the Sign-in heading, an EMPLOYEE NO. field with a live canonicalised
// (EMP-0088) readout, 6 PIN segment bars (NOT a text input), and a 3-col
// gold keypad (1-9, blank, 0, backspace). Typing 6 digits auto-submits
// the login. Setup + reset stay reachable as secondary views with the
// same dark/light sheet styling.
//
// Both palettes (dark + light) are ported exactly from the source's `T`
// theme object. A circular Sun/Moon toggle (top-right, safe-area aware)
// flips the theme; the choice persists to localStorage. ALL worker auth
// behaviour (3 modes, handlers, finalizeLogin, every t() i18n call) is
// preserved.
// ============================================================
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { IdCard, Delete, Sun, Moon } from "lucide-react";
import { useT } from "@/lib/worker-i18n";
import {
  WORKER_TOKEN_KEY,
  WORKER_ME_KEY,
  type WorkerMe,
} from "@/lib/worker-session";

type Mode = "login" | "setup" | "reset";
type ThemeName = "dark" | "light";

const THEME_KEY = "hookka.worker.theme";

// ---- Palette: ported verbatim from the design source's `T` object ----
// (dark + light). Gold accents are part of each palette; every render
// site reads off this object so the Sun/Moon toggle flips everything.
type Palette = {
  screenBg: string;
  statusFg: string;
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
  canon: string;
  pinOff: string;
  pinOn: string;
  pinGlow: string;
  keyBg: string;
  keyBorder: string;
  keyColor: string;
  backIcon: string;
  snowGlow: string;
  snowMul: number;
  snow: (op: number) => string;
  togBg: string;
  togBorder: string;
  togIcon: "sun" | "moon";
  togIconColor: string;
};

const PALETTE: Record<ThemeName, Palette> = {
  dark: {
    screenBg: "#16140F",
    statusFg: "#F0ECE9",
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
    pinOff: "rgba(255,255,255,.12)",
    pinOn: "#C9A961",
    pinGlow: "rgba(201,169,97,.55)",
    keyBg: "rgba(255,255,255,.06)",
    keyBorder: "rgba(201,169,97,.16)",
    keyColor: "#E8E1D2",
    backIcon: "#E8E1D2",
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
    statusFg: "#1F1D1B",
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
    pinOff: "rgba(31,29,27,.12)",
    pinOn: "#8B7A4E",
    pinGlow: "rgba(139,122,78,.4)",
    keyBg: "rgba(255,255,255,.6)",
    keyBorder: "#E7E0D4",
    keyColor: "#1F1D1B",
    backIcon: "#4D4630",
    snowGlow: "rgba(40,36,28,.25)",
    snowMul: 1,
    snow: (op) => `rgba(40,36,28,${(op * 0.5).toFixed(2)})`,
    togBg: "rgba(31,29,27,.05)",
    togBorder: "#E2DDD8",
    togIcon: "moon",
    togIconColor: "#6B5C32",
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

// canonEmp — ported verbatim from the design source. Turns whatever the
// worker types ("88", "emp88", "EMP-0088") into a clean "EMP-0088" shown
// to the right of the field as a confirmation readout.
function canonEmp(raw: string): string {
  const d = (raw || "").replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
  const m = d.match(/^EMP0*(\d+)$/) || d.match(/^0*(\d+)$/);
  if (m) return "EMP-" + m[1].padStart(4, "0");
  return d || "";
}

// ---- Deterministic two-layer parallax snow ----
// The source generates flakes with Math.random over fixed ranges. Random
// is fine in the browser, but we want stable, render-every-time flakes —
// so we seed a small LCG once at module load and freeze the arrays. Ranges
// (count / size / duration / delay / opacity / blur) match the source.
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

const _rng = makeRng(0x4845_4f4b); // "HEOK"
const rnd = (a: number, b: number) => a + _rng() * (b - a);

// back = many, smaller, blurred, slower (depth, drifts behind frosted sheet)
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

type WorkerAuthResponse =
  | WorkerAuthSuccess
  | WorkerAuthNeedsSetup
  | WorkerAuthError;

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
  // Accepts an explicit pin so the keypad can auto-submit the freshly
  // typed 6th digit without waiting for a state flush.
  async function handleLogin(e?: React.FormEvent, pinOverride?: string) {
    if (e) e.preventDefault();
    setError(null);
    const usePin = pinOverride ?? pin;
    if (!empNo.trim()) {
      setError(t("common.error"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/worker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empNo: empNo.trim(), pin: usePin }),
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
        setPin(""); // clear so the keypad is ready for a retry
        return;
      }
      finalizeLogin(data);
    } catch {
      setError(t("common.error"));
      setPin("");
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

  // ----- Keypad → PIN -----
  // Digits fill the 6 bars; the 6th digit auto-submits the login. Guard
  // against double-submit while a request is already in flight.
  const submittingRef = useRef(false);
  function pressKey(k: string) {
    if (mode !== "login") return;
    setError(null);
    if (k === "back") {
      setPin((prev) => prev.slice(0, -1));
      return;
    }
    setPin((prev) => {
      if (prev.length >= 6) return prev;
      const next = prev + k;
      if (next.length === 6 && !submittingRef.current) {
        submittingRef.current = true;
        // submit on the freshly completed 6-digit PIN
        void handleLogin(undefined, next).finally(() => {
          submittingRef.current = false;
        });
      }
      return next;
    });
  }

  // Hardware / soft keyboard support for the keypad (desktop testing +
  // anyone who prefers typing) — only active in login mode.
  useEffect(() => {
    if (mode !== "login") return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key >= "0" && ev.key <= "9") {
        pressKey(ev.key);
      } else if (ev.key === "Backspace") {
        // don't steal Backspace while focused in the empNo input
        const el = document.activeElement as HTMLElement | null;
        if (el && el.tagName === "INPUT") return;
        pressKey("back");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, empNo, pin]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

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
        @keyframes hkDotPop { 0% { transform:scale(.6); } 55% { transform:scale(1.12); } 100% { transform:scale(1); } }
        @keyframes hkSnow {
          0% { transform:translateY(-8%) translateX(0); opacity:0; }
          8% { opacity:.85; }
          50% { transform:translateY(46vh) translateX(16px); }
          92% { opacity:.6; }
          100% { transform:translateY(94vh) translateX(-12px); opacity:0; }
        }
        .hk-key { transition: transform .09s ease, background .15s ease, border-color .15s ease; }
        .hk-key:active { transform: scale(.95); }
        .wl-emp-input::placeholder { color: ${p.canon}; }
        .wl-btn-primary {
          width: 100%;
          border: none;
          border-radius: 13px;
          padding: 14px;
          font-family: inherit;
          font-size: 15px;
          font-weight: 700;
          color: #fff;
          cursor: pointer;
          background: linear-gradient(135deg, #6B5C32, #8B7A4E);
          transition: opacity .2s ease;
        }
        .wl-btn-primary:hover { opacity: .92; }
        .wl-btn-primary:disabled { opacity: .5; cursor: default; }
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
            padding:
              "calc(env(safe-area-inset-top, 0px) + 68px) 28px 22px",
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
                letterSpacing: "3.5px",
                fontWeight: 700,
                whiteSpace: "nowrap",
              }}
            >
              WORKER PORTAL
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
        <div
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
              fontSize: "21px",
              fontWeight: 800,
              color: p.title,
              letterSpacing: "-.3px",
            }}
          >
            {mode === "login"
              ? t("login.title")
              : mode === "setup"
                ? t("login.setupTitle")
                : t("login.resetTitle")}
          </h2>
          <p
            style={{
              margin: "0 0 20px",
              fontSize: "12.5px",
              color: p.sub,
              lineHeight: 1.5,
            }}
          >
            {mode === "login"
              ? t("login.setupDesc")
              : mode === "setup"
                ? t("login.setupDesc")
                : t("login.phoneLast4")}
          </p>

          {/* ----- mode = login (keypad-driven) ----- */}
          {mode === "login" && (
            <div>
              {/* EMPLOYEE NO. */}
              <div style={{ marginBottom: "14px" }}>
                <FieldLabel p={p}>{t("login.empNo")}</FieldLabel>
                <div style={fieldStyle(p)}>
                  <IdCard size={18} color={p.accent} />
                  <input
                    className="wl-emp-input"
                    autoComplete="username"
                    value={empNo}
                    onChange={(e) => {
                      setEmpNo(e.target.value);
                      setError(null);
                    }}
                    placeholder="EMP-0088"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: "none",
                      background: "transparent",
                      outline: "none",
                      fontFamily: "inherit",
                      fontSize: "15px",
                      fontWeight: 600,
                      color: p.input,
                      letterSpacing: ".3px",
                    }}
                  />
                  <span
                    style={{
                      fontSize: "11px",
                      color: p.canon,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {canonEmp(empNo)}
                  </span>
                </div>
              </div>

              {/* PIN — 6 segment bars */}
              <div style={{ marginBottom: "6px" }}>
                <FieldLabel p={p}>{t("login.pin")}</FieldLabel>
                <div
                  style={{
                    display: "flex",
                    gap: "9px",
                    justifyContent: "space-between",
                  }}
                >
                  {[0, 1, 2, 3, 4, 5].map((i) => {
                    const on = i < pin.length;
                    return (
                      <div
                        key={i}
                        style={{
                          flex: 1,
                          height: "12px",
                          borderRadius: "6px",
                          transition: "background .2s ease",
                          background: on ? p.pinOn : p.pinOff,
                          ...(i === pin.length - 1
                            ? { animation: "hkDotPop .28s ease" }
                            : {}),
                          ...(on
                            ? { boxShadow: `0 0 9px ${p.pinGlow}` }
                            : {}),
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {error && (
                <div style={{ marginTop: "12px" }}>
                  <ErrorBanner>{error}</ErrorBanner>
                </div>
              )}
              {loading && (
                <p
                  style={{
                    margin: "12px 0 0",
                    textAlign: "center",
                    fontSize: "12.5px",
                    color: p.sub,
                  }}
                >
                  {t("common.loading")}
                </p>
              )}

              {/* keypad */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: "9px",
                  marginTop: "16px",
                }}
              >
                {keys.map((k, idx) => {
                  if (k === "") {
                    return <div key={idx} style={{ height: "52px" }} />;
                  }
                  return (
                    <div
                      key={idx}
                      className="hk-key"
                      onClick={() => pressKey(k)}
                      role="button"
                      aria-label={k === "back" ? "Backspace" : k}
                      style={keyStyle(p)}
                    >
                      {k === "back" ? (
                        <Delete size={22} color={p.backIcon} />
                      ) : (
                        k
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Forgot PIN? */}
              <div
                onClick={() => {
                  setMode("reset");
                  setPin("");
                  setPin2("");
                  setError(null);
                }}
                role="button"
                style={{
                  textAlign: "center",
                  margin: "16px 0",
                  paddingBottom:
                    "calc(env(safe-area-inset-bottom, 0px) + 8px)",
                  fontSize: "12.5px",
                  color: p.accent,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("login.forgotPin")}
              </div>
            </div>
          )}

          {/* ----- mode = setup ----- */}
          {mode === "setup" && (
            <form onSubmit={handleSetup} style={formStyle}>
              <Field p={p} label={t("login.empNo")}>
                <input
                  type="text"
                  value={empNo}
                  readOnly
                  style={{ ...textInputStyle(p), opacity: 0.7 }}
                />
              </Field>
              <Field p={p} label={t("login.newPin")}>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  style={textInputStyle(p)}
                  placeholder="••••••"
                />
              </Field>
              <Field p={p} label={t("login.confirmPin")}>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                  style={textInputStyle(p)}
                  placeholder="••••••"
                />
              </Field>
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
                style={backLinkStyle(p)}
              >
                {t("common.back")}
              </button>
            </form>
          )}

          {/* ----- mode = reset ----- */}
          {mode === "reset" && (
            <form onSubmit={handleReset} style={formStyle}>
              <Field p={p} label={t("login.empNo")}>
                <input
                  type="text"
                  value={empNo}
                  onChange={(e) => setEmpNo(e.target.value)}
                  style={textInputStyle(p)}
                  placeholder="EMP-0088"
                />
              </Field>
              <Field p={p} label={t("login.phoneLast4")}>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  value={phoneLast4}
                  onChange={(e) =>
                    setPhoneLast4(e.target.value.replace(/\D/g, ""))
                  }
                  style={textInputStyle(p)}
                  placeholder="1234"
                />
              </Field>
              <Field p={p} label={t("login.newPin")}>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  style={textInputStyle(p)}
                  placeholder="••••••"
                />
              </Field>
              <Field p={p} label={t("login.confirmPin")}>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                  style={textInputStyle(p)}
                  placeholder="••••••"
                />
              </Field>
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
                style={backLinkStyle(p)}
              >
                {t("common.back")}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ----- style helpers -----
function fieldStyle(p: Palette): React.CSSProperties {
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

function keyStyle(p: Palette): React.CSSProperties {
  return {
    height: "52px",
    borderRadius: "13px",
    background: p.keyBg,
    border: `1px solid ${p.keyBorder}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "22px",
    fontWeight: 600,
    color: p.keyColor,
    cursor: "pointer",
    userSelect: "none",
  };
}

function FieldLabel({
  children,
  p,
}: {
  children: React.ReactNode;
  p: Palette;
}) {
  return (
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
      {children}
    </div>
  );
}

// ----- secondary (setup / reset) form bits, styled to match the sheet -----
const formStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)",
};

const btnPrimary = "wl-btn-primary";

function textInputStyle(p: Palette): React.CSSProperties {
  return {
    width: "100%",
    background: p.fieldBg,
    border: `1.5px solid ${p.fieldBorder}`,
    borderRadius: "11px",
    padding: "13px 14px",
    outline: "none",
    fontFamily: "inherit",
    fontSize: "15px",
    fontWeight: 600,
    color: p.input,
    letterSpacing: ".3px",
  };
}

function backLinkStyle(p: Palette): React.CSSProperties {
  return {
    width: "100%",
    background: "transparent",
    border: 0,
    cursor: "pointer",
    color: p.sub,
    fontSize: "13px",
    paddingTop: "2px",
  };
}

function Field({
  label,
  children,
  p,
}: {
  label: string;
  children: React.ReactNode;
  p: Palette;
}) {
  return (
    <div>
      <FieldLabel p={p}>{label}</FieldLabel>
      {children}
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: "11px",
        padding: "12px 14px",
        fontSize: "13px",
        background: "rgba(220, 38, 38, 0.12)",
        border: "1px solid rgba(220, 38, 38, 0.3)",
        color: "#FCA5A5",
      }}
      role="alert"
    >
      {children}
    </div>
  );
}

// ============================================================================
// /m dark/light theme mode — persisted in localStorage, applied via the
// body's data-theme attribute. The CSS variables in theme-vars.css read the
// attribute and re-tint everything.
//
// CHANGELOG (owner 2026-06-29): "Dark / Light Mode：手机版在 More 菜单、
// Fold 版在左栏底部;即时切换、记忆设置;logo/QR/照片不反色".
// ============================================================================
import { useEffect, useState } from "react";

const STORAGE_KEY = "hkm_theme";
type Mode = "light" | "dark";

function readStoredMode(): Mode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage disabled — fall through
  }
  return "light";
}

function writeStoredMode(mode: Mode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

function applyMode(mode: Mode): void {
  if (typeof document === "undefined") return;
  document.body.setAttribute("data-theme", mode);
}

/** Apply the persisted mode at module load (BEFORE React mounts) so first
 * paint is correct — no light-flash. Called once from MobileLayout's import
 * side effect path. */
export function bootstrapMobileTheme(): void {
  applyMode(readStoredMode());
}

/** React hook for the theme toggle UI. Returns [mode, toggle]. */
export function useMobileThemeMode(): {
  mode: Mode;
  toggle: () => void;
  set: (m: Mode) => void;
} {
  const [mode, setMode] = useState<Mode>(() => readStoredMode());

  useEffect(() => {
    applyMode(mode);
    writeStoredMode(mode);
  }, [mode]);

  return {
    mode,
    toggle: () => setMode((m) => (m === "light" ? "dark" : "light")),
    set: setMode,
  };
}

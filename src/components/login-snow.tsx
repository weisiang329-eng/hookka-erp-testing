// Falling snow for the login pages (owner 2026-06-27: "登录要加飘落的雪花 — 要").
// Soft white-gold flakes drifting down with a gentle sway over the dark login
// panel. CSS-only (compositor animation, no JS loop / canvas), absolute +
// pointer-events-none + low opacity. Render it INSIDE a `relative` dark panel,
// behind the card (give the card `relative z-10`). Deterministic positions —
// no Math.random — so it renders identically every load.

const FLAKES: {
  left: string;
  size: number;
  dur: number; // fall duration (s)
  delay: number; // start offset (s)
  op: number; // peak opacity
}[] = [
  { left: "4%", size: 3, dur: 14, delay: 0, op: 0.5 },
  { left: "11%", size: 2, dur: 19, delay: 5, op: 0.35 },
  { left: "19%", size: 4, dur: 12, delay: 2, op: 0.6 },
  { left: "27%", size: 2.5, dur: 17, delay: 8, op: 0.4 },
  { left: "34%", size: 3, dur: 15, delay: 11, op: 0.45 },
  { left: "43%", size: 2, dur: 21, delay: 3, op: 0.32 },
  { left: "51%", size: 4, dur: 13, delay: 7, op: 0.6 },
  { left: "59%", size: 2.5, dur: 18, delay: 1, op: 0.4 },
  { left: "67%", size: 3, dur: 16, delay: 9, op: 0.45 },
  { left: "74%", size: 2, dur: 20, delay: 4, op: 0.33 },
  { left: "82%", size: 4, dur: 12.5, delay: 12, op: 0.6 },
  { left: "89%", size: 2.5, dur: 17.5, delay: 6, op: 0.4 },
  { left: "95%", size: 3, dur: 15.5, delay: 10, op: 0.45 },
];

export default function LoginSnow({
  // White-gold flakes read perfectly on a dark panel (the ERP login + the
  // worker login's dark theme). On a LIGHT (cream) panel white vanishes, so the
  // worker login passes a soft-gold flake instead — keeps the snow visible.
  flakeColor = "rgba(255,250,235,0.95)",
  glowColor = "rgba(201,169,97,0.45)",
}: {
  flakeColor?: string;
  glowColor?: string;
} = {}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <style>{`
        @keyframes hkSnowFall {
          0%   { transform: translateY(-6%) translateX(0); opacity: 0; }
          12%  { opacity: var(--hk-snow-op); }
          50%  { transform: translateY(48%) translateX(10px); }
          88%  { opacity: var(--hk-snow-op); }
          100% { transform: translateY(106%) translateX(-8px); opacity: 0; }
        }
      `}</style>
      {FLAKES.map((f, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: "-8px",
            left: f.left,
            width: `${f.size}px`,
            height: `${f.size}px`,
            borderRadius: "50%",
            background: flakeColor,
            boxShadow: `0 0 6px 1px ${glowColor}`,
            ["--hk-snow-op" as string]: String(f.op),
            animation: `hkSnowFall ${f.dur}s linear ${f.delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

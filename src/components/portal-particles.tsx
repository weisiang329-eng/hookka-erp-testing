// Subtle "snowflake" drift for the main portal background (owner 2026-06-27:
// "雪花很漂亮…给 Main Portal 也加一点点那种感觉"). A faint echo of the login's
// orbiting gold dots — soft gold-cream flecks drifting gently down with a slight
// sway. CSS-only (no JS animation loop / canvas): just a handful of compositor-
// animated dots, fixed + pointer-events-none + low opacity, so it never costs
// CPU beyond compositing and never blocks any click. Behind all content.
//
// Deterministic positions (no Math.random) so it renders identically every load
// and SSR/hydration can't mismatch.

const DOTS: {
  left: string;
  size: number;
  dur: number; // fall duration (s)
  delay: number; // start offset (s)
  op: number; // peak opacity
}[] = [
  { left: "6%", size: 4, dur: 26, delay: 0, op: 0.22 },
  { left: "14%", size: 2.5, dur: 34, delay: 8, op: 0.16 },
  { left: "23%", size: 5, dur: 22, delay: 3, op: 0.26 },
  { left: "31%", size: 3, dur: 30, delay: 14, op: 0.18 },
  { left: "42%", size: 2, dur: 38, delay: 5, op: 0.14 },
  { left: "50%", size: 4.5, dur: 24, delay: 11, op: 0.24 },
  { left: "58%", size: 3, dur: 32, delay: 2, op: 0.18 },
  { left: "67%", size: 2.5, dur: 36, delay: 16, op: 0.16 },
  { left: "75%", size: 5, dur: 23, delay: 7, op: 0.26 },
  { left: "83%", size: 3, dur: 29, delay: 13, op: 0.18 },
  { left: "91%", size: 2, dur: 40, delay: 4, op: 0.13 },
  { left: "97%", size: 4, dur: 27, delay: 18, op: 0.2 },
];

export default function PortalParticles() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <style>{`
        @keyframes hkPortalDrift {
          0%   { transform: translateY(-8vh) translateX(0); opacity: 0; }
          12%  { opacity: var(--hk-op); }
          50%  { transform: translateY(46vh) translateX(14px); }
          88%  { opacity: var(--hk-op); }
          100% { transform: translateY(104vh) translateX(-10px); opacity: 0; }
        }
      `}</style>
      {DOTS.map((d, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: "-12px",
            left: d.left,
            width: `${d.size}px`,
            height: `${d.size}px`,
            borderRadius: "50%",
            background: "rgba(201,169,97,0.9)",
            boxShadow: "0 0 6px 1px rgba(201,169,97,0.45)",
            ["--hk-op" as string]: String(d.op),
            animation: `hkPortalDrift ${d.dur}s linear ${d.delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

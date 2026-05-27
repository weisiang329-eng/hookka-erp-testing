// ---------------------------------------------------------------------------
// PasswordStrengthMeter — small visual feedback under password inputs.
//
// Why it exists: the only password rule on file used to be `length >= 6`,
// which is how the SUPER_ADMIN ended up with password "hookka". This meter
// lives below the new-password field on reset-password.tsx (and any future
// change-password modal) and:
//   - Shows a 4-segment colour bar (red/amber/blue/green) for the score.
//   - Shows the first failing rule in plain English so the user knows what
//     to fix next, OR "Strong password" in green when all rules pass.
//
// Calls into src/api/lib/password-strength.ts so the rule set is identical
// to the one the backend uses — see memory "Frontend + backend validation
// must be unified". Inline styles match the existing dark theme used by
// forgot-password.tsx / reset-password.tsx (no Tailwind needed since those
// pages already mix inline + Tailwind).
// ---------------------------------------------------------------------------
import { validatePasswordStrength } from "@/api/lib/password-strength";

// Theme colour ramp matching the existing reset-password page. Red for fail,
// amber for weak, blue for OK, green for strong/excellent. The segment NOT
// "lit" stays a muted brown so the bar always shows 4 slots (predictable
// visual structure regardless of score).
const SEGMENT_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "#9A3A2D", // red — fails rules
  1: "#C9A14E", // amber — passes rules but predictable
  2: "#4A8DBE", // blue — OK
  3: "#5FA66B", // green — strong
  4: "#A4D08E", // bright green — excellent
};

const DIM_SEGMENT = "rgba(139, 122, 78, 0.18)";

type Props = {
  password: string;
  email?: string;
};

export default function PasswordStrengthMeter({ password, email }: Props) {
  // If the user hasn't typed yet, render nothing — no point shouting at an
  // empty field. The meter only appears once they start typing.
  if (!password) return null;

  const result = validatePasswordStrength(password, email);
  const litColor = SEGMENT_COLORS[result.score];

  // 4 segments. Light up `result.score` of them when the password passes,
  // or light up just one in red when it fails — that way "fail" is always
  // visually distinct from "weak-but-passes" (1 amber vs 1 red).
  const litCount = result.ok ? result.score : 1;

  return (
    <div style={{ marginTop: "6px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "3px",
          marginBottom: "4px",
        }}
        aria-hidden="true"
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: "4px",
              borderRadius: "2px",
              background: i < litCount ? litColor : DIM_SEGMENT,
              transition: "background 120ms ease",
            }}
          />
        ))}
      </div>
      <p
        style={{
          margin: 0,
          color: result.ok ? "#A4D08E" : "#E8AFA4",
          fontSize: "12px",
          lineHeight: 1.45,
        }}
      >
        {result.ok ? "Strong password ✓" : result.error}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hookka AI logo — monoline SVG.
//
// Default variant: rounded chat-bubble with a speaker-tail, "HK" monogram
// inside, and a 4-point sparkle/star at the top-right corner indicating
// "AI / generative".
//
// `sparkle-only` variant: just the sparkle, for inline accent use (e.g. a
// small badge next to a heading).
//
// Stroke uses `currentColor` so the logo inherits the surrounding text
// colour — wraps nicely in both dark sidebar contexts and light buttons.
// ---------------------------------------------------------------------------

type Props = {
  /** Pixel size (width === height). Default 24. Accepts number or string
      so this drops into LucideIcon-shaped slots without complaints. */
  size?: number | string;
  /** Either the full bubble logo, or just the corner sparkle. */
  variant?: "default" | "sparkle-only";
  /** Optional override className for layout / colour tweaks. */
  className?: string;
  /** Ignored — present so the component is interchangeable with a
      Lucide icon in slots that pass `strokeWidth`. Our paths use fixed
      stroke widths inside the SVG. */
  strokeWidth?: number | string;
};

export function HookkaAILogo({
  size = 24,
  variant = "default",
  className,
}: Props) {
  if (variant === "sparkle-only") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        {/* 4-point star — two diamond strokes, one horizontal/vertical, one
            45deg rotated, to give the classic "AI sparkle" look. */}
        <path
          d="M12 3 L13.4 10.6 L21 12 L13.4 13.4 L12 21 L10.6 13.4 L3 12 L10.6 10.6 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="0.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Hookka AI"
    >
      {/* Rounded chat bubble — slight asymmetric corner radius makes it
          feel less like a generic rect. */}
      <path
        d="M5 8 A4 4 0 0 1 9 4 H21 A4 4 0 0 1 25 8 V18 A4 4 0 0 1 21 22 H13 L8 27 V22 H9 A4 4 0 0 1 5 18 Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Monogram "HK". Two crossbars + a slash for the K shape — minimal
          but legible at sidebar 16px. */}
      <text
        x="15"
        y="16.5"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        fontWeight="700"
        fontSize="9"
        fill="currentColor"
        dominantBaseline="middle"
      >
        HK
      </text>
      {/* Corner sparkle — top-right, slightly outside the bubble to read
          as an "AI accent" rather than a checkmark. */}
      <path
        d="M26 4 L26.6 6.4 L29 7 L26.6 7.6 L26 10 L25.4 7.6 L23 7 L25.4 6.4 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default HookkaAILogo;

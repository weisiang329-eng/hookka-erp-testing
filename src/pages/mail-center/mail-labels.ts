// ---------------------------------------------------------------------------
// Mail Center — label catalogue types + colour helpers (shared by the inbox
// sidebar, the thread-list chips and the detail reading pane).
//
// The per-thread label SET stays a JSON name array on email_threads.labels.
// The CATALOGUE (GET /api/mail-center/labels) adds a canonical name → colour
// mapping so labels render with a Gmail-style coloured dot. These helpers turn
// a label name into its catalogue colour (defaulting to the brand brown) and
// derive a soft chip background from that colour, so every surface colours a
// label identically without duplicating the logic.
// ---------------------------------------------------------------------------

export type MailLabel = {
  id: string;
  name: string;
  color: string;
  createdAt: string;
};

// The curated palette offered by the colour picker — mirrors the backend's
// LABEL_COLORS allow-list (mail-center.ts) so the swatches match what the server
// will actually store. The first entry is the brand-neutral default.
export const LABEL_PALETTE: { value: string; name: string }[] = [
  { value: "#6B5C32", name: "Brown" },
  { value: "#B45309", name: "Amber" },
  { value: "#15803D", name: "Green" },
  { value: "#0E7490", name: "Teal" },
  { value: "#1D4ED8", name: "Blue" },
  { value: "#6D28D9", name: "Violet" },
  { value: "#BE185D", name: "Pink" },
  { value: "#B91C1C", name: "Red" },
  { value: "#475569", name: "Slate" },
];

export const DEFAULT_LABEL_COLOR = LABEL_PALETTE[0].value;

// Build a fast name(lowercased) → colour lookup from the catalogue.
export function labelColorMap(labels: MailLabel[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of labels) {
    const c = (l.color || "").trim();
    m.set(l.name.toLowerCase(), c || DEFAULT_LABEL_COLOR);
  }
  return m;
}

// Resolve a label name's dot colour from a catalogue map (falls back to brand).
export function colorForLabel(
  name: string,
  map: Map<string, string>,
): string {
  return map.get(name.toLowerCase()) || DEFAULT_LABEL_COLOR;
}

// A soft chip background derived from the dot colour. We render the dot at full
// strength and tint the pill with the same hue at low alpha (≈12%) so the chip
// stays legible on the warm-neutral surfaces — same trick Gmail uses. Accepts a
// #RRGGBB string; non-hex input falls back to the neutral brand chip tokens.
export function chipStyle(color: string): {
  backgroundColor: string;
  color: string;
} {
  const hex = (color || "").trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    return { backgroundColor: "#EFE9DD", color: "#6B5C32" };
  }
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.12)`,
    // Use the full-strength colour for the text so the chip reads as that hue.
    color: `#${m[1]}`,
  };
}

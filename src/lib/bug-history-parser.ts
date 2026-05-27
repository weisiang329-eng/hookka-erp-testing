// ---------------------------------------------------------------------------
// bug-history-parser.ts — parses docs/BUG-HISTORY.md into a structured
// array for the /admin/health "Past fixes" panel.
//
// Format (per existing entries, see docs/BUG-HISTORY.md):
//
//   ## BUG-YYYY-MM-DD-NNN — Title goes here (may be long)
//
//   **Status:** 🟢 Fixed (YYYY-MM-DD)
//   **Category:** category-tag
//
//   **Symptom:** ...
//   **Root cause:** ...
//   **Fix:** ...
//
// We extract:
//   - id          (BUG-YYYY-MM-DD-NNN)
//   - title       (after the em-dash on the heading line)
//   - status      ("Fixed" / "Identified" / "Fix in progress")
//   - statusIcon  ("🟢" / "🔴" / "🟡")
//   - statusDate  (date in parens after status, or "" if absent)
//   - category    (the **Category:** value)
//
// Everything else (Symptom / Root cause / Fix prose) is dropped — the
// dashboard panel only needs the header line for the recent-fixes list
// and the category counter. Detail viewing happens by clicking the BUG
// ID, which links to GitHub's view of BUG-HISTORY.md anchored to that
// heading.
// ---------------------------------------------------------------------------

export type BugEntry = {
  id: string;          // "BUG-2026-05-27-001"
  title: string;       // text after the em-dash on the heading line
  status: string;      // "Fixed" | "Identified" | "Fix in progress" | "Unknown"
  statusIcon: string;  // emoji marker
  statusDate: string;  // YYYY-MM-DD or ""
  category: string;    // category tag (lower-case-with-hyphens)
};

// Headline regex — matches "## BUG-YYYY-MM-DD-NNN — TITLE"
// The em-dash is U+2014 (—) or hyphen-minus (-). Real BUG-HISTORY uses
// the em-dash but be permissive.
const HEADLINE = /^##\s+(BUG-\d{4}-\d{2}-\d{2}-\d{3})\s*[—\-–]\s*(.+)$/;
// Status line — captures the icon (greedy 1 char) + the word + the
// optional (YYYY-MM-DD).
// Match the optional icon as "any chars that are NOT letters or
// whitespace" — emojis (single or with variation selectors) match,
// but if someone forgot the icon and wrote `Status: Fixed (date)`
// the icon group stays empty rather than swallowing "Fixed". Sidesteps
// the surrogate-pair / combined-character lint by not enumerating
// each emoji literal in a character class.
const STATUS = /\*\*Status:\*\*\s*([^A-Za-z\s]+)?\s*([A-Za-z\s]+?)\s*(?:\(([\d-]+)\))?\s*$/mu;
const CATEGORY = /\*\*Category:\*\*\s*([\w-]+)/m;

/**
 * Parse a BUG-HISTORY.md string into a structured array.
 *
 * Splits on `\n## ` (BUG entry boundaries), then per-chunk extracts the
 * fields with the regexes above. Forgiving — any chunk that doesn't
 * parse cleanly is dropped (no exceptions raised). Returns entries in
 * the same order as the source file (newest-first per project
 * convention).
 */
export function parseBugHistory(raw: string): BugEntry[] {
  if (!raw) return [];
  // Split into chunks at each level-2 heading.  Re-prefix `## ` so
  // each chunk starts with a heading line (split eats the delimiter).
  const chunks = raw.split(/\n##\s+/).map((c, i) => (i === 0 ? c : "## " + c));
  const out: BugEntry[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const headline = lines[0] ?? "";
    const hMatch = headline.match(HEADLINE);
    if (!hMatch) continue;
    const id = hMatch[1];
    const title = hMatch[2].trim();
    const statusMatch = chunk.match(STATUS);
    const categoryMatch = chunk.match(CATEGORY);
    out.push({
      id,
      title,
      status: statusMatch?.[2]?.trim() ?? "Unknown",
      statusIcon: statusMatch?.[1]?.trim() ?? "",
      statusDate: statusMatch?.[3] ?? "",
      category: categoryMatch?.[1] ?? "uncategorised",
    });
  }
  return out;
}

/**
 * Build a top-N category histogram from the parsed entries. Returns
 * { category, n } sorted by count descending.
 *
 * High-count categories are the "this module keeps breaking" signal —
 * if `sales-orders` shows 23 fixes, the next bug there should trigger
 * a rewrite discussion, not another patch.
 */
export function topCategories(
  entries: BugEntry[],
  limit = 10,
): Array<{ category: string; n: number }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

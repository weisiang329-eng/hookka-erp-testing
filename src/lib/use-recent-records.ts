// ---------------------------------------------------------------------------
// useRecentRecords / pushRecent — localStorage-backed "recently visited"
// list for the Cmd-K command palette.
//
// Records are pushed only for URLs that look like a record detail page
// (matches one of the labelled regex patterns); list pages and
// non-detail routes are skipped so the recents list stays useful.
//
// Storage shape (max 10 entries, newest first):
//   [{ path: "/sales/SO-2502-0123", label: "SO · SO-2502-0123", visitedAt: 17... }, ...]
// ---------------------------------------------------------------------------
import { useState } from "react";

const STORAGE_KEY = "hookka-recent-records";
const MAX_ENTRIES = 10;

export type RecentRecord = {
  path: string;
  label: string;
  visitedAt: number;
};

// Patterns that count as a "record detail" worth remembering. List
// pages, dashboard, and helper routes are intentionally excluded.
const RECORD_PATTERNS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^\/sales\/([^/]+)\/edit\/?$/, (m) => `Edit ${m[1]}`],
  [/^\/sales\/(?!create$)([^/]+)\/?$/, (m) => `SO · ${m[1]}`],
  [/^\/delivery\/([^/]+)\/?$/, (m) => `DO · ${m[1]}`],
  [/^\/invoices\/(?!credit-notes|debit-notes|e-invoice|payments)([^/]+)\/?$/, (m) => `Invoice · ${m[1]}`],
  [/^\/procurement\/(?!grn|pi|pricing|in-transit|maintenance)([^/]+)\/?$/, (m) => `PO · ${m[1]}`],
  [/^\/products\/([^/]+)\/bom\/?$/, (m) => `BOM · ${m[1]}`],
  [/^\/consignment\/(?!create|note|return)([^/]+)\/?$/, (m) => `Consignment · ${m[1]}`],
  [/^\/rd\/([^/]+)\/?$/, (m) => `R&D · ${m[1]}`],
];

function labelForRecord(path: string): string | null {
  for (const [re, mk] of RECORD_PATTERNS) {
    const m = re.exec(path);
    if (m) return mk(m);
  }
  return null;
}

function readRecents(): RecentRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentRecord =>
        r &&
        typeof r.path === "string" &&
        typeof r.label === "string" &&
        typeof r.visitedAt === "number",
    );
  } catch {
    return [];
  }
}

function writeRecents(list: RecentRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota / disabled storage — best effort */
  }
}

// Call this on every route change. No-op for non-record paths.
export function pushRecent(path: string): void {
  const label = labelForRecord(path);
  if (!label) return;
  const list = readRecents().filter((r) => r.path !== path);
  list.unshift({ path, label, visitedAt: Date.now() });
  writeRecents(list.slice(0, MAX_ENTRIES));
}

// Hook for the palette to render recents. The palette mounts/unmounts
// on each Cmd-K toggle (CommandPalette returns null when closed), so a
// useState initialiser reads fresh on every open without an effect.
export function useRecentRecords(): RecentRecord[] {
  const [list] = useState<RecentRecord[]>(() => readRecents());
  return list;
}

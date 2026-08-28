// ---------------------------------------------------------------------------
// lead-import.ts — turning a bought contact list into leads, safely.
//
// The list this was built for (SSM DATA Penang.xlsx, 2026-08-19) is 1,029 rows
// scraped from Google Maps across four industry sheets. Three properties of
// that file drove every decision here, and they are typical of bought lists:
//
//   * ZERO of the 1,029 rows carry an email address. All 1,029 carry a phone.
//     So the phone is the only identity the data actually has — it is the dedupe
//     key, and a row without one cannot become a lead.
//   * There is NO contact person, only a company name. The person's name is the
//     OUTPUT of the first phone call, not an input to the import.
//   * 86 company names and 90 phone numbers repeat. Importing blind means two
//     salespeople cold-call the same shop.
//
// Pure functions only — no DB, no network — so the rules above are testable
// without a database and the route stays a thin shell around them.
// ---------------------------------------------------------------------------

/** One row as it comes out of the spreadsheet, already header-mapped. */
export interface RawLeadRow {
  company?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  industry?: string | null;
  location?: string | null;
  notes?: string | null;
}

export interface PreparedLead extends RawLeadRow {
  /** Digits-only phone, used for dedupe. Never shown to a person. */
  phoneKey: string;
  /** The untouched scraped title, when `company` was shortened from it. */
  originalCompany?: string | null;
  /** Other names sharing this phone — usually branches of the same chain. */
  alsoListedAs?: string[];
}

export type SkipReason =
  | "NO_COMPANY"
  | "NO_PHONE"
  | "DUPLICATE_IN_FILE"
  | "ALREADY_IN_SYSTEM";

export interface Skipped {
  row: RawLeadRow;
  reason: SkipReason;
  /** For DUPLICATE_IN_FILE / ALREADY_IN_SYSTEM: what it collided with. */
  collidesWith?: string;
}

export interface ImportPlan {
  insert: PreparedLead[];
  skipped: Skipped[];
  /** Counts by reason, for the confirmation screen. */
  summary: {
    total: number;
    insert: number;
    noCompany: number;
    noPhone: number;
    duplicateInFile: number;
    alreadyInSystem: number;
    withoutEmail: number;
  };
}

/**
 * Reduce a Malaysian phone number to comparable digits.
 *
 * The same shop appears as "+60 10-248 6699", "010-2486699" and "0102486699"
 * across a scraped file, and those must collide. Local numbers are lifted to
 * the 60 country code so a local and an international spelling of one number
 * are the same key.
 *
 * Returns "" when there is nothing usable — the caller treats that as NO_PHONE
 * rather than as an empty key that would collide with every other empty one.
 */
export function normalizePhone(input: string | null | undefined): string {
  if (!input) return "";
  let d = String(input).replace(/\D+/g, "");
  if (!d) return "";
  // 0060… → 60…
  if (d.startsWith("00")) d = d.slice(2);
  // Local 01x… / 0x… → 601x… / 6x…
  if (d.startsWith("0")) d = `60${d.slice(1)}`;
  // A Malaysian number is 60 + 9..10 digits. Anything shorter is a fragment
  // (a scraped opening-hours field, a house number) and is not an identity.
  if (d.length < 9) return "";
  return d;
}

/** Collapse a company name for the "looks like the same shop" check. */
export function normalizeCompany(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .toLowerCase()
    .replace(/\b(sdn\.?\s*bhd\.?|enterprise|trading|holdings?|s\/b)\b/g, "")
    .replace(/[^a-z0-9一-鿿]+/g, "")
    .trim();
}

/**
 * Google Maps exports carry a tracking suffix on every URL
 * ("https://example.com/&opi=79508299"). Strip it so the stored website
 * is something a person can actually click.
 */
export function cleanWebsite(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  // The suffix arrives as a LITERAL backslash-u sequence in the cell, not as a
  // decoded "=", so the pattern has to match the backslashes themselves:
  //   https://www.beezstorybabyhouse.com/&opi\\u003d79508299
  // Matching on `&opi` and taking everything after it covers every spelling
  // (escaped, decoded, single- or double-backslashed) with one rule.
  s = s.replace(/[&?]opi[\\u003d=].*$/i, "");
  s = s.replace(/[?&]+$/, "");
  return s || null;
}

/**
 * Recover the business name from a Google Maps listing title.
 *
 * Scraped titles are keyword-stuffed for search, not written as names:
 *   "Meiko Upholstery Specialist, Sofa Repair, Customize, baik pulih, Penang, Malaysia"
 * The business is the first segment; the rest is SEO. A salesperson reading a
 * list needs the name, so the tail is cut — but only when the title actually
 * looks stuffed (two or more commas AND long), so an ordinary
 * "ABC Trading, Penang" is left alone.
 *
 * The full original is never thrown away; the caller keeps it in the notes.
 */
export function cleanCompanyName(input: string | null | undefined): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const commas = (raw.match(/,/g) ?? []).length;
  if (commas < 2 || raw.length < 45) return raw;
  const head = raw.split(",")[0].trim();
  // Refuse to shorten to something uselessly short — better a long name than
  // a truncated one nobody recognises.
  return head.length >= 4 ? head : raw;
}

/**
 * Scraped rows frequently repeat the business name inside the address field
 * ("Meiko Upholstery Specialist, Sofa Repair, …, Penang"). Drop the leading
 * repeat so the stored location is the location.
 */
export function cleanLocation(
  location: string | null | undefined,
  company: string | null | undefined,
): string | null {
  const loc = (location ?? "").trim();
  if (!loc) return null;
  const co = (company ?? "").trim();
  if (co && loc.toLowerCase().startsWith(co.toLowerCase())) {
    const rest = loc.slice(co.length).replace(/^[\s,、]+/, "");
    return rest || null;
  }
  return loc;
}

/**
 * Decide what a spreadsheet import would actually do, WITHOUT doing it.
 *
 * `existingPhoneKeys` is every phone already on a lead in this org. Dedupe runs
 * against the file AND against the system, because the second import of an
 * overlapping list is where duplicates really come from.
 *
 * Nothing here writes. The caller shows the plan, the operator confirms, and
 * only then are `plan.insert` rows written — which is the whole point: on a
 * 1,029-row file you want to see "86 duplicates" before, not after.
 */
export function planImport(
  rows: RawLeadRow[],
  existingPhoneKeys: Iterable<string> = [],
): ImportPlan {
  const existing = new Set<string>();
  for (const k of existingPhoneKeys) if (k) existing.add(k);

  const seenInFile = new Map<string, number>(); // phoneKey → index in `insert`
  const insert: PreparedLead[] = [];
  const skipped: Skipped[] = [];

  for (const raw of rows) {
    const company = (raw.company ?? "").trim();
    if (!company) {
      skipped.push({ row: raw, reason: "NO_COMPANY" });
      continue;
    }
    const phoneKey = normalizePhone(raw.phone);
    if (!phoneKey) {
      // Deliberately a skip, not a warning. Without a phone AND without an
      // email (this list has none), the row is a name nobody can contact.
      skipped.push({ row: raw, reason: "NO_PHONE" });
      continue;
    }
    if (seenInFile.has(phoneKey)) {
      const keptIdx = seenInFile.get(phoneKey)!;
      const kept = insert[keptIdx];
      skipped.push({
        row: raw,
        reason: "DUPLICATE_IN_FILE",
        collidesWith: kept?.company ?? undefined,
      });
      // Two branches of one chain routinely share a phone — "Carte Kitchen
      // Cabinet (Bayan Lepas Showroom)" and "(Bukit Mertajam Showroom)" in the
      // Penang file. One phone is one conversation, so they collapse into one
      // lead; but the other branch is real information, so record it on the
      // survivor instead of dropping it on the floor.
      if (kept) {
        const other = cleanCompanyName(company);
        if (other && other !== kept.company) {
          kept.alsoListedAs = [...(kept.alsoListedAs ?? []), other];
        }
      }
      continue;
    }
    if (existing.has(phoneKey)) {
      skipped.push({ row: raw, reason: "ALREADY_IN_SYSTEM", collidesWith: phoneKey });
      continue;
    }
    seenInFile.set(phoneKey, insert.length);
    insert.push({
      company: cleanCompanyName(company),
      originalCompany: cleanCompanyName(company) === company.trim() ? null : company.trim(),
      contactName: (raw.contactName ?? "").trim() || null,
      phone: (raw.phone ?? "").trim() || null,
      email: (raw.email ?? "").trim() || null,
      website: cleanWebsite(raw.website),
      industry: (raw.industry ?? "").trim() || null,
      location: cleanLocation(raw.location, company),
      notes: (raw.notes ?? "").trim() || null,
      phoneKey,
    });
  }

  const count = (r: SkipReason) => skipped.filter((s) => s.reason === r).length;
  return {
    insert,
    skipped,
    summary: {
      total: rows.length,
      insert: insert.length,
      noCompany: count("NO_COMPANY"),
      noPhone: count("NO_PHONE"),
      duplicateInFile: count("DUPLICATE_IN_FILE"),
      alreadyInSystem: count("ALREADY_IN_SYSTEM"),
      withoutEmail: insert.filter((r) => !r.email).length,
    },
  };
}

/**
 * A stable label for one import run, e.g. "penang-2026-08-19".
 *
 * Every imported lead carries it. Bought lists vary wildly in quality, and the
 * batch label is what makes "this list was rubbish, remove all of it" a single
 * action instead of an unpickable mess months later.
 */
export function makeBatchLabel(name: string, isoDate: string): string {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const day = String(isoDate).slice(0, 10);
  return slug ? `${slug}-${day}` : day;
}

// ---------------------------------------------------------------------------
// contact-format — shared, system-wide standardisation for the fields that were
// free-text everywhere (owner 2026-07-30): phone numbers, email, Malaysian
// state, postcode. Pure helpers + constant tables; the React inputs that use
// them live in src/components/ui/{phone-input,state-select}.tsx.
//
// Non-destructive by design: every parser tolerates the legacy free-text values
// already in the DB, so nothing breaks on first render — a stored
// "011-6151 1613" simply shows under the default +60 dial code until re-saved.
// ---------------------------------------------------------------------------

/** Dial codes offered in the phone country picker. Malaysia (+60) is default;
 *  the rest cover the shop's real international spread (SEA + common export). */
export const COUNTRY_DIAL_CODES: { code: string; label: string }[] = [
  { code: "+60", label: "Malaysia (+60)" },
  { code: "+65", label: "Singapore (+65)" },
  { code: "+62", label: "Indonesia (+62)" },
  { code: "+66", label: "Thailand (+66)" },
  { code: "+673", label: "Brunei (+673)" },
  { code: "+63", label: "Philippines (+63)" },
  { code: "+84", label: "Vietnam (+84)" },
  { code: "+95", label: "Myanmar (+95)" },
  { code: "+855", label: "Cambodia (+855)" },
  { code: "+856", label: "Laos (+856)" },
  { code: "+86", label: "China (+86)" },
  { code: "+852", label: "Hong Kong (+852)" },
  { code: "+886", label: "Taiwan (+886)" },
  { code: "+81", label: "Japan (+81)" },
  { code: "+82", label: "South Korea (+82)" },
  { code: "+91", label: "India (+91)" },
  { code: "+61", label: "Australia (+61)" },
  { code: "+64", label: "New Zealand (+64)" },
  { code: "+44", label: "United Kingdom (+44)" },
  { code: "+1", label: "US / Canada (+1)" },
];

export const DEFAULT_DIAL_CODE = "+60";

// Longest-first so "+673" wins over "+6" and "+852" over "+85".
const DIAL_CODES_SORTED = [...COUNTRY_DIAL_CODES]
  .map((c) => c.code)
  .sort((a, b) => b.length - a.length);

/** Split a stored phone string into { dial, local }. A leading "+<code>" is
 *  matched against the known list; otherwise the whole value is treated as a
 *  local number under the default dial code (legacy rows). */
export function splitPhone(stored: string | null | undefined): { dial: string; local: string } {
  const v = (stored ?? "").trim();
  if (v.startsWith("+")) {
    const compact = v.replace(/\s+/g, "");
    for (const dial of DIAL_CODES_SORTED) {
      if (compact.startsWith(dial)) {
        return { dial, local: v.slice(v.indexOf(dial) + dial.length).trim() };
      }
    }
    // Unknown "+" prefix — keep it in local so the user can see/fix it.
    return { dial: DEFAULT_DIAL_CODE, local: v };
  }
  return { dial: DEFAULT_DIAL_CODE, local: v };
}

/** Recombine a dial code + local number into the stored form. Empty local →
 *  empty string (so a blank phone stays blank, not a bare "+60"). */
export function joinPhone(dial: string, local: string): string {
  const l = (local ?? "").trim();
  if (!l) return "";
  return `${dial} ${l}`;
}

/** Email shape check. Empty is allowed (most email fields are optional); a
 *  non-empty value must look like an address. Single source of truth so every
 *  form validates identically. */
export function isValidEmail(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  return t === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

// Delivery-hub state CODES. IMPORTANT: this is the operational field the 3PL
// state-rate table + the CS-agent transit-day map key on (see
// three-pl-state-rates / cs-agent transitDaysByState) — it is a CODE, never a
// full state name. Standardising it means every hub form picks from this ONE
// list (it was duplicated inline before), not switching it to prose. A
// full-address state + postcode field is a separate future schema addition.
export const HUB_STATE_CODES = [
  "KL", "SGR", "PG", "JB", "SRW", "SBH", "IPH", "MLK", "KCH", "KB", "KT",
] as const;

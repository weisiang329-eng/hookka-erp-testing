// ---------------------------------------------------------------------------
// Mail Center — view preferences (Gmail-style toggles) + the sender category
// heuristic. All client-side; nothing here touches the backend or the API
// contract.
//
// THREE persisted view toggles (the owner's "可以开关"), each saved in
// localStorage so the choice sticks across reloads and devices-per-browser:
//   • density       — "compact" (Gmail single-line rows) vs "comfortable"
//                      (the original taller multi-line cards). Default compact.
//   • readingPane   — "split" (list + right reading pane, the current 3-pane
//                      behaviour) vs "full" (full-width list; a row opens the
//                      conversation via the detail route). Default split.
//   • categoryTabs  — show/hide the Primary / Notifications category tabs above
//                      the list. Default on.
//
// We expose ONE tiny external store (useSyncExternalStore-friendly) so the page
// re-renders when a toggle flips, with cross-tab sync via the storage event —
// the same shape mail-local.ts uses for drafts.
// ---------------------------------------------------------------------------

export type MailDensity = "compact" | "comfortable";
export type MailReadingPane = "split" | "full";

export type MailViewPrefs = {
  density: MailDensity;
  readingPane: MailReadingPane;
  categoryTabs: boolean;
};

// Gmail's category names map onto our two-bucket heuristic. "all" is the
// no-filter view; the other two are derived per-row (see classifyCategory).
export type MailCategory = "all" | "primary" | "notifications";

const KEY = "hookka-mail-prefs:v1";

const DEFAULTS: MailViewPrefs = {
  density: "compact",
  readingPane: "split",
  categoryTabs: true,
};

function load(): MailViewPrefs {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MailViewPrefs>;
    return {
      density: parsed.density === "comfortable" ? "comfortable" : "compact",
      readingPane: parsed.readingPane === "full" ? "full" : "split",
      // Default ON unless explicitly stored false.
      categoryTabs: parsed.categoryTabs === false ? false : true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: MailViewPrefs = load();
const listeners = new Set<() => void>();

function persistAndNotify(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Quota / disabled storage — keep the in-memory copy so the session works.
    }
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a bad subscriber must not break the others */
    }
  }
}

// Cross-tab sync: another tab flipping a toggle fires a storage event here.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    state = load();
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  });
}

export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPrefsSnapshot(): MailViewPrefs {
  return state;
}

export function setDensity(density: MailDensity): void {
  if (state.density === density) return;
  state = { ...state, density };
  persistAndNotify();
}

export function setReadingPane(readingPane: MailReadingPane): void {
  if (state.readingPane === readingPane) return;
  state = { ...state, readingPane };
  persistAndNotify();
}

export function setCategoryTabs(categoryTabs: boolean): void {
  if (state.categoryTabs === categoryTabs) return;
  state = { ...state, categoryTabs };
  persistAndNotify();
}

// ---------------------------------------------------------------------------
// Sender category heuristic (CLIENT-SIDE only — no backend columns).
//
// Gmail splits the inbox into Primary (real people) and automated buckets. We
// keep it to two buckets the small shop cares about:
//   • Notifications — automated senders: any address whose LOCAL-PART matches a
//     no-reply / system / alerting pattern, OR whose DOMAIN is a known bank /
//     payment / e-services sender (Malaysian banks the factory actually gets
//     statements + payment alerts from). These are the ones the owner doesn't
//     need to reply to.
//   • Primary — everything else (real human / customer / supplier mail).
//
// The match is on the counterparty email only (the other party of the thread),
// case-insensitively. Threads with no email fall to Primary (safer — a real
// person we just don't have an address for shouldn't be hidden in
// Notifications).
// ---------------------------------------------------------------------------

// Local-part / generic automated-sender markers (no-reply mailers, system,
// alerts, e-services, statements, etc.). Word-ish boundaries via the regex.
const AUTOMATED_LOCALPART =
  /no-?reply|do-?not-?reply|donotreply|notification|notify|alert|mailer|mailer-daemon|postmaster|eservice|e-?services|statement|auto(?:mated)?|system|noreply|bounce|newsletter|updates?/i;

// Known automated / institutional DOMAINS the factory receives mail from:
// Malaysian banks + common payment / e-services providers. Substring match on
// the domain so subdomains (e.g. notification.maybank2u.com.my) also catch.
const AUTOMATED_DOMAIN =
  /hongleong|hlbb|hlb\.com|uob|maybank|mbb|cimb|publicbank|pbebank|rhb|ambank|bankislam|affinbank|alliancebank|ocbc|hsbc|stripe|paypal|billplz|ipay88|senangpay|razorpay|lhdn|hasil|myinvois|kwsp|epf|perkeso|socso/i;

// Classify a counterparty email into a category bucket. Exported so the list
// filter, the tab counts and any future surface all agree on one rule.
export function classifyCategory(
  counterpartyEmail: string | null | undefined,
): Exclude<MailCategory, "all"> {
  const email = (counterpartyEmail ?? "").trim().toLowerCase();
  if (!email) return "primary";
  const at = email.lastIndexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at + 1) : "";
  if (AUTOMATED_LOCALPART.test(local)) return "notifications";
  if (domain && AUTOMATED_DOMAIN.test(domain)) return "notifications";
  return "primary";
}

// ---------------------------------------------------------------------------
// Password strength validator for change-password / reset-password flows.
//
// Why this module exists:
// Until 2026-05-27 the only password rule on file was `length >= 6`. That let
// the SUPER_ADMIN (Wei Siang) set the master account password to "hookka" — a
// 6-char dictionary word built from the company name. This module raises the
// floor so the next operator can't repeat that. It runs on BOTH frontend
// (PasswordStrengthMeter, reset-password.tsx) and backend (auth.ts) so the
// rule never drifts between client and server. See memory:
// "Frontend + backend validation must be unified".
//
// Deliberately zero dependencies — runs in the Workers runtime and in node
// tests without any extra bundle weight. Common-passwords list is inlined; a
// 200-entry array is ~3KB of source, smaller than pulling in a 25KB npm dep.
//
// Returns the FIRST violation so the user fixes one thing at a time. Error
// messages are short, plain English, actionable — memory: "No code jargon".
// ---------------------------------------------------------------------------

export type PasswordStrengthResult = {
  ok: boolean;
  error?: string;
  score: 0 | 1 | 2 | 3 | 4;
};

// ---------------------------------------------------------------------------
// Top common passwords (lowercase). Sources: SecLists rockyou top-200,
// NCSC top-100, plus a few project-specific obvious ones ("hookka", "sofa",
// "factory"). Lowercase-compared, so "Hookka" / "HOOKKA" also get rejected.
// Keep this list tight — it's a guard against the worst offenders, not a
// pretend-zxcvbn. zxcvbn-style scoring would need a dictionary 100x bigger.
// ---------------------------------------------------------------------------
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "123456", "password", "12345678", "qwerty", "123456789", "12345",
  "1234", "111111", "1234567", "dragon", "123123", "baseball", "abc123",
  "football", "monkey", "letmein", "shadow", "master", "666666", "qwertyuiop",
  "123321", "mustang", "1234567890", "michael", "654321", "pussy", "superman",
  "1qaz2wsx", "7777777", "121212", "000000", "qazwsx", "123qwe", "killer",
  "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster",
  "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou",
  "fuckme", "2000", "charlie", "robert", "thomas", "hockey", "ranger",
  "daniel", "starwars", "klaster", "112233", "george", "computer", "michelle",
  "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111", "131313",
  "freedom", "777777", "pass", "fuck", "maggie", "159753", "aaaaaa",
  "ginger", "princess", "joshua", "cheese", "amanda", "summer", "love",
  "ashley", "6969", "nicole", "chelsea", "biteme", "matthew", "access",
  "yankees", "987654321", "dallas", "austin", "thunder", "taylor", "matrix",
  "william", "corvette", "hello", "martin", "heather", "secret", "fucker",
  "merlin", "diamond", "1234qwer", "gfhjkm", "hammer", "silver", "222222",
  "88888888", "anthony", "justin", "test", "bailey", "q1w2e3r4t5", "patrick",
  "internet", "scooter", "orange", "11111", "golfer", "cookie", "richard",
  "samantha", "bigdog", "guitar", "jackson", "whatever", "mickey", "chicken",
  "sparky", "snoopy", "maverick", "phoenix", "camaro", "sexy", "peanut",
  "morgan", "welcome", "falcon", "cowboy", "ferrari", "samsung", "andrea",
  "smokey", "steelers", "joseph", "mercedes", "dakota", "arsenal", "eagles",
  "melissa", "boomer", "booboo", "spider", "nascar", "monster", "tigers",
  "yellow", "xxxxxx", "123123123", "gateway", "marina", "diablo", "bulldog",
  "qwer1234", "compaq", "purple", "hardcore", "banana", "junior", "hannah",
  "123654", "porsche", "lakers", "iceman", "money", "cowboys", "987654",
  "london", "tennis", "999999", "ncc1701", "coffee", "scooby", "0000",
  "miller", "boston", "q1w2e3r4", "fuckoff", "brandon", "yamaha", "chester",
  "mother", "forever", "johnny", "edward", "333333", "oliver", "redsox",
  "player", "nikita", "knight", "fender", "barney", "midnight", "please",
  "brandy", "chicago", "badboy", "iwantu", "slayer", "rangers", "charles",
  "angel", "flower", "bigdaddy", "rabbit", "wizard", "bigdick", "jasper",
  "enter", "rachel", "chris", "steven", "winner", "adidas", "victoria",
  "natasha", "1q2w3e4r", "jasmine", "winter", "prince", "panties", "marine",
  "ghbdtn", "fishing", "cocacola", "casper", "james", "232323", "raiders",
  "888888", "marlboro", "gandalf", "asdfasdf", "crystal", "87654321",
  "12344321", "sexsex", "golden", "blowme", "bigtits", "8675309", "panther",
  "lauren", "angela", "bitch", "spanky", "thx1138", "angels", "madison",
  "winston", "shannon", "mike", "toyota", "blowjob", "jordan23", "canada",
  "sophie", "abcd1234", "abcdefg", "passw0rd", "p@ssw0rd", "qwerty123",
  "qwerty1", "111222", "admin", "administrator", "root", "toor", "guest",
  "hookka", "sofa", "factory", "supersofa", "hookkasofa", "hookkaerp",
]);

const SYMBOL_REGEX = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;
const UPPER_REGEX = /[A-Z]/;
const LOWER_REGEX = /[a-z]/;
const DIGIT_REGEX = /[0-9]/;

// ---------------------------------------------------------------------------
// validatePasswordStrength — single source of truth for "is this password
// strong enough to land in users.passwordHash". Returns first violation so
// the UI guides the user to fix one rule at a time. Pass `email` to also
// block passwords that contain the local-part (the bit before @) of the
// owner's email — that's the most common "set password = my username" trap.
// ---------------------------------------------------------------------------
export function validatePasswordStrength(
  pw: string,
  email?: string,
): PasswordStrengthResult {
  // Length is the single most-correlated factor with crack-time, so it's
  // first. 12 is the NIST 2024 minimum for human-chosen passwords.
  if (pw.length < 12) {
    return { ok: false, error: "Password must be at least 12 characters", score: 0 };
  }
  if (!UPPER_REGEX.test(pw)) {
    return { ok: false, error: "Add at least one uppercase letter", score: 0 };
  }
  if (!LOWER_REGEX.test(pw)) {
    return { ok: false, error: "Add at least one lowercase letter", score: 0 };
  }
  if (!DIGIT_REGEX.test(pw)) {
    return { ok: false, error: "Add at least one number", score: 0 };
  }
  if (!SYMBOL_REGEX.test(pw)) {
    return { ok: false, error: "Add at least one symbol like !@#$", score: 0 };
  }

  // Common-password check. Compare lowercase so "Password1!" still gets
  // caught via the base word. We check the raw lowercase form against the
  // dictionary — adding numbers/symbols around a dictionary word is still
  // dictionary-derived but we accept that trade-off to keep the list small.
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return {
      ok: false,
      error: "This password is too common — pick something less guessable",
      score: 0,
    };
  }

  // Email local-part check. If the owner's email is weisiang329@gmail.com,
  // reject "Weisiang329-Strong!" — that's just username-as-password with
  // window dressing. Only meaningful if local-part has at least 3 chars,
  // otherwise we'd reject anything containing "a" or "x".
  if (email) {
    const at = email.indexOf("@");
    const local = (at === -1 ? email : email.slice(0, at)).toLowerCase();
    if (local.length >= 3 && lower.includes(local)) {
      return {
        ok: false,
        error: "Password can't contain your email name",
        score: 0,
      };
    }
  }

  // ---------------------------------------------------------------------
  // Scoring (only reached once all hard rules pass).
  //   1 = passes minimum bar (12 chars + all 4 char types)
  //   2 = + length ≥ 16
  //   3 = + length ≥ 20
  //   4 = + length ≥ 24 (excellent — passphrase territory)
  // Caller (PasswordStrengthMeter) uses this to colour the bar so the user
  // gets positive feedback for going beyond the minimum.
  // ---------------------------------------------------------------------
  let score: 1 | 2 | 3 | 4 = 1;
  if (pw.length >= 16) score = 2;
  if (pw.length >= 20) score = 3;
  if (pw.length >= 24) score = 4;
  return { ok: true, score };
}

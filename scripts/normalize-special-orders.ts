// ---------------------------------------------------------------------------
// Backfill sales_order_items.specialOrder → semicolon-separated canonical
// values that exist in the variants-config (specials / sofaSpecials).
//
// Input shapes we see in prod:
//   1. Multi-value comma-separated:  "DIVAN CURVE, HB Fully Cover"
//   2. Multi-value slash-separated:  "1\"LEG / NYLON FABRIC"
//   3. Single value with inconsistent casing / spelling:
//        "NO SIDE PANEL"  (config has "No Side Panel")
//        "SEPARATE BACKREST"  (config has "SEPERATE BACKREST PACKING" — typo)
//   4. Already clean single value:   "Right Drawer"
//   5. Malformed quoted value:       "\"SEAT ADD ON 4\"\"\""
//   6. Free-text compound:           "1NA : 44\" / 2A : 32\" / HEADREST MODEL 5537 / 1\" LEG / NYLON FABRIC"
//      (partial match: 1" LEG → "1\" LEG" no exact match; NYLON FABRIC → matches)
//
// Strategy: split on `;` / `,` / `/`, trim, fuzzy-match (case-insensitive,
// whitespace-normalized, 1-char Levenshtein tolerance for "SEPARATE" ≈
// "SEPERATE"). Tokens that can't be matched are kept as-is but logged so the
// user can review them in the UI. Output rejoined with "; ".
//
// Usage:  npx tsx scripts/normalize-special-orders.ts [--dry-run]
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROD = "https://hookka-erp-testing.pages.dev";
const EMAIL = "weisiang329@gmail.com";
const PASSWORD = "CbpxqJQpjy3VA5yd3Q";
const DRY_RUN = process.argv.includes("--dry-run");

type VariantsCfg = {
  specials?: Array<{ value: string; priceSen: number } | string>;
  sofaSpecials?: Array<{ value: string; priceSen: number } | string>;
};

type Row = {
  id: string;
  itemCategory: string | null;
  specialOrder: string | null;
};

// --- login -----------------------------------------------------------------

async function login(): Promise<string> {
  const r = await fetch(`${PROD}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await r.json()) as { data?: { token?: string } };
  if (!j.data?.token) throw new Error("login failed");
  return j.data.token;
}

// --- canonical tokens ------------------------------------------------------

function extractCanonical(arr: VariantsCfg["specials"]): string[] {
  if (!arr) return [];
  return arr
    .map((v) => (typeof v === "object" && v && "value" in v ? v.value : String(v)))
    .filter(Boolean);
}

// 1-char Levenshtein — good enough for "SEPARATE" vs "SEPERATE".
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Word-by-word fuzzy equal: tokens match if they're identical or within
 *  1 edit distance (when both words are ≥ 5 chars so short words don't
 *  collide — e.g. "LEG" vs "1".) */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1) return true;
  return false;
}

/** Return canonical name, or null if no confident match found. */
function fuzzyMatch(
  token: string,
  canonical: string[],
): { match: string | null; reason: string } {
  const raw = token.trim();
  if (!raw) return { match: null, reason: "empty" };

  const normToken = normalize(raw);
  const tokenWords = normToken.split(/\s+/);

  // 1. Exact case-insensitive whitespace-normalized match
  for (const c of canonical) {
    if (normalize(c) === normToken) return { match: c, reason: "exact" };
  }
  // 2. Substring match — token is a prefix of canonical (e.g. "SEPARATE BACKREST"
  //    → "SEPERATE BACKREST PACKING"). Done word-by-word so minor typos in any
  //    single word still match.
  for (const c of canonical) {
    const cWords = normalize(c).split(/\s+/);
    // Token is a word-prefix of canonical (allow 1-char typo per word)
    if (tokenWords.length <= cWords.length && tokenWords.length >= 1) {
      let ok = true;
      for (let i = 0; i < tokenWords.length; i++) {
        if (!wordsMatch(tokenWords[i], cWords[i])) { ok = false; break; }
      }
      if (ok && tokenWords.join("").length >= 6) {
        return { match: c, reason: "word-prefix" };
      }
    }
    // Canonical is a word-prefix of token (rare but possible)
    if (cWords.length <= tokenWords.length) {
      let ok = true;
      for (let i = 0; i < cWords.length; i++) {
        if (!wordsMatch(cWords[i], tokenWords[i])) { ok = false; break; }
      }
      if (ok && cWords.join("").length >= 6) {
        return { match: c, reason: "word-prefix-rev" };
      }
    }
  }
  // 3. 1-char Levenshtein on whole string — safety net for single-word tokens
  for (const c of canonical) {
    const normC = normalize(c);
    if (editDistance(normC, normToken) <= 1) return { match: c, reason: "lev1" };
    // Word-by-word: any word in canonical with 1-edit distance matches
    // a single-word token (e.g. "SEPARATE" ≈ "SEPERATE")
    if (tokenWords.length === 1 && normToken.length >= 6) {
      const words = normC.split(/\s+/);
      for (const w of words) {
        if (w.length >= 6 && editDistance(w, normToken) <= 1) {
          return { match: c, reason: "lev1-word" };
        }
      }
    }
  }
  return { match: null, reason: "no-match" };
}

function normalizeSpecialOrder(
  raw: string,
  category: string,
  cfg: VariantsCfg,
): { out: string; unmatched: string[]; changed: boolean } {
  const original = raw;
  if (!raw || !raw.trim()) return { out: "", unmatched: [], changed: false };

  // Pool: sofa canonical for SOFA lines, otherwise bedframe (and always
  // include both so cross-category typos still match — e.g. bedframe rows
  // with sofa-ish values don't silently drop).
  const pool =
    category === "SOFA"
      ? [...extractCanonical(cfg.sofaSpecials), ...extractCanonical(cfg.specials)]
      : [...extractCanonical(cfg.specials), ...extractCanonical(cfg.sofaSpecials)];

  // Strip wrapper double-quotes if the whole string is quoted (CSV export artifact)
  let cleaned = raw.trim();
  if (cleaned.startsWith('"""') && cleaned.endsWith('"""')) {
    cleaned = cleaned.slice(3, -3);
  } else if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length > 1) {
    cleaned = cleaned.slice(1, -1);
  }

  // Split on `;` / `,` / ` / ` (with spaces to avoid breaking up quoted tokens
  // like 1"LEG; we special-case `"/` attached to digits below).
  const parts = cleaned.split(/\s*[;,]\s*|\s+\/\s+/);
  const canonicalParts: string[] = [];
  const unmatched: string[] = [];
  for (const rawPart of parts) {
    const p = rawPart.trim();
    if (!p) continue;
    const { match } = fuzzyMatch(p, pool);
    if (match) {
      if (!canonicalParts.includes(match)) canonicalParts.push(match);
    } else {
      // Keep original token so user can review in UI
      if (!canonicalParts.includes(p)) canonicalParts.push(p);
      unmatched.push(p);
    }
  }
  const out = canonicalParts.join("; ");
  return { out, unmatched, changed: out !== original };
}

// --- D1 access -------------------------------------------------------------

function d1(command: string, { mutation = false }: { mutation?: boolean } = {}): unknown {
  // For queries we pass the command string directly via --command= so wrangler
  // streams the result rows. For multi-statement mutations we write the SQL
  // to a temp file and use --file= (wrangler accepts multiple statements).
  const tmp = path.join(os.tmpdir(), `normalize-so-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
  let cmd: string;
  if (mutation) {
    fs.writeFileSync(tmp, command, "utf-8");
    cmd = `npx wrangler d1 execute hookka-erp-db --remote --json --file="${tmp.replace(/\\/g, "\\\\")}"`;
  } else {
    // Escape double-quotes inside the command for the shell. Our SELECT is
    // trivial and doesn't contain shell metacharacters beyond spaces.
    const escaped = command.replace(/"/g, '\\"');
    cmd = `npx wrangler d1 execute hookka-erp-db --remote --json --command="${escaped}"`;
  }
  try {
    const r = spawnSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      shell: true,
      windowsHide: true,
    });
    if (r.error) throw new Error(`d1 spawn error: ${r.error.message}`);
    if (r.status !== 0) {
      throw new Error(`d1 exit ${r.status}: stderr=${r.stderr?.slice(0, 500)} stdout=${r.stdout?.slice(0, 500)}`);
    }
    const out = r.stdout || "";
    const firstBracket = out.indexOf("[");
    if (firstBracket < 0) throw new Error(`no JSON output. stdout=${out.slice(0, 500)}`);
    return JSON.parse(out.slice(firstBracket));
  } finally {
    if (mutation) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

// --- main ------------------------------------------------------------------

async function main() {
  const token = await login();
  const cfgRes = await fetch(`${PROD}/api/kv-config/variants-config`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const cfgJ = (await cfgRes.json()) as { data?: VariantsCfg };
  const cfg = cfgJ.data || {};
  const bfCanon = extractCanonical(cfg.specials);
  const sfCanon = extractCanonical(cfg.sofaSpecials);
  console.log(`Loaded config: ${bfCanon.length} bedframe specials, ${sfCanon.length} sofa specials`);
  console.log("  Bedframe canonical:", bfCanon);
  console.log("  Sofa canonical:", sfCanon);

  console.log("\nFetching all SO items with specialOrder...");
  const rowsJson = d1(
    "SELECT id, itemCategory, specialOrder FROM sales_order_items WHERE specialOrder != '' AND specialOrder IS NOT NULL",
  ) as Array<{ results: Row[] }>;
  const rows = rowsJson[0]?.results || [];
  console.log(`  ${rows.length} rows have non-empty specialOrder`);

  let changed = 0;
  const allUnmatched: Array<{ id: string; tokens: string[]; raw: string }> = [];
  const updates: Array<{ id: string; out: string }> = [];
  const samples: Array<{ id: string; before: string; after: string; cat: string }> = [];

  let sofaChanged = 0;
  let bedframeChanged = 0;
  const sofaSamples: typeof samples = [];
  for (const row of rows) {
    const raw = row.specialOrder || "";
    const { out, unmatched, changed: isChanged } = normalizeSpecialOrder(
      raw,
      row.itemCategory || "BEDFRAME",
      cfg,
    );
    if (isChanged) {
      changed++;
      if (row.itemCategory === "SOFA") sofaChanged++; else bedframeChanged++;
      updates.push({ id: row.id, out });
      if (samples.length < 10) {
        samples.push({ id: row.id, before: raw, after: out, cat: row.itemCategory || "" });
      }
      if (row.itemCategory === "SOFA" && sofaSamples.length < 5) {
        sofaSamples.push({ id: row.id, before: raw, after: out, cat: row.itemCategory || "" });
      }
    }
    if (unmatched.length > 0) {
      allUnmatched.push({ id: row.id, tokens: unmatched, raw });
    }
  }
  console.log(`\n  Bedframe rows changed: ${bedframeChanged}`);
  console.log(`  Sofa rows changed: ${sofaChanged}`);

  console.log(`\n${changed} rows would be updated.`);
  console.log("\nSample before/after (up to 10):");
  for (const s of samples) {
    console.log(`  [${s.cat}] ${s.id}`);
    console.log(`    BEFORE: ${JSON.stringify(s.before)}`);
    console.log(`    AFTER:  ${JSON.stringify(s.after)}`);
  }
  console.log("\nSofa-specific samples (up to 5):");
  for (const s of sofaSamples) {
    console.log(`  [${s.cat}] ${s.id}`);
    console.log(`    BEFORE: ${JSON.stringify(s.before)}`);
    console.log(`    AFTER:  ${JSON.stringify(s.after)}`);
  }

  // Show transformations for any row whose raw contains SEPARATE/SEPERATE so
  // we can sanity-check the 1-char-edit fuzzy match ("SEPARATE" ≈ "SEPERATE")
  console.log("\nSpelling-variant samples (SEPARATE):");
  for (const u of updates) {
    const orig = rows.find((r) => r.id === u.id);
    if (orig?.specialOrder && /SEP[AE]RATE/i.test(orig.specialOrder)) {
      console.log(`  [${orig.itemCategory}] ${u.id}`);
      console.log(`    BEFORE: ${JSON.stringify(orig.specialOrder)}`);
      console.log(`    AFTER:  ${JSON.stringify(u.out)}`);
    }
  }

  console.log(`\n${allUnmatched.length} rows contain unmatched tokens.`);
  // Deduplicate unmatched tokens for summary
  const freq = new Map<string, number>();
  for (const u of allUnmatched) for (const t of u.tokens) freq.set(t, (freq.get(t) || 0) + 1);
  console.log("Unmatched token frequencies:");
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sorted) console.log(`  x${n}  ${JSON.stringify(t)}`);

  if (DRY_RUN) {
    console.log("\n(--dry-run: no updates applied)");
    return;
  }

  if (updates.length === 0) {
    console.log("\nNothing to update.");
    return;
  }

  console.log(`\nApplying ${updates.length} UPDATEs (batched in groups of 50)...`);
  const batchSize = 50;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    const sql = batch
      .map(
        (u) =>
          `UPDATE sales_order_items SET specialOrder='${sqlEscape(u.out)}' WHERE id='${sqlEscape(u.id)}';`,
      )
      .join("\n");
    d1(sql, { mutation: true });
    console.log(`  batch ${i / batchSize + 1}: ${batch.length} rows`);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

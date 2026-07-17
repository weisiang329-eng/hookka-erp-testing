// ---------------------------------------------------------------------------
// specials-config.ts — server-side read of the owner-editable special-order
// price list (kv_config.variants-config.specials), so the backend prices a
// scanned order exactly like the frontend prices a typed one.
//
// The frontend reads this same list via maintenanceConfig and applies it in
// calcPredefinedSurcharge (sales/create.tsx). Before BUG-2026-07-17-002 the
// backend never needed it — it just trusted whatever the client posted. Now it
// derives the surcharge when the client omits it (the scan paths), so it needs
// the same source of truth or the two would drift the moment the owner edits a
// price in Settings.
//
// Read pattern mirrors sofa-size-validation.ts (the existing precedent for
// reading variants-config inside a write path): missing row / malformed JSON /
// missing key all degrade to `null`, which makes the derivation fall back to
// the static catalog in src/lib/pricing-options.ts. Degrading is right here —
// a wedged config must never block order creation, and the static table is the
// same list the config was seeded from.
// ---------------------------------------------------------------------------
import type { CfgSpecial } from "../../lib/special-order-surcharge";

const KV_CONFIG_KEY = "variants-config";

type DbLike = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => { first: <T>() => Promise<T | null> };
  };
};

/**
 * Load `variants-config.specials` (bedframe specials). Returns null when the
 * config is absent/unreadable — callers then fall back to the static catalog.
 * Never throws.
 */
export async function loadSpecialsConfig(
  db: DbLike,
): Promise<CfgSpecial[] | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind(KV_CONFIG_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    const cfg = JSON.parse(row.value) as { specials?: unknown };
    if (!Array.isArray(cfg.specials)) return null;
    const out: CfgSpecial[] = [];
    for (const e of cfg.specials) {
      if (!e || typeof e !== "object") continue;
      const { value, priceSen } = e as { value?: unknown; priceSen?: unknown };
      if (typeof value !== "string" || !value) continue;
      const p = Number(priceSen);
      if (!Number.isFinite(p)) continue;
      out.push({ value, priceSen: p });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

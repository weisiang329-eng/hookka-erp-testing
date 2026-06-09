// ---------------------------------------------------------------------------
// Soft punch-geofence — distance check for worker clock in/out locations.
//
// "Soft" = we only RECORD the punch location and FLAG punches that fall outside
// the factory radius (so the operator can spot home-punching). It never blocks a
// punch, and a phone that denies/can't-get location is simply "no location".
//
// The factory centre defaults to Hookka Manufacturing Sdn Bhd, Shah Alam (the
// coordinates Wei Siang gave on 2026-06-09). It can be overridden per-tenant by
// the kv_config row `factory_geofence` = {lat, lng, radiusM} once an in-app
// "set factory location" control exists — read via getFactoryGeofence().
// ---------------------------------------------------------------------------

export type Geofence = { lat: number; lng: number; radiusM: number };

// Hookka Manufacturing Sdn Bhd, Shah Alam. 200 m radius leaves room for the
// yard / parking / GPS drift in a metal-roofed factory (indoor GPS can wander
// tens of metres). Override via kv_config 'factory_geofence' to fine-tune.
export const DEFAULT_FACTORY_GEOFENCE: Geofence = {
  lat: 3.187681,
  lng: 101.570928,
  radiusM: 200,
};

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): { first<T = unknown>(): Promise<T | null> };
  };
}

/** Great-circle distance between two WGS84 points, in metres (Haversine). */
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6_371_000; // Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type PunchLocationStatus = "in" | "out" | "none";

/**
 * Classify a punch's location against the fence.
 *   "none" — no/garbage coordinates (location not captured) → never flagged.
 *   "in"   — within radius.
 *   "out"  — outside radius (flag red for the operator).
 */
export function evalPunchLocation(
  lat: number | null | undefined,
  lng: number | null | undefined,
  fence: Geofence,
): PunchLocationStatus {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return "none";
  }
  const dist = haversineMeters(lat, lng, fence.lat, fence.lng);
  return dist <= fence.radiusM ? "in" : "out";
}

/**
 * The active factory geofence: the kv_config 'factory_geofence' override if it's
 * a valid {lat, lng, radiusM}, else the Hookka default. Resilient — any read
 * error or malformed row falls back to the default (soft feature, never throws).
 */
export async function getFactoryGeofence(db: DbLike): Promise<Geofence> {
  try {
    const row = await db
      .prepare("SELECT value FROM kv_config WHERE key = ?")
      .bind("factory_geofence")
      .first<{ value: string }>();
    if (row?.value) {
      const p = JSON.parse(row.value) as Partial<Geofence>;
      if (
        typeof p.lat === "number" &&
        typeof p.lng === "number" &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng)
      ) {
        const radiusM =
          typeof p.radiusM === "number" && p.radiusM > 0
            ? p.radiusM
            : DEFAULT_FACTORY_GEOFENCE.radiusM;
        return { lat: p.lat, lng: p.lng, radiusM };
      }
    }
  } catch {
    /* malformed / missing — use the default */
  }
  return DEFAULT_FACTORY_GEOFENCE;
}

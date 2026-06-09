// ---------------------------------------------------------------------------
// punch-geofence.test.mjs — the soft punch-geofence.
//   • geofence.ts pure math: Haversine distance + in/out/none classification +
//     the Hookka factory default (Shah Alam, 200 m).
//   • Structural guards: the punch route stamps location, the worker app sends
//     it (graceful), and the daily report flags out-of-area punches.
// SOFT means: location is recorded + flagged, NEVER blocks the punch.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const geo = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/geofence.ts")).href
);

const FENCE = geo.DEFAULT_FACTORY_GEOFENCE;

test("factory default is the Shah Alam site, 200 m radius", () => {
  assert.ok(Math.abs(FENCE.lat - 3.187681) < 0.001, "lat ~ 3.1877");
  assert.ok(Math.abs(FENCE.lng - 101.570928) < 0.001, "lng ~ 101.5709");
  assert.equal(FENCE.radiusM, 200);
});

test("haversineMeters: same point is ~0; ~0.003° lat is a few hundred metres", () => {
  assert.ok(geo.haversineMeters(FENCE.lat, FENCE.lng, FENCE.lat, FENCE.lng) < 1);
  const d = geo.haversineMeters(FENCE.lat, FENCE.lng, FENCE.lat + 0.003, FENCE.lng);
  assert.ok(d > 300 && d < 360, `expected ~333m, got ${Math.round(d)}`);
});

test("evalPunchLocation: inside radius = in, far = out, no coords = none", () => {
  // At the factory → in.
  assert.equal(geo.evalPunchLocation(FENCE.lat, FENCE.lng, FENCE), "in");
  // ~100 m away (0.0009° lat) → still in (within 200 m).
  assert.equal(geo.evalPunchLocation(FENCE.lat + 0.0009, FENCE.lng, FENCE), "in");
  // ~550 m away → out.
  assert.equal(geo.evalPunchLocation(FENCE.lat + 0.005, FENCE.lng, FENCE), "out");
  // No / garbage location → none (never flagged).
  assert.equal(geo.evalPunchLocation(null, null, FENCE), "none");
  assert.equal(geo.evalPunchLocation(undefined, undefined, FENCE), "none");
  assert.equal(geo.evalPunchLocation(NaN, 5, FENCE), "none");
});

// ── Structural wiring ────────────────────────────────────────────────────────

const WORKER_API = readFileSync(
  resolve(process.cwd(), "src/api/routes/worker.ts"),
  "utf8",
);
const WORKER_HOME = readFileSync(
  resolve(process.cwd(), "src/pages/worker/index.tsx"),
  "utf8",
);
const REPORT = readFileSync(
  resolve(process.cwd(), "src/api/lib/efficiency-report.ts"),
  "utf8",
);

test("punch route adds geo columns at runtime + stamps the punch location", () => {
  assert.ok(
    WORKER_API.includes("ADD COLUMN IF NOT EXISTS clockInLat") &&
      WORKER_API.includes("ADD COLUMN IF NOT EXISTS clockOutLng"),
    "geo columns must be self-applied (ensurePendingMigrations pattern)",
  );
  assert.ok(
    WORKER_API.includes("stampPunchGeo(") &&
      /UPDATE attendance_records SET \$\{cols\} WHERE id = \?/.test(WORKER_API),
    "the punch must stamp the captured lat/lng onto the record",
  );
});

test("worker app captures location but a denial still punches (soft)", () => {
  assert.ok(
    WORKER_HOME.includes("navigator.geolocation.getCurrentPosition"),
    "the worker app must request the punch location",
  );
  assert.ok(
    /loc \? \{ action, lat: loc\.lat, lng: loc\.lng \} : \{ action \}/.test(
      WORKER_HOME,
    ),
    "a null location must still post the punch (no lat/lng) — soft, never blocks",
  );
});

test("daily report flags out-of-area punches (OFF-SITE), resilient to missing columns", () => {
  assert.ok(REPORT.includes("OFF-SITE"), "out-of-area punches show an OFF-SITE badge");
  assert.ok(
    REPORT.includes("evalPunchLocation(") && REPORT.includes("punchOutOfArea"),
    "the report must classify punch location against the fence",
  );
  assert.ok(
    /catch \{[\s\S]{0,400}SELECT employeeId, clockIn, clockOut, status\b/.test(
      REPORT,
    ),
    "must fall back to a geo-less query when the columns don't exist yet",
  );
});

import { getReleaseMetadata } from "./lib/release-metadata.mjs";

const baseUrl = (process.env.STAGING_BASE_URL ??
  "https://staging.hookka-erp-testing.pages.dev").replace(/\/$/, "");
const expected = getReleaseMetadata();

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

const [manifest, ping] = await Promise.all([
  getJson(`/version.json?verify=${encodeURIComponent(expected.commitSha)}`),
  getJson("/api/pg-ping"),
]);

const problems = [];
function expect(label, actual, wanted) {
  if (actual !== wanted) problems.push(`${label}: expected ${wanted}, got ${actual}`);
}

expect("manifest version", manifest.version, expected.version);
expect("manifest channel", manifest.channel, "staging");
expect("manifest commit", manifest.commitSha, expected.commitSha);
expect("manifest source schema", manifest.schemaVersion, expected.schemaVersion);
expect("API release", ping.release?.releaseId, manifest.releaseId);
expect("API commit", ping.release?.commitSha, expected.commitSha);
expect("API expected schema", ping.schema?.expected, expected.schemaVersion);
expect("DB applied schema", ping.schema?.applied, expected.schemaVersion);
expect("DB schema sync", ping.schema?.inSync, true);

if (problems.length > 0) {
  throw new Error(`Staging release verification failed:\n- ${problems.join("\n- ")}`);
}

console.log(
  `Verified ${manifest.releaseId}; DB schema ${ping.schema.applied}; ${baseUrl}`,
);

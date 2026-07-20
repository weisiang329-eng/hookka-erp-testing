import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  channelForBranch,
  getReleaseMetadata,
  latestSchemaVersion,
} from "../scripts/lib/release-metadata.mjs";

test("release metadata binds SemVer, channel, commit and current schema", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const release = getReleaseMetadata({
    env: {
      HOOKKA_BUILD_BRANCH: "staging",
      HOOKKA_BUILD_SHA: "a".repeat(40),
    },
  });
  assert.equal(release.version, packageVersion);
  assert.equal(release.releaseId, `${packageVersion}-staging+${"a".repeat(12)}`);
  assert.equal(release.channel, "staging");
  assert.equal(release.commitSha, "a".repeat(40));
  assert.equal(release.schemaVersion, latestSchemaVersion(process.cwd()));
});

test("production release IDs do not carry a prerelease channel", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const release = getReleaseMetadata({
    env: {
      HOOKKA_BUILD_BRANCH: "main",
      HOOKKA_BUILD_SHA: "b".repeat(40),
    },
  });
  assert.equal(release.releaseId, `${packageVersion}+${"b".repeat(12)}`);
  assert.equal(channelForBranch("main"), "production");
  assert.equal(channelForBranch("feature/a"), "preview");
});

test("an explicit deploy channel wins over a branch alias", () => {
  assert.equal(channelForBranch("staging", "production"), "production");
});

test("the build, API and promotion workflow share the release identity", () => {
  const vite = readFileSync("vite.config.ts", "utf8");
  const worker = readFileSync("src/api/worker.ts", "utf8");
  const gate = readFileSync(
    ".github/workflows/production-release-gate.yml",
    "utf8",
  );
  assert.match(vite, /fileName: 'version\.json'/);
  assert.doesNotMatch(vite, /__BUILD_ID__:\s*JSON\.stringify\(Date\.now/);
  assert.match(worker, /release: RELEASE/);
  assert.match(worker, /inSync: appliedSchemaVersion === RELEASE\.schemaVersion/);
  assert.match(gate, /github\.head_ref != 'staging'/);
  assert.match(gate, /verify-staging-release\.mjs/);
});

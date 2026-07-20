import assert from "node:assert/strict";
import test from "node:test";

import {
  scanTextForSecrets,
  scanTrackedFiles,
} from "../scripts/check-hardcoded-secrets.mjs";
import { requiredDatabaseUrl } from "../scripts/lib/required-database-url.mjs";

test("secret scanner detects a credentialed database URL without retaining it", () => {
  const password = "real-looking-private-value";
  const findings = scanTextForSecrets(
    `const url = "postgresql://postgres:${password}@db.example.com/postgres";`,
    "fixture.mjs",
  );
  assert.deepEqual(findings, [{
    file: "fixture.mjs",
    line: 1,
    rule: "credentialed-postgres-url",
  }]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(password));
});

test("documented placeholder URLs are permitted", () => {
  const findings = scanTextForSecrets(
    "postgresql://postgres.project:secret@pooler.example.com/postgres",
    "fixture.mjs",
  );
  assert.deepEqual(findings, []);
});

test("repository source contains no credentialed PostgreSQL URL", () => {
  assert.deepEqual(scanTrackedFiles(), []);
});

test("database helpers fail closed instead of choosing a default target", () => {
  assert.throws(
    () => requiredDatabaseUrl("PROD_DATABASE_URL", {}),
    /PROD_DATABASE_URL is required/,
  );
  assert.equal(
    requiredDatabaseUrl("STAGING_DATABASE_URL", { STAGING_DATABASE_URL: "postgresql://provided" }),
    "postgresql://provided",
  );
});

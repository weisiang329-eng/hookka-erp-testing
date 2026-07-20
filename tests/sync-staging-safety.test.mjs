import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { parseSupabaseTarget, validateSyncTargets } from "../scripts/validate-db-sync-targets.mjs";

const prodRef = "prodprojectref";
const stagingRef = "stageprojectref";
const prodUrl = `postgresql://postgres.${prodRef}:secret@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres`;
const stagingUrl = `postgresql://postgres.${stagingRef}:secret@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`;

test("sync target validator accepts distinct, expected Supabase projects", () => {
  const result = validateSyncTargets({
    prodUrl,
    stagingUrl,
    expectedProdRef: prodRef,
    expectedStagingRef: stagingRef,
  });
  assert.equal(result.prod.projectRef, prodRef);
  assert.equal(result.staging.projectRef, stagingRef);
});

test("sync target validator rejects a staging URL that points at prod", () => {
  assert.throws(
    () => validateSyncTargets({
      prodUrl,
      stagingUrl: prodUrl,
      expectedProdRef: prodRef,
      expectedStagingRef: stagingRef,
    }),
    /STAGING_DATABASE_URL does not match/,
  );
});

test("sync target validator rejects swapped expected refs", () => {
  assert.throws(
    () => validateSyncTargets({
      prodUrl,
      stagingUrl,
      expectedProdRef: stagingRef,
      expectedStagingRef: prodRef,
    }),
    /PROD_DATABASE_URL does not match/,
  );
});

test("pooler URL must carry the Supabase project ref in its username", () => {
  assert.throws(
    () => parseSupabaseTarget(
      "postgresql://postgres:secret@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres",
      "STAGING_DATABASE_URL",
    ),
    /does not expose a Supabase project ref/,
  );
});

test("staging sync workflow fails closed before destructive work", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/sync-staging.yml"), "utf8");
  const validateAt = workflow.indexOf("Validate isolated database targets");
  const connectivityAt = workflow.indexOf("Preflight both database connections");
  const dumpAt = workflow.indexOf("pg_dump prod");
  const dropAt = workflow.indexOf("Reset staging public schema");

  assert.ok(validateAt >= 0 && validateAt < dumpAt);
  assert.ok(connectivityAt >= 0 && connectivityAt < dumpAt);
  assert.ok(dumpAt >= 0 && dumpAt < dropAt);
  assert.match(workflow, /PROD_SUPABASE_PROJECT_REF/);
  assert.match(workflow, /STAGING_SUPABASE_PROJECT_REF/);
  assert.match(workflow, /PROD_SUPABASE_PROJECT_REF: vpwdqtsxexpiqxzweivd/);
  assert.match(workflow, /STAGING_SUPABASE_PROJECT_REF: zaxygxwadidiqcphibma/);
  assert.doesNotMatch(workflow, /vars\.PROD_SUPABASE_PROJECT_REF/);
  assert.doesNotMatch(workflow, /vars\.STAGING_SUPABASE_PROJECT_REF/);
  assert.match(workflow, /STAGING_WORKER_PIN_HASH/);
  assert.match(workflow, /TRUNCATE TABLE public\.user_sessions/);
  assert.match(workflow, /TRUNCATE TABLE public\.worker_sessions/);
  assert.doesNotMatch(workflow, /123456/);
  assert.doesNotMatch(workflow, /sample ACTIVE empNos/i);
});

test("staging deploy validates its reviewed target before every migration step", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/deploy.yml"), "utf8");
  const expectedRefAssignments = workflow.match(
    /EXPECTED_SUPABASE_PROJECT_REF: zaxygxwadidiqcphibma/g,
  ) ?? [];
  assert.equal(expectedRefAssignments.length, 3);
  assert.doesNotMatch(workflow, /vars\.STAGING_SUPABASE_PROJECT_REF/);
  assert.ok(
    workflow.indexOf("Preflight staging database migrations")
      < workflow.indexOf("Apply reviewed migrations to staging"),
  );
});

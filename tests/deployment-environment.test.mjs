import assert from "node:assert/strict";
import test from "node:test";

import {
  isPreviewHostname,
  runtimeEnvironment,
} from "../src/api/lib/deployment-environment.ts";

test("production Pages hostname remains production", () => {
  const url = "https://hookka-erp-testing.pages.dev/api/health";
  assert.equal(isPreviewHostname(url), false);
  assert.equal(runtimeEnvironment(url, "production"), "production");
});

test("staging branch hostname overrides the inherited production binding", () => {
  const url = "https://staging.hookka-erp-testing.pages.dev/api/health";
  assert.equal(isPreviewHostname(url), true);
  assert.equal(runtimeEnvironment(url, "production"), "staging");
});

test("canary and commit previews use the staging environment", () => {
  assert.equal(
    runtimeEnvironment(
      "https://canary-62.hookka-erp-testing.pages.dev/api/health",
      "production",
    ),
    "staging",
  );
  assert.equal(
    runtimeEnvironment(
      "https://abc123.hookka-erp-testing.pages.dev/api/health",
      "production",
    ),
    "staging",
  );
});

test("custom domains and local development keep their configured environment", () => {
  assert.equal(runtimeEnvironment("https://erp.hookka.com/api/health", "production"), "production");
  assert.equal(runtimeEnvironment("http://localhost:8788/api/health", "development"), "development");
});

test("malformed URLs are never treated as preview", () => {
  assert.equal(isPreviewHostname("not a url"), false);
  assert.equal(runtimeEnvironment("not a url", "test"), "test");
});

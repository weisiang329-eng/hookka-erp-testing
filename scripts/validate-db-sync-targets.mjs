import { pathToFileURL } from "node:url";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

function required(value, name) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

export function parseSupabaseTarget(rawUrl, name) {
  const value = required(rawUrl, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${name} must use postgres:// or postgresql://`);
  }

  const username = decodeURIComponent(url.username || "");
  const hostname = url.hostname.toLowerCase();
  let projectRef = null;

  // Pooler URLs identify the project in postgres.<project-ref>; direct
  // Supabase URLs identify it in <project-ref>.supabase.co.
  if (hostname.endsWith(".pooler.supabase.com")) {
    const dot = username.indexOf(".");
    if (dot >= 0 && dot < username.length - 1) projectRef = username.slice(dot + 1);
  } else if (hostname.endsWith(".supabase.co")) {
    projectRef = hostname.slice(0, -".supabase.co".length).split(".").at(-1) || null;
  }

  if (!projectRef) {
    throw new Error(
      `${name} does not expose a Supabase project ref; use the documented session-pooler URL with username postgres.<project-ref>`,
    );
  }

  return {
    hostname,
    port: url.port || "5432",
    database: url.pathname.replace(/^\//, "") || "postgres",
    projectRef: projectRef.toLowerCase(),
  };
}

export function validateSyncTargets({ prodUrl, stagingUrl, expectedProdRef, expectedStagingRef }) {
  const prod = parseSupabaseTarget(prodUrl, "PROD_DATABASE_URL");
  const staging = parseSupabaseTarget(stagingUrl, "STAGING_DATABASE_URL");
  const prodRef = required(expectedProdRef, "PROD_SUPABASE_PROJECT_REF").toLowerCase();
  const stagingRef = required(expectedStagingRef, "STAGING_SUPABASE_PROJECT_REF").toLowerCase();

  if (prodRef === stagingRef) {
    throw new Error("Expected production and staging project refs must be different");
  }
  if (prod.projectRef !== prodRef) {
    throw new Error("PROD_DATABASE_URL does not match PROD_SUPABASE_PROJECT_REF");
  }
  if (staging.projectRef !== stagingRef) {
    throw new Error("STAGING_DATABASE_URL does not match STAGING_SUPABASE_PROJECT_REF");
  }
  if (prod.projectRef === staging.projectRef) {
    throw new Error("Refusing to sync: production and staging resolve to the same Supabase project");
  }

  return { prod, staging };
}

function main() {
  const { prod, staging } = validateSyncTargets({
    prodUrl: process.env.PROD_DATABASE_URL,
    stagingUrl: process.env.STAGING_DATABASE_URL,
    expectedProdRef: process.env.PROD_SUPABASE_PROJECT_REF,
    expectedStagingRef: process.env.STAGING_SUPABASE_PROJECT_REF,
  });

  // Project refs are public identifiers. Never print connection URLs,
  // usernames, or passwords.
  console.log(`Validated isolated Supabase targets: prod=${prod.projectRef}, staging=${staging.projectRef}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`Sync target validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

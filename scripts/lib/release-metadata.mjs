import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function gitValue(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function normalizeSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : "unknown";
}

function normalizeBranch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/[^0-9a-z._/-]+/g, "-") || "local";
}

export function channelForBranch(branch, explicitChannel = "") {
  if (explicitChannel) return normalizeBranch(explicitChannel).replaceAll("/", "-");
  if (branch === "main") return "production";
  if (branch === "staging") return "staging";
  if (branch === "local") return "local";
  return "preview";
}

export function latestSchemaVersion(rootDir) {
  const migrationsDir = resolve(rootDir, "migrations-postgres");
  const versions = readdirSync(migrationsDir)
    .map((name) => /^(\d{4})_[^.]+\.sql$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  if (versions.length === 0) throw new Error("No numbered Postgres migrations found");
  return String(Math.max(...versions)).padStart(4, "0");
}

export function getReleaseMetadata({ rootDir = process.cwd(), env = process.env } = {}) {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
  if (!SEMVER.test(pkg.version) || pkg.version === "0.0.0") {
    throw new Error(`package.json must contain a real SemVer release; got ${pkg.version}`);
  }

  const commitSha = normalizeSha(
    env.HOOKKA_BUILD_SHA ??
      env.CF_PAGES_COMMIT_SHA ??
      env.GITHUB_SHA ??
      gitValue(["rev-parse", "HEAD"], rootDir),
  );
  const branch = normalizeBranch(
    env.HOOKKA_BUILD_BRANCH ??
      env.CF_PAGES_BRANCH ??
      env.GITHUB_HEAD_REF ??
      env.GITHUB_REF_NAME ??
      gitValue(["branch", "--show-current"], rootDir),
  );
  const channel = channelForBranch(branch, env.HOOKKA_RELEASE_CHANNEL);
  const shortSha = commitSha === "unknown" ? commitSha : commitSha.slice(0, 12);
  const prerelease = channel === "production" ? "" : `-${channel}`;

  return Object.freeze({
    version: pkg.version,
    releaseId: `${pkg.version}${prerelease}+${shortSha}`,
    channel,
    branch,
    commitSha,
    shortSha,
    schemaVersion: latestSchemaVersion(rootDir),
  });
}

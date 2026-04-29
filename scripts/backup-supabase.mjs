#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Phase C #7 quick-win — admin-side Supabase backup driver.
//
// Why a Node script alongside the Workers cron (cron/daily-backup.ts):
//   pg_dump produces a much higher-fidelity artifact than a logical JSON
//   dump (custom format, includes constraints, sequences, large objects,
//   restore parallelism). Workers cannot run pg_dump. So we keep both:
//     * cron/daily-backup.ts — runs inside CF Workers, JSON-Lines fallback.
//     * scripts/backup-supabase.mjs — runs from a dev laptop or CI box
//       that has `pg_dump` installed; produces .dump.gz alongside the
//       cron's .json.gz under hookka-files/backups/supabase/.
//
// Storage backend: was Cloudflare R2 before the storage-supabase-migration
// (2026-04-29). Now uploads to Supabase Storage via the v1 REST API. No
// aws-sdk dependency anymore — plain fetch() with a service-role bearer.
//
// Strategy (this script):
//   1. Shell out to `pg_dump -Fc --no-owner --no-acl $DATABASE_URL`
//      and pipe the output through `gzip` to a temp file.
//   2. Upload the temp file to Supabase Storage at
//      hookka-files/backups/supabase/<YYYY-MM-DD>.dump.gz with
//      `x-upsert: true` so re-runs replace.
//   3. List existing keys under that prefix and delete anything older
//      than 90 days (RETENTION_DAYS).
//
// Why we shell out to pg_dump rather than streaming via postgres.js:
//   pg_dump's custom format (-Fc) is the only logical format that
//   pg_restore can replay in parallel with constraints disabled and
//   re-enabled in the right order. JSON dumps cannot match that.
//
// Required env vars:
//   DATABASE_URL                 — Supabase Postgres connection string
//   SUPABASE_PROJECT_REF         — slug from <ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — service_role key (bearer auth)
//   SUPABASE_BUCKET              — optional; defaults to "hookka-files"
//
// Note: this script is largely superseded by .github/workflows/backup.yml,
// which does the same thing on Ubuntu runners with curl. Kept for ad-hoc
// local runs (e.g. before a risky migration the operator wants a fresh
// snapshot of, without pushing first).
//
// Usage:
//   node scripts/backup-supabase.mjs            # one-shot backup
//   node scripts/backup-supabase.mjs --restore <YYYY-MM-DD>  (TODO)
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";

const RETENTION_DAYS = 90;
const STORAGE_PREFIX = "backups/supabase/";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  SUPABASE_PROJECT_REF: process.env.SUPABASE_PROJECT_REF,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET: process.env.SUPABASE_BUCKET ?? "hookka-files",
};
const REQUIRED = ["DATABASE_URL", "SUPABASE_PROJECT_REF", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length > 0) {
  console.error(
    `[backup-supabase] missing env vars: ${missing.join(", ")}\n` +
      `See docs/DR-RUNBOOK.md for the full list.`,
  );
  process.exit(1);
}

const STORAGE_BASE = `https://${env.SUPABASE_PROJECT_REF}.supabase.co/storage/v1`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${STORAGE_PREFIX}${today}.dump.gz`;

  const workDir = await mkdir(join(tmpdir(), `hookka-backup-${today}`), {
    recursive: true,
  });
  const dumpPath = join(workDir ?? tmpdir(), `${today}.dump.gz`);

  console.log(`[backup-supabase] running pg_dump → ${dumpPath}`);
  await runPgDumpToFile(env.DATABASE_URL, dumpPath);

  const sz = (await stat(dumpPath)).size;
  console.log(`[backup-supabase] dump complete: ${sz} bytes`);

  console.log(
    `[backup-supabase] uploading to supabase://${env.SUPABASE_BUCKET}/${key}`,
  );
  await uploadToStorage(dumpPath, key, "application/gzip");

  console.log(`[backup-supabase] pruning backups older than ${RETENTION_DAYS}d`);
  await pruneOldBackups();

  await rm(dumpPath, { force: true });
  console.log(`[backup-supabase] done — ${key}`);
}

// ---------------------------------------------------------------------------
// pg_dump → gzip → file
// ---------------------------------------------------------------------------
function runPgDumpToFile(connectionString, outPath) {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      [
        "-Fc",
        "--no-owner",
        "--no-acl",
        "--quote-all-identifiers",
        connectionString,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const gz = spawn("gzip", ["-9"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    dump.stdout.pipe(gz.stdin);
    const out = createWriteStream(outPath);
    gz.stdout.pipe(out);

    let dumpExit = null;
    let gzExit = null;
    const settle = () => {
      if (dumpExit !== null && gzExit !== null) {
        if (dumpExit !== 0) reject(new Error(`pg_dump exited ${dumpExit}`));
        else if (gzExit !== 0) reject(new Error(`gzip exited ${gzExit}`));
        else out.on("close", resolve);
      }
    };
    dump.on("exit", (code) => {
      dumpExit = code;
      settle();
    });
    gz.on("exit", (code) => {
      gzExit = code;
      settle();
    });
    dump.on("error", reject);
    gz.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Supabase Storage v1 — POST/LIST/DELETE via plain fetch()
// ---------------------------------------------------------------------------
const authHeader = () => ({
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
});

async function uploadToStorage(filePath, key, contentType) {
  const body = await readFile(filePath);
  const url = `${STORAGE_BASE}/object/${encodeURIComponent(env.SUPABASE_BUCKET)}/${encodeObjectPath(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader(),
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`upload failed ${res.status}: ${text}`);
  }
}

async function pruneOldBackups() {
  const url = `${STORAGE_BASE}/object/list/${encodeURIComponent(env.SUPABASE_BUCKET)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      prefix: STORAGE_PREFIX.replace(/\/+$/, ""),
      limit: 1000,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`list failed ${res.status}: ${text}`);
  }
  const list = await res.json();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const obj of list ?? []) {
    const ts = obj.updated_at ?? obj.created_at;
    const last = ts ? new Date(ts).getTime() : NaN;
    if (Number.isFinite(last) && last < cutoff) {
      const fullKey = `${STORAGE_PREFIX}${obj.name}`;
      console.log(
        `[backup-supabase] pruning ${fullKey} (age > ${RETENTION_DAYS}d)`,
      );
      const delUrl = `${STORAGE_BASE}/object/${encodeURIComponent(env.SUPABASE_BUCKET)}/${encodeObjectPath(fullKey)}`;
      const delRes = await fetch(delUrl, {
        method: "DELETE",
        headers: authHeader(),
      });
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(`[backup-supabase]   delete failed ${delRes.status}`);
      }
    }
  }
}

function encodeObjectPath(key) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

// ---------------------------------------------------------------------------
main().catch((err) => {
  console.error("[backup-supabase] FAILED:", err);
  process.exit(1);
});

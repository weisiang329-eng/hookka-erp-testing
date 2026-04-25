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
//       cron's .json.gz under r2://hookka-files/backups/supabase/.
//
// Strategy (this script):
//   1. Shell out to `pg_dump -Fc --no-owner --no-acl $DATABASE_URL`
//      and pipe the output through `gzip` to a temp file.
//   2. Upload the temp file to R2 at backups/supabase/<YYYY-MM-DD>.dump.gz
//      via the Cloudflare R2 S3-compatible API.
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
//   R2_ENDPOINT                  — https://<account>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID             — from Cloudflare dashboard → R2 → API Tokens
//   R2_SECRET_ACCESS_KEY         — same
//   R2_BUCKET                    — e.g. "hookka-files"
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
const R2_PREFIX = "backups/supabase/";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: process.env.R2_BUCKET ?? "hookka-files",
};
const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(
    `[backup-supabase] missing env vars: ${missing.join(", ")}\n` +
      `See docs/DR-RUNBOOK.md for the full list.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${R2_PREFIX}${today}.dump.gz`;

  const workDir = await mkdir(join(tmpdir(), `hookka-backup-${today}`), {
    recursive: true,
  });
  const dumpPath = join(workDir ?? tmpdir(), `${today}.dump.gz`);

  console.log(`[backup-supabase] running pg_dump → ${dumpPath}`);
  await runPgDumpToFile(env.DATABASE_URL, dumpPath);

  const sz = (await stat(dumpPath)).size;
  console.log(`[backup-supabase] dump complete: ${sz} bytes`);

  console.log(`[backup-supabase] uploading to r2://${env.R2_BUCKET}/${key}`);
  await uploadToR2(dumpPath, key, "application/gzip");

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
// R2 — minimal S3-compatible PUT/LIST/DELETE
// ---------------------------------------------------------------------------
async function r2Fetch(method, key, body, extraHeaders = {}) {
  // Deferred: the full SigV4 signing is library-shaped — for the script
  // path we use AWS SDK v3's @aws-sdk/client-s3. This script intentionally
  // declares the dependency at the runbook level (docs/DR-RUNBOOK.md
  // step 0) so the repo stays slim for the Workers build.
  const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } =
    await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  if (method === "PUT") {
    const buf = body instanceof Buffer ? body : await readFile(body);
    return client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        Body: buf,
        ContentType: extraHeaders["Content-Type"] ?? "application/octet-stream",
      }),
    );
  }
  if (method === "LIST") {
    return client.send(
      new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: R2_PREFIX }),
    );
  }
  if (method === "DELETE") {
    return client.send(
      new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    );
  }
  throw new Error(`unhandled method ${method}`);
}

async function uploadToR2(filePath, key, contentType) {
  await r2Fetch("PUT", key, filePath, { "Content-Type": contentType });
}

async function pruneOldBackups() {
  const res = await r2Fetch("LIST");
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const obj of res.Contents ?? []) {
    const lastMod = obj.LastModified
      ? new Date(obj.LastModified).getTime()
      : NaN;
    if (Number.isFinite(lastMod) && lastMod < cutoff) {
      console.log(`[backup-supabase] pruning ${obj.Key} (age > ${RETENTION_DAYS}d)`);
      await r2Fetch("DELETE", obj.Key);
    }
  }
}

// ---------------------------------------------------------------------------
main().catch((err) => {
  console.error("[backup-supabase] FAILED:", err);
  process.exit(1);
});

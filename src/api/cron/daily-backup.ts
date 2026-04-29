// ---------------------------------------------------------------------------
// Phase C #7 quick-win — daily logical backup of Supabase to Supabase Storage.
//
// Runs as a Cloudflare Workers Cron Trigger (commented in wrangler.toml
// until the admin provisions the trigger; see docs/DR-RUNBOOK.md). Pages
// Functions does not host scheduled events natively, so this lives as a
// standalone scheduled handler that a sibling Worker (or eventually the
// post-SDK-split unified Worker) wires up.
//
// Approach inside the Worker runtime:
//   pg_dump is not available in the Workers JS runtime. Instead we run a
//   logical SELECT-to-JSON dump of every table in the `public` schema,
//   gzip it, and write it to Supabase Storage at:
//     hookka-files/backups/supabase/YYYY-MM-DD.json.gz
//
//   The format is JSON Lines so a partial dump can still be parsed; each
//   line is `{"table":"sales_orders","row":{...}}`. Restore tooling
//   (scripts/backup-supabase.mjs --restore) reads back into a target
//   Postgres via INSERT ... ON CONFLICT DO NOTHING.
//
//   For higher fidelity (CONSTRAINTS, INDEXES, sequences) the GitHub
//   Actions workflow at .github/workflows/backup.yml runs `pg_dump -Fc`
//   from an Ubuntu runner and uploads the .dump to the same Storage
//   prefix. The cron path is the inside-Workers fallback so we always
//   have *something* even when the GitHub Actions runner is degraded.
//
// Storage backend: was Cloudflare R2 before the storage-supabase-migration
// refactor. Helper module is src/api/lib/supabase-storage.ts; it kept the
// original R2-flavoured export names so the call sites here didn't change
// shape, only the import path.
//
// Retention: prune any object under backups/supabase/ older than 90
// days from the SAME prefix. RPO is technically 24h with this cron;
// docs/DR-RUNBOOK.md flags the gap and recommends switching to hourly
// for production.
// ---------------------------------------------------------------------------

import { putFile, listFiles, deleteFile } from "../lib/supabase-storage";

/** Minimum env surface this handler needs. Imported lazily so the
 * scheduled handler doesn't pull in the full Hono Env. */
export interface DailyBackupEnv {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  SUPABASE_PROJECT_REF?: string;
  SUPABASE_SERVICE_KEY?: string;
}

/** 90-day retention for the daily-cron logical dumps. */
const RETENTION_DAYS = 90;
const PREFIX = "backups/supabase/";

export default {
  async scheduled(
    _event: unknown,
    env: DailyBackupEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ): Promise<void> {
    ctx.waitUntil(runDailyBackup(env));
  },
};

/**
 * Top-level driver. Exported so a /api/internal/run-backup admin
 * endpoint can invoke the same code path manually for ad-hoc runs.
 */
export async function runDailyBackup(env: DailyBackupEnv): Promise<{
  ok: boolean;
  bytes?: number;
  key?: string;
  error?: string;
}> {
  if (!env.SUPABASE_PROJECT_REF || !env.SUPABASE_SERVICE_KEY) {
    return {
      ok: false,
      error:
        "Supabase Storage credentials missing — set SUPABASE_PROJECT_REF + SUPABASE_SERVICE_KEY",
    };
  }
  const dbUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!dbUrl) {
    return { ok: false, error: "no database connection string" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const key = `${PREFIX}${today}.json.gz`;

  try {
    // Lazy import — keeps the cold-start light when no cron fires.
    const { getSql } = await import("../lib/db-pg");
    const sql = getSql(dbUrl);

    // Enumerate user tables in public schema. Skip pg internal /
    // auth-managed tables (Supabase puts those in `auth` schema, but be
    // defensive in case someone moved a table).
    type TableRow = { tablename: string };
    const tablesRaw = (await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT LIKE 'pg_%'
        AND tablename NOT LIKE '_supabase%'
      ORDER BY tablename
    `) as unknown as TableRow[];

    const lines: string[] = [];
    for (const t of tablesRaw) {
      const tableName = t.tablename;
      // Use postgres.js's tagged template safely — quote the identifier.
      // Defensive: filter to a safe character set since pg_tables might
      // surface user-DDL'd tables with unexpected names.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
        console.warn(
          `[daily-backup] skipping table with non-safe name: ${tableName}`,
        );
        continue;
      }
      // sql.unsafe runs the query without quoting — we just validated
      // the identifier above.
      const rows = (await (
        sql as unknown as {
          unsafe: (q: string) => Promise<Record<string, unknown>[]>;
        }
      ).unsafe(`SELECT * FROM "${tableName}"`)) as Record<string, unknown>[];
      for (const row of rows) {
        lines.push(JSON.stringify({ table: tableName, row }));
      }
    }

    const body = lines.join("\n") + "\n";
    const compressed = await gzip(body);

    await putFile(env, key, compressed, "application/gzip");

    // Retention prune — drop anything older than 90 days.
    await pruneOldBackups(env, RETENTION_DAYS);

    return { ok: true, bytes: compressed.byteLength, key };
  } catch (err) {
    console.error("[daily-backup] failed:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "backup failed",
    };
  }
}

async function pruneOldBackups(
  env: DailyBackupEnv,
  retentionDays: number,
): Promise<void> {
  if (!env.SUPABASE_PROJECT_REF || !env.SUPABASE_SERVICE_KEY) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    const objects = await listFiles(env, PREFIX, 1000);
    for (const obj of objects) {
      const uploaded = obj.uploaded instanceof Date
        ? obj.uploaded.getTime()
        : new Date(obj.uploaded as unknown as string).getTime();
      if (Number.isFinite(uploaded) && uploaded < cutoff) {
        await deleteFile(env, obj.key);
        console.log(
          `[daily-backup] pruned ${obj.key} (age > ${retentionDays}d)`,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[daily-backup] retention prune failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Workers runtime exposes the Compression Streams API. We pipe the
 * UTF-8 bytes through a gzip stream and collect into a single Uint8Array.
 */
async function gzip(text: string): Promise<Uint8Array> {
  const inputBytes = new TextEncoder().encode(text);
  const cs = new (
    globalThis as unknown as {
      CompressionStream: new (algo: "gzip") => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    }
  ).CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(inputBytes);
  void writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

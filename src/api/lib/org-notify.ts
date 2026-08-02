// ---------------------------------------------------------------------------
// Send something up the reporting line.
//
// The org chart stored who reports to whom and then nothing read it — it was a
// drawing, not wiring (owner 2026-08-02: 「我只要能把 reporting line 放对，这整个
// 东西就会做出来了 …包括通知 reporting line」). This is the one place that turns
// an edge into a delivered notification, so every future producer (an
// unacknowledged alert, a resignation, a shortfall) gets the same behaviour for
// free and a new person or department needs no code change at all — set their
// manager and they are wired.
//
// Deliberately best-effort: a notification that fails to write must never fail
// the thing that triggered it. A resignation still saves if the manager's inbox
// is unreachable.
// ---------------------------------------------------------------------------
import { managerChainOf, personKey, parsePersonKey } from "../../lib/org-people";

/** Anything that can run the two statements this module needs. */
type Db = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      all: <T>() => Promise<{ results?: T[] }>;
      run: () => Promise<unknown>;
    };
    all: <T>() => Promise<{ results?: T[] }>;
    run: () => Promise<unknown>;
  };
};

export type OrgNotification = {
  type: string;
  title: string;
  message?: string;
  /** "info" | "warning" | "error" — matches the notifications table. */
  severity?: string;
  link?: string;
};

// Runtime self-apply. Migrations are inert on deploy in this repo, so the
// column exists only because this runs and is AWAITED before the first write.
// Without it every targeted notification would throw on a missing column and
// (being best-effort) vanish silently — the worst possible failure for a
// feature whose whole job is to tell someone.
let _mig: Promise<void> | null = null;
export function ensureNotificationTargeting(db: Db): Promise<void> {
  if (_mig) return _mig;
  _mig = (async () => {
    await db
      .prepare("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id TEXT")
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id)",
      )
      .run();
  })();
  return _mig;
}

/** For tests — drop the module-level migration cache. */
export function _resetOrgNotifyMigForTests(): void {
  _mig = null;
}

/**
 * Every reporting edge in the org, as personKey → managerKey.
 *
 * Same precedence the chart itself uses: an explicit `org_reporting` row wins,
 * and `users.reportsTo` is the fallback for office accounts wired up before
 * that table existed. If the two ever disagree, the chart and the notification
 * must agree with each other — hence one loader, not two.
 */
export async function loadReportingMap(db: Db): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();

  const uRes = await db
    .prepare("SELECT id, reportsTo FROM users")
    .all<{ id: string; reportsTo: string | null }>();
  for (const u of uRes.results ?? []) {
    if (u.reportsTo) map.set(personKey("user", u.id), personKey("user", u.reportsTo));
  }

  const eRes = await db
    .prepare("SELECT person_key, manager_key FROM org_reporting")
    .all<{ person_key: string; manager_key: string | null }>();
  for (const e of eRes.results ?? []) map.set(e.person_key, e.manager_key ?? null);

  return map;
}

/**
 * Notify the people above `subject` in the chart.
 *
 * `depth` 1 (default) is the direct manager only — the common case, and the one
 * that does not spam a whole company. Raise it to escalate further up.
 *
 * Only `user:` managers can actually receive anything: a notification is a row
 * keyed to a login, and a factory worker has no account. A worker sitting in
 * the chain is therefore SKIPPED but does NOT stop the walk — the message
 * continues to whoever is above them, which is exactly what should happen when
 * an Operator Leader has no login.
 */
export async function notifyManagerChain(
  db: Db,
  subjectKey: string,
  n: OrgNotification,
  opts: { depth?: number; orgId?: string } = {},
): Promise<{ notified: string[]; skipped: string[] }> {
  const notified: string[] = [];
  const skipped: string[] = [];
  if (!parsePersonKey(subjectKey)) return { notified, skipped };

  try {
    await ensureNotificationTargeting(db);
    const map = await loadReportingMap(db);
    // Walk the whole chain, then take the first `depth` managers that can
    // actually be reached. Slicing the chain first would silently drop the
    // message when the direct manager happens to be an account-less worker.
    const chain = managerChainOf(subjectKey, map);
    const depth = Math.max(1, opts.depth ?? 1);
    const targets: string[] = [];
    for (const key of chain) {
      const parsed = parsePersonKey(key);
      if (!parsed) continue;
      if (parsed.source !== "user") {
        skipped.push(key);
        continue;
      }
      targets.push(parsed.id);
      if (targets.length >= depth) break;
    }
    if (targets.length === 0) return { notified, skipped };

    const now = new Date().toISOString();
    for (const userId of targets) {
      const id = `notif-${crypto.randomUUID().slice(0, 12)}`;
      await db
        .prepare(
          `INSERT INTO notifications (id, type, title, message, severity, isRead, link, user_id, orgId, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          n.type,
          n.title,
          n.message ?? "",
          n.severity ?? "info",
          n.link ?? null,
          userId,
          opts.orgId ?? null,
          now,
        )
        .run();
      notified.push(userId);
    }
  } catch (e) {
    // Never fail the caller. A resignation still saves when the manager's
    // inbox is unreachable — but say so, or this goes quiet forever.
    console.error("[org-notify] could not notify the reporting line:", e);
  }
  return { notified, skipped };
}

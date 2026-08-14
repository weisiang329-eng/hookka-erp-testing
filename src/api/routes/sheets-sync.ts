// ---------------------------------------------------------------------------
// sheets-sync.ts — Google Sheets <-> ERP bidirectional sync routes.
//
// Mounted under /api/sheets-sync in worker.ts.
//
// Routes:
//   POST /api/sheets-sync/apps-script-webhook
//     Receives onEdit POSTs from the spreadsheet's Apps Script trigger.
//     Validates HMAC against SHEETS_SYNC_SECRET + a 5-minute timestamp
//     window, then applies the edit to the matching job_cards row (only
//     completionDate / pic1Name / pic2Name are accepted from this path).
//     Recomputes the parent PO's progress + currentDepartment after the
//     UPDATE so the dashboard stays in sync.  Idempotent — re-posting the
//     same payload is a no-op.
//
//   POST /api/sheets-sync/backfill
//     Admin-only.  Body: { dryRun?: boolean }.  When dryRun is true (the
//     default) returns the row count + a 5-row sample.  When false, scans
//     every active JC and upserts each one to its dept tab.  Returns
//     { success, scanned, pushed, errors[] }.
//
// Both routes return 503 with a clear error body when GOOGLE_SHEETS_SA_KEY
// or SHEETS_SPREADSHEET_ID is missing on the env — the build is otherwise
// safe to ship before the GCP service account is provisioned.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { invalidateProductionListCaches } from "../lib/po-list-cache";
// job_cards.completed_at. A date keyed into a spreadsheet is an ASSERTION about
// a day, never an observation of an instant, so this path never MINTS one — it
// only decides whether the instant already on the row still describes the date
// being written (and a revert to not-done drops it).
import {
  ensureJobCardCompletedAt,
  readCompletedAt,
  reconcileCompletedAt,
} from "../lib/job-card-completed-at";
import { tryGetOrgId, DEFAULT_ORG_ID } from "../lib/tenant";
import { DEPT_ORDER } from "../lib/lead-times";
import {
  backfillAllJobCards,
  buildWebhookHmacPayload,
  SheetsSyncNotConfiguredError,
  verifyWebhookSignature,
} from "../lib/sheets-sync";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Apps Script webhook — Sheets -> ERP path.
// ---------------------------------------------------------------------------

const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

type WebhookBody = {
  jobCardId?: unknown;
  completionDate?: unknown;
  pic1Name?: unknown;
  pic2Name?: unknown;
  signature?: unknown;
  timestamp?: unknown;
};

app.post("/apps-script-webhook", async (c) => {
  // Public endpoint by design — Apps Script can't carry the dashboard JWT.
  // Auth boils down to the HMAC signature + timestamp window below.

  const env = c.env as unknown as { SHEETS_SYNC_SECRET?: string };
  const secret = env.SHEETS_SYNC_SECRET;
  if (!secret) {
    // Fails closed before any state is touched.  503 (not 401) so the Apps
    // Script log surfaces it as "service not configured" rather than an
    // auth bug.
    return c.json(
      {
        success: false,
        error: "sheets sync not configured (SHEETS_SYNC_SECRET missing)",
      },
      503,
    );
  }

  let body: WebhookBody;
  try {
    body = (await c.req.json()) as WebhookBody;
  } catch {
    return c.json({ success: false, error: "invalid json body" }, 400);
  }

  const jobCardId = typeof body.jobCardId === "string" ? body.jobCardId : null;
  const signature = typeof body.signature === "string" ? body.signature : null;
  const timestamp = typeof body.timestamp === "number" ? body.timestamp : null;
  if (!jobCardId || !signature || timestamp == null) {
    return c.json(
      {
        success: false,
        error: "missing required fields: jobCardId, signature, timestamp",
      },
      400,
    );
  }
  // Timestamp freshness — reject anything older than 5 minutes (or more
  // than 5 minutes in the future, which would mean clock skew or replay).
  const skewMs = Math.abs(Date.now() - timestamp);
  if (skewMs > WEBHOOK_TIMESTAMP_WINDOW_MS) {
    return c.json(
      {
        success: false,
        error: "stale or future-dated timestamp",
        code: "TIMESTAMP_WINDOW",
      },
      401,
    );
  }

  const completionDate =
    body.completionDate === null
      ? null
      : typeof body.completionDate === "string"
        ? body.completionDate
        : undefined;
  const pic1Name =
    body.pic1Name === null
      ? null
      : typeof body.pic1Name === "string"
        ? body.pic1Name
        : undefined;
  const pic2Name =
    body.pic2Name === null
      ? null
      : typeof body.pic2Name === "string"
        ? body.pic2Name
        : undefined;

  // Verify signature against the canonical payload.  The canonical form is
  // shared with the Apps Script signer in scripts/apps-script-onedit.gs.
  const payload = buildWebhookHmacPayload({
    jobCardId,
    timestamp,
    completionDate: completionDate ?? null,
    pic1Name: pic1Name ?? null,
    pic2Name: pic2Name ?? null,
  });
  const ok = await verifyWebhookSignature(secret, payload, signature);
  if (!ok) {
    return c.json({ success: false, error: "invalid signature" }, 401);
  }

  const db = c.var.DB;
  // Migrations are inert on deploy (CLAUDE.md) — awaited before the SELECT that
  // reads the column and the UPDATE that writes it.
  await ensureJobCardCompletedAt(db);
  const jc = await db
    .prepare(
      `SELECT id, productionOrderId, status, completedDate, completedAt,
              pic1Id, pic1Name, pic2Id, pic2Name, overdue
         FROM job_cards WHERE id = ?`,
    )
    .bind(jobCardId)
    .first<{
      id: string;
      productionOrderId: string;
      status: string;
      completedDate: string | null;
      completedAt?: string | null;
      completed_at?: string | null;
      pic1Id: string | null;
      pic1Name: string | null;
      pic2Id: string | null;
      pic2Name: string | null;
      overdue: string | null;
    }>();
  if (!jc) {
    return c.json({ success: false, error: "job card not found" }, 404);
  }

  // Only touch the three Sheets-editable fields.  Status is recomputed
  // below from completedDate + the existing piece-pic state (forward-only:
  // setting completionDate to a non-null value flips the JC to COMPLETED
  // when it isn't already; clearing completionDate moves it back to
  // WAITING/IN_PROGRESS based on whether any PIC slot is filled).
  const newCompletionDate =
    completionDate === undefined ? jc.completedDate : completionDate;
  // Nothing is measured here. Carry a previously OBSERVED instant forward only
  // while it still describes the date being stored: an unchanged date keeps it,
  // a re-dated card drops it, and clearing the date clears it.
  const newCompletedAt = reconcileCompletedAt(
    newCompletionDate,
    readCompletedAt(jc),
  );
  const newPic1Name = pic1Name === undefined ? jc.pic1Name : (pic1Name ?? "");
  const newPic2Name = pic2Name === undefined ? jc.pic2Name : (pic2Name ?? "");

  let newStatus = jc.status;
  let newOverdue = jc.overdue;
  if (newCompletionDate && jc.status !== "COMPLETED" && jc.status !== "TRANSFERRED") {
    newStatus = "COMPLETED";
    newOverdue = "COMPLETED";
  } else if (
    !newCompletionDate &&
    (jc.status === "COMPLETED" || jc.status === "TRANSFERRED")
  ) {
    // Reverting from DONE -> not-done.  Pick WAITING vs IN_PROGRESS based
    // on whether either PIC name is filled.
    newStatus = newPic1Name || newPic2Name ? "IN_PROGRESS" : "WAITING";
    newOverdue = jc.overdue === "COMPLETED" ? null : jc.overdue;
  }

  // Idempotency — bail early if nothing actually changed.
  if (
    newCompletionDate === jc.completedDate &&
    newPic1Name === jc.pic1Name &&
    newPic2Name === jc.pic2Name &&
    newStatus === jc.status
  ) {
    return c.json({ success: true, applied: false, reason: "no change" });
  }

  await db
    .prepare(
      // completedAt travels with completedDate in every statement that writes
      // the date — the two must never be able to disagree.
      `UPDATE job_cards SET completedDate = ?, completedAt = ?, pic1Name = ?, pic2Name = ?,
                            status = ?, overdue = ?
         WHERE id = ?`,
    )
    .bind(
      newCompletionDate,
      newCompletedAt,
      newPic1Name ?? "",
      newPic2Name ?? "",
      newStatus,
      newOverdue,
      jobCardId,
    )
    .run();

  // Recompute PO progress from the freshly-updated JC set.  Mirrors the
  // minimal slice of applyPoUpdate's progress block (reading every JC for
  // the PO and counting completed/transferred).
  try {
    const siblings = await db
      .prepare(
        "SELECT id, status, departmentCode FROM job_cards WHERE productionOrderId = ?",
      )
      .bind(jc.productionOrderId)
      .all<{ id: string; status: string; departmentCode: string | null }>();
    const list = siblings.results ?? [];
    if (list.length > 0) {
      const completed = list.filter(
        (j) => j.status === "COMPLETED" || j.status === "TRANSFERRED",
      ).length;
      const progress = Math.round((completed / list.length) * 100);
      const allDone = completed === list.length;
      // Frontier = earliest department in the chain (DEPT_ORDER) that still
      // has a not-yet-done job card. A plain `find` of the first incomplete JC
      // reads rows in arbitrary DB order (no ORDER BY), so the reported dept
      // need not reflect the order's true chain position — same fix as the
      // PATCH + scan paths in production-orders.ts.
      const deptRank = (code: string | null | undefined): number => {
        const idx = DEPT_ORDER.indexOf((code ?? "") as (typeof DEPT_ORDER)[number]);
        return idx >= 0 ? idx : DEPT_ORDER.length;
      };
      const frontier = list
        .filter((j) => j.status !== "COMPLETED" && j.status !== "TRANSFERRED")
        .reduce<(typeof list)[number] | null>((earliest, j) => {
          if (!earliest) return j;
          return deptRank(j.departmentCode) < deptRank(earliest.departmentCode)
            ? j
            : earliest;
        }, null);
      const currentDept = frontier?.departmentCode || "PACKING";
      const today = new Date().toISOString().split("T")[0];
      await db
        .prepare(
          `UPDATE production_orders SET progress = ?, currentDepartment = ?,
              status = CASE WHEN ? = 1 THEN 'COMPLETED'
                            WHEN ? > 0 THEN 'IN_PROGRESS'
                            ELSE status END,
              completedDate = CASE WHEN ? = 1 THEN ? ELSE completedDate END,
              updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          progress,
          currentDept,
          allDone ? 1 : 0,
          completed,
          allDone ? 1 : 0,
          today,
          new Date().toISOString(),
          jc.productionOrderId,
        )
        .run();
    }
  } catch (err) {
    // Progress recompute is supplementary bookkeeping — never void the
    // primary JC UPDATE on its account.  Log + continue.
    console.error(
      "[sheets-sync/webhook] PO progress recompute failed",
      err instanceof Error ? err.message : err,
    );
  }

  // The webhook just moved a job card and recomputed its PO's progress /
  // currentDepartment / status — the operator's dept sheet must show it on the
  // next open, not after a TTL. See
  // tests/production-write-invalidation-class.test.mjs.
  try {
    await invalidateProductionListCaches(c, tryGetOrgId(c) ?? DEFAULT_ORG_ID);
  } catch (err) {
    console.warn(
      "[sheets-sync/webhook] cache invalidation failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return c.json({
    success: true,
    applied: true,
    jobCardId,
    status: newStatus,
  });
});

// ---------------------------------------------------------------------------
// Admin backfill — push every active JC to its dept tab.
// ---------------------------------------------------------------------------

app.post("/backfill", async (c) => {
  const denied = await requirePermission(c, "production-orders", "update");
  if (denied) return denied;

  let body: { dryRun?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dryRun !== false; // default safe

  try {
    const result = await backfillAllJobCards(
      c.env as unknown as {
        GOOGLE_SHEETS_SA_KEY?: string;
        SHEETS_SPREADSHEET_ID?: string;
      },
      c.var.DB,
      { dryRun },
    );
    return c.json({ success: true, dryRun, ...result });
  } catch (err) {
    if (err instanceof SheetsSyncNotConfiguredError) {
      return c.json({ success: false, error: err.message }, 503);
    }
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

export default app;

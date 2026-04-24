// ---------------------------------------------------------------------------
// Phase 6 — job_card_events audit log writer.
//
// Parallel to the existing `UPDATE job_cards SET ...` path: every mutation
// also appends a row here so future audit / rollback tooling has a
// lossless log of what changed, when, by whom, from what source.
//
// Keep this module PURE of side-effects outside the DB writes — no logging,
// no event-emission, no dependencies on Hono context. Callers pass a
// plain D1Database handle + data so we can also call this from batch
// contexts where the Hono ctx isn't available (e.g. scan-complete).
//
// Two entry points:
//   appendJobCardEvent   — immediate INSERT (use when the caller is
//                          already awaiting a run() and adding one more
//                          round-trip is fine).
//   buildJobCardEventStatements — returns prepared D1 statements for
//                          inclusion in a db.batch([...]) call alongside
//                          the main UPDATE, so the event write lands in
//                          the same implicit transaction as the mutation.
// ---------------------------------------------------------------------------

export type JobCardEventType =
  | "STATUS_CHANGED"
  | "COMPLETED_DATE_SET"
  | "COMPLETED_DATE_CLEARED"
  | "PIC_ASSIGNED"
  | "PIC_CLEARED"
  | "DUE_DATE_CHANGED"
  | "RACK_ASSIGNED"
  | "CREATED"
  | "DELETED";

export type JobCardEventSource = "ui" | "scan" | "admin" | "migration" | "system";

export type JobCardEventInput = {
  jobCardId: string;
  productionOrderId: string;
  eventType: JobCardEventType;
  /**
   * Free-form JSON payload, typically { from, to, ... }. Caller passes
   * a plain object; we JSON.stringify here so call sites can't forget.
   */
  payload: Record<string, unknown>;
  /**
   * Actor metadata. Leave undefined for system events (FG cascades,
   * scheduled jobs, etc.). The middleware stashes userId/userRole on
   * the Hono ctx — pull those at the call site if you have the ctx.
   */
  actorUserId?: string | null;
  actorName?: string | null;
  source?: JobCardEventSource | null;
  /**
   * Optional timestamp override — used only by backfills. Runtime calls
   * omit this and we fill in new Date().toISOString().
   */
  ts?: string;
};

// Crypto random ID that doesn't require `crypto.randomUUID` to be
// available on every Workers runtime. evt_<hex> is distinguishable from
// customer-facing ids in logs without needing prefix lookups elsewhere.
function newEventId(): string {
  // 12 bytes of entropy in hex — 96-bit, plenty for a non-PK ID.
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return `evt_${hex}`;
}

// Build the D1 prepared statement for an event. Callers either await
// .run() on it or pass it into db.batch([...]). Kept separate from
// appendJobCardEvent so the PATCH handler can atomically include the
// event write in its main batch alongside the UPDATE job_cards SET.
export function buildJobCardEventStatement(
  db: D1Database,
  evt: JobCardEventInput,
): D1PreparedStatement {
  const id = newEventId();
  const ts = evt.ts ?? new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO job_card_events
         (id, jobCardId, productionOrderId, eventType, payload,
          actorUserId, actorName, source, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      evt.jobCardId,
      evt.productionOrderId,
      evt.eventType,
      JSON.stringify(evt.payload ?? {}),
      evt.actorUserId ?? null,
      evt.actorName ?? null,
      evt.source ?? null,
      ts,
    );
}

// Convenience wrapper that builds + runs the statement. Use when the
// surrounding code is NOT already batching writes.
export async function appendJobCardEvent(
  db: D1Database,
  evt: JobCardEventInput,
): Promise<void> {
  await buildJobCardEventStatement(db, evt).run();
}

// ---------------------------------------------------------------------------
// Diff helper — derives the event rows to write for a JC mutation by
// comparing the pre- and post-UPDATE JobCardRow snapshots. Keeps the
// PATCH handler terse: one call, one array of events back.
//
// The "field that actually changed" contract from the phase-6 spec is
// enforced here — no events are emitted for fields whose before/after
// values are equal. For PIC slots we distinguish between assigned (null→id)
// and cleared (id→null); a pure swap (id-A → id-B) produces one CLEARED
// + one ASSIGNED event so the chronology stays legible.
// ---------------------------------------------------------------------------

type JcBeforeAfter = {
  id: string;
  productionOrderId: string;
  status?: string | null;
  completedDate?: string | null;
  pic1Id?: string | null;
  pic1Name?: string | null;
  pic2Id?: string | null;
  pic2Name?: string | null;
  dueDate?: string | null;
  rackingNumber?: string | null;
};

export function diffJobCardEvents(
  before: JcBeforeAfter,
  after: JcBeforeAfter,
  meta: {
    actorUserId?: string | null;
    actorName?: string | null;
    source?: JobCardEventSource | null;
  },
): JobCardEventInput[] {
  const out: JobCardEventInput[] = [];
  const baseMeta = {
    jobCardId: after.id,
    productionOrderId: after.productionOrderId,
    actorUserId: meta.actorUserId ?? null,
    actorName: meta.actorName ?? null,
    source: meta.source ?? null,
  };

  // status
  if (before.status !== after.status && after.status !== undefined) {
    out.push({
      ...baseMeta,
      eventType: "STATUS_CHANGED",
      payload: { from: before.status ?? null, to: after.status ?? null },
    });
  }

  // completedDate — split into SET / CLEARED so audit screens can filter
  // for "when did JC X actually get marked done" vs "when was the mark
  // pulled back". If both sides are truthy but different (date edit),
  // emit a SET with { from, to } to capture the rewrite.
  const bDate = before.completedDate ?? null;
  const aDate = after.completedDate ?? null;
  if (bDate !== aDate) {
    if (aDate && !bDate) {
      out.push({ ...baseMeta, eventType: "COMPLETED_DATE_SET", payload: { to: aDate } });
    } else if (!aDate && bDate) {
      out.push({
        ...baseMeta,
        eventType: "COMPLETED_DATE_CLEARED",
        payload: { from: bDate },
      });
    } else {
      out.push({
        ...baseMeta,
        eventType: "COMPLETED_DATE_SET",
        payload: { from: bDate, to: aDate },
      });
    }
  }

  // PIC1 — assigned vs cleared vs swapped (two events).
  if ((before.pic1Id ?? null) !== (after.pic1Id ?? null)) {
    if (before.pic1Id) {
      out.push({
        ...baseMeta,
        eventType: "PIC_CLEARED",
        payload: { slot: "pic1", from: before.pic1Id, fromName: before.pic1Name ?? null },
      });
    }
    if (after.pic1Id) {
      out.push({
        ...baseMeta,
        eventType: "PIC_ASSIGNED",
        payload: { slot: "pic1", to: after.pic1Id, toName: after.pic1Name ?? null },
      });
    }
  }

  // PIC2 — same logic.
  if ((before.pic2Id ?? null) !== (after.pic2Id ?? null)) {
    if (before.pic2Id) {
      out.push({
        ...baseMeta,
        eventType: "PIC_CLEARED",
        payload: { slot: "pic2", from: before.pic2Id, fromName: before.pic2Name ?? null },
      });
    }
    if (after.pic2Id) {
      out.push({
        ...baseMeta,
        eventType: "PIC_ASSIGNED",
        payload: { slot: "pic2", to: after.pic2Id, toName: after.pic2Name ?? null },
      });
    }
  }

  // dueDate
  if ((before.dueDate ?? null) !== (after.dueDate ?? null)) {
    out.push({
      ...baseMeta,
      eventType: "DUE_DATE_CHANGED",
      payload: { from: before.dueDate ?? null, to: after.dueDate ?? null },
    });
  }

  // rackingNumber — single event type for assign OR change (null→rack,
  // rack-A→rack-B). Callers that need to distinguish can read payload.from.
  if ((before.rackingNumber ?? null) !== (after.rackingNumber ?? null)) {
    out.push({
      ...baseMeta,
      eventType: "RACK_ASSIGNED",
      payload: {
        from: before.rackingNumber ?? null,
        to: after.rackingNumber ?? null,
      },
    });
  }

  return out;
}

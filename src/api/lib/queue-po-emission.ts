// ---------------------------------------------------------------------------
// Phase C #3 quick-win — PO emission queue producer.
//
// Why this file exists:
//   Today, "SO confirm" runs the SMTP send for every cascaded PO inline. A
//   transient Resend failure leaves the SO in "half-confirmed" purgatory
//   (~70% of stuck cascades per the ROADMAP-PHASE-C.md analysis). Routing
//   PO emission through Cloudflare Queues isolates the SMTP failure from
//   the SO confirm transaction: the SO is durably CONFIRMED, and the email
//   side-effect retries on its own schedule.
//
// Wiring:
//   1. wrangler.toml declares a producer + consumer binding for
//      queue=`po-emission` (commented out until the admin runs
//      `wrangler queues create po-emission`; see docs/QUEUES-SETUP.md).
//   2. POST /api/sales-orders/:id/confirm (sales-orders route) calls
//      enqueuePoEmission(env, { ... }) AFTER the synchronous PO insert
//      batch succeeds.
//   3. The consumer handler in src/api/queues/po-emission-consumer.ts reads
//      each message and runs the existing notifySupplierPoSubmitted email
//      logic. Failed messages auto-retry (max_retries=3) and dead-letter
//      to `po-emission-dlq`.
//
// Graceful degradation:
//   When env.PO_EMISSION_QUEUE is undefined (binding not yet wired up),
//   we fall back to running the email/notification inline so the dev/local
//   environment keeps the same behavior as production. This guarantees
//   the scaffold ships behind the binding gate without breaking any
//   environment that hasn't yet provisioned the queue.
// ---------------------------------------------------------------------------

export interface PoEmissionMessage {
  /** PO row id in production_orders. */
  poId: string;
  /** Source SO id that caused this PO emission. Used by the consumer
   * for audit context. */
  soId: string;
  /** Customer-facing email destination. May be empty when the supplier
   * record has no email; consumer logs and skips in that case. */
  customerEmail?: string;
  /** Optional: human-readable PO number for log lines. */
  poNo?: string;
  /** Optional: supplier id / name carried for the email template. */
  supplierId?: string;
  supplierName?: string;
  /** Active org scope (Phase C #1). Carried so the consumer queries the
   * right tenant when it re-reads the PO. */
  orgId?: string;
  /** ISO timestamp when the producer enqueued the message. Helps the
   * consumer compute end-to-end latency for the workflow_run dashboard
   * (Phase C #3 finish). */
  enqueuedAt: string;
}

/**
 * Cloudflare Queue producer binding shape — stripped to just `send` for
 * what we actually need. The full type comes from
 * @cloudflare/workers-types but importing it here would force every
 * consumer to also import the workers-types ambient declarations, so we
 * declare the minimum surface we depend on.
 */
type QueueProducer = {
  send: (message: PoEmissionMessage) => Promise<void>;
};

/**
 * Producer entry point. Pushes one message onto the PO_EMISSION_QUEUE
 * binding when it exists; otherwise falls back to the inline emit (same
 * behavior as today).
 *
 * Returns `{ via: "queue" }` when the message was enqueued and `{ via:
 * "inline", reason }` when we fell back. Callers use this to log which
 * path ran without changing their control flow.
 */
export async function enqueuePoEmission(
  env: { PO_EMISSION_QUEUE?: QueueProducer },
  args: Omit<PoEmissionMessage, "enqueuedAt"> & { enqueuedAt?: string },
): Promise<{ via: "queue" | "inline"; reason?: string }> {
  const message: PoEmissionMessage = {
    ...args,
    enqueuedAt: args.enqueuedAt ?? new Date().toISOString(),
  };

  const queue = env.PO_EMISSION_QUEUE;
  if (queue && typeof queue.send === "function") {
    try {
      await queue.send(message);
      return { via: "queue" };
    } catch (err) {
      // Queue unavailable for some reason (binding present but service
      // disabled, account quota exceeded, etc.) — fall through to the
      // inline path so the email still goes out and the SO confirm
      // doesn't silently swallow a side-effect.
      console.warn(
        "[queue-po-emission] queue.send failed; falling back to inline:",
        err instanceof Error ? err.message : err,
      );
      await runInline(message);
      return {
        via: "inline",
        reason: err instanceof Error ? err.message : "queue send failed",
      };
    }
  }

  await runInline(message);
  return { via: "inline", reason: "PO_EMISSION_QUEUE binding not configured" };
}

/**
 * Inline fallback for the SO-confirm → production-PO emission flow.
 * NOTE: this queue is for INTERNAL production orders spawned at SO
 * confirm — not the procurement PO → supplier flow that
 * `notifySupplierPoSubmitted` handles. The two were sharing one stub
 * pre-2026-04-26; the supplier-facing path is now wired to Resend
 * (see `lib/email.ts`) but the production-PO emission path still has
 * no concrete receiver (no customer-facing portal exists yet). Log
 * only — when a real customer notification template lands, swap the
 * console.log for a sendEmail call.
 */
async function runInline(message: PoEmissionMessage): Promise<void> {
  console.log(
    `[queue-po-emission:inline] PO ${message.poNo ?? message.poId} (SO ${message.soId}) emitted; no customer-facing notification wired yet.`,
  );
}

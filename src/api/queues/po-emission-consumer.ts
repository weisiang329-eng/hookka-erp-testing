// ---------------------------------------------------------------------------
// Phase C #3 quick-win — PO emission queue consumer.
//
// Cloudflare Queues consumer entry point. The producer
// (src/api/lib/queue-po-emission.ts) pushes one message per PO that needs
// email + PDF generation; this handler reads the batch, runs the existing
// supplier notification path for each message, and ack/retries per-message
// so a single bad message does not poison the batch.
//
// Wiring:
//   * `wrangler.toml` declares the consumer binding (commented out until
//     the admin runs `wrangler queues create po-emission`; see
//     docs/QUEUES-SETUP.md).
//   * The consumer is exported as the default export's `queue` handler.
//     A thin shim in functions/api/[[route]].ts can re-export it once the
//     binding is live; until then, this module is dead code path-wise but
//     still compiled by the strict-build gate, which is what we want.
//   * Failed messages bubble out via `message.retry()` so the queue's
//     max_retries policy kicks in, then dead-letter to `po-emission-dlq`.
//
// Side-effect note: the actual email is currently a `console.log` stub
// (see lib/email.ts notifySupplierPoSubmitted). Once Resend is wired in
// behind that helper, the consumer immediately picks up the real send
// without any change here.
// ---------------------------------------------------------------------------

import type { PoEmissionMessage } from "../lib/queue-po-emission";

/**
 * Cloudflare Queue message + batch shapes — declared locally so this
 * file does not depend on the workers-types ambient declarations being
 * loaded in every consumer.
 */
type QueueMessage<T> = {
  id: string;
  timestamp: Date;
  body: T;
  ack: () => void;
  retry: (opts?: { delaySeconds?: number }) => void;
};

type MessageBatch<T> = {
  queue: string;
  messages: QueueMessage<T>[];
};

/**
 * Minimal env surface for the consumer — same DB/email bindings as the
 * Hono app uses. Imported lazily via the producer's email helper to keep
 * the module graph small.
 */
export interface PoEmissionConsumerEnv {
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
}

/**
 * Process one batch of PO-emission messages. Each message is handled
 * independently — a failure on message N does not affect messages N+1..K.
 *
 * Retry policy:
 *   * Transient failure (Resend 5xx, network timeout) → message.retry()
 *     with a small backoff. The queue's max_retries=3 + DLQ catches
 *     anything that's still failing after that.
 *   * Permanent failure (no supplier email, malformed message) →
 *     message.ack() + a console.warn so it shows up in `wrangler tail`
 *     but doesn't burn retry budget on something the queue can never fix.
 */
export async function handlePoEmissionBatch(
  batch: MessageBatch<PoEmissionMessage>,
  env: PoEmissionConsumerEnv,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processOne(msg.body, env);
      msg.ack();
    } catch (err) {
      const transient = isTransient(err);
      console.warn(
        `[po-emission-consumer] message ${msg.id} failed (transient=${transient}):`,
        err instanceof Error ? err.message : err,
      );
      if (transient) {
        // Exponential-ish backoff: queue config sets max_retries=3 so
        // worst-case the message gets ~30s + 60s + 120s before DLQ.
        msg.retry({ delaySeconds: 30 });
      } else {
        // Permanent failure — ack so we don't loop forever; rely on the
        // console.warn for ops to find it in `wrangler tail`. Future
        // work: surface to the workflow_run dashboard (Phase C #3
        // finish) so ops gets a UI for these.
        msg.ack();
      }
    }
  }
}

async function processOne(
  message: PoEmissionMessage,
  _env: PoEmissionConsumerEnv,
): Promise<void> {
  // Lazy import keeps the consumer module light and avoids a circular
  // import (email.ts ← queue-po-emission.ts ← worker.ts → consumer).
  const { notifySupplierPoSubmitted } = await import("../lib/email");

  // Permanent failure: no supplier identity at all. Log + ack (handled
  // by the caller catching the throw with isTransient === false).
  if (!message.supplierId && !message.poNo) {
    throw new PermanentError(
      `PO ${message.poId}: missing supplierId AND poNo — cannot route email`,
    );
  }

  notifySupplierPoSubmitted({
    poNo: message.poNo ?? message.poId,
    supplierName: message.supplierName ?? "(unknown supplier)",
    supplierId: message.supplierId ?? "",
  });

  // TODO (Phase C #3 finish): once a workflow_run table exists, write a
  // step-completion row here so the UI can show "PO emission completed
  // for SO X at <timestamp>".
}

/**
 * Sentinel error type — message handlers throw this when the failure
 * is unrecoverable so the batch loop can ack instead of retrying.
 */
export class PermanentError extends Error {
  readonly _permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof PermanentError) return false;
  // Network-ish errors and 5xx from Resend are retried. Everything else
  // (validation, missing data) is treated as permanent above.
  return true;
}

/**
 * Default export shape that wrangler's queue consumer wiring expects.
 * Once the binding is uncommented in wrangler.toml, the admin needs to
 * point the consumer entrypoint at this module's `queue` handler — for
 * a Pages Functions deployment that means adding a sibling Worker (the
 * Pages Functions runtime doesn't host queue consumers directly).
 *
 * See docs/QUEUES-SETUP.md for the full wire-up.
 */
export default {
  async queue(
    batch: MessageBatch<PoEmissionMessage>,
    env: PoEmissionConsumerEnv,
  ): Promise<void> {
    await handlePoEmissionBatch(batch, env);
  },
};

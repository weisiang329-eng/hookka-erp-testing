// ---------------------------------------------------------------------------
// Async job dispatch helper (Phase 6).
//
// Purpose: isolate the "where does this heavy work run?" decision behind a
// single function so routes don't care whether the work went to a Queue, a
// Durable Object, an external service, or ran inline.
//
// Strategy TODAY (no Queues binding yet):
//   * If env.EXPORT_QUEUE is bound → enqueue via CF Queues.
//   * Otherwise → run inline, up to the 30s CPU limit.  Good enough for
//     small reports on 10-50 user ERP.  The heavy ops (Excel export over
//     10k+ rows, PDF batch gen, mass email) should be migrated to a real
//     Queue when frequency or dataset size crosses the threshold.
//
// To enable CF Queues later:
//   1. `wrangler queues create erp-jobs`
//   2. Add to wrangler.toml:
//        [[queues.producers]]
//        binding = "EXPORT_QUEUE"
//        queue = "erp-jobs"
//   3. Create a consumer Worker (Pages Functions cannot consume queues —
//      this is a Workers-only binding).
//   4. Deploy the consumer Worker with a matching [[queues.consumers]] section.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

export type Job =
  | { type: "export.excel"; table: string; filters?: Record<string, unknown> }
  | { type: "export.pdf"; docType: "invoice" | "do" | "po"; id: string }
  | { type: "email.bulk"; templateId: string; recipientIds: string[] };

export interface DispatchResult {
  jobId: string;
  mode: "queue" | "inline";
}

/**
 * Dispatch a background job.  If CF Queues isn't bound yet, runs `inlineFn`
 * synchronously so the feature works (slow but correct).  Production should
 * wire the queue binding so this returns immediately with a jobId the client
 * can poll.
 */
export async function dispatch<T>(
  c: Context<Env>,
  job: Job,
  inlineFn: () => Promise<T>,
): Promise<DispatchResult> {
  const jobId = crypto.randomUUID();
  const queue = (c.env as unknown as { EXPORT_QUEUE?: { send: (msg: unknown) => Promise<void> } })
    .EXPORT_QUEUE;
  if (queue) {
    await queue.send({ jobId, ...job });
    return { jobId, mode: "queue" };
  }
  // Fallback: run inline.  No jobId persistence — caller gets the result
  // synchronously.  If you need status polling, wire the queue.
  await inlineFn();
  return { jobId, mode: "inline" };
}

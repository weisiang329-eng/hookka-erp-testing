// ---------------------------------------------------------------------------
// sequence-unlock — the client half of the upstream sequence lock.
//
// The backend refuses a completion whose upstream is still open with a 409
// carrying `code: "UPSTREAM_INCOMPLETE"`. Five screens can trigger that (the
// schedule grid, the batch date stamp, the planning board, the admin scanner
// and the worker's phone), so the SHAPE of that refusal is parsed in exactly
// one place. Five copies of a response parser is five chances for one of them
// to render "error 409" at a worker holding a sofa.
//
// Owner 2026-09-06: 「简单来说就是一模一样直接上线，只是在影子模式下它还是会锁
// 起来，不过锁起来的时候他们可以直接解锁」 — the lock is real and visible from
// day one, and anyone may release it. `canSelfUnlock` comes from the SERVER on
// every refusal; this module never decides it. When the policy tightens to
// supervisors only, nothing here changes.
// ---------------------------------------------------------------------------

export type SequenceBlocker = {
  id: string;
  departmentCode: string;
  status: string;
};

export type SequenceLockRefusal = {
  /** Departments that must finish first, in the order they must happen. */
  blockedBy: SequenceBlocker[];
  /** Job-card ids the server refused (fan-out scans refuse several at once). */
  blockedCards: string[];
  /** Decided by the server, never inferred here. */
  canSelfUnlock: boolean;
  /** Ready-to-show English sentence from the server. */
  message: string;
};

type MaybeRefusal = {
  code?: unknown;
  error?: unknown;
  blockedBy?: unknown;
  blockedCards?: unknown;
  canSelfUnlock?: unknown;
};

/**
 * Read a response body as a sequence-lock refusal, or `null` if it is anything
 * else. Callers keep their existing error handling for everything else — this
 * must not swallow unrelated failures.
 */
export function asSequenceLockRefusal(body: unknown): SequenceLockRefusal | null {
  if (!body || typeof body !== "object") return null;
  const b = body as MaybeRefusal;
  if (b.code !== "UPSTREAM_INCOMPLETE") return null;
  const blockedBy = Array.isArray(b.blockedBy)
    ? b.blockedBy.flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const r = x as Record<string, unknown>;
        const dept = String(r.departmentCode ?? "").trim();
        if (!dept) return [];
        return [{
          id: String(r.id ?? ""),
          departmentCode: dept,
          status: String(r.status ?? ""),
        }];
      })
    : [];
  return {
    blockedBy,
    blockedCards: Array.isArray(b.blockedCards) ? b.blockedCards.map(String) : [],
    // Absent means NOT unlockable. An optimistic default would hand a worker a
    // button the server will refuse.
    canSelfUnlock: b.canSelfUnlock === true,
    message:
      typeof b.error === "string" && b.error.trim()
        ? b.error
        : "An earlier step must be completed first.",
  };
}

/** The distinct departments to finish, in order. Display helper. */
export function blockingDepartments(refusal: SequenceLockRefusal): string[] {
  return [...new Set(refusal.blockedBy.map((b) => b.departmentCode))];
}

/**
 * The reasons offered when releasing a lock. Free text is also accepted, but a
 * short list is what makes the weekly review readable: "upstream was actually
 * finished" and "this step does not apply" are different problems with
 * different fixes, and typed prose collapses them into noise.
 *
 * English — the UI is 100% English (CLAUDE.md).
 */
export const UNLOCK_REASONS = [
  "Earlier step was finished but not recorded",
  "Earlier step does not apply to this order",
  "Urgent — will record the earlier step later",
  "Other",
] as const;

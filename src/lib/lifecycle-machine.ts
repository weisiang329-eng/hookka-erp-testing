// ---------------------------------------------------------------------------
// lifecycle-machine.ts — pure state machine for document lifecycle (F3).
// State ACTIVE/VOID/DELETED. Void = visible reversal (both legs shown).
// Delete = hidden from GL (both legs hidden). Unvoid = back to active
// (reversal hidden, original shown). hidden flags are non-hashed ledger
// metadata; the reversal entry is created once and thereafter only its
// (and the original's) `hidden` flag toggles.
// ---------------------------------------------------------------------------

export type DocState = "ACTIVE" | "VOID" | "DELETED";
export type LifecycleAction = "void" | "delete" | "unvoid";

const TRANSITIONS: Record<DocState, Partial<Record<LifecycleAction, DocState>>> = {
  ACTIVE: { void: "VOID", delete: "DELETED" },
  VOID: { unvoid: "ACTIVE", delete: "DELETED" },
  DELETED: { unvoid: "ACTIVE" },
};

export function nextState(cur: DocState, action: LifecycleAction): DocState | null {
  return TRANSITIONS[cur]?.[action] ?? null;
}

export function hiddenTargets(state: DocState): { original: 0 | 1; reversal: 0 | 1 } {
  switch (state) {
    case "ACTIVE": return { original: 0, reversal: 1 };
    case "VOID": return { original: 0, reversal: 0 };
    case "DELETED": return { original: 1, reversal: 1 };
  }
}

export function needsReversal(action: LifecycleAction): boolean {
  return action === "void" || action === "delete";
}

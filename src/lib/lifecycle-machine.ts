// ---------------------------------------------------------------------------
// lifecycle-machine.ts — pure state machine for document lifecycle (F3).
// State ACTIVE/VOID/DELETED.
//   Void   = reversed AND hidden from the GL (both legs hidden); the document
//            still appears in its own list (VOID badge, restorable). The
//            "trace" is the list entry, not the GL.
//   Delete = same GL hiding, but also removed from its list (Audit Log only).
//   Unvoid = back to active (reversal hidden, original shown).
// Both void and delete keep the document OUT of the GL — they differ only in
// list visibility (owner clarification 2026-06-19). hidden flags are non-hashed
// ledger metadata; the reversal entry is created once and thereafter only its
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
    case "VOID": return { original: 1, reversal: 1 };
    case "DELETED": return { original: 1, reversal: 1 };
  }
}

export function needsReversal(action: LifecycleAction): boolean {
  return action === "void" || action === "delete";
}

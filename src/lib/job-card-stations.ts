// ---------------------------------------------------------------------------
// job-card-stations.ts — roll a production order's job cards up to one station
// per DEPARTMENT.
//
// Job cards are raised per COMPONENT, not per department: one sofa produces
// four Fabric Sewing cards and three Wood Cutting cards, so the raw list draws
// as ~20 near-identical tiles on the relationship map. Owner 2026-08-02:
// 「这个我哪里有那么多production呢 就分成8个部门就行了啊？」
//
// The department is the unit that carries meaning on a chain map — "3/4 done at
// Framing" is a fact an operator can act on; twenty tiles are wallpaper. The
// roll-up stays honest about what it merged (done/total is always shown when
// more than one card collapsed into a station), so nothing is hidden by it.
//
// Kept OUT of the component so it can be unit-tested as plain data.
// ---------------------------------------------------------------------------

export type NodeState = "linked" | "current" | "pending";

export type JobCard = {
  id: string;
  departmentCode?: string | null;
  departmentName?: string | null;
  sequence?: number | null;
  status?: string | null;
  completedDate?: string | null;
  pic1Name?: string | null;
  pic2Name?: string | null;
  estMinutes?: number | null;
  actualMinutes?: number | null;
};

export const JC_STATE: Record<string, NodeState> = {
  COMPLETED: "linked",
  TRANSFERRED: "linked",
  IN_PROGRESS: "current",
  PAUSED: "current",
  BLOCKED: "current",
  WAITING: "pending",
};

/** `WOOD_CUT` → `Wood Cut`. Last resort when no departmentName is on hand. */
export function prettyDept(code: string): string {
  return code
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export type Station = {
  code: string;
  name: string;
  seq: number;
  state: NodeState;
  /** How many job cards rolled up into this station. */
  total: number;
  done: number;
  /** Latest completion among the finished cards. */
  completedDate: string | null;
  who: string[];
  estMinutes: number;
  actualMinutes: number;
};

export function groupJobCardsByDept(cards: JobCard[]): Station[] {
  const byDept = new Map<string, Station>();
  for (const jc of cards) {
    const code = (jc.departmentCode || jc.departmentName || "—").trim();
    const seq = Number(jc.sequence) || 0;
    let s = byDept.get(code);
    if (!s) {
      s = {
        code,
        name: jc.departmentName || prettyDept(code),
        seq,
        state: "pending",
        total: 0,
        done: 0,
        completedDate: null,
        who: [],
        estMinutes: 0,
        actualMinutes: 0,
      };
      byDept.set(code, s);
    }
    // The station sits where its EARLIEST card sits in the route.
    if (seq > 0 && (s.seq === 0 || seq < s.seq)) s.seq = seq;
    const st = JC_STATE[(jc.status ?? "").toUpperCase()] ?? "pending";
    s.total += 1;
    if (st === "linked") {
      s.done += 1;
      const d = jc.completedDate || null;
      if (d && (!s.completedDate || d > s.completedDate)) s.completedDate = d;
    }
    if (st === "current") s.state = "current";
    for (const n of [jc.pic1Name, jc.pic2Name]) {
      if (n && !s.who.includes(n)) s.who.push(n);
    }
    s.estMinutes += Number(jc.estMinutes) || 0;
    s.actualMinutes += Number(jc.actualMinutes) || 0;
  }
  const out = [...byDept.values()];
  for (const s of out) {
    // A card in progress anywhere wins. Otherwise the station is done only when
    // EVERY card is done — a part-finished station must never read as green,
    // which is the whole point of「好了就亮灯」.
    if (s.state === "current") continue;
    if (s.done === s.total) s.state = "linked";
    else if (s.done > 0) s.state = "current";
  }
  return out.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
}

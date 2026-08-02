// ---------------------------------------------------------------------------
// Org chart — the whole company on one board, factory floor included.
//
// The existing chart was drawn from `users` alone, which is ten people; the
// other forty-two work on the floor and live in `workers` with no account
// (owner 2026-08-01: 「要的」). This reads /api/org-chart, which returns both
// tables as one list keyed by (source, id), so a Fab Cut operator and the
// Production Manager sit on the same board and an edge can run between them.
//
// Laid out like the Houzs board the owner asked for: one column per department,
// reporting lines nested inside it, collapsible, zoomable. Every worker is in
// Production — their production sub-department is a costing dimension, not a
// reporting line.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Network, Minus, Plus, Users, Pencil } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { buildOrgTree, countSubtree, type OrgNode, type OrgPerson } from "@/lib/org-people";

/**
 * Fallback column order, used only until the server's department list arrives
 * (and if that read ever fails).
 *
 * The server now ships the real `departments` table with the people, so a
 * department added in Settings appears here under its own NAME in its own
 * position — it does not need adding to this array (owner 2026-08-02:
 * 「无论是有新添加的人或者部门…这整个东西就会做出来」). Anything still
 * unrecognised falls to the end, before Unassigned.
 */
const DEPT_ORDER_FALLBACK = [
  "Management",
  "Production",
  "R&D",
  "QA",
  "Sales",
  "Office",
  "Finance",
  "HR",
  "Others",
];

const UNASSIGNED = "Unassigned";

/** One stripe colour per department box, so neighbours are told apart. */
const ACCENTS = ["#6B5C32", "#3E6570", "#2F6E62", "#8A5A6B", "#5A6B8A", "#8A7A3E"];

type DeptMeta = { code: string; name: string; sequence: number };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function deptOf(p: OrgPerson): string {
  const d = (p.departmentCode || "").trim();
  return d || UNASSIGNED;
}

type Props = {
  /** Editing the reporting line needs users:update; read-only otherwise. */
  canManage: boolean;
};

export function OrgChart({ canManage }: Props) {
  const { data, loading, refresh } = useCachedJson<{
    data?: OrgPerson[];
    departments?: DeptMeta[];
  }>("/api/org-chart");
  const people = useMemo(() => data?.data ?? [], [data]);

  // The live departments table. A department created in Settings arrives here
  // on the next load — no code change, no entry in any list.
  const deptMeta = useMemo(() => {
    const m = new Map<string, DeptMeta>();
    for (const d of data?.departments ?? []) m.set(d.code, d);
    return m;
  }, [data]);

  const deptLabel = useCallback(
    (code: string) => (code === UNASSIGNED ? code : deptMeta.get(code)?.name ?? code),
    [deptMeta],
  );

  const deptRank = useCallback(
    (code: string) => {
      if (code === UNASSIGNED) return Number.MAX_SAFE_INTEGER;
      const seq = deptMeta.get(code)?.sequence;
      if (typeof seq === "number") return seq;
      // Not in the table (an office user's free-text department, or the list
      // failed to load) — keep the old ordering, then anything else.
      const i = DEPT_ORDER_FALLBACK.indexOf(code);
      return i >= 0 ? 10_000 + i : 20_000;
    },
    [deptMeta],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(100);
  const [showInactive, setShowInactive] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which card has its reporting-line picker open. */
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * Two views, because the owner asked for two different things and they are
   * genuinely different questions.
   *
   *   TREE  — "who reports to whom", drawn like the textbook chart they sent:
   *           one box per person, levels stacked, connected by hairlines.
   *   BOARD — "who is in which department", grouped by department then position.
   *
   * The board cannot show rank (its cards only NAME their upline) and the tree
   * cannot show a department at a glance. Neither is a worse version of the
   * other, so both stay.
   */
  const [view, setView] = useState<"tree" | "board">("tree");

  const visible = useMemo(
    () => (showInactive ? people : people.filter((p) => p.active)),
    [people, showInactive],
  );
  // ─── The board ───────────────────────────────────────────────────────────
  //
  // Owner 2026-08-02:「你那个设计很丑,我要像这样子的 Org Chart」, with the
  // Houzs board attached. The first version drew a left-indented list of the
  // reporting tree, which had two problems: it looks like a directory, and the
  // moment everyone actually reports to one person it collapses into a single
  // 44-deep column.
  //
  // So the BOARD groups by DEPARTMENT, and inside each department by POSITION —
  // exactly what Houzs do (their `HELPER` / `DRIVER` / `STOREKEEPER` strips are
  // position labels inside one department box, not reporting lines). The
  // reporting line is edited on the card and drawn nowhere: a box is a grouping,
  // a line is a relationship, and mixing them is what made the old one unusable.
  const board = useMemo(() => {
    const byDept = new Map<string, OrgPerson[]>();
    for (const p of visible) {
      const d = deptOf(p);
      const arr = byDept.get(d);
      if (arr) arr.push(p);
      else byDept.set(d, [p]);
    }
    // Leaders lead. Anything with leader/head/manager/supervisor in its title
    // sorts to the top of its box so the person in charge is the first card.
    const posRank = (pos: string) =>
      /head|manager/i.test(pos) ? 0 : /leader|supervisor/i.test(pos) ? 1 : 2;
    return [...byDept.entries()]
      .map(([dept, ppl]) => {
        const byPos = new Map<string, OrgPerson[]>();
        for (const p of ppl) {
          const pos = (p.position || "").trim() || "—";
          const arr = byPos.get(pos);
          if (arr) arr.push(p);
          else byPos.set(pos, [p]);
        }
        const groups = [...byPos.entries()]
          .map(([position, members]) => ({
            position,
            members: [...members].sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .sort(
            (a, b) =>
              posRank(a.position) - posRank(b.position) ||
              a.position.localeCompare(b.position),
          );
        return { dept, label: deptLabel(dept), count: ppl.length, groups };
      })
      .sort(
        (a, b) => deptRank(a.dept) - deptRank(b.dept) || a.label.localeCompare(b.label),
      );
  }, [visible, deptLabel, deptRank]);

  const totalOnChart = useMemo(
    () => board.reduce((s, c) => s + c.count, 0),
    [board],
  );

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setManager = useCallback(
    async (personKey: string, managerKey: string) => {
      setSaving(personKey);
      setError(null);
      try {
        const res = await fetch("/api/org-chart/reporting", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personKey, managerKey }),
        });
        const body = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || !body.success) {
          // The server refuses a loop; surface its words rather than a generic
          // failure, because "that would create a loop" is actionable.
          setError(body.error || `Could not save (HTTP ${res.status})`);
          return;
        }
        invalidateCachePrefix("/api/org-chart");
        refresh();
      } catch {
        setError("Could not reach the server.");
      } finally {
        setSaving(null);
      }
    },
    [refresh],
  );

  // Who this person may report to: everyone except themselves and anyone who
  // already reports up through them — choosing one of those is exactly the loop
  // the server rejects, so it is not offered.
  const descendantsOf = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const p of visible) {
      if (!p.managerKey) continue;
      const arr = kids.get(p.managerKey);
      if (arr) arr.push(p.key);
      else kids.set(p.managerKey, [p.key]);
    }
    return (key: string) => {
      const out = new Set<string>([key]);
      const stack = [key];
      while (stack.length) {
        for (const c of kids.get(stack.pop()!) ?? []) {
          if (out.has(c)) continue;
          out.add(c);
          stack.push(c);
        }
      }
      return out;
    };
  }, [visible]);

  const managerName = useCallback(
    (key: string | null) => visible.find((p) => p.key === key)?.name ?? null,
    [visible],
  );

  // The reporting forest. Anyone whose manager is filtered out becomes a root
  // rather than disappearing — a chart that hides people is worse than one with
  // an extra root.
  const forest = useMemo(() => buildOrgTree(visible), [visible]);

  // A pure top-down chart is as wide as its widest fan-out, and this one has a
  // Production Head with fourteen direct reports — so the first paint was a
  // canvas several screens across, opened somewhere in the middle, with the
  // root off-screen. Useless as a first impression of the hierarchy.
  //
  // So a WIDE node starts folded: you land on
  //   owner → Violet → Production Head → three leaders + the unled
  // which is the shape the owner described (「第一个、第二个、第三个、第四个」),
  // and a click opens any team. Done once, keyed on the data, so it does not
  // fight the operator every time the list refreshes.
  const [autoFolded, setAutoFolded] = useState("");
  useEffect(() => {
    const sig = `${forest.length}:${visible.length}`;
    if (!forest.length || autoFolded === sig) return;
    const wide = new Set<string>();
    const walk = (n: OrgNode) => {
      if (n.children.length > 14) wide.add(n.key);
      n.children.forEach(walk);
    };
    forest.forEach(walk);
    setAutoFolded(sig);
    if (wide.size) setCollapsed((prev) => new Set([...prev, ...wide]));
  }, [forest, visible.length, autoFolded]);

  const TreeCard = ({ node }: { node: OrgNode }) => {
    const open = editing === node.key;
    const kids = node.children.length;
    const shut = collapsed.has(node.key);
    return (
      <div className="relative">
        <div
          className={`w-[176px] rounded-md border px-2 py-1.5 ${
            node.active ? "border-[#E2DDD8] bg-white" : "border-dashed border-[#D8D2CC] bg-white opacity-60"
          }`}
        >
          {/* The tree cards had no avatar while the department board's did, so
              the same person looked like two different things depending on the
              view. Owner 2026-08-02:「他们的头像啊,好像没有」— Houzs put a face
              on every card, and a face is what makes a row of boxes read as
              people. Initials until there is somewhere to store a photo. */}
          <div className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                node.source === "worker"
                  ? "bg-[#F0ECE9] text-[#6B5C32]"
                  : "bg-[#E0EDF0] text-[#3E6570]"
              }`}
              title={node.source === "worker" ? "Factory employee" : "Office account"}
            >
              {initials(node.name)}
            </span>
            <div className="min-w-0 flex-1 text-left">
              <div className="truncate text-[11px] font-semibold uppercase leading-tight text-[#1F1D1B]">
                {node.name}
              </div>
              <div className="truncate text-[10px] text-[#8A8577]">
                {node.position || node.departmentCode || "—"}
              </div>
            </div>
          </div>
          {canManage && (
            <button
              type="button"
              onClick={() => setEditing(open ? null : node.key)}
              className="absolute right-1 top-1 text-[#C2BDB6] hover:text-[#6B5C32]"
              aria-label={`Change who ${node.name} reports to`}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {canManage && open && (
            <select
              autoFocus
              value={node.managerKey ?? ""}
              disabled={saving === node.key}
              onChange={(e) => {
                setEditing(null);
                void setManager(node.key, e.target.value);
              }}
              onBlur={() => setEditing(null)}
              className="mt-1 h-6 w-full rounded border border-[#E2DDD8] bg-[#FBFAF8] px-1 text-[10px] text-[#6B7280]"
            >
              <option value="">— no manager (top) —</option>
              {(() => {
                const banned = descendantsOf(node.key);
                return visible
                  .filter((c) => !banned.has(c.key))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                      {c.position ? ` · ${c.position}` : ""}
                    </option>
                  ));
              })()}
            </select>
          )}
        </div>
        {kids > 0 && (
          <button
            type="button"
            onClick={() => toggle(node.key)}
            aria-label={shut ? `Show ${kids} report(s)` : "Hide reports"}
            className="absolute -bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[#E2DDD8] bg-white px-1 text-[9px] font-semibold text-[#6B5C32]"
          >
            {shut ? `+${countSubtree(node) - 1}` : "–"}
          </button>
        )}
      </div>
    );
  };

  /** Everyone at or below a node, flattened. */
  const flatten = useCallback((n: OrgNode): OrgNode[] => {
    const out: OrgNode[] = [n];
    for (const c of n.children) out.push(...flatten(c));
    return out;
  }, []);

  /**
   * The subtree below a node, as DEPARTMENT BOXES rather than more branches.
   *
   * Owner 2026-08-02:「两个 leader…他们应该合在一起,两个 leader 共同带剩下的
   * 人才对」and「为什么这里没有分部门呢?正常的 HouzsERP 里是有看到部门划分的」.
   *
   * Houzs's chart does not express co-management with lines either — their model
   * is a single manager_id, same as ours. What their board does is stop drawing
   * the tree and switch to a DEPARTMENT BOX: the leaders sit at the top of the
   * box, the team sits under a position label, and NO line divides the team
   * between the leaders. Belonging is expressed by being in the same box.
   *
   * That is the right answer here too, because a line per leader is exactly the
   * distinction the owner does not want drawn: two Operator Leaders both cover
   * Upholstery and Framing, and splitting the seventeen between them was an
   * invention of the layout, not a fact about the factory.
   */
  /**
   * Is this person a manager OF MANAGERS?
   *
   * The switch from branches to boxes has to happen at the LAST management
   * level and not one above it. The first cut fired as soon as a subtree merely
   * CONTAINED a manager, so at the owner's level it swallowed Violet and the
   * Production Head into the boxes as ordinary cards and the whole management
   * chain vanished — owner 2026-08-02:「整个 Production 的上司不是一个叫 Lim
   * 的吗?然后 Lim 的上司不是叫 Violet 吗?为什么没看到这条线啊?」
   *
   * Someone whose own reports also have reports keeps their branch. Someone
   * whose reports are the shop floor folds into a box with them.
   */
  const leadsManagers = useCallback(
    (n: OrgNode) => n.children.some((c) => c.children.length > 0),
    [],
  );

  /**
   * The teams below a node, as boxes.
   *
   * Keyed by LEADER, not by department — owner:「Fabric Cutting 还有 Fabric
   * Sewing 应该都是 under 一个部门…让这个 operator leader 来 leading 这两个部门」.
   * ANN runs both Fabric Cutting and Fabric Sewing, so splitting her team into
   * two boxes drew a division that does not exist. One leader, one box, titled
   * with every department it covers.
   *
   * Two leaders on the same team share one box and NO line divides their people
   * between them — that is how Houzs express co-management, and their model is
   * a single manager_id exactly like ours.
   */
  const boxesUnder = useCallback(
    (node: OrgNode) => {
      const isLeader = (p: OrgNode) =>
        /leader|head|manager|supervisor/i.test(p.position ?? "");
      const boxes: {
        key: string;
        label: string;
        count: number;
        leads: OrgNode[];
        groups: { position: string; members: OrgNode[] }[];
      }[] = [];

      const build = (leads: OrgNode[], team: OrgNode[], fallbackKey: string) => {
        const depts = [...new Set([...leads, ...team].map(deptOf))].sort(
          (a, b) => deptRank(a) - deptRank(b),
        );
        const byPos = new Map<string, OrgNode[]>();
        for (const p of team) {
          const pos = (p.position || "").trim() || "—";
          const arr = byPos.get(pos);
          if (arr) arr.push(p);
          else byPos.set(pos, [p]);
        }
        boxes.push({
          key: leads[0]?.key ?? fallbackKey,
          label: depts.map(deptLabel).join(" + "),
          count: leads.length + team.length,
          leads,
          groups: [...byPos.entries()]
            .map(([position, members]) => ({
              position,
              members: [...members].sort((a, b) => a.name.localeCompare(b.name)),
            }))
            .sort((a, b) => a.position.localeCompare(b.position)),
        });
      };

      // A child WITH reports is a team: that person (plus any co-leader on the
      // same departments) heads one box.
      const teamLeads = node.children.filter((c) => c.children.length > 0);
      const used = new Set<string>();
      for (const lead of teamLeads) {
        if (used.has(lead.key)) continue;
        const myDepts = new Set(lead.children.map(deptOf).concat(deptOf(lead)));
        // A co-leader is another team lead covering the SAME departments.
        const co = teamLeads.filter(
          (o) =>
            !used.has(o.key) &&
            o.key !== lead.key &&
            [...new Set(o.children.map(deptOf).concat(deptOf(o)))].some((d) =>
              myDepts.has(d),
            ),
        );
        const leads = [lead, ...co].sort((a, b) => a.name.localeCompare(b.name));
        leads.forEach((l) => used.add(l.key));
        build(leads, leads.flatMap((l) => l.children.flatMap(flatten)), lead.key);
      }

      // Everyone reporting straight to this node with nobody under them —
      // grouped by department, because they have no leader to group by.
      const loose = node.children.filter((c) => c.children.length === 0);
      const byDept = new Map<string, OrgNode[]>();
      for (const p of loose) {
        const d = deptOf(p);
        const arr = byDept.get(d);
        if (arr) arr.push(p);
        else byDept.set(d, [p]);
      }
      for (const [dept, ppl] of byDept) {
        build(ppl.filter(isLeader), ppl.filter((p) => !isLeader(p)), dept);
      }

      return boxes.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    },
    [flatten, deptLabel, deptRank],
  );

  const Branch = ({ node }: { node: OrgNode }): React.ReactElement => {
    const kids = collapsed.has(node.key) ? [] : node.children;
    return (
      <div className="flex flex-col items-center">
        <TreeCard node={node} />
        {kids.length > 0 && (
          <>
            {/* stem down from the parent */}
            <div className="h-5 w-px bg-[#C2BDB6]" />
            {/*
              MANY reports do not fan out sideways. Owner 2026-08-02:「如果很多
              下线她是怎么排的」— Houzs answer it by stopping the tree and
              dropping into a BOX whose cards stack vertically in columns. A
              Production Head with fourteen reports fanned horizontally is a
              canvas several screens wide; the same fourteen stacked three-up is
              one card tall and readable.

              The classic fan is kept for a SMALL number of children, because
              that is the shape that reads as an org chart. The switch is at
              four, and only when those children lead nobody themselves — a
              manager with a team of their own still deserves their own branch.
            */}
            {/* Below the last MANAGER the tree stops and department boxes take
                over — the Houzs shape. A branch is right where there are a few
                named relationships; forty operators fanned into hairlines is a
                wall of string. */}
            {/* A whole dark department box around ONE card reads as a heading
                with nothing under it — owner 2026-08-02, seeing Finance wrapped
                around a single person:「有点怪的感觉」. A box earns its chrome at
                two people; below that the plain branch says the same thing with
                less furniture. */}
            {node.children.length > 1 && !node.children.some(leadsManagers) ? (
              // NO flex `gap` on this row. The connector bus is drawn INSIDE
              // each child, so a gap leaves the line with a hole exactly where
              // the gap is — owner 2026-08-02:「那个线好像断掉那样?」. Padding on
              // the child gives the same spacing and keeps the bus continuous,
              // which is what the person-level branch already did.
              <div className="flex items-start">
                {boxesUnder(node).map((box, bi) => (
                  <div key={box.key} className="relative flex flex-col items-center px-1.5">
                    {boxesUnder(node).length > 1 && (
                      <span
                        aria-hidden
                        className="absolute top-0 h-px bg-[#C2BDB6]"
                        style={{
                          left: bi === 0 ? "50%" : 0,
                          right: bi === boxesUnder(node).length - 1 ? "50%" : 0,
                        }}
                      />
                    )}
                    <div className="h-5 w-px bg-[#C2BDB6]" />
                    <div className="overflow-hidden rounded-lg border border-[#E2DDD8] bg-white">
                      <div className="flex items-center gap-2 bg-[#33404E] px-3 py-1.5 text-white">
                        <span
                          aria-hidden
                          className="h-3.5 w-1 rounded-full"
                          style={{ background: ACCENTS[bi % ACCENTS.length] }}
                        />
                        <span className="text-[11px] font-semibold uppercase tracking-wide">
                          {box.label}
                        </span>
                        <span className="ml-auto flex items-center gap-1 text-[11px] opacity-75">
                          <Users className="h-3 w-3" />
                          {box.count}
                        </span>
                      </div>
                      {box.leads.length > 0 && (
                        <div className="border-b border-[#EFEAE5] bg-[#FBFAF8] px-2 py-2">
                          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                            {box.leads.length > 1
                              ? `Led together by ${box.leads.length}`
                              : "Leader"}
                          </div>
                          <div className="flex gap-1.5">
                            {box.leads.map((l) => (
                              <TreeCard key={l.key} node={l} />
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="space-y-2 p-2">
                        {box.groups.map((g) => (
                          <div key={g.position}>
                            <div className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                              {g.position}
                              <span className="text-[#C2BDB6]">{g.members.length}</span>
                            </div>
                            <div className="flex flex-col gap-1.5">
                              {g.members.map((m) => (
                                <TreeCard key={m.key} node={m} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : kids.length > 4 && kids.every((c) => c.children.length === 0) ? (
              <div className="rounded-lg border border-[#E2DDD8] bg-[#FBFAF8] p-2">
                <div
                  className="grid gap-1.5"
                  style={{
                    gridTemplateColumns: `repeat(${Math.min(4, Math.ceil(kids.length / 4))}, minmax(0, 1fr))`,
                  }}
                >
                  {kids.map((c) => (
                    <TreeCard key={c.key} node={c} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-center">
                {kids.map((c, i) => (
                  <div key={c.key} className="relative flex flex-col items-center px-2">
                    {/* the bus across the siblings, half-width at each end so it
                        stops at the outermost child instead of hanging in air */}
                    {kids.length > 1 && (
                      <span
                        aria-hidden
                        className="absolute top-0 h-px bg-[#C2BDB6]"
                        style={{
                          left: i === 0 ? "50%" : 0,
                          right: i === kids.length - 1 ? "50%" : 0,
                        }}
                      />
                    )}
                    <div className="h-5 w-px bg-[#C2BDB6]" />
                    <Branch node={c} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  if (loading && people.length === 0) {
    return <div className="p-6 text-center text-sm text-[#9CA3AF]">Loading org chart…</div>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[#6B7280]">
          <Network className="h-4 w-4 text-[#6B5C32]" />
          <span className="font-semibold text-[#1F1D1B]">{totalOnChart}</span> people on the
          chart
          <span className="text-[#9CA3AF]">
            · office accounts and factory employees together
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-[#E2DDD8]">
            {(["tree", "board"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-2 py-1 text-[11px] capitalize ${
                  view === v ? "bg-[#6B5C32] text-white" : "text-[#6B7280] hover:text-[#1F1D1B]"
                }`}
              >
                {v === "tree" ? "Hierarchy" : "Departments"}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-[11px] text-[#6B7280]">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <button
            type="button"
            onClick={() => setCollapsed(new Set(board.map((b) => b.dept)))}
            className="rounded border border-[#E2DDD8] px-2 py-1 text-[11px] text-[#6B7280] hover:text-[#1F1D1B]"
          >
            Collapse all
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(new Set())}
            className="rounded border border-[#E2DDD8] px-2 py-1 text-[11px] text-[#6B7280] hover:text-[#1F1D1B]"
          >
            Expand all
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(50, z - 10))}
              className="rounded border border-[#E2DDD8] p-1 text-[#6B7280] hover:text-[#1F1D1B]"
              aria-label="Zoom out"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="w-10 text-center text-[11px] text-[#6B7280]">{zoom}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(150, z + 10))}
              className="rounded border border-[#E2DDD8] p-1 text-[#6B7280] hover:text-[#1F1D1B]"
              aria-label="Zoom in"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-[#E8AFA4] bg-[#FBE9E5] px-3 py-2 text-[12px] text-[#7E251A]">
          {error}
        </div>
      )}

      {/* Boxes sit side by side and the BOARD scrolls, not the page — a
          department with forty people must not push the next one off-screen. */}
      <div className="overflow-x-auto pb-4">
        <div
          style={{ zoom: `${zoom}%` }}
          className="flex min-w-max items-start gap-3"
        >
          {view === "tree" && (
            <div className="mx-auto flex min-w-max items-start justify-center gap-8 px-4 pt-2">
              {forest.map((r) => (
                <Branch key={r.key} node={r} />
              ))}
              {forest.length === 0 && (
                <div className="py-10 text-sm text-[#9CA3AF]">Nobody on the chart yet.</div>
              )}
            </div>
          )}
          {view === "board" && board.map((box, boxIdx) => {
            const isShut = collapsed.has(box.dept);
            const accent = ACCENTS[boxIdx % ACCENTS.length];
            return (
              <div
                key={box.dept}
                className="overflow-hidden rounded-lg border border-[#E2DDD8] bg-white"
              >
                {/* Dark cap + a colour stripe per department, so two boxes side
                    by side are told apart at a glance. Houzs's move. */}
                <button
                  type="button"
                  onClick={() => toggle(box.dept)}
                  className="flex w-full items-center gap-2 bg-[#33404E] px-3 py-2 text-left text-white"
                >
                  <span
                    aria-hidden
                    className="h-4 w-1 rounded-full"
                    style={{ background: accent }}
                  />
                  {isShut ? (
                    <ChevronRight className="h-3.5 w-3.5 opacity-80" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 opacity-80" />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wide">
                    {box.label}
                  </span>
                  <span className="ml-auto flex items-center gap-1 text-[11px] opacity-75">
                    <Users className="h-3 w-3" />
                    {box.count}
                  </span>
                </button>

                {!isShut && (
                  <div className="flex items-start gap-5 p-3">
                    {box.groups.map((g) => (
                      <div key={g.position}>
                        {/* Position strip — the grouping INSIDE a department,
                            the same role Houzs's HELPER / DRIVER labels play. */}
                        <div className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                          {g.position}
                          <span className="text-[#C2BDB6]">{g.members.length}</span>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {g.members.map((p) => {
                            const open = editing === p.key;
                            return (
                              <div
                                key={p.key}
                                className={`relative w-[178px] rounded-md border bg-white px-2 py-1.5 ${
                                  p.active
                                    ? "border-[#E2DDD8]"
                                    : "border-dashed border-[#D8D2CC] opacity-60"
                                }`}
                              >
                                <div className="flex items-start gap-2">
                                  <span
                                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                                      p.source === "worker"
                                        ? "bg-[#F0ECE9] text-[#6B5C32]"
                                        : "bg-[#E0EDF0] text-[#3E6570]"
                                    }`}
                                    title={
                                      p.source === "worker"
                                        ? "Factory employee"
                                        : "Office account"
                                    }
                                  >
                                    {initials(p.name)}
                                  </span>
                                  <div className="min-w-0 flex-1 pr-4">
                                    <div className="truncate text-[11px] font-semibold uppercase leading-tight text-[#1F1D1B]">
                                      {p.name}
                                    </div>
                                    <div className="truncate text-[10px] text-[#8A8577]">
                                      {p.position || "—"}
                                    </div>
                                    {/* Who they report to, in words. The old
                                        chart drew this as nesting; a name is
                                        shorter and survives everyone reporting
                                        to one person. */}
                                    {p.managerKey && (
                                      <div className="truncate text-[10px] text-[#9CA3AF]">
                                        ↳ {managerName(p.managerKey) ?? "—"}
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {canManage && (
                                  <button
                                    type="button"
                                    onClick={() => setEditing(open ? null : p.key)}
                                    className="absolute right-1 top-1 text-[#C2BDB6] hover:text-[#6B5C32]"
                                    aria-label={`Change who ${p.name} reports to`}
                                    title="Change who this person reports to"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                )}

                                {canManage && open && (
                                  <select
                                    autoFocus
                                    value={p.managerKey ?? ""}
                                    disabled={saving === p.key}
                                    onChange={(e) => {
                                      setEditing(null);
                                      void setManager(p.key, e.target.value);
                                    }}
                                    onBlur={() => setEditing(null)}
                                    className="mt-1.5 h-6 w-full rounded border border-[#E2DDD8] bg-[#FBFAF8] px-1 text-[10px] text-[#6B7280]"
                                  >
                                    <option value="">— no manager (top) —</option>
                                    {(() => {
                                      const banned = descendantsOf(p.key);
                                      return visible
                                        .filter((c) => !banned.has(c.key))
                                        .sort((a, b) => a.name.localeCompare(b.name))
                                        .map((c) => (
                                          <option key={c.key} value={c.key}>
                                            {c.name}
                                            {c.position ? ` · ${c.position}` : ""}
                                          </option>
                                        ));
                                    })()}
                                  </select>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {board.length === 0 && (
            <div className="py-10 text-center text-sm text-[#9CA3AF]">
              Nobody on the chart yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

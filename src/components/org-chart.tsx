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
import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Network, Minus, Plus, Users } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { buildOrgTree, countSubtree, type OrgNode, type OrgPerson } from "@/lib/org-people";

/** Column order. Anything unrecognised falls to the end, before Unassigned. */
const DEPT_ORDER = [
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

function deptRank(d: string): number {
  const i = DEPT_ORDER.indexOf(d);
  if (i >= 0) return i;
  return d === UNASSIGNED ? DEPT_ORDER.length + 1 : DEPT_ORDER.length;
}

type Props = {
  /** Editing the reporting line needs users:update; read-only otherwise. */
  canManage: boolean;
};

export function OrgChart({ canManage }: Props) {
  const { data, loading, refresh } = useCachedJson<{ data?: OrgPerson[] }>(
    "/api/org-chart",
  );
  const people = useMemo(() => data?.data ?? [], [data]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(100);
  const [showInactive, setShowInactive] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () => (showInactive ? people : people.filter((p) => p.active)),
    [people, showInactive],
  );

  // One tree per department. A person's manager may sit in ANOTHER department
  // (a Fab Cut operator under the Production Manager, an office lead under the
  // GM) — that edge is real, so the tree is built ONCE across everyone and the
  // columns then take whichever roots fall to them. Building per-column instead
  // would silently re-root anyone whose manager is elsewhere.
  const columns = useMemo(() => {
    const roots = buildOrgTree(visible);
    const byDept = new Map<string, OrgNode[]>();
    const push = (d: string, n: OrgNode) => {
      const arr = byDept.get(d) ?? [];
      arr.push(n);
      byDept.set(d, arr);
    };
    for (const r of roots) push(deptOf(r), r);
    return [...byDept.entries()]
      .map(([dept, nodes]) => ({
        dept,
        nodes,
        headcount: nodes.reduce((s, n) => s + countSubtree(n), 0),
      }))
      .sort((a, b) => deptRank(a.dept) - deptRank(b.dept) || a.dept.localeCompare(b.dept));
  }, [visible]);

  const totalOnChart = useMemo(
    () => columns.reduce((s, c) => s + c.headcount, 0),
    [columns],
  );

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    // Only nodes that HAVE children are worth collapsing.
    const withKids = new Set<string>();
    const walk = (n: OrgNode) => {
      if (n.children.length) withKids.add(n.key);
      n.children.forEach(walk);
    };
    columns.forEach((c) => c.nodes.forEach(walk));
    setCollapsed(withKids);
  }, [columns]);

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

  // Manager picker options — everyone on the chart except the person and their
  // own descendants (choosing one of those is exactly the loop the server
  // rejects, so it should not be offered in the first place).
  const pickerFor = useCallback(
    (node: OrgNode) => {
      const banned = new Set<string>([node.key]);
      const mark = (n: OrgNode) => {
        banned.add(n.key);
        n.children.forEach(mark);
      };
      mark(node);
      return visible
        .filter((p) => !banned.has(p.key))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    [visible],
  );

  const renderNode = (node: OrgNode, depth: number) => {
    const isCollapsed = collapsed.has(node.key);
    const kids = node.children.length;
    return (
      <div key={node.key} style={{ marginLeft: depth === 0 ? 0 : 14 }}>
        <div
          className={`mb-1.5 rounded-md border bg-white px-2 py-1.5 ${
            node.active ? "border-[#E2DDD8]" : "border-dashed border-[#D8D2CC] opacity-60"
          }`}
        >
          <div className="flex items-start gap-2">
            {kids > 0 ? (
              <button
                type="button"
                onClick={() => toggle(node.key)}
                className="mt-0.5 text-[#9CA3AF] hover:text-[#6B5C32]"
                title={isCollapsed ? `Show ${kids} report(s)` : "Hide reports"}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              <span className="mt-0.5 inline-block h-3.5 w-3.5" />
            )}
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
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-[#1F1D1B]">
                {node.name}
              </div>
              <div className="truncate text-[10px] text-[#6B7280]">
                {node.position || "—"}
                {node.ref ? ` · ${node.ref}` : ""}
              </div>
              {canManage && (
                <select
                  value={node.managerKey ?? ""}
                  disabled={saving === node.key}
                  onChange={(e) => setManager(node.key, e.target.value)}
                  className="mt-1 h-6 w-full rounded border border-[#E2DDD8] bg-[#FBFAF8] px-1 text-[10px] text-[#6B7280]"
                  title="Who this person reports to"
                >
                  <option value="">— no manager (top) —</option>
                  {pickerFor(node).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                      {p.position ? ` · ${p.position}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {kids > 0 && isCollapsed && (
              <span className="mt-0.5 rounded-full bg-[#F0ECE9] px-1.5 text-[10px] font-semibold text-[#6B5C32]">
                +{countSubtree(node) - 1}
              </span>
            )}
          </div>
        </div>
        {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
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
          <span className="font-semibold text-[#1F1D1B]">{totalOnChart}</span> people on the chart
          <span className="text-[#9CA3AF]">
            · office accounts and factory employees together
          </span>
        </div>
        <div className="flex items-center gap-2">
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
            onClick={collapseAll}
            className="rounded border border-[#D8D2CC] px-2 py-1 text-[11px] hover:bg-[#F0ECE9]"
          >
            Collapse all
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(new Set())}
            className="rounded border border-[#D8D2CC] px-2 py-1 text-[11px] hover:bg-[#F0ECE9]"
          >
            Expand all
          </button>
          <div className="flex items-center gap-1 rounded border border-[#D8D2CC] px-1">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(50, z - 10))}
              className="p-1 text-[#6B7280] hover:text-[#1F1D1B]"
              title="Zoom out"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="w-9 text-center text-[11px] tabular-nums">{zoom}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(130, z + 10))}
              className="p-1 text-[#6B7280] hover:text-[#1F1D1B]"
              title="Zoom in"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-[#E8C4BE] bg-[#FBEAE7] px-3 py-2 text-xs text-[#9A3A2D]">
          {error}
        </div>
      )}

      {columns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#D8D2CC] p-8 text-center text-sm text-[#9CA3AF]">
          Nobody on the chart yet.
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div
            className="flex items-start gap-3"
            style={{
              zoom: zoom / 100,
              // `zoom` keeps hit-testing aligned with what is drawn; a CSS
              // transform would offset every click by the scale factor.
            }}
          >
            {columns.map((col) => (
              <div
                key={col.dept}
                className="w-[260px] shrink-0 rounded-lg border border-[#E5E7EB] bg-[#FBFAF8] p-2"
              >
                <div className="mb-2 flex items-center justify-between border-b border-[#E2DDD8] pb-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#6B5C32]">
                    {col.dept}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-[#9CA3AF]">
                    <Users className="h-3 w-3" />
                    {col.headcount}
                  </span>
                </div>
                {col.nodes.map((n) => renderNode(n, 0))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default OrgChart;

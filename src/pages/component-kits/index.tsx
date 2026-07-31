// ---------------------------------------------------------------------------
// Component Kits — reusable sub-BOMs (owner 2026-07-31).
//
// A pushback mechanism, or a set of legs, always needs certain screws. Instead
// of re-listing those screws in every product BOM that uses the mechanism, bind
// them ONCE here against the mechanism's own SKU. Every product BOM that
// references that SKU then auto-explodes the screws into consumption / costing
// — the owner never has to remember them again. (Backend: component-bom.ts +
// po-cost-cascade.ts explodeKits.)
//
// This is the orthodox multi-level-BOM ("kit / phantom") approach: define the
// sub-BOM in one place, reuse it everywhere.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { humanizeError } from "@/lib/humanize-error";
import { MaterialPicker, type MaterialOption } from "@/components/material-picker";
import { Loader2, Plus, Trash2, Wrench, Package, ArrowRight } from "lucide-react";

type KitChild = {
  childCode: string;
  childName: string;
  qtyPer: number;
  wastePct: number;
};
type Kit = {
  parentCode: string;
  parentName: string;
  children: KitChild[];
};
type RawMaterial = { itemCode: string; description: string };

export default function ComponentKitsPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [kits, setKits] = useState<Kit[]>([]);
  const [catalog, setCatalog] = useState<RawMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Kit | null>(null);
  const [saving, setSaving] = useState(false);

  const options: MaterialOption[] = useMemo(
    () => catalog.map((m) => ({ itemCode: m.itemCode, description: m.description })),
    [catalog],
  );
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of catalog) m.set(r.itemCode, r.description);
    return m;
  }, [catalog]);

  async function reload() {
    setLoading(true);
    try {
      const [kRes, iRes] = await Promise.all([
        fetch("/api/component-boms").then((r) => r.json()) as Promise<{ success?: boolean; error?: string; data?: Kit[] }>,
        fetch("/api/inventory").then((r) => r.json()) as Promise<{ data?: { rawMaterials?: RawMaterial[] } }>,
      ]);
      // A failed list read used to fall through here silently, leaving the page
      // on its "No component kits yet" empty state — indistinguishable from a
      // genuinely empty list, which is exactly how the camelCase read bug in
      // component-bom.ts stayed invisible after a successful save. Fail loud.
      if (!kRes?.success) throw new Error(kRes?.error || "could not load kits");
      setKits(Array.isArray(kRes.data) ? kRes.data : []);
      const raw = (iRes?.data?.rawMaterials ?? []) as RawMaterial[];
      setCatalog(
        raw.map((m) => ({ itemCode: String(m.itemCode ?? ""), description: String(m.description ?? "") })),
      );
    } catch (e) {
      toast.error(`Failed to load kits: ${humanizeError(e)}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    // Initial data fetch on mount — reload() setStates once the async load
    // resolves (not synchronously in the effect body), which is the standard
    // fetch-on-mount pattern the rule's heuristic can't see through.
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    void reload();
  }, []);

  function startNew() {
    setEditing({ parentCode: "", parentName: "", children: [] });
  }
  function startEdit(kit: Kit) {
    // deep copy so cancel discards
    setEditing({ ...kit, children: kit.children.map((c) => ({ ...c })) });
  }

  async function save() {
    if (!editing) return;
    const code = editing.parentCode.trim();
    if (!code) {
      toast.error("Pick a parent SKU first");
      return;
    }
    const children = editing.children.filter((c) => c.childCode.trim() && c.qtyPer > 0);
    if (children.length === 0) {
      toast.error("Add at least one component with a quantity");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/component-boms/${encodeURIComponent(code)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentName: editing.parentName, children }),
      }).then((r) => r.json()) as { success?: boolean; error?: string };
      if (!res?.success) throw new Error(res?.error || "save failed");
      toast.success(`Kit saved — ${code} → ${children.length} component(s)`);
      setEditing(null);
      await reload();
    } catch (e) {
      toast.error(`Save failed: ${humanizeError(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(kit: Kit) {
    const ok = await confirm({
      title: "Delete this kit?",
      message: `${kit.parentCode} will no longer auto-add its components to BOMs.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/component-boms/${encodeURIComponent(kit.parentCode)}`, {
        method: "DELETE",
      }).then((r) => r.json()) as { success?: boolean; error?: string };
      if (!res?.success) throw new Error(res?.error || "delete failed");
      toast.success("Kit deleted");
      await reload();
    } catch (e) {
      toast.error(`Delete failed: ${humanizeError(e)}`);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Wrench className="h-6 w-6" /> Component Kits
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Bind a mechanism or leg SKU to the screws (or any parts) it always needs. Any product BOM
            that uses that SKU will <strong>auto-include these components</strong> in consumption and
            costing — you never have to list the screws in the BOM again.
          </p>
        </div>
        {!editing && (
          <Button onClick={startNew}>
            <Plus className="h-4 w-4 mr-1" /> New Kit
          </Button>
        )}
      </div>

      {editing && (
        <KitEditor
          kit={editing}
          options={options}
          nameByCode={nameByCode}
          saving={saving}
          onChange={setEditing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : kits.length === 0 && !editing ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No component kits yet. Click <strong>New Kit</strong> to bind a mechanism to its screws.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {kits.map((kit) => (
            <Card key={kit.parentCode}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  <span className="font-mono">{kit.parentCode}</span>
                  {kit.parentName && (
                    <span className="text-sm font-normal text-muted-foreground truncate">
                      {kit.parentName}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <ul className="text-sm space-y-1">
                  {kit.children.map((c, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="font-mono">{c.childCode}</span>
                      <span className="text-muted-foreground truncate flex-1">{c.childName}</span>
                      <span className="tabular-nums font-medium">×{c.qtyPer}</span>
                      {c.wastePct > 0 && (
                        <span className="text-xs text-muted-foreground">+{c.wastePct}% waste</span>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={() => startEdit(kit)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(kit)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function KitEditor({
  kit,
  options,
  nameByCode,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  kit: Kit;
  options: MaterialOption[];
  nameByCode: Map<string, string>;
  saving: boolean;
  onChange: (k: Kit) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  function setParent(code: string, name: string) {
    onChange({ ...kit, parentCode: code, parentName: name });
  }
  function addChild() {
    onChange({ ...kit, children: [...kit.children, { childCode: "", childName: "", qtyPer: 1, wastePct: 0 }] });
  }
  function setChild(i: number, patch: Partial<KitChild>) {
    onChange({ ...kit, children: kit.children.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  }
  function removeChild(i: number) {
    onChange({ ...kit, children: kit.children.filter((_, j) => j !== i) });
  }

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {kit.parentCode ? `Edit kit — ${kit.parentCode}` : "New kit"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-sm font-medium mb-1 block">
            Parent SKU (the mechanism / leg)
          </label>
          <div className="max-w-md">
            <MaterialPicker
              value={kit.parentCode}
              options={options}
              onPick={(o) => setParent(o.itemCode, o.description)}
              onTyped={(t) => setParent(t, nameByCode.get(t) ?? kit.parentName)}
              placeholder="Search the mechanism / leg code or name…"
            />
          </div>
          {kit.parentName && (
            <p className="text-xs text-muted-foreground mt-1">{kit.parentName}</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium">Required components (screws, etc.)</label>
            <Button size="sm" variant="outline" onClick={addChild}>
              <Plus className="h-4 w-4 mr-1" /> Add component
            </Button>
          </div>
          {kit.children.length === 0 ? (
            <p className="text-sm text-muted-foreground">No components yet — add the screws this SKU needs.</p>
          ) : (
            <div className="space-y-2">
              {kit.children.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <MaterialPicker
                      value={c.childCode}
                      options={options}
                      onPick={(o) => setChild(i, { childCode: o.itemCode, childName: o.description })}
                      onTyped={(t) => setChild(i, { childCode: t, childName: nameByCode.get(t) ?? c.childName })}
                      placeholder="Search the screw / part…"
                    />
                    {c.childName && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.childName}</p>
                    )}
                  </div>
                  <div className="w-24 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={c.qtyPer}
                      onChange={(e) => setChild(i, { qtyPer: Number(e.target.value) })}
                      placeholder="Qty"
                      aria-label="Quantity per parent"
                    />
                    <span className="text-[10px] text-muted-foreground">qty / parent</span>
                  </div>
                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={c.wastePct}
                      onChange={(e) => setChild(i, { wastePct: Number(e.target.value) })}
                      placeholder="0"
                      aria-label="Waste percent"
                    />
                    <span className="text-[10px] text-muted-foreground">% waste</span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeChild(i)} aria-label="Remove component">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save kit
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

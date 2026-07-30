// ---------------------------------------------------------------------------
// repair-scope.ts — single source of truth for the Service-Order "Repair
// Scope" feature (partial repairs instead of full remakes).
//
// A service order line may carry sales_order_items.repairscope (runtime-added
// column, folded lowercase — read it dual-key: row.repairScope ??
// row.repairscope). Stored value is a JSON string:
//
//   {"preset":"FULL"|"FABRIC"|"FRAME"|"FOAM"|"CUSTOM",
//    "depts":["FAB_CUT",...],
//    "components"?: [{"key":"<wipKey>","label":"8\" Divan- 6FT","qty":1}, ...]}
//
// or NULL (= FULL = no filtering, byte-identical to a normal order).
//
// `components` (Component-level Repair Scope) narrows the repair to specific
// top-level BOM WIP pieces — bedframe Headboard vs Divan, sofa base / seat
// cushion / back cushion / armrest / headrest. `key` is the deterministic
// wipKey from breakBomIntoWips (src/api/lib/bom-wip-breakdown.ts) — the same
// key the UPHOLSTERY-side job cards already group by. `qty` is the picked
// piece count (≤ the BOM's per-FG piece count; the builder/cascade clamp).
// ABSENT components = ALL components — byte-identical to a dept-only scope,
// so every pre-feature row keeps today's behaviour. When the operator leaves
// every component ticked at full BOM qty the field is OMITTED entirely
// (see canonicalizeComponentPicks).
//
// Consumers:
//   * src/api/routes/sales-orders.ts        — validate on POST/PUT writes
//   * src/api/routes/_shared/production-builder.ts
//        — filter each WIP's process chain + L1 processes to the scope's
//          depts; stamp the canonical scope onto production_orders.
//   * src/api/lib/po-cost-cascade.ts        — filter BOM material lines
//        before RM consumption (class-based for presets, branch-based
//        for CUSTOM — see materialLineInScope below).
//   * src/lib/delivery-pipeline.ts          — delivery-readiness fallback
//        for scoped POs whose scope excludes UPHOLSTERY.
//   * src/pages/sales/create.tsx            — per-line scope picker
//        (service-order mode only) + the same validator on Save.
//
// Frontend + backend MUST share this module so the Save handler and the
// POST/PUT endpoints reject identical inputs with identical errors.
// ---------------------------------------------------------------------------

// The 8 production department codes, in global chain order. Mirrors
// DEPT_ORDER in src/api/lib/lead-times.ts — duplicated here (with a
// structural test pinning equality) because this module is imported by
// frontend pages and must not pull in the API-side lead-time machinery.
export const REPAIR_DEPT_CODES = [
  "FAB_CUT",
  "FAB_SEW",
  "WOOD_CUT",
  "FOAM_CUTTING",
  "FOAM",
  "FRAMING",
  "WEBBING",
  "UPHOLSTERY",
  "PACKING",
] as const;
export type RepairDeptCode = (typeof REPAIR_DEPT_CODES)[number];

export const REPAIR_DEPT_LABELS: Record<RepairDeptCode, string> = {
  FAB_CUT: "Fabric Cutting",
  FAB_SEW: "Fabric Sewing",
  WOOD_CUT: "Wood Cutting",
  FOAM_CUTTING: "Foam Cutting",
  FOAM: "Foam",
  FRAMING: "Framing",
  WEBBING: "Webbing",
  UPHOLSTERY: "Upholstery",
  PACKING: "Packing",
};

export type RepairScopePreset = "FULL" | "FABRIC" | "FRAME" | "FOAM" | "CUSTOM";

// Owner-approved preset table (2026-06-11). FULL is represented as NULL in
// storage and as `null` after parsing — no filtering anywhere.
export const REPAIR_SCOPE_PRESET_DEPTS: Record<
  "FABRIC" | "FRAME" | "FOAM",
  readonly RepairDeptCode[]
> = {
  FABRIC: ["FAB_CUT", "FAB_SEW", "UPHOLSTERY", "PACKING"],
  FRAME: ["WOOD_CUT", "FRAMING", "UPHOLSTERY", "PACKING"],
  FOAM: ["FOAM", "UPHOLSTERY", "PACKING"],
};

export const REPAIR_SCOPE_PRESET_LABELS: Record<RepairScopePreset, string> = {
  FULL: "Full remake",
  FABRIC: "Fabric replacement",
  FRAME: "Frame repair",
  FOAM: "Foam replacement",
  CUSTOM: "Custom",
};

// One picked repair component — a top-level BOM WIP piece. `key` is the
// breakBomIntoWips wipKey (productCode::idx::wipType::rawTopCode — variant-
// stable because it uses the UNRESOLVED template code); `label` is the
// resolved display label snapshotted at pick time (used in badges and in
// the stale-pick error); `qty` is the picked piece count, integer ≥ 1.
export type RepairComponentPick = {
  key: string;
  label: string;
  qty: number;
};

// A parsed, non-FULL repair scope. FULL parses to `null` so every consumer's
// "no scope" branch is byte-identical to pre-feature behaviour. `components`
// absent = all components (today's behaviour for every existing row).
export type RepairScope = {
  preset: "FABRIC" | "FRAME" | "FOAM" | "CUSTOM";
  depts: RepairDeptCode[];
  components?: RepairComponentPick[];
};

function isKnownDept(code: unknown): code is RepairDeptCode {
  return (
    typeof code === "string" &&
    (REPAIR_DEPT_CODES as readonly string[]).includes(code)
  );
}

// Order a dept set into canonical chain order (deterministic storage form).
function inChainOrder(depts: readonly RepairDeptCode[]): RepairDeptCode[] {
  return REPAIR_DEPT_CODES.filter((d) => depts.includes(d));
}

export function serializeRepairScope(scope: RepairScope | null): string | null {
  if (!scope) return null;
  // components is serialized ONLY when present and non-empty — an absent
  // field is the canonical "all components" form, keeping dept-only scopes
  // byte-identical to their pre-feature storage.
  if (scope.components && scope.components.length > 0) {
    return JSON.stringify({
      preset: scope.preset,
      depts: scope.depts,
      components: scope.components.map((c) => ({
        key: c.key,
        label: c.label,
        qty: c.qty,
      })),
    });
  }
  return JSON.stringify({ preset: scope.preset, depts: scope.depts });
}

// Lenient read-side components parser (mirror of parseRepairScope's
// philosophy: storage is write-validated, so malformed entries here are
// hand-tampered — drop them; zero survivors degrades to "all components",
// the same FULL-ward degradation the dept parser applies).
function parseComponentsLenient(raw: unknown): RepairComponentPick[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RepairComponentPick[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const key = (entry as { key?: unknown }).key;
    const label = (entry as { label?: unknown }).label;
    const qtyRaw = (entry as { qty?: unknown }).qty;
    if (typeof key !== "string" || key.length === 0 || seen.has(key)) continue;
    const qty = typeof qtyRaw === "number" ? qtyRaw : Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 1) continue;
    seen.add(key);
    out.push({ key, label: typeof label === "string" ? label : "", qty });
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// parseRepairScope — LENIENT read-side parser. Storage is write-validated, so
// anything malformed here is hand-tampered data; the safe default is `null`
// (= FULL, the pre-feature behaviour). Preset rows re-derive their dept set
// from the preset table (the preset is authoritative); CUSTOM keeps only
// known codes and degrades to null when none survive.
// ---------------------------------------------------------------------------
export function parseRepairScope(
  raw: string | null | undefined,
): RepairScope | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const preset = (parsed as { preset?: unknown }).preset;
  if (preset === "FULL") return null;
  // components ride along on any non-FULL scope (the picker only writes
  // them for CUSTOM, but legacy preset rows edited via API keep them too).
  const components = parseComponentsLenient(
    (parsed as { components?: unknown }).components,
  );
  if (preset === "FABRIC" || preset === "FRAME" || preset === "FOAM") {
    return {
      preset,
      depts: [...REPAIR_SCOPE_PRESET_DEPTS[preset]],
      ...(components ? { components } : {}),
    };
  }
  if (preset === "CUSTOM") {
    const rawDepts = (parsed as { depts?: unknown }).depts;
    if (!Array.isArray(rawDepts)) return null;
    const depts = inChainOrder(
      rawDepts.filter(isKnownDept) as RepairDeptCode[],
    );
    if (depts.length === 0) return null;
    return { preset: "CUSTOM", depts, ...(components ? { components } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// validateRepairScopeInput — STRICT write-side validator, shared verbatim by
// the frontend Save handler and the backend POST/PUT so both reject the same
// inputs with the same English error. Accepts the raw per-line value from a
// request body (string | object | null | undefined) and returns either the
// canonical storage string (or null for FULL / absent) or an error message.
//
// Reject — don't normalize: unknown presets, unknown/duplicate dept codes,
// and CUSTOM with no depts are 400s, never silently coerced.
// ---------------------------------------------------------------------------

// Strict components validation (write side). `undefined`/`null` = field
// absent = all components (always ok). Present → must be a non-empty array
// of {key: non-empty string, label: string, qty: integer ≥ 1}, no duplicate
// keys. Rejected shapes are never coerced — the qty bound against the BOM
// (≤ per-FG piece count) is enforced by the builder/cascade clamp, not
// here, because the validator has no BOM access.
function validateComponentsInput(
  raw: unknown,
):
  | { ok: true; components: RepairComponentPick[] | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, components: undefined };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "Invalid repairScope: components must be an array of {key, label, qty}.",
    };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      error:
        "Invalid repairScope: keep at least one repair component ticked (or omit components to repair all of them).",
    };
  }
  const out: RepairComponentPick[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        error:
          "Invalid repairScope: each component must be an object {key, label, qty}.",
      };
    }
    const key = (entry as { key?: unknown }).key;
    const label = (entry as { label?: unknown }).label;
    const qty = (entry as { qty?: unknown }).qty;
    if (typeof key !== "string" || key.trim().length === 0) {
      return {
        ok: false,
        error: "Invalid repairScope: component key must be a non-empty string.",
      };
    }
    if (typeof label !== "string") {
      return {
        ok: false,
        error: `Invalid repairScope: component "${key}" label must be a string.`,
      };
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
      return {
        ok: false,
        error: `Invalid repairScope: component "${label || key}" qty must be a whole number of pieces (1 or more).`,
      };
    }
    if (seen.has(key)) {
      return {
        ok: false,
        error: `Invalid repairScope: duplicate component key "${key}".`,
      };
    }
    seen.add(key);
    out.push({ key, label, qty });
  }
  return { ok: true, components: out };
}

export function validateRepairScopeInput(
  raw: unknown,
): { ok: true; canonical: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, canonical: null };
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Invalid repairScope: not valid JSON." };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        'Invalid repairScope: expected {"preset":"FULL|FABRIC|FRAME|FOAM|CUSTOM","depts":[...]}.',
    };
  }
  const preset = (parsed as { preset?: unknown }).preset;
  const rawDepts = (parsed as { depts?: unknown }).depts;
  const rawComponents = (parsed as { components?: unknown }).components;
  if (preset === "FULL") {
    // A full remake repairs every component by definition — a client that
    // sends component picks on FULL is confused; reject, don't strip.
    if (rawComponents !== undefined && rawComponents !== null) {
      return {
        ok: false,
        error:
          "Invalid repairScope: a Full remake already repairs every component — components can only be set on a partial repair.",
      };
    }
    return { ok: true, canonical: null };
  }
  const componentsCheck = validateComponentsInput(rawComponents);
  if (!componentsCheck.ok) return componentsCheck;
  const components = componentsCheck.components;
  if (preset === "FABRIC" || preset === "FRAME" || preset === "FOAM") {
    const canonicalDepts = REPAIR_SCOPE_PRESET_DEPTS[preset];
    // depts may be omitted (server derives them) or must match the preset
    // table exactly — a different set means a confused client; reject.
    if (rawDepts !== undefined) {
      if (!Array.isArray(rawDepts)) {
        return { ok: false, error: "Invalid repairScope: depts must be an array." };
      }
      const sent = [...rawDepts].sort();
      const want = [...canonicalDepts].sort();
      if (
        sent.length !== want.length ||
        sent.some((d, i) => d !== want[i])
      ) {
        return {
          ok: false,
          error: `Invalid repairScope: preset ${preset} implies departments ${canonicalDepts.join(", ")} — do not send a different dept list (use CUSTOM instead).`,
        };
      }
    }
    return {
      ok: true,
      canonical: serializeRepairScope({
        preset,
        depts: [...canonicalDepts],
        ...(components ? { components } : {}),
      }),
    };
  }
  if (preset === "CUSTOM") {
    if (!Array.isArray(rawDepts) || rawDepts.length === 0) {
      return {
        ok: false,
        error:
          "Invalid repairScope: CUSTOM requires at least one department code in depts.",
      };
    }
    const unknown = rawDepts.filter((d) => !isKnownDept(d));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Invalid repairScope: unknown department code "${String(unknown[0])}". Allowed: ${REPAIR_DEPT_CODES.join(", ")}.`,
      };
    }
    const seen = new Set<string>();
    for (const d of rawDepts as string[]) {
      if (seen.has(d)) {
        return {
          ok: false,
          error: `Invalid repairScope: duplicate department code "${d}".`,
        };
      }
      seen.add(d);
    }
    return {
      ok: true,
      canonical: serializeRepairScope({
        preset: "CUSTOM",
        depts: inChainOrder(rawDepts as RepairDeptCode[]),
        ...(components ? { components } : {}),
      }),
    };
  }
  return {
    ok: false,
    error:
      'Invalid repairScope: preset must be one of "FULL", "FABRIC", "FRAME", "FOAM", "CUSTOM".',
  };
}

// ---------------------------------------------------------------------------
// filterWipsByRepairScope — the job-card filter. Generic over the builder's
// WipBreakdownItem shape so it stays a pure function (unit-testable without
// the DB-bound builder). scope === null → identity (byte-identical FULL
// behaviour). Otherwise: keep only in-scope processes per WIP, drop WIPs
// with zero surviving processes. Process order is preserved, so the first
// surviving dept becomes chain[0] → sequence 0 → prerequisiteMet=1 in the
// builder's planned loop.
// ---------------------------------------------------------------------------
export function filterWipsByRepairScope<
  P extends { deptCode: string },
  W extends { processes: P[] },
>(wips: W[], scope: RepairScope | null): W[] {
  if (!scope) return wips;
  const allow = new Set<string>(scope.depts);
  return wips
    .map((w) => ({
      ...w,
      processes: w.processes.filter((p) => allow.has(p.deptCode)),
    }))
    .filter((w) => w.processes.length > 0);
}

// ---------------------------------------------------------------------------
// filterWipsByRepairComponents — the Component-level job-card filter, applied
// by the builder AFTER the dept filter above. No components on the scope →
// identity (all components, byte-identical to a dept-only scope).
//
// Stale detection: a picked key that doesn't exist in `allBomWipKeys` (the
// FULL breakdown's keys, captured BEFORE any narrowing) means the product's
// BOM top-level structure changed since the operator picked — the caller
// MUST fail loudly (never silently build the wrong subset of a paid repair),
// so on any stale pick this returns the stale list and an EMPTY wips array.
// A pick whose key exists but whose WIP was dropped by the Headboard-Only /
// dept filters is NOT stale — that's legal narrowing, and a scope that
// narrows to nothing is caught by the builder's existing zero-step throw.
//
// Qty scaling: the kept WIP's quantityMultiplier (its per-FG piece count —
// the source of the planned job card's wipQty) is clamped to
// min(pickedQty, bomQty) so a partial pick (1 of 2 divan pieces) builds
// fewer pieces and a BOM whose qty shrank since picking never over-builds.
// ---------------------------------------------------------------------------
export function filterWipsByRepairComponents<
  W extends { wipKey: string; quantityMultiplier: number },
>(
  wips: W[],
  scope: RepairScope | null,
  allBomWipKeys?: Iterable<string>,
): { wips: W[]; stale: RepairComponentPick[] } {
  const components = scope?.components;
  if (!scope || !components || components.length === 0) {
    return { wips, stale: [] };
  }
  const known = new Set<string>(
    allBomWipKeys ?? wips.map((w) => w.wipKey),
  );
  const stale = components.filter((c) => !known.has(c.key));
  if (stale.length > 0) return { wips: [], stale };
  const pickByKey = new Map(components.map((c) => [c.key, c]));
  const kept = wips
    .filter((w) => pickByKey.has(w.wipKey))
    .map((w) => {
      const pick = pickByKey.get(w.wipKey)!;
      const scaled = Math.min(pick.qty, w.quantityMultiplier);
      return scaled === w.quantityMultiplier
        ? w
        : { ...w, quantityMultiplier: scaled };
    });
  return { wips: kept, stale: [] };
}

// ---------------------------------------------------------------------------
// repairComponentScale — the Component-level MATERIAL rule, used by
// consumeRawMaterialsForPO on top of materialLineInScope. Returns the
// quantity factor for one BOM material line:
//
//   1         → scope has no component picks (all components), or the
//               owning component is picked at its full BOM qty.
//   fraction  → partial pick: pickedQty / bomQty (picked 1 of the 2 divan
//               pieces → 0.5 of the line's per-FG quantity).
//   null      → DROP the line: its owning component wasn't picked, or the
//               line can't prove which component owns it (no ownerWipKey —
//               legacy bom_versions.tree / flat bom_components shapes).
//               For a partial repair we never consume materials we can't
//               prove are in scope.
//
// line.ownerWipKey is derived during the cascade's BOM tree walk with the
// SAME deriveTopLevelWipKey helper breakBomIntoWips uses for job-card
// wipKeys (single source of truth — structurally pinned in tests), so a
// picked key matches its material lines exactly. ownerWipQty is the owning
// top-level node's per-FG piece count (the bound the pick is clamped to).
// ---------------------------------------------------------------------------
export function repairComponentScale(
  line: { ownerWipKey?: string; ownerWipQty?: number },
  scope: RepairScope | null,
): number | null {
  const components = scope?.components;
  if (!scope || !components || components.length === 0) return 1;
  if (!line.ownerWipKey) return null;
  const pick = components.find((c) => c.key === line.ownerWipKey);
  if (!pick) return null;
  const bomQty =
    line.ownerWipQty != null && line.ownerWipQty > 0 ? line.ownerWipQty : 1;
  return Math.min(pick.qty, bomQty) / bomQty;
}

// ---------------------------------------------------------------------------
// canonicalizeComponentPicks — storage canonicalization shared by the
// frontend picker (and unit-tested directly). `options` is the BOM's
// component list (from /api/sales-orders/repair-components); `picks` is the
// operator's checked entries.
//
//   undefined → everything is picked at full BOM qty (or the BOM has no
//               components) — OMIT the components field entirely, the
//               canonical "all components" form.
//   array     → an explicit subset / reduced-qty pick, ordered by the BOM's
//               component order, qty clamped to [1, bomQty]. An empty array
//               (operator unticked everything) is returned as-is so the
//               shared validator blocks Save with its at-least-one error.
//
// Picks whose key isn't in `options` are dropped (the product / BOM
// changed under the picker — the survivors are re-canonicalized).
// ---------------------------------------------------------------------------
export function canonicalizeComponentPicks(
  options: readonly { key: string; label: string; qty: number }[],
  picks: readonly { key: string; label?: string; qty: number }[],
): RepairComponentPick[] | undefined {
  const cleaned: RepairComponentPick[] = [];
  let allAtFullQty = true;
  for (const opt of options) {
    const pick = picks.find((p) => p.key === opt.key);
    // BOM piece counts are integers in practice (divan=2, headboard=1,
    // cushions=2); floor() guards a pathological fractional BOM qty.
    const bomQty = Math.max(1, Math.floor(opt.qty) || 1);
    if (!pick) {
      allAtFullQty = false;
      continue;
    }
    const qty = Math.min(Math.max(1, Math.floor(pick.qty) || 1), bomQty);
    if (qty !== bomQty) allAtFullQty = false;
    cleaned.push({ key: opt.key, label: opt.label, qty });
  }
  if (cleaned.length === options.length && allAtFullQty) return undefined;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Material classification (RM consumption side).
//
// Class signal — raw_materials.itemGroup (live prod groups, audited
// 2026-06-11 against the full raw_materials table):
//   FABRIC → B.M-FABR / S.M-FABR / S-FABRIC / S-FABR / LINING
//            (the fabric itemGroups; S-FABR kept for parity with
//            fabric-validation.ts even though live rows use S-FABRIC.
//            WEBBING-group elastics are deliberately NOT fabric here —
//            they are consumed by the WEBBING dept, which no fabric
//            replacement touches.)
//   WOOD   → PLYWOOD / WD STRIP (boards, MDF, strips, finger joint)
//   FOAM   → B.FILLER / S.FILLER (sponges, polyester fibre fills, springs)
// Everything else (B.ACCE, PACKING, EQUIPMEN, ...) classifies to null.
//
// A BOM line tagged autoDetect:"FABRIC" is fabric-class by construction
// (it resolves to the SO line's fabricCode at consume time), so it never
// needs the itemGroup lookup.
// ---------------------------------------------------------------------------
export type MaterialClass = "FABRIC" | "WOOD" | "FOAM";

const FABRIC_CLASS_GROUPS = new Set([
  "B.M-FABR",
  "S.M-FABR",
  "S-FABRIC",
  "S-FABR",
  "LINING",
]);
const WOOD_CLASS_GROUPS = new Set(["PLYWOOD", "WD STRIP"]);
const FOAM_CLASS_GROUPS = new Set(["B.FILLER", "S.FILLER"]);

export function materialClassForItemGroup(
  itemGroup: string | null | undefined,
): MaterialClass | null {
  if (!itemGroup) return null;
  if (FABRIC_CLASS_GROUPS.has(itemGroup)) return "FABRIC";
  if (WOOD_CLASS_GROUPS.has(itemGroup)) return "WOOD";
  if (FOAM_CLASS_GROUPS.has(itemGroup)) return "FOAM";
  return null;
}

// Preset → the single material class it consumes.
export const MATERIAL_CLASS_BY_PRESET: Record<
  "FABRIC" | "FRAME" | "FOAM",
  MaterialClass
> = {
  FABRIC: "FABRIC",
  FRAME: "WOOD",
  FOAM: "FOAM",
};

// ---------------------------------------------------------------------------
// materialLineInScope — should this BOM material line be consumed for a
// scoped repair? Pure decision function used by consumeRawMaterialsForPO.
//
//   scope null            → true (FULL — consume everything, as today).
//   preset FABRIC/FRAME/FOAM → CLASS-BASED: keep only lines whose class
//       matches the preset's class. Line class = "FABRIC" when the BOM line
//       is autoDetect:"FABRIC", else classified from the resolved
//       raw_materials.itemGroup. Unclassifiable lines (no RM match, or an
//       itemGroup outside the three classes) are DROPPED — for a partial
//       repair we never consume materials we can't prove are in scope.
//   preset CUSTOM         → BRANCH-BASED: keep lines whose owning BOM node
//       has at least one process in the chosen depts (ownerDeptCodes is
//       captured by collectTreeMaterials). Lines with no owner-process
//       information (flat bom_components fallback, legacy trees) are
//       DROPPED for the same never-over-consume reason.
// ---------------------------------------------------------------------------
export function materialLineInScope(
  line: {
    autoDetect?: string;
    ownerDeptCodes?: readonly string[];
  },
  resolvedItemGroup: string | null | undefined,
  scope: RepairScope | null,
): boolean {
  if (!scope) return true;
  if (scope.preset === "CUSTOM") {
    const owners = line.ownerDeptCodes ?? [];
    return owners.some((d) => (scope.depts as readonly string[]).includes(d));
  }
  const wantClass = MATERIAL_CLASS_BY_PRESET[scope.preset];
  const lineClass: MaterialClass | null =
    line.autoDetect === "FABRIC"
      ? "FABRIC"
      : materialClassForItemGroup(resolvedItemGroup);
  return lineClass === wantClass;
}

// Compact human label for badges: "Fabric replacement", or for CUSTOM the
// joined dept labels ("Custom: Foam + Packing"). Component picks append a
// short piece summary: "Custom: Wood Cutting + Framing · Divan ×1".
export function repairScopeBadgeLabel(scope: RepairScope | null): string {
  if (!scope) return REPAIR_SCOPE_PRESET_LABELS.FULL;
  const base =
    scope.preset === "CUSTOM"
      ? `Custom: ${scope.depts.map((d) => REPAIR_DEPT_LABELS[d]).join(" + ")}`
      : REPAIR_SCOPE_PRESET_LABELS[scope.preset];
  if (scope.components && scope.components.length > 0) {
    const pieces = scope.components
      .map((c) => `${c.label || c.key} ×${c.qty}`)
      .join(" + ");
    return `${base} · ${pieces}`;
  }
  return base;
}

// Normalize a repaired-component label to the short form printed on the DO
// (Wei Siang 2026-06-16): the repaired part must read the SAME way as on a
// complete unit / the WIP sticker — "1 HB", "1 BC", "1 Arm", never spelled out.
// Maps the picker's labels to their abbreviations; an unknown label passes
// through unchanged (and can be added here when a new component appears).
export function normalizePartLabel(label: string): string {
  switch (label.trim().toUpperCase()) {
    case "HB":
    case "HEADBOARD":
      return "HB";
    case "DIVAN":
      return "Divan";
    case "BC":
    case "BACK CUSHION":
      return "BC";
    case "RIGHT ARM":
    case "R ARM":
      return "Right Arm";
    case "LEFT ARM":
    case "L ARM":
      return "Left Arm";
    case "ARM":
    case "ARMREST":
      return "Arm";
    case "HR":
    case "HEADREST":
      return "Headrest";
    case "BASE":
      return "Base";
    default:
      return label.trim();
  }
}

// Clean short part label from a repair component's wipKey. The stored `label`
// is the VERBOSE BOM wipLabel ("5531-2A(RHF) -Base 28"); the KEY encodes the
// wipType (productCode::idx::WIPTYPE::rawCode), which is clean — so map the
// wipType to its short form (BASE→Base, BACK_CUSHION→BC, RIGHT_ARM→R Arm, …).
// An unknown wipType title-cases ("SEAT_CUSHION" → "Seat Cushion"); a key with
// no wipType segment falls back to normalizing the stored label.
export function partLabelFromKey(
  key: string | undefined | null,
  fallbackLabel?: string | null,
): string {
  const seg = String(key || "").split("::");
  if (seg.length >= 4 && seg[2]) {
    const wipType = seg[2].replace(/_/g, " ").trim();
    const mapped = normalizePartLabel(wipType);
    if (mapped.toUpperCase() === wipType.toUpperCase()) {
      // Unknown type — title-case it so it reads "Seat Cushion", not "SEAT CUSHION".
      return wipType.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
    }
    return mapped;
  }
  return normalizePartLabel(String(fallbackLabel || ""));
}

// Parts-only summary for the delivery "Repair: …" badge — just the repaired
// component labels in full words ("Headboard + Armrest", or "Headboard + 2
// Armrest" when a part's picked qty > 1). Returns null when the scope has no
// component picks (a full or dept-only repair has no specific parts to list, so
// no badge).
export function repairPartsLabel(scope: RepairScope | null): string | null {
  const comps = scope?.components;
  if (!comps || comps.length === 0) return null;
  const parts = comps
    .map((c) => {
      const lab = partLabelFromKey(c.key, c.label);
      if (!lab) return "";
      return c.qty > 1 ? `${c.qty} ${lab}` : lab;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" + ") : null;
}

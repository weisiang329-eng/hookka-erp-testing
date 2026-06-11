// ---------------------------------------------------------------------------
// repair-scope.ts — single source of truth for the Service-Order "Repair
// Scope" feature (partial repairs instead of full remakes).
//
// A service order line may carry sales_order_items.repairscope (runtime-added
// column, folded lowercase — read it dual-key: row.repairScope ??
// row.repairscope). Stored value is a JSON string:
//
//   {"preset":"FULL"|"FABRIC"|"FRAME"|"FOAM"|"CUSTOM","depts":["FAB_CUT",...]}
//
// or NULL (= FULL = no filtering, byte-identical to a normal order).
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

// A parsed, non-FULL repair scope. FULL parses to `null` so every consumer's
// "no scope" branch is byte-identical to pre-feature behaviour.
export type RepairScope = {
  preset: "FABRIC" | "FRAME" | "FOAM" | "CUSTOM";
  depts: RepairDeptCode[];
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
  return JSON.stringify({ preset: scope.preset, depts: scope.depts });
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
  if (preset === "FABRIC" || preset === "FRAME" || preset === "FOAM") {
    return { preset, depts: [...REPAIR_SCOPE_PRESET_DEPTS[preset]] };
  }
  if (preset === "CUSTOM") {
    const rawDepts = (parsed as { depts?: unknown }).depts;
    if (!Array.isArray(rawDepts)) return null;
    const depts = inChainOrder(
      rawDepts.filter(isKnownDept) as RepairDeptCode[],
    );
    if (depts.length === 0) return null;
    return { preset: "CUSTOM", depts };
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
  if (preset === "FULL") return { ok: true, canonical: null };
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
      canonical: serializeRepairScope({ preset, depts: [...canonicalDepts] }),
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
// joined dept labels ("Custom: Foam + Packing").
export function repairScopeBadgeLabel(scope: RepairScope | null): string {
  if (!scope) return REPAIR_SCOPE_PRESET_LABELS.FULL;
  if (scope.preset === "CUSTOM") {
    return `Custom: ${scope.depts.map((d) => REPAIR_DEPT_LABELS[d]).join(" + ")}`;
  }
  return REPAIR_SCOPE_PRESET_LABELS[scope.preset];
}

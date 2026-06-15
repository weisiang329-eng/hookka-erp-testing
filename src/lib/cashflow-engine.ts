// Cash Flow engine — pure functions. Turns fetched ledger data into a
// cash-basis Statement of Cash Flow. No DB, no I/O. Unit-tested in
// tests/cashflow-engine.test.mjs.

export type CfSection =
  | "REVENUE_COLLECTION"
  | "RAW_MATERIALS"
  | "DIRECT_LABOUR"
  | "FACTORY_OVERHEAD"
  | "GENERAL_EXPENSE"
  | "TAXATION"
  | "FINANCE_COST"
  | "CAPEX"
  | "DEPOSIT"
  | "LOAN"
  | "UNALLOCATED";

export type CoaLite = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" | "COST";
  sat: string | null;
};

// Sections presented as cash OUT (payments shown positive, subtracted).
// REVENUE_COLLECTION, LOAN, UNALLOCATED present cash IN (inflow positive).
export const OUTFLOW_SECTIONS: ReadonlySet<CfSection> = new Set<CfSection>([
  "RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD", "GENERAL_EXPENSE",
  "TAXATION", "FINANCE_COST", "CAPEX", "DEPOSIT",
]);

// Operating sections feed "Net operation surplus / (deficit)".
export const OPERATING_SECTIONS: ReadonlySet<CfSection> = new Set<CfSection>([
  "REVENUE_COLLECTION", "RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD",
  "GENERAL_EXPENSE", "TAXATION",
]);

// Display order of sections in the statement.
export const SECTION_ORDER: CfSection[] = [
  "REVENUE_COLLECTION", "RAW_MATERIALS", "DIRECT_LABOUR", "FACTORY_OVERHEAD",
  "GENERAL_EXPENSE", "TAXATION", "FINANCE_COST", "CAPEX", "DEPOSIT", "LOAN",
  "UNALLOCATED",
];

export const SECTION_LABELS: Record<CfSection, string> = {
  REVENUE_COLLECTION: "REVENUE COLLECTION",
  RAW_MATERIALS: "Raw Materials",
  DIRECT_LABOUR: "Direct Labour",
  FACTORY_OVERHEAD: "Factory Overhead",
  GENERAL_EXPENSE: "General Expense",
  TAXATION: "Taxation",
  FINANCE_COST: "Finance Cost",
  CAPEX: "Capital Expenditure (CAPEX)",
  DEPOSIT: "Deposit Incurred / (Repay)",
  LOAN: "Loan / (Repayment)",
  UNALLOCATED: "Unallocated",
};

export function displaySign(section: CfSection): 1 | -1 {
  return OUTFLOW_SECTIONS.has(section) ? -1 : 1;
}

const band = (code: string): number => parseInt(code.split("-")[0] ?? "0", 10) || 0;

// Best-effort default placement of a contra account into a cash-flow section.
// The owner can override any account via the Maintenance mapping editor.
export function defaultSectionFor(a: CoaLite): CfSection {
  const b = band(a.code);
  // Debtor control / sales collection.
  if (a.sat === "SDC" || b === 300 || b === 305) return "REVENUE_COLLECTION";
  // GST / SST payable settlements shown under collection as (-) GST Payables.
  if (b === 350) return "REVENUE_COLLECTION";
  // AP control / supplier payments → raw materials (split by PI downstream).
  if (a.sat === "SCC" || b === 400 || b === 405) return "RAW_MATERIALS";
  // Direct labour.
  if (b === 750) return "DIRECT_LABOUR";
  // Factory overhead (700-range manufacturing + 780 overhead).
  if (b === 780 || (b >= 700 && b <= 705)) return "FACTORY_OVERHEAD";
  // Fixed assets → capex.
  if (b >= 200 && b <= 299) return "CAPEX";
  // Director / related-party advances & borrowings.
  if (b >= 450 && b <= 459) return "LOAN";
  // Generic expense.
  if (a.type === "EXPENSE" || b === 900) return "GENERAL_EXPENSE";
  return "UNALLOCATED";
}

export const RM_LINES = [
  "Purchase of Fabric",
  "Purchase of Wooden",
  "Purchase of Filler",
  "Purchase of Other & Packaging",
] as const;
export type RmLine = (typeof RM_LINES)[number];

// Default stock-group → raw-material line. Override map (cashflow_stockgroup_map)
// takes precedence; unmapped groups fall to "Other & Packaging".
export function rawMaterialLineFor(
  group: string,
  override: Record<string, string>,
): string {
  if (override[group]) return override[group];
  const g = group.toUpperCase();
  if (g.includes("FABR")) return "Purchase of Fabric";
  if (g.includes("PLYWOOD") || g.includes("WD") || g.includes("WOOD"))
    return "Purchase of Wooden";
  if (g.includes("FILLER")) return "Purchase of Filler";
  return "Purchase of Other & Packaging";
}

// Distribute an integer total (sen) across weighted buckets so the parts sum
// EXACTLY to total (largest-remainder method). Used to split one supplier
// payment across the material lines of the PI it settled.
export function splitByLargestRemainder(
  totalSen: number,
  buckets: { key: string; weight: number }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets) out[b.key] = (out[b.key] ?? 0) + 0;
  const wsum = buckets.reduce((s, b) => s + Math.max(0, b.weight), 0);
  if (buckets.length === 0) return out;
  if (wsum <= 0) {
    out[buckets[0].key] = (out[buckets[0].key] ?? 0) + totalSen;
    return out;
  }
  const exact = buckets.map((b) => ({
    key: b.key,
    raw: (totalSen * Math.max(0, b.weight)) / wsum,
  }));
  let assigned = 0;
  const floored = exact.map((e) => {
    const f = Math.floor(e.raw);
    assigned += f;
    return { key: e.key, floor: f, rem: e.raw - f };
  });
  let leftover = totalSen - assigned;
  floored.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < floored.length && leftover > 0; i++, leftover--)
    floored[i].floor += 1;
  for (const f of floored) out[f.key] = (out[f.key] ?? 0) + f.floor;
  return out;
}

// Which product line a raw-material item-group belongs to, for the P&L line split.
// B.* codes are Bedframe-only, S.* / S- codes are Sofa-only, everything else
// (PLYWOOD, WD STRIP, MAINTENA, PACKING, EQUIPMENT, R&D, …) is shared and is
// apportioned by the sales ratio.
export type RmLine = "bedframe" | "sofa" | "shared";
export function rmLineOf(code: string): RmLine {
  const c = (code ?? "").trim().toUpperCase();
  if (c.startsWith("B.")) return "bedframe";
  if (c.startsWith("S.") || c.startsWith("S-")) return "sofa";
  return "shared";
}
/** Scale factor for an RM group's value in a given line view. */
export function rmScale(code: string, line: "all" | "sofa" | "bedframe", salesRatio: number): number {
  if (line === "all") return 1;
  const rl = rmLineOf(code);
  if (rl === "shared") return salesRatio;       // pro-rata
  return rl === line ? 1 : 0;                    // line-specific: 100% own line, 0 other
}

import type { ProductionOrder } from "../types";

// Inline product detail block under product code: fabric · size · DV · LG · GP
export function ProductDetailLine({ order }: { order: ProductionOrder }) {
  const bits: string[] = [];
  if (order.fabricCode) bits.push(order.fabricCode);
  if (order.sizeLabel) bits.push(order.sizeLabel);
  if (order.divanHeightInches != null) bits.push(`DV ${order.divanHeightInches}"`);
  if (order.legHeightInches != null) bits.push(`LG ${order.legHeightInches}"`);
  if (order.gapInches != null) bits.push(`GP ${order.gapInches}"`);
  return (
    <div className="text-[10px] text-[#9A918A] mt-0.5">{bits.join(" · ")}</div>
  );
}

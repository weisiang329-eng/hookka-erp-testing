"use client";

import React, { useMemo } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocNodeType =
  | "SO"
  | "DO"
  | "INVOICE"
  | "AR_PAYMENT"
  | "PO"
  | "GRN"
  | "PI"
  | "AP_PAYMENT"
  | "PRODUCTION";

export type LinkType = "full" | "partial" | "value" | "payment";

export type DocNode = {
  type: DocNodeType;
  label: string;       // e.g. "Sales Order"
  docNo: string;       // e.g. "SO-2604-023"
  status?: string;     // e.g. "CONFIRMED"
  isCurrent?: boolean; // highlight as the currently viewed document
  href?: string;       // link to detail page
};

export type DocLink = {
  from: number; // index in nodes array
  to: number;
  type: LinkType;
};

export type DocumentFlowDiagramProps = {
  /** Top row: Sales side (SO → DO → Invoice → AR Payment) */
  salesFlow: DocNode[];
  /** Bottom row: Purchase side (PO → GRN → PI → AP Payment) */
  purchaseFlow?: DocNode[];
  /** Cross links between rows (e.g. SO ←partial← PO) */
  crossLinks?: { fromRow: "sales" | "purchase"; fromIdx: number; toRow: "sales" | "purchase"; toIdx: number; type: LinkType }[];
  onClose?: () => void;
  title?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_W = 140;
const NODE_H = 68;
const GAP_X = 40;
const GAP_Y = 80;
const PAD_X = 30;
const PAD_Y = 30;

const LINK_COLORS: Record<LinkType, string> = {
  full: "#1D4ED8",      // blue
  partial: "#DC2626",   // red
  value: "#EA580C",     // orange
  payment: "#16A34A",   // green
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function NodeBox({ node, x, y, onClick }: { node: DocNode; x: number; y: number; onClick?: () => void }) {
  const bg = node.isCurrent
    ? "fill-[#FFF3CD] stroke-[#D4A843]"
    : "fill-[#F0F0F0] stroke-[#BCBCBC]";

  return (
    <g
      className={cn("cursor-pointer", onClick && "hover:opacity-80")}
      onClick={onClick}
    >
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={4}
        className={bg}
        strokeWidth={node.isCurrent ? 2 : 1.5}
      />
      {/* Label */}
      <text
        x={x + NODE_W / 2}
        y={y + 20}
        textAnchor="middle"
        className="fill-[#333] text-[11px] font-medium"
        style={{ fontSize: 11 }}
      >
        {node.label}
      </text>
      {/* Doc number */}
      <text
        x={x + NODE_W / 2}
        y={y + 36}
        textAnchor="middle"
        className="fill-[#666] text-[10px] font-bold"
        style={{ fontSize: 10, fontWeight: 700 }}
      >
        {node.docNo}
      </text>
      {/* Status */}
      {node.status && (
        <text
          x={x + NODE_W / 2}
          y={y + 52}
          textAnchor="middle"
          className="fill-[#888] text-[9px]"
          style={{ fontSize: 9 }}
        >
          {node.status.replace(/_/g, " ")}
        </text>
      )}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, type }: { x1: number; y1: number; x2: number; y2: number; type: LinkType }) {
  const color = LINK_COLORS[type];
  const markerId = `arrow-${type}`;

  // Determine if this is a diagonal arrow
  const isDiag = Math.abs(y2 - y1) > 10;

  return (
    <>
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 7"
          refX="9"
          refY="3.5"
          markerWidth="8"
          markerHeight="6"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill={color} />
        </marker>
      </defs>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={isDiag ? 1.5 : 2}
        strokeDasharray={type === "partial" ? "6 3" : undefined}
        markerEnd={`url(#${markerId})`}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DocumentFlowDiagram({
  salesFlow,
  purchaseFlow,
  crossLinks,
  onClose,
  title,
}: DocumentFlowDiagramProps) {
  const hasPurchase = purchaseFlow && purchaseFlow.length > 0;
  const rows = hasPurchase ? 2 : 1;

  // Calculate SVG dimensions
  const maxCols = Math.max(salesFlow.length, purchaseFlow?.length || 0);
  const svgW = PAD_X * 2 + maxCols * NODE_W + (maxCols - 1) * GAP_X;
  const svgH = PAD_Y * 2 + rows * NODE_H + (rows > 1 ? GAP_Y : 0);

  // Node positions
  const salesPositions = useMemo(
    () => salesFlow.map((_, i) => ({ x: PAD_X + i * (NODE_W + GAP_X), y: PAD_Y })),
    [salesFlow]
  );
  const purchasePositions = useMemo(
    () => (purchaseFlow || []).map((_, i) => ({ x: PAD_X + i * (NODE_W + GAP_X), y: PAD_Y + NODE_H + GAP_Y })),
    [purchaseFlow]
  );

  const handleNodeClick = (node: DocNode) => {
    if (node.href) {
      window.location.assign(node.href);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-[#E2DDD8] shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#E2DDD8] bg-[#FAF9F7]">
        <h3 className="text-sm font-bold text-[#1F1D1B]">
          {title || "Document Relationship"}
        </h3>
        {onClose && (
          <button
            onClick={onClose}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#E2DDD8] text-[#999] hover:text-[#333] transition-colors"
          >
            ✕
          </button>
        )}
      </div>

      {/* SVG Diagram */}
      <div className="p-4 overflow-x-auto">
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="mx-auto"
        >
          {/* Sales flow arrows */}
          {salesFlow.map((_, i) => {
            if (i === 0) return null;
            const prev = salesPositions[i - 1];
            const curr = salesPositions[i];
            return (
              <Arrow
                key={`s-arrow-${i}`}
                x1={prev.x + NODE_W}
                y1={prev.y + NODE_H / 2}
                x2={curr.x}
                y2={curr.y + NODE_H / 2}
                type="full"
              />
            );
          })}

          {/* Purchase flow arrows */}
          {(purchaseFlow || []).map((_, i) => {
            if (i === 0) return null;
            const prev = purchasePositions[i - 1];
            const curr = purchasePositions[i];
            return (
              <Arrow
                key={`p-arrow-${i}`}
                x1={prev.x + NODE_W}
                y1={prev.y + NODE_H / 2}
                x2={curr.x}
                y2={curr.y + NODE_H / 2}
                type="full"
              />
            );
          })}

          {/* Cross links (diagonal arrows between rows) */}
          {(crossLinks || []).map((link, i) => {
            const fromPos = link.fromRow === "sales" ? salesPositions[link.fromIdx] : purchasePositions[link.fromIdx];
            const toPos = link.toRow === "sales" ? salesPositions[link.toIdx] : purchasePositions[link.toIdx];
            if (!fromPos || !toPos) return null;

            // Determine attachment points
            const fromX = fromPos.x + NODE_W / 2;
            const fromY = link.fromRow === "sales" ? fromPos.y + NODE_H : fromPos.y;
            const toX = toPos.x + NODE_W / 2;
            const toY = link.toRow === "sales" ? toPos.y + NODE_H : toPos.y;

            return (
              <Arrow
                key={`cross-${i}`}
                x1={fromX}
                y1={fromY}
                x2={toX}
                y2={toY}
                type={link.type}
              />
            );
          })}

          {/* Sales nodes */}
          {salesFlow.map((node, i) => (
            <NodeBox
              key={`s-${i}`}
              node={node}
              x={salesPositions[i].x}
              y={salesPositions[i].y}
              onClick={() => handleNodeClick(node)}
            />
          ))}

          {/* Purchase nodes */}
          {(purchaseFlow || []).map((node, i) => (
            <NodeBox
              key={`p-${i}`}
              node={node}
              x={purchasePositions[i].x}
              y={purchasePositions[i].y}
              onClick={() => handleNodeClick(node)}
            />
          ))}
        </svg>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 px-5 py-2.5 border-t border-[#E2DDD8] bg-[#FAFAF8]">
        {[
          { type: "full" as LinkType, label: "Full Transfer" },
          { type: "partial" as LinkType, label: "Partial Transfer" },
          { type: "value" as LinkType, label: "Value Transfer" },
          { type: "payment" as LinkType, label: "Payment" },
        ].map(({ type, label }) => (
          <div key={type} className="flex items-center gap-1.5">
            <svg width="24" height="10">
              <line
                x1="0" y1="5" x2="18" y2="5"
                stroke={LINK_COLORS[type]}
                strokeWidth={2}
                strokeDasharray={type === "partial" ? "4 2" : undefined}
              />
              <polygon
                points="18,2 24,5 18,8"
                fill={LINK_COLORS[type]}
              />
            </svg>
            <span className="text-[11px] font-medium" style={{ color: LINK_COLORS[type] }}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Base skeleton block
// ---------------------------------------------------------------------------
interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  rounded?: boolean;
}

export function Skeleton({
  className,
  width,
  height,
  rounded = true,
}: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse bg-[#E2DDD8]/50",
        rounded && "rounded-md",
        className
      )}
      style={{
        width: width !== undefined ? (typeof width === "number" ? `${width}px` : width) : undefined,
        height: height !== undefined ? (typeof height === "number" ? `${height}px` : height) : undefined,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Text lines
// ---------------------------------------------------------------------------
interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

export function SkeletonText({ lines = 1, className }: SkeletonTextProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={14}
          // Make the last line shorter for a natural look
          width={i === lines - 1 && lines > 1 ? "70%" : "100%"}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card skeleton
// ---------------------------------------------------------------------------
interface SkeletonCardProps {
  className?: string;
}

export function SkeletonCard({ className }: SkeletonCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[#E2DDD8] bg-white shadow-sm p-4 space-y-3",
        className
      )}
    >
      <Skeleton height={14} width="50%" />
      <Skeleton height={32} width="65%" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table skeleton — header + configurable rows
// ---------------------------------------------------------------------------
interface SkeletonTableProps {
  rows?: number;
  columns?: number;
  className?: string;
}

export function SkeletonTable({
  rows = 5,
  columns = 5,
  className,
}: SkeletonTableProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[#E2DDD8] overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="bg-[#FAF9F7] border-b border-[#E2DDD8] px-4 py-3 flex gap-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} height={12} className="flex-1" />
        ))}
      </div>

      {/* Rows */}
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="px-4 py-3 flex gap-4 border-b border-[#E2DDD8] last:border-b-0"
        >
          {Array.from({ length: columns }).map((_, colIdx) => (
            <Skeleton
              key={colIdx}
              height={14}
              // Vary widths a bit so it looks more realistic
              width={colIdx === 0 ? "90px" : "100%"}
              className="flex-1"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail page skeleton — page header + info cards + table
// ---------------------------------------------------------------------------
export function SkeletonDetailPage() {
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton height={28} width={220} />
          <Skeleton height={14} width={160} />
        </div>
        <div className="flex gap-2">
          <Skeleton height={36} width={90} />
          <Skeleton height={36} width={110} />
        </div>
      </div>

      {/* Stat cards row */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>

      {/* Info card */}
      <div className="rounded-lg border border-[#E2DDD8] bg-white shadow-sm p-6 space-y-4">
        <Skeleton height={18} width={140} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton height={11} width="60%" />
              <Skeleton height={16} width="80%" />
            </div>
          ))}
        </div>
      </div>

      {/* Items table */}
      <div className="rounded-lg border border-[#E2DDD8] bg-white shadow-sm">
        <div className="p-4 border-b border-[#E2DDD8]">
          <Skeleton height={18} width={120} />
        </div>
        <div className="p-4">
          <SkeletonTable rows={4} columns={6} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard skeleton — stat cards + chart area
// ---------------------------------------------------------------------------
export function SkeletonDashboard() {
  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton height={28} width={200} />
          <Skeleton height={14} width={280} />
        </div>
        <Skeleton height={36} width={120} />
      </div>

      {/* KPI stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-[#E2DDD8] bg-white shadow-sm p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton height={13} width="55%" />
              <Skeleton height={32} width={32} rounded />
            </div>
            <Skeleton height={36} width="50%" />
            <Skeleton height={12} width="70%" />
          </div>
        ))}
      </div>

      {/* Chart / wide card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-lg border border-[#E2DDD8] bg-white shadow-sm p-6 space-y-4">
          <Skeleton height={18} width={160} />
          <Skeleton height={220} className="w-full" />
        </div>

        <div className="rounded-lg border border-[#E2DDD8] bg-white shadow-sm p-6 space-y-4">
          <Skeleton height={18} width={130} />
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton height={32} width={32} rounded />
                <div className="flex-1 space-y-1.5">
                  <Skeleton height={13} width="75%" />
                  <Skeleton height={11} width="50%" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Table area */}
      <div className="rounded-lg border border-[#E2DDD8] bg-white shadow-sm">
        <div className="p-4 border-b border-[#E2DDD8] flex items-center justify-between">
          <Skeleton height={18} width={160} />
          <Skeleton height={32} width={100} />
        </div>
        <div className="p-4">
          <SkeletonTable rows={5} columns={5} />
        </div>
      </div>
    </div>
  );
}

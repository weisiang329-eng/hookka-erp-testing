import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Standard page header used by every route-level page.
 *
 * Replaces the recurring pattern:
 *   <div className="flex items-center justify-between">
 *     <div>
 *       <h1 className="text-2xl font-bold text-[#1F1D1B]">...</h1>
 *       <p className="text-sm text-[#6B7280]">...</p>
 *     </div>
 *     <Button>...</Button>
 *   </div>
 *
 * Keeps chrome consistent: heading weight, subtitle colour, spacing,
 * responsive wrap behaviour when action row is long.
 */
export interface PageHeaderProps {
  /** Page title — displayed as <h1>. Required. */
  title: string;
  /** Optional one-line description below the title. */
  subtitle?: React.ReactNode;
  /** Action area on the right (buttons, links, export controls). */
  actions?: React.ReactNode;
  /**
   * Optional breadcrumb-style path shown above the title
   * (e.g. ["Sales", "SO-001"]). Rendered small and muted.
   */
  breadcrumbs?: string[];
  /** Extra className appended to the outer wrapper. */
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="mb-1 flex items-center gap-1.5 text-xs text-[#8A7F73]"
          >
            {breadcrumbs.map((crumb, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-[#C4BDB5]">/</span>}
                <span className={i === breadcrumbs.length - 1 ? "text-[#6B5C32]" : ""}>
                  {crumb}
                </span>
              </React.Fragment>
            ))}
          </nav>
        )}
        <h1 className="text-2xl font-bold text-[#1F1D1B] truncate">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm text-[#6B7280]">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          {actions}
        </div>
      )}
    </div>
  );
}

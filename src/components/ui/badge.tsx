import * as React from "react";
import { cn, getStatusColor } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "status";
  status?: string;
}

export function Badge({ className, variant = "default", status, children, ...props }: BadgeProps) {
  if (variant === "status" && status) {
    const colors = getStatusColor(status);
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border",
          colors.bg,
          colors.text,
          colors.border,
          className
        )}
        {...props}
      >
        {children || status.replace(/_/g, " ")}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-[#F0ECE9] text-[#6B5C32] border border-[#E2DDD8]",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

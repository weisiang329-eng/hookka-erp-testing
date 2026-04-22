"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32] disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-[#1F1D1B] text-white hover:bg-[#1F1D1B]/90",
        primary: "bg-[#6B5C32] text-white hover:bg-[#4D4224]",
        destructive: "bg-red-600 text-white hover:bg-red-700",
        outline: "border border-[#E2DDD8] bg-white text-[#1F1D1B] hover:bg-[#F0ECE9]",
        secondary: "bg-[#F0ECE9] text-[#1F1D1B] hover:bg-[#E2DDD8]",
        ghost: "hover:bg-[#F0ECE9] text-[#6B7280]",
        link: "text-[#6B5C32] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 rounded-md px-8 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };

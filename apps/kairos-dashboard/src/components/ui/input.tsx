import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base text-foreground shadow-xs transition-[color,box-shadow,border-color] duration-150 ease-out outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20",
        "aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };

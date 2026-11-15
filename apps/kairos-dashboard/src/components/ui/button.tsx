import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * FlowFlex buttons: violet primary, 4px corners, heights 36 (default) / 32 (sm) / 28 (xs),
 * flat surfaces with borders instead of shadows, and a calm 2px focus ring.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-background hover:bg-destructive/90 focus-visible:ring-destructive/40",
        outline: "border border-input bg-background text-foreground hover:bg-muted",
        secondary: "bg-secondary text-secondary-foreground hover:bg-muted-foreground/10",
        ghost: "text-foreground hover:bg-muted aria-expanded:bg-muted aria-pressed:bg-muted",
        link: "h-auto px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 has-[>svg]:px-3",
        xs: "h-7 gap-1.5 px-2.5 text-[13px] has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-10 px-5 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

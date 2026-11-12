import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../lib/utils"
import { Slot } from "radix-ui"

/*
 * FlowFlex badges are pills. The soft tones (ai, good, warning, danger, accent) are what `Tag` uses;
 * `ai` is reserved for things the AI agent did.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "bg-muted text-muted-foreground [a&]:hover:text-foreground",
        destructive: "bg-destructive text-background [a&]:hover:bg-destructive/90",
        outline: "border-border text-foreground [a&]:hover:bg-muted",
        ghost: "[a&]:hover:bg-muted",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        accent: "bg-accent text-accent-foreground",
        ai: "bg-ai text-ai-foreground",
        good: "bg-good-soft text-good",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-destructive",
      },
      size: {
        sm: "h-5 px-1.5 text-[11px] [&>svg]:size-3",
        md: "h-6 px-2 text-xs [&>svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "md",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }

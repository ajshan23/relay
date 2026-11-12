"use client";

import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

export type SidePanelWidth = "sm" | "md" | "lg";

const widthClass: Record<SidePanelWidth, string> = {
  sm: "sm:max-w-[380px]",
  md: "sm:max-w-[480px]",
  lg: "sm:max-w-[640px]",
};

export interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  width?: SidePanelWidth;
  children?: ReactNode;
  /** Rendered in a fixed bottom bar with a top border. Use `ModalActions` inside it. */
  footer?: ReactNode;
  className?: string;
}

/**
 * A panel that slides in from the right for details or edits about one thing while the page
 * stays in view: a customer, a run, a setting group. Use `Modal` when the task should block
 * the page. The header and footer stay put; the body scrolls.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  width = "md",
  children,
  footer,
  className,
}: SidePanelProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn("w-full gap-0 p-0", widthClass[width], className)}
      >
        <SheetHeader className="shrink-0 gap-1 border-b border-border px-5 py-4 pr-14">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 text-sm">{children}</div>
        {footer ? <div className="shrink-0 border-t border-border px-5 py-3">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}

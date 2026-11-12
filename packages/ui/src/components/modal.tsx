"use client";

import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

export type ModalSize = "sm" | "md" | "lg" | "xl";

const sizeClass: Record<ModalSize, string> = {
  sm: "sm:max-w-[400px]",
  md: "sm:max-w-[520px]",
  lg: "sm:max-w-[680px]",
  xl: "sm:max-w-[880px]",
};

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always required: screen readers announce it when the modal opens. */
  title: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  children?: ReactNode;
  /** Rendered in a fixed bottom bar with a top border. Use `ModalActions` inside it. */
  footer?: ReactNode;
  hideClose?: boolean;
  className?: string;
}

/**
 * A centred window for a focused task that needs the page to wait: a short form, a preview,
 * a choice. Use `ConfirmDialog` for yes/no questions and `SidePanel` for details that sit
 * beside the page. The header and footer stay put; the body scrolls when tall.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  children,
  footer,
  hideClose = false,
  className,
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={!hideClose}
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn(
          "flex max-h-[85vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0",
          sizeClass[size],
          className,
        )}
      >
        <DialogHeader className={cn("shrink-0 gap-1 px-6 pt-5 pb-4 text-left", !hideClose && "pr-14")}>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6 text-sm">{children}</div>
        {footer ? <div className="shrink-0 border-t border-border px-6 py-3">{footer}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

export interface ModalActionsProps {
  children: ReactNode;
  /** Optional content pinned to the left, such as a destructive "Delete" or a hint. */
  start?: ReactNode;
  className?: string;
}

/** The button row for a `Modal` or `SidePanel` footer: actions sit on the right, primary last. */
export function ModalActions({ children, start, className }: ModalActionsProps) {
  return (
    <div className={cn("flex w-full flex-wrap items-center gap-2", className)}>
      {start ? <div className="mr-auto flex items-center gap-2">{start}</div> : null}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

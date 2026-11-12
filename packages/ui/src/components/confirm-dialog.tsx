"use client";

import { Loader2Icon } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export type ConfirmTone = "default" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** Say what happens: "Delete flow", "Send broadcast". */
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  tone?: ConfirmTone;
  /** Show a spinner and lock the dialog. Also set automatically while `onConfirm` is pending. */
  loading?: boolean;
  /**
   * Runs when the person confirms. If it returns a promise the dialog stays open with a spinner
   * until it settles, then closes on success and stays open on failure.
   */
  onConfirm: () => void | Promise<void>;
}

/**
 * Asks a yes/no question before something that is hard to undo or costs money. Use the
 * `danger` tone for deletes and other destructive actions. For a one-line `await` in an event
 * handler, use `useConfirm()` instead of managing `open` yourself.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const busy = loading || pending;

  const handleConfirm = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (busy) return;
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    try {
      await result;
      onOpenChange(false);
    } catch {
      // The caller reports the error (for example with notify.error); keep the dialog open to retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <AlertDialogContent className="sm:max-w-[420px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  tone?: ConfirmTone;
}

/**
 * Promise-based confirm for event handlers. Render `element` once in the component, then:
 *
 * ```tsx
 * const [confirm, confirmElement] = useConfirm();
 * if (await confirm({ title: "Delete flow?", description: "…", confirmLabel: "Delete flow", tone: "danger" })) { … }
 * ```
 *
 * Resolves `true` when confirmed and `false` when cancelled or dismissed.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
  }, []);

  useEffect(() => () => settle(false), [settle]);

  const confirm = useCallback(
    (next: ConfirmOptions) => {
      settle(false);
      setOptions(next);
      setOpen(true);
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
    },
    [settle],
  );

  const element = options ? (
    <ConfirmDialog
      {...options}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) settle(false);
      }}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return [confirm, element];
}

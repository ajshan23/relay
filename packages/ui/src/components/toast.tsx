"use client";

import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { type ExternalToast, Toaster as Sonner, toast } from "sonner";

const pillButton =
  "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The toast container. Mount it once near the root, inside `ThemeProvider`, then call `notify`
 * from anywhere. Toasts appear bottom-centre as a dark pill in light mode and a light pill in
 * dark mode.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="bottom-center"
      offset={20}
      mobileOffset={16}
      visibleToasts={3}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "inset-x-0 mx-auto flex min-h-10 w-fit max-w-full items-center gap-2 rounded-full bg-foreground py-2 pr-2 pl-4 font-sans text-sm font-medium text-background shadow-xl",
          icon: "relative flex size-4 shrink-0 items-center justify-center",
          content: "flex min-w-0 flex-col gap-0.5 pr-2",
          title: "leading-5",
          description: "text-[13px] leading-5 font-normal text-background/70",
          actionButton: `${pillButton} bg-background/15 text-background hover:bg-background/25`,
          cancelButton: `${pillButton} text-background/70 hover:text-background`,
        },
      }}
    />
  );
}

/** Extra settings for one toast: a `description`, an `action` button, `duration` in ms, or an `id` to replace. */
export type NotifyOptions = Pick<ExternalToast, "id" | "description" | "action" | "cancel" | "duration">;

type PromiseMessages<T> = {
  loading: ReactNode;
  success: ReactNode | ((data: T) => ReactNode);
  error: ReactNode | ((error: unknown) => ReactNode);
};

/**
 * Short, passing feedback after an action: "Flow saved", "Couldn't send the message".
 * Keep the message to a few words. For something the person must act on, use a `Modal` or an
 * inline message instead.
 */
export const notify = {
  success: (message: ReactNode, options?: NotifyOptions) => toast.success(message, options),
  error: (message: ReactNode, options?: NotifyOptions) => toast.error(message, options),
  info: (message: ReactNode, options?: NotifyOptions) => toast.info(message, options),
  /** Shows `loading` until the promise settles, then `success` or `error`. Returns the promise's result. */
  promise: <T,>(promise: Promise<T> | (() => Promise<T>), messages: PromiseMessages<T>): Promise<T> =>
    toast.promise(promise, messages).unwrap(),
  dismiss: (id?: string | number) => toast.dismiss(id),
};

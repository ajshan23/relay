import { Icon } from "@relay/ui/components/icon";
import { cn } from "@relay/ui/lib/utils";
import Link from "next/link";
import type { ReactNode } from "react";
import { CardBody } from "./card-body";
import { ProductPanel } from "./product-panel";

/** The product mark: a chat bubble passing a message on. Placeholder until the product is named. */
export function RelayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path
        d="M9 10.5A2.5 2.5 0 0 1 11.5 8h9A2.5 2.5 0 0 1 23 10.5v7a2.5 2.5 0 0 1-2.5 2.5H15l-4.2 3.4a.5.5 0 0 1-.8-.4V20a2.5 2.5 0 0 1-1-2z"
        className="fill-primary-foreground/95"
      />
      <path
        d="M13 14h6m-2.2-2.4L19.2 14l-2.4 2.4"
        fill="none"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-primary"
      />
    </svg>
  );
}

/**
 * Every signed-out screen and onboarding: one card in the middle of a quiet page, and on wide
 * screens a panel beside it explaining the product. The card holds the logo, a heading,
 * the form and, last, an `AuthFooter` strip.
 */
export function AuthFrame({
  children,
  wide = false,
  panel = "product",
}: {
  children: ReactNode;
  wide?: boolean;
  panel?: "product" | "onboarding";
}) {
  return (
    <div className="flex min-h-dvh bg-muted text-foreground">
      <div className="relative flex min-w-0 flex-1 flex-col items-center px-4">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,var(--accent),transparent)]"
        />
        {/* Centred. Field messages sit in fixed slots, so the card keeps its height while people type. */}
        <main className="relative flex w-full flex-1 flex-col items-center justify-center pt-10 pb-16">
          <div
            className={cn(
              "w-full overflow-hidden rounded-[12px] border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_40px_-12px_rgb(16_15_15/0.18)]",
              wide ? "max-w-[480px]" : "max-w-[408px]",
            )}
          >
            <CardBody
              logo={
                <Link
                  href="/"
                  aria-label="Relay home"
                  className="mx-auto rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <RelayMark />
                </Link>
              }
            >
              {children}
            </CardBody>
          </div>
          <nav
            aria-label="Legal"
            className="absolute bottom-5 flex items-center gap-5 text-xs text-muted-foreground"
          >
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <a href="mailto:support@relay.test" className="hover:text-foreground">
              Help
            </a>
          </nav>
        </main>
      </div>
      <aside aria-label="About Relay" className="hidden w-[46%] max-w-[680px] shrink-0 lg:block">
        <div className="sticky top-0 h-dvh">
          <ProductPanel variant={panel} />
        </div>
      </aside>
    </div>
  );
}

/** Centred title and one line under the logo. */
export function AuthHeading({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="-mt-1.5 flex flex-col items-center gap-1 text-center">
      <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.015em] text-balance">{title}</h1>
      {description ? (
        <p className="text-[14px] leading-[22px] text-balance text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/** An inline link in the auth screens' voice. */
export function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {children}
    </Link>
  );
}

/** The grey strip at the bottom of the card. Render it as the card's last child. */
export function AuthFooter({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-6 -mb-7 border-t border-border bg-muted/70 px-6 py-3.5 text-center text-[14px] text-muted-foreground sm:-mx-9 sm:px-9">
      {children}
    </div>
  );
}

/** Footer strip pointing to the other way in ("Don't have an account? Sign up"). */
export function AuthSwitch({ prompt, href, label }: { prompt: string; href: string; label: string }) {
  return (
    <AuthFooter>
      {prompt} <AuthLink href={href}>{label}</AuthLink>
    </AuthFooter>
  );
}

/**
 * The one-line slot under a field. The hint and the error take turns in the same fixed space,
 * so an error appearing never changes the height of the form.
 */
export function FieldNote({
  id,
  error,
  hint,
  tone = "muted",
  className,
}: {
  id?: string;
  error?: ReactNode;
  hint?: ReactNode;
  tone?: "muted" | "good";
  className?: string;
}) {
  return (
    <p
      id={id}
      role={error ? "alert" : undefined}
      className={cn(
        "-mt-1 min-h-[18px] truncate text-[12.5px] leading-[18px]",
        error ? "text-destructive" : tone === "good" ? "text-good" : "text-muted-foreground",
        className,
      )}
    >
      <span
        key={String(error || hint || "")}
        className="block truncate animate-drop-in motion-reduce:animate-none"
      >
        {error || hint || "\u00a0"}
      </span>
    </p>
  );
}

/** Spinner and a few words while something loads. */
export function AuthLoading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
      <Icon name="loading" />
      {label}
    </p>
  );
}

/** A plain-words error box for the whole form. */
export function AuthError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="flex gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-[13px] leading-5 text-destructive"
    >
      <Icon name="alert" size="sm" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Input height and size on the auth screens. */
/** Input size on the auth screens. 16px on phones, so iOS Safari does not zoom in when a field is tapped. */
export const authControl = "h-10 text-[16px] sm:text-[14px] md:text-[14px]";

/** Main button on the auth screens. */
export const authButton = "h-10 w-full text-[14px]";

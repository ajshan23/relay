import { redirect } from "next/navigation";
import { KairosMark, ThemeSwitch } from "@/components/theme";
import { passwordConfigured, signedIn } from "@/lib/auth";
import { LoginForm } from "./form";

export default async function LoginPage() {
  if (await signedIn()) redirect("/");
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      {/* A faint dial behind the form: Kairos is about the right moment. */}
      <svg
        viewBox="0 0 600 600"
        className="pointer-events-none absolute top-1/2 left-1/2 size-[760px] -translate-x-1/2 -translate-y-1/2 opacity-60"
        aria-hidden
      >
        <circle cx="300" cy="300" r="280" fill="none" className="stroke-border" strokeWidth="1" />
        <circle
          cx="300"
          cy="300"
          r="210"
          fill="none"
          className="stroke-border"
          strokeWidth="1"
          strokeDasharray="2 10"
        />
        <path
          d="M300 20 A280 280 0 0 1 520 130"
          fill="none"
          className="stroke-primary"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="520" cy="130" r="5" className="fill-now" />
      </svg>
      <div className="absolute top-4 right-4">
        <ThemeSwitch />
      </div>
      <div className="relative w-full max-w-sm rounded-2xl border bg-card p-7 shadow-elevated">
        <KairosMark className="size-10" />
        <h1 className="mt-5 text-xl font-semibold tracking-tight">Sign in to Kairos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Runs, waits and failures of every workflow, as they happen.
        </p>
        {passwordConfigured() ? (
          <LoginForm />
        ) : (
          <p className="mt-5 text-sm text-destructive">
            Set <code className="font-mono">KAIROS_ADMIN_PASSWORD</code> on the server to turn on sign-in.
          </p>
        )}
      </div>
    </div>
  );
}

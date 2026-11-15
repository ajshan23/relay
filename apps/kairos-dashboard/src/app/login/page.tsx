import { redirect } from "next/navigation";
import { passwordConfigured, signedIn } from "@/lib/auth";
import { LoginForm } from "./form";

export default async function LoginPage() {
  if (await signedIn()) redirect("/");
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6">
        <h1 className="text-xl font-semibold tracking-tight">Sign in to Kairos</h1>
        <p className="mt-1 text-sm text-muted-foreground">Runs, waits and failures of every workflow.</p>
        {passwordConfigured() ? (
          <LoginForm />
        ) : (
          <p className="mt-4 text-sm text-destructive">
            Set <code className="font-mono">KAIROS_ADMIN_PASSWORD</code> on the server to turn on sign-in.
          </p>
        )}
      </div>
    </div>
  );
}

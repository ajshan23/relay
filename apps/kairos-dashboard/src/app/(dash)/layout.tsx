import { LogOut } from "lucide-react";
import { logout } from "@/app/actions";
import { Brand, Nav } from "@/components/nav";
import { ThemeSwitch } from "@/components/theme";
import { requireSignIn } from "@/lib/auth";
import { schemaName } from "@/lib/db";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  await requireSignIn();
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 border-r border-nav-border bg-nav px-3 py-5 md:flex">
        <Brand />
        <Nav />
        <div className="mt-auto flex flex-col gap-3 px-1">
          <div className="flex items-center justify-between">
            <ThemeSwitch />
            <form action={logout}>
              <button
                type="submit"
                className="inline-flex size-8 items-center justify-center rounded-lg text-nav-muted transition-colors hover:bg-nav-active hover:text-nav-foreground"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
          <p className="px-1 text-[11px] text-nav-muted">
            Reading schema <code className="font-mono text-nav-foreground">{schemaName}</code>
          </p>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="flex items-center justify-between border-b border-nav-border bg-nav px-4 py-3 md:hidden">
          <Brand />
          <ThemeSwitch />
        </div>
        <div className="md:hidden overflow-x-auto border-b border-nav-border px-2 py-1.5">
          <div className="w-max">
            <Nav row />
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}

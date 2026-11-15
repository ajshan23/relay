import { LogOut } from "lucide-react";
import { logout } from "@/app/actions";
import { Brand, Nav } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { requireSignIn } from "@/lib/auth";
import { schemaName } from "@/lib/db";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  await requireSignIn();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col gap-4 border-r border-nav-border bg-nav px-3 py-4">
        <Brand />
        <Nav />
        <div className="mt-auto flex flex-col gap-2 px-2.5">
          <span className="text-xs text-muted-foreground">
            Schema <code className="font-mono">{schemaName}</code>
          </span>
          <form action={logout}>
            <Button type="submit" variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
              <LogOut aria-hidden />
              Sign out
            </Button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

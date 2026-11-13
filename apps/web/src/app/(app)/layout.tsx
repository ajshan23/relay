import type { ReactNode } from "react";
import { DataProvider } from "@/components/inbox/live";
import { AppShell } from "@/components/shell/app-shell";
import { BranchProvider } from "@/components/shell/branch-context";
import { MeProvider } from "@/lib/me";

/** Every signed-in route: the account, the branch choice and the Board shell. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider fallback={<div className="h-dvh bg-background" />}>
      <DataProvider>
        <BranchProvider>
          <AppShell>{children}</AppShell>
        </BranchProvider>
      </DataProvider>
    </MeProvider>
  );
}

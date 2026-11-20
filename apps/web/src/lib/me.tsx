"use client";

import { companyPermissions } from "@relay/core/permissions";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Me, type Permission } from "./api";

type MeContextValue = {
  me: Me;
  /** Fetches the account again, after a change to the organization, branches or roles. */
  refresh: () => Promise<void>;
  /** True for people who can change anyone's access (owners and admins). */
  canManageOrg: boolean;
  /**
   * May they do this? Company-wide permissions ignore the branch; others are checked in `branchId`
   * (on at least one of its numbers). The server always decides; this only hides what won't work.
   */
  can: (perm: Permission, branchId?: string | null) => boolean;
  /** Do they hold this permission in any branch? */
  canAnywhere: (perm: Permission) => boolean;
};

export function canFor(me: Me, perm: Permission, branchId?: string | null) {
  if (me.owner) return true;
  if (companyPermissions.has(perm) || !branchId) return me.permissions.includes(perm);
  return !!me.branches.find((b) => b.id === branchId)?.permissions.includes(perm);
}

const MeContext = createContext<MeContextValue | null>(null);

/**
 * Loads the signed-in account for everything inside it.
 * Sends the visitor to /sign-in when there is no session, and to /onboarding when they have no organization yet.
 */
export function MeProvider({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<Me>("/me");
      if (!next.organization) {
        router.replace("/onboarding");
        return;
      }
      setMe(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
        return;
      }
      setFailed(true);
    }
  }, [router, pathname]);

  // Load once on mount. `load` changes with the path, which must not trigger a refetch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    void load();
  }, []);

  const value = useMemo(
    () =>
      me
        ? {
            me,
            refresh: load,
            canManageOrg: me.owner || me.permissions.includes("team.edit_access"),
            can: (perm: Permission, branchId?: string | null) => canFor(me, perm, branchId),
            canAnywhere: (perm: Permission) =>
              me.owner ||
              me.permissions.includes(perm) ||
              me.branches.some((b) => b.permissions.includes(perm)),
          }
        : null,
    [me, load],
  );

  if (failed && !value) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <p>We could not load your account. Check your connection and try again.</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-muted"
          onClick={() => {
            setFailed(false);
            void load();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!value) return <>{fallback}</>;
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used inside <MeProvider>");
  return ctx;
}

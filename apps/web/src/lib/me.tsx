"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Me } from "./api";

type MeContextValue = {
  me: Me;
  /** Fetches the account again, after a change to the organization, branches or roles. */
  refresh: () => Promise<void>;
  /** True for organization owners and admins, who can manage every branch and the team. */
  canManageOrg: boolean;
};

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
    () => (me ? { me, refresh: load, canManageOrg: me.orgRole === "owner" || me.orgRole === "admin" } : null),
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

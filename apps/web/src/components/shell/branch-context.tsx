"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { useMe } from "@/lib/me";

/** A branch the signed-in person can reach, or the "All branches" choice. */
export type Branch = { id: string; name: string };

export const ALL_BRANCHES: Branch = { id: "all", name: "All branches" };

const STORAGE_KEY = "relay.branch";
const CHANGE_EVENT = "relay:branch-change";

/** Used when localStorage is unavailable (private mode, blocked site data). */
let memoryValue: string | null = null;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? memoryValue;
  } catch {
    return memoryValue;
  }
}

function writeStored(value: string) {
  memoryValue = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage is unavailable; the in-memory value keeps the choice for this visit.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

type BranchContextValue = {
  branches: Branch[];
  branch: Branch;
  setBranch: (id: string) => void;
};

const BranchContext = createContext<BranchContextValue | null>(null);

export function BranchProvider({ children }: { children: ReactNode }) {
  // The server and the first client render use "All branches"; the stored choice applies right after.
  const storedId = useSyncExternalStore(subscribe, readStored, () => null);
  const { me } = useMe();
  // "All branches" is only a choice when there is more than one branch to combine.
  const branches = useMemo<Branch[]>(
    () => (me.branches.length > 1 ? [...me.branches, ALL_BRANCHES] : me.branches),
    [me.branches],
  );
  const branch = branches.find((b) => b.id === storedId) ?? branches.at(-1) ?? ALL_BRANCHES;
  const setBranch = useCallback((id: string) => writeStored(id), []);
  const value = useMemo(() => ({ branches, branch, setBranch }), [branches, branch, setBranch]);
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranch(): BranchContextValue {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error("useBranch must be used inside <BranchProvider>");
  return ctx;
}

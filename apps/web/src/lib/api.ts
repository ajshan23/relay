/** Shapes returned by the API. Keep in step with docs/02-accounts-api.md. */

import type { Permission } from "@relay/core/permissions";

export type { Permission };
export type OrgRole = "owner" | "admin" | "member";
/** Built-in role keys (Admin, Manager, Agent, Viewer). */
export type BranchRole = "admin" | "manager" | "agent" | "viewer";

export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  organization: { id: string; name: string; slug: string } | null;
  /** Kept for older screens: "owner", "admin" (can change anyone's access) or "member". */
  orgRole: OrgRole | null;
  /** The company owner can do everything. */
  owner: boolean;
  /** What they may do across the company (numbers, team, roles, settings...). */
  permissions: Permission[];
  branches: BranchSummary[];
};

export type BranchSummary = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  /** The branch's logo, or null to show its initial. */
  logoUrl: string | null;
  /** Their role name(s) in this branch, or "Owner". */
  role: string | null;
  /** What they may do in this branch (on at least one of its numbers). */
  permissions: Permission[];
};
export type Branch = BranchSummary & { createdAt: string; memberCount: number };

/** One role given to someone, in some branches and numbers. */
export type AccessGrant = {
  id?: string;
  roleId: string;
  roleName?: string;
  allBranches: boolean;
  branchIds: string[];
  allNumbers: boolean;
  numberIds: string[];
};

export type BranchMember = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  owner: boolean;
  /** Their role name(s) here. */
  role: string;
  /** The grants that reach this branch. */
  grants: AccessGrant[];
  /** Their access here comes from the owner role or a grant for several branches: change it in Team. */
  inherited: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Calls the API through this app's /api proxy, with the session cookie. Throws ApiError on a non-2xx reply. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...rest,
    headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "request_failed", body?.message);
  return body as T;
}

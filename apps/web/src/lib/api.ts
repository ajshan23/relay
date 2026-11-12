/** Shapes returned by the API. Keep in step with docs/02-accounts-api.md. */

export type OrgRole = "owner" | "admin" | "member";
export type BranchRole = "manager" | "agent" | "viewer";

export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  organization: { id: string; name: string; slug: string } | null;
  orgRole: OrgRole | null;
  branches: BranchSummary[];
};

export type BranchSummary = { id: string; name: string; slug: string; timezone: string; role: BranchRole };
export type Branch = BranchSummary & { createdAt: string; memberCount: number };

export type BranchMember = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  orgRole: OrgRole;
  /** Null when the person reaches this branch only through their organization role. */
  branchRole: BranchRole | null;
  /** True for organization owners and admins, who can manage every branch. */
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

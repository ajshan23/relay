import type { OrgRole } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { unwrap } from "./words";

export type OrgMember = {
  /** The organization membership id, used by Better Auth to change or remove the member. */
  memberId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: OrgRole;
  createdAt: Date;
};

/** Everyone in the active organization, oldest first. */
export async function listOrgMembers(): Promise<OrgMember[]> {
  const data = await unwrap(
    authClient.organization.listMembers({
      query: { limit: 500, sortBy: "createdAt", sortDirection: "asc" },
    }),
  );
  return (data?.members ?? []).map((m) => ({
    memberId: m.id,
    userId: m.userId,
    name: m.user.name || m.user.email,
    email: m.user.email,
    image: m.user.image ?? null,
    role: (m.role === "owner" || m.role === "admin" ? m.role : "member") as OrgRole,
    createdAt: new Date(m.createdAt),
  }));
}

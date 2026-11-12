# Accounts API contract

Step 2 of the build: accounts, organizations, branches and per-branch roles.
The browser calls everything through the web app's `/api` proxy, so cookies are first-party.

## Who owns what

- **Better Auth** (`/api/auth/*`): users, sign-in, sessions, organizations, organization members, invitations.
  Organization roles are `owner`, `admin`, `member`. The active organization is on the session (`activeOrganizationId`).
- **Ours**: `branch` and `branch_member` tables (`packages/db/src/schema/branches.ts`). Branch roles are `manager`, `agent`, `viewer`.

## Access rule

- Organization **owner** and **admin** can reach and manage every branch. They need no `branch_member` row and appear as an inherited manager.
- Organization **member** can reach only the branches they have a `branch_member` row for, with that row's role.
- A branch **manager** can rename the branch and manage its members. **agent** and **viewer** cannot.

## Routes (all need a session; 401 `unauthenticated` otherwise)

Every route below works on the session's active organization. If there is none: `409 { "error": "no_active_organization" }`.
Errors are `{ "error": "<code>", "message"?: "<human text>" }`.

| Method and path | Who | Body | Success |
|---|---|---|---|
| `GET /api/me` | anyone signed in (works with no organization) | | `200 Me` |
| `GET /api/branches` | member | | `200 { branches: Branch[] }` (only those the caller can reach, not archived) |
| `POST /api/branches` | owner, admin | `{ name, timezone? }` | `201 { branch: Branch }`. Slug is made from the name; add `-2`, `-3` on a clash |
| `PATCH /api/branches/:id` | owner, admin, branch manager | `{ name?, timezone? }` | `200 { branch: Branch }` |
| `DELETE /api/branches/:id` | owner, admin | | `204`. Archives, never deletes. `409 last_branch` if it is the only active branch |
| `GET /api/branches/:id/members` | anyone who can reach the branch | | `200 { members: BranchMember[] }` (inherited owners and admins included) |
| `PUT /api/branches/:id/members/:userId` | owner, admin, branch manager | `{ role }` | `200 { member: BranchMember }`. `422 not_in_organization` if the user is not an organization member |
| `DELETE /api/branches/:id/members/:userId` | owner, admin, branch manager | | `204` |

Other codes: `403 forbidden`, `404 not_found` (also used when the branch belongs to another organization), `422 invalid_input`.

The response types are in `apps/web/src/lib/api.ts`.

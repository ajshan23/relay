# Accounts, roles and permissions

Accounts, companies, branches, and who may do what. The browser calls everything through the web app's `/api` proxy, so cookies are first-party.

## Who owns what

- **Better Auth** (`/api/auth/*`): users, sign-in, sessions, companies (organizations), members and accepting invitations. `member.role` only marks the **owner**; everyone else is `member` (old rows may say `admin`, which is no longer read). The active company is on the session (`activeOrganizationId`).
- **Ours**: branches, numbers, roles and grants.
  - `branch`.
  - `channel_account.branch_id`: every number belongs to exactly one branch.
  - `role`.
  - `member_grant`.
  - `invitation_grant`.
  - The rules live in `packages/core/src/permissions.ts`; nothing else decides access.

## The model

- **Permissions** are a fixed catalogue in code (`permissionGroups`): chats, contacts, broadcasts, templates, automations, AI agent, catalogue, bookings, quick replies, groups, branch, numbers, team and company. Adding one needs no migration.
- **Roles** are sets of permissions.
  - Every company has four built-in roles: **Admin** (everything), **Manager**, **Agent** and **Viewer**. Their permissions come from code, so they can't be edited, only copied.
  - A company can make its own roles by ticking permissions.
- **Grants** give a person one role, in:
  - **branches**: all of them (including ones added later) or picked ones;
  - **numbers**: all numbers in those branches (including new ones) or picked ones. A picked number must sit in a chosen branch.
- A person can hold several grants, for example Manager in Marina and Agent in JBR.
- The **owner** needs no grant and can always do everything.

Rules:
1. **One grant at a time.** A permission counts only inside the branches and numbers of the same grant. Reach from one grant never combines with a permission from another.
2. **Company-wide permissions need a grant covering every branch and every number.** These are numbers, team, roles, branches create and close, company settings, usage, contact fields and tags, and catalogue types. They are marked "Whole company" in the role editor.
3. **Chats:**
   - `chats.view_all` sees every chat on the grant's numbers.
   - `chats.view_unassigned` sees your own chats plus unassigned ones.
   - `chats.view` sees only chats assigned to you.
   - Taking a chat for yourself needs `chats.reply`. Giving it to someone else, closing or snoozing needs `chats.assign`. Only people who may reply on a chat's number can be assigned it.
4. **Templates** live on numbers. Seeing a template needs `templates.view` on one of its numbers; changing it needs `templates.manage` on all of them.
5. **Nobody hands out or takes away more than they hold.** When saving a grant, the person saving must hold every permission of that role in every branch and number it covers. Only people who hold everything a role allows can make or change that role. Nobody changes their own access, and the owner's access never changes.
6. **Live updates** (`/api/events`) reach only people who may see that chat. Access is re-read at most every minute.

## Routes

All routes need a session (otherwise `401 unauthenticated`) and work on the session's active company (otherwise `409 no_active_organization`). Errors are `{ "error": "<code>", "message"?: "<human text>" }`.

### Who you are

`GET /api/me` (anyone signed in) returns:
- `user` and `organization`;
- `owner`;
- `permissions`: the company-wide permissions they hold;
- `branches`: the branches they can reach, each with `role` (their role names there) and `permissions` (what they may do there).

### Branches

| Method and path | Needs | Body | Success |
|---|---|---|---|
| `GET /api/branches` | any grant | | `200 { branches }`, only the branches they can reach |
| `POST /api/branches` | `branches.create` | `{ name, timezone? }` | `201 { branch }` |
| `PATCH /api/branches/:id` | `branches.edit` there | `{ name?, timezone? }` | `200 { branch }` |
| `DELETE /api/branches/:id` | `branches.delete` | | `204`. Archives the branch. `409 last_branch` if it's the only one |
| `GET /api/branches/:id/members` | reach | | `200 { members, roles, numbers, canManage }` |
| `PUT /api/branches/:id/members/:userId` | `branches.people` there, or `team.edit_access` | `{ roleId \| role, allNumbers, numberIds }` | `200 { member }`. Replaces their access made just for this branch |
| `DELETE /api/branches/:id/members/:userId` | the same | | `204`. Grants just for this branch go; grants for several branches lose this one |

### Team and roles

| Method and path | Needs | Body | Success |
|---|---|---|---|
| `GET /api/team` | `team.view` | | people with their grants, pending invitations, roles, branches and numbers |
| `PUT /api/team/:userId/access` | `team.edit_access` | `{ grants: Grant[] }` | `200`. Replaces all their grants |
| `DELETE /api/team/:userId` | `team.remove` | | `204`. Their open chats become unassigned |
| `POST /api/team/invitations` | `team.invite` | `{ email, grants }` | `201`. The grants apply when they accept |
| `DELETE /api/team/invitations/:id` | `team.invite` | | `204` |
| `GET /api/roles` | `team.view` | | roles with permissions and people counts, plus the catalogue |
| `POST /api/roles` | `roles.manage` | `{ name, description, permissions }` | `201` |
| `PATCH /api/roles/:id` | `roles.manage` | the same | `200`. Built-in roles: `409 built_in` |
| `DELETE /api/roles/:id` | `roles.manage` | | `204`. `409 in_use` while anyone has it |

A `Grant` is `{ roleId, allBranches, branchIds, allNumbers, numberIds }`.

### Other codes

- `403 forbidden`, with a message.
- `404 not_found`, also used for things in branches or numbers you can't reach.
- `409 own_access`: nobody changes their own access.
- `409 owner`: the owner's access never changes.
- `422 invalid_input`.
- `422 invalid_assignee`.

## Tests

- **Core rules:** `packages/core/test/permissions.test.ts`.
- **End to end over HTTP** on the local drill database: `apps/api/test/access.test.ts`.

The response types are in `apps/web/src/lib/api.ts`.

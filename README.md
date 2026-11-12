# Relay (working name)

Customer conversations, AI agents and automation. Built from scratch as a successor to FlowFlex.

## Layout

```
apps/web       Next.js + shadcn/ui      http://localhost:3200
apps/api       Hono API                 http://localhost:3201
apps/worker    BullMQ worker
apps/lab       Design lab: one MVP in six structures and six colour designs   http://localhost:3210
packages/core  env validation, IDs, queue names
packages/db    Drizzle schema and client (Postgres)
packages/ui    design system: tokens, shadcn primitives, common components
docs/          plans
research/      Meta platform research
rivals/        competitor reviews
opensource/    reference repos (not part of the product)
```

Inside the API, each feature is a folder under `apps/api/src/modules`. A module owns its routes, logic and queries; other modules use it only through its exports.

## Run locally

```bash
pnpm install
pnpm db:up        # Postgres on 5544, Redis on 6390 (Docker)
pnpm dev          # web, api and worker together
```

Other commands: `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:down`.

Copy `.env.example` to `.env` before the first run.

## Notes

- pnpm is pinned to 10.x in `package.json` because this machine's corepack cannot run pnpm 12.
- shadcn components are copied in by hand from the local clone in `opensource/08-saas-foundations/ui`, because `ui.shadcn.com` is not reachable from this network. `components.json` is in place for when the CLI works.

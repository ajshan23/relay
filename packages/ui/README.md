# @relay/ui

The product's design system. Pages are built only from what is in here.

## Layout

```
src/styles/globals.css   tokens: FlowFlex light (:root) and FlowFlex dark (.dark), Inter, 4px corners
src/lib/utils.ts         cn()
src/ui/*                 shadcn primitives, copied in and restyled. Low level.
src/components/*         our common components, built from src/ui. Pages import these.
```

Import as `@relay/ui/ui/button`, `@relay/ui/components/modal`, `@relay/ui/lib/utils`.
Inside the package use relative imports (`../ui/button`, `../lib/utils`).

## Rules

1. **No raw colours.** Use token classes only: `bg-background`, `bg-card`, `bg-muted`, `text-foreground`,
   `text-muted-foreground`, `bg-primary text-primary-foreground`, `bg-accent text-accent-foreground`,
   `border-border`, `text-destructive`, `bg-danger-soft`, `text-good`, `bg-good-soft`,
   `text-warning`, `bg-warning-soft`, and for the sidebar `bg-nav`, `text-nav-foreground`,
   `text-nav-muted`, `bg-nav-active`, `border-nav-border`.
2. **Violet-lilac means the AI did it.** `bg-ai text-ai-foreground` for tints,
   `bg-ai-strong text-ai-strong-foreground` for solid marks. Never use these for anything else.
3. **Corners come from the scale.** `rounded-sm` (2px), `rounded-md` (4px, the default), `rounded-lg` (6px),
   `rounded-xl` (8px), `rounded-full` for pills and avatars. No arbitrary radius values.
4. **Type.** Inter only. Body 14px (`text-sm`), dense rows 13px (`text-[13px]`), page titles `text-2xl font-semibold tracking-tight`.
5. **Both themes.** Everything must read well in light and dark. Never use `dark:` to hard-code a colour; change the token.
6. **Accessible by default.** Real `<button>`s, labels tied to inputs, visible focus, `aria-label` on icon-only buttons.
7. **Pages never import from `src/ui` when a common component exists.** A modal is `Modal`, a table is `DataTable`,
   an icon is `Icon`. If a page needs something new, add it here first.
8. **Wording.** Sentence case, plain verbs, a button says what it does ("Save changes", not "Submit").
9. **`"use client"`** at the top of any file that uses state, effects, event handlers or Radix components.

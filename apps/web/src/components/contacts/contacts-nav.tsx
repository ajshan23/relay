"use client";

import { Icon } from "@relay/ui/components/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { builtInViews } from "./contacts-page";
import { useContactsMeta, useLists } from "./queries";

/** The sidebar sub-menu for Contacts: the built-in views, the views people saved, then lists. */
export function ContactsNav({ itemClass }: { itemClass: (active: boolean) => string }) {
  const params = useSearchParams();
  const meta = useContactsMeta();
  const lists = useLists();
  const listId = params.get("list");
  // A list page isn't one of the views.
  const view = listId ? null : (params.get("view") ?? "all");
  const saved = meta.data?.views ?? [];
  const href = (id: string) => (id === "all" ? "/contacts" : `/contacts?view=${id}`);
  return (
    <>
      <div className="flex flex-col gap-px">
        <p className="mb-0.5 px-2 text-xs text-nav-muted">Contacts</p>
        {Object.entries(builtInViews).map(([id, v]) => (
          <Link
            key={id}
            href={href(id)}
            aria-current={view === id ? "page" : undefined}
            className={itemClass(view === id)}
          >
            <span className="truncate">{v.label}</span>
          </Link>
        ))}
      </div>
      {saved.length ? (
        <div className="mt-4 flex flex-col gap-px">
          <p className="mb-0.5 px-2 text-xs text-nav-muted">Saved views</p>
          {saved.map((v) => (
            <Link
              key={v.id}
              href={href(v.id)}
              aria-current={view === v.id ? "page" : undefined}
              className={itemClass(view === v.id)}
            >
              <span className="flex-1 truncate">{v.name}</span>
              {v.shared ? (
                <Icon name="users" size="xs" className="shrink-0 text-nav-muted" label="Shared" />
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-px">
        <p className="mb-0.5 px-2 text-xs text-nav-muted">Lists</p>
        {(lists.data?.lists ?? []).map((l) => (
          <Link
            key={l.id}
            href={`/contacts?list=${l.id}`}
            aria-current={listId === l.id ? "page" : undefined}
            className={itemClass(listId === l.id)}
          >
            {l.kind === "smart" ? (
              <Icon name="zap" size="xs" className="shrink-0 text-nav-muted" label="Smart list" />
            ) : null}
            <span className="flex-1 truncate">{l.name}</span>
            <span className="text-xs text-nav-muted tabular-nums">{l.count.toLocaleString()}</span>
          </Link>
        ))}
        {lists.data && !lists.data.lists.length ? (
          <p className="px-2 text-xs text-nav-muted">
            Select contacts and add them to a list, or save your filters as a smart list.
          </p>
        ) : null}
      </div>
    </>
  );
}

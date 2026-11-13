"use client";

import { Icon } from "@relay/ui/components/icon";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { builtInViews } from "./contacts-page";
import { useContactsMeta } from "./queries";

/** The sidebar sub-menu for Contacts: the built-in views, then the views people saved. */
export function ContactsNav({ itemClass }: { itemClass: (active: boolean) => string }) {
  const params = useSearchParams();
  const meta = useContactsMeta();
  const view = params.get("view") ?? "all";
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
    </>
  );
}

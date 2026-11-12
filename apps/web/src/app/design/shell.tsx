import {
  BarChart3,
  ChevronsUpDown,
  Home,
  Megaphone,
  MessageCircle,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

export type ScreenId = "home" | "inbox" | "agent";

/** The agent's face. It is the product's one recurring character, so it stays simple and ours. */
export function AgentFace({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Mira, your AI agent">
      <rect width="32" height="32" rx="11" fill="var(--primary)" />
      <circle cx="11.5" cy="14" r="2" fill="var(--primary-ink)" />
      <circle cx="20.5" cy="14" r="2" fill="var(--primary-ink)" />
      <path
        d="M11 20c1.4 1.7 3.1 2.5 5 2.5s3.600-.8 5-2.500"
        stroke="var(--primary-ink)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{ width: size, height: size, background: "var(--surface-2)", color: "var(--ink)" }}
    >
      {initials}
    </span>
  );
}

const rail: { id: ScreenId | null; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <Home size={19} /> },
  { id: "inbox", label: "Inbox", icon: <MessageCircle size={19} /> },
  { id: "agent", label: "Agents", icon: <AgentFace size={22} /> },
  { id: null, label: "Contacts", icon: <Users size={19} /> },
  { id: null, label: "Campaigns", icon: <Megaphone size={19} /> },
  { id: null, label: "Insights", icon: <BarChart3 size={19} /> },
];

export type NavGroup = { title: string; items: { label: string; count?: number; current?: boolean }[] };

export function Shell({
  screen,
  onNavigate,
  title,
  groups,
  actions,
  children,
}: {
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  title: ReactNode;
  groups?: NavGroup[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 p-2">
      <nav aria-label="Main" className="hidden w-12 shrink-0 flex-col items-center gap-1 py-1 md:flex">
        {rail.map((item) => {
          const current = item.id === screen;
          return (
            <button
              key={item.label}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={current ? "page" : undefined}
              onClick={() => item.id && onNavigate(item.id)}
              className="d-nav d-muted inline-flex size-10 items-center justify-center rounded-[10px]"
            >
              {item.icon}
            </button>
          );
        })}
        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          className="d-nav d-muted mt-auto inline-flex size-10 items-center justify-center rounded-[10px]"
        >
          <Settings size={19} />
        </button>
        <Avatar name="Priya Shah" />
      </nav>

      <div className="d-frame flex min-w-0 flex-1 overflow-hidden">
        {groups ? (
          <aside
            aria-label={`${rail.find((r) => r.id === screen)?.label ?? ""} menu`}
            className="d-line hidden w-56 shrink-0 flex-col gap-5 overflow-y-auto border-r p-3 lg:flex"
          >
            {groups.map((group) => (
              <div key={group.title} className="flex flex-col gap-0.5">
                <h2 className="px-2 pb-1 text-xs font-semibold">{group.title}</h2>
                {group.items.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    aria-current={item.current ? "page" : undefined}
                    className="d-nav d-muted flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm"
                  >
                    <span>{item.label}</span>
                    {item.count ? <span className="text-xs">{item.count}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </aside>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="d-line flex h-14 shrink-0 items-center gap-3 border-b px-4">
            <div className="flex min-w-0 items-center gap-2.5 text-sm font-semibold">{title}</div>
            <div className="ml-auto flex items-center gap-2">
              {actions}
              <button
                type="button"
                aria-label="Search"
                className="d-nav d-muted inline-flex size-9 items-center justify-center rounded-lg"
              >
                <Search size={17} />
              </button>
              <button
                type="button"
                className="d-btn-quiet inline-flex h-9 items-center gap-2 px-3 text-sm"
                aria-label="Switch branch. Current branch: Marina"
              >
                Marina branch
                <ChevronsUpDown size={14} className="d-muted" />
              </button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
        </div>
      </div>
    </div>
  );
}

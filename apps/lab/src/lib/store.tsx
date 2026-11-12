"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AnswerKind, answerKind, type Chat, type Need, type PageId, seedChats, seedNeeds } from "./data";
import {
  type CornerId,
  corners,
  type FontId,
  fonts,
  type SidebarId,
  type StructureId,
  sidebars,
  structures,
  type ThemeId,
  themes,
} from "./themes";

type Thread = { q: string; kind: AnswerKind; stage: "thinking" | "done" } | null;

type Lab = {
  structure: StructureId;
  setStructure: (s: StructureId) => void;
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  sidebar: SidebarId;
  setSidebar: (s: SidebarId) => void;
  corner: CornerId;
  setCorner: (c: CornerId) => void;
  font: FontId;
  setFont: (f: FontId) => void;
  page: PageId;
  go: (p: PageId) => void;
  branch: string;
  setBranch: (b: string) => void;
  chats: Chat[];
  chatId: string;
  openChat: (id: string) => void;
  reply: (text: string) => void;
  takeOver: () => void;
  markDone: () => void;
  draftUsed: boolean;
  applyDraft: () => void;
  pendingDraft: string;
  clearDraft: () => void;
  needs: Need[];
  resolveNeed: (id: string) => void;
  thread: Thread;
  ask: (q: string, instant?: boolean) => void;
  closeThread: () => void;
  panel: boolean;
  setPanel: (open: boolean) => void;
  sent: boolean;
  toggleSent: () => void;
  toast: string;
  notify: (text: string) => void;
  palette: boolean;
  setPalette: (open: boolean) => void;
};

const Ctx = createContext<Lab | null>(null);
export const useLab = () => {
  const lab = useContext(Ctx);
  if (!lab) throw new Error("useLab must be used inside LabProvider");
  return lab;
};

function saved<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(key);
    const value = (fromUrl ?? window.localStorage.getItem(`lab-${key}`)) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(`lab-${key}`, value);
  } catch {
    // Storage can be unavailable in private windows; the choice still applies for this visit.
  }
}

export function LabProvider({ children }: { children: ReactNode }) {
  const [structure, setStructureState] = useState<StructureId>("linear");
  const [theme, setThemeState] = useState<ThemeId>("poppy");
  const [sidebar, setSidebarState] = useState<SidebarId>("double");
  const [corner, setCornerState] = useState<CornerId>("soft");
  const [font, setFontState] = useState<FontId>("figtree");
  const [page, setPage] = useState<PageId>("home");
  const [branch, setBranch] = useState("Marina");
  const [chats, setChats] = useState<Chat[]>(seedChats);
  const [chatId, setChatId] = useState("daniel");
  const [draftUsed, setDraftUsed] = useState(false);
  const [pendingDraft, setPendingDraft] = useState("");
  const [needs, setNeeds] = useState<Need[]>(seedNeeds);
  const [thread, setThread] = useState<Thread>(null);
  const [panel, setPanel] = useState(true);
  const [sent, setSent] = useState(false);
  const [toast, setToast] = useState("");
  const [palette, setPalette] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the last choices after mount, so server and first client render match.
  useEffect(() => {
    setStructureState(
      saved<StructureId>(
        "structure",
        structures.map((x) => x.id),
        "linear",
      ),
    );
    setThemeState(
      saved<ThemeId>(
        "theme",
        themes.map((t) => t.id),
        "poppy",
      ),
    );
    setSidebarState(
      saved<SidebarId>(
        "sidebar",
        sidebars.map((x) => x.id),
        "double",
      ),
    );
    setCornerState(
      saved<CornerId>(
        "corner",
        corners.map((c) => c.id),
        "soft",
      ),
    );
    setFontState(
      saved<FontId>(
        "font",
        fonts.map((f) => f.id),
        "figtree",
      ),
    );
  }, []);

  // Apply the colour design to <html> so portals (dialogs, menus, sheets) are themed too.
  useEffect(() => {
    const root = document.documentElement;
    const t = themes.find((x) => x.id === theme) ?? themes[0];
    if (!t) return;
    for (const [name, value] of Object.entries(t.vars)) root.style.setProperty(name, value);
    root.classList.toggle("dark", t.dark);
    root.style.colorScheme = t.dark ? "dark" : "light";
    root.style.setProperty("--radius", `${corners.find((c) => c.id === corner)?.px ?? 10}px`);
    const f = fonts.find((x) => x.id === font) ?? fonts[0];
    root.style.setProperty("--font-body", f.body);
    root.style.setProperty("--font-head", f.head);
  }, [theme, corner, font]);

  const notify = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  const value = useMemo<Lab>(() => {
    const open = chats.find((c) => c.id === chatId) ?? chats[0];
    const patch = (id: string, change: (c: Chat) => Chat) =>
      setChats((list) => list.map((c) => (c.id === id ? change(c) : c)));
    return {
      structure,
      setStructure: (s) => {
        setStructureState(s);
        remember("structure", s);
        setPage("home");
        setThread(null);
      },
      theme,
      setTheme: (t) => {
        setThemeState(t);
        remember("theme", t);
      },
      sidebar,
      setSidebar: (v) => {
        setSidebarState(v);
        remember("sidebar", v);
      },
      corner,
      setCorner: (c) => {
        setCornerState(c);
        remember("corner", c);
      },
      font,
      setFont: (f) => {
        setFontState(f);
        remember("font", f);
      },
      page,
      go: (p) => {
        setPage(p);
        if (p === "home") setThread(null);
      },
      branch,
      setBranch,
      chats,
      chatId: open?.id ?? "",
      openChat: (id) => {
        setChatId(id);
        setPendingDraft("");
        patch(id, (c) => ({ ...c, unread: 0 }));
      },
      reply: (text) => {
        if (!open) return;
        patch(open.id, (c) => ({
          ...c,
          unread: 0,
          preview: `You: ${text}`,
          who: c.who === "Needs a person" ? "Priya" : c.who,
          lines: [...c.lines, { by: "you", text }],
        }));
        setPendingDraft("");
      },
      takeOver: () => {
        if (!open) return;
        patch(open.id, (c) => ({
          ...c,
          who: "Priya",
          lines: [...c.lines, { by: "note", text: "You took over from Mira" }],
        }));
        notify("You're replying now. Mira has stopped.");
      },
      markDone: () => {
        if (!open) return;
        const rest = chats.filter((c) => c.id !== open.id);
        setChats(rest);
        setChatId(rest[0]?.id ?? "");
        setPendingDraft("");
        notify(`${open.name} marked done`);
      },
      draftUsed,
      applyDraft: () => {
        setDraftUsed(true);
        setPendingDraft("draft");
      },
      pendingDraft,
      clearDraft: () => setPendingDraft(""),
      needs,
      resolveNeed: (id) => {
        setNeeds((list) => list.filter((n) => n.id !== id));
        notify("Marked as done");
      },
      thread,
      ask: (q, instant) => {
        const text = q.trim() || "Offer 10% off cleanings to lapsed patients";
        setPage("home");
        setPanel(true);
        setThread({ q: text, kind: answerKind(text), stage: instant ? "done" : "thinking" });
        if (!instant)
          setTimeout(() => setThread((t) => (t && t.q === text ? { ...t, stage: "done" } : t)), 1100);
      },
      closeThread: () => setThread(null),
      panel,
      setPanel,
      sent,
      toggleSent: () => {
        notify(sent ? "Sending cancelled" : "Scheduled for 5:00 pm today");
        setSent(!sent);
      },
      toast,
      notify,
      palette,
      setPalette,
    };
  }, [
    structure,
    theme,
    sidebar,
    corner,
    font,
    page,
    branch,
    chats,
    chatId,
    draftUsed,
    pendingDraft,
    needs,
    thread,
    panel,
    sent,
    toast,
    palette,
    notify,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

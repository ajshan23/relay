"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useLab } from "@/lib/store";
import { corners, fonts, sidebars, structures, themes } from "@/lib/themes";

/*
 * The design switcher. It is deliberately styled with fixed neutral colours,
 * so it stays the same while everything under it changes.
 */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 items-center gap-2">
      <legend className="float-left mr-1 shrink-0 text-xs font-semibold text-neutral-400">{label}</legend>
      <div className="flex flex-wrap gap-1">{children}</div>
    </fieldset>
  );
}

function Option({
  on,
  onClick,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-offset-2 focus-visible:outline-2 focus-visible:outline-white ${
        on ? "bg-white text-neutral-950" : "bg-neutral-800 text-neutral-200 hover:bg-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

export function LabBar() {
  const lab = useLab();
  const [open, setOpen] = useState(true);
  const structure = structures.find((s) => s.id === lab.structure);
  const theme = themes.find((t) => t.id === lab.theme);

  return (
    <div
      className="shrink-0 bg-neutral-950 text-neutral-100"
      style={{ fontFamily: "system-ui, sans-serif", colorScheme: "dark" }}
    >
      <div className="flex items-center gap-3 px-3 py-1.5">
        <span className="text-xs font-semibold">Design lab</span>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">
          {structure?.name} structure in {theme?.name}. {structure?.note}
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          {open ? "Hide options" : "Show options"}
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>
      {open ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-neutral-800 px-3 py-2">
          <Group label="Structure">
            {structures.map((s, i) => (
              <Option
                key={s.id}
                on={lab.structure === s.id}
                onClick={() => lab.setStructure(s.id)}
                title={s.note}
              >
                {i + 1}. {s.name}
              </Option>
            ))}
          </Group>
          <Group label="Sidebar">
            {sidebars.map((x) => (
              <Option
                key={x.id}
                on={lab.sidebar === x.id}
                onClick={() => lab.setSidebar(x.id)}
                title={x.note}
              >
                {x.name}
              </Option>
            ))}
          </Group>
          <Group label="Colour">
            {themes.map((t) => (
              <Option key={t.id} on={lab.theme === t.id} onClick={() => lab.setTheme(t.id)} title={t.note}>
                <span className="flex overflow-hidden rounded-full ring-1 ring-neutral-500">
                  {t.swatch.map((c) => (
                    <span key={c} className="size-3" style={{ background: c }} />
                  ))}
                </span>
                {t.name}
              </Option>
            ))}
          </Group>
          <Group label="Corners">
            {corners.map((c) => (
              <Option key={c.id} on={lab.corner === c.id} onClick={() => lab.setCorner(c.id)}>
                {c.name}
              </Option>
            ))}
          </Group>
          <Group label="Type">
            {fonts.map((f) => (
              <Option key={f.id} on={lab.font === f.id} onClick={() => lab.setFont(f.id)}>
                {f.name}
              </Option>
            ))}
          </Group>
        </div>
      ) : null}
    </div>
  );
}

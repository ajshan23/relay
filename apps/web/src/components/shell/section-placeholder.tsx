import { Suspense } from "react";
import { currentSubTopic, getSection, type SectionId } from "./nav-config";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function SelectedView({ id, searchParams }: { id: SectionId; searchParams: SearchParams }) {
  const raw = (await searchParams).view;
  const view = Array.isArray(raw) ? raw[0] : raw;
  const topic = currentSubTopic(getSection(id), view);
  return (
    <p className="mt-4 text-sm text-muted-foreground">
      Selected view: <span className="font-medium text-foreground">{topic?.label ?? view ?? "none"}</span>
    </p>
  );
}

/** Placeholder for a section until its real page is built. */
export function SectionPlaceholder({ id, searchParams }: { id: SectionId; searchParams: SearchParams }) {
  const section = getSection(id);
  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight">{section.label}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{section.summary}</p>
      {/* searchParams is request data, so it renders in its own boundary and the rest stays prerendered. */}
      <Suspense fallback={null}>
        <SelectedView id={id} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

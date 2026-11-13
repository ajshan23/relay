import { EditTemplate } from "@/components/templates/pages";

/** Driven by the URL (?from= or the template id) and live data: nothing to prerender. */
export const instant = false;

export default async function Page({ params }: PageProps<"/settings/templates/[id]">) {
  const { id } = await params;
  return <EditTemplate id={id} />;
}

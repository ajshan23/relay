import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/contacts">) {
  return <SectionPlaceholder id="contacts" searchParams={searchParams} />;
}

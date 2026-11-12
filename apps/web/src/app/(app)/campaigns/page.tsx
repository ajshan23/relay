import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/campaigns">) {
  return <SectionPlaceholder id="campaigns" searchParams={searchParams} />;
}

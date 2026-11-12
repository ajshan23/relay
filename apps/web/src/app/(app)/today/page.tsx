import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/today">) {
  return <SectionPlaceholder id="today" searchParams={searchParams} />;
}

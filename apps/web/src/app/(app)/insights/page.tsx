import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/insights">) {
  return <SectionPlaceholder id="insights" searchParams={searchParams} />;
}

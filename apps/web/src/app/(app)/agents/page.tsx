import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/agents">) {
  return <SectionPlaceholder id="agents" searchParams={searchParams} />;
}

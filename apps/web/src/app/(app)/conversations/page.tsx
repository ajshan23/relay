import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/conversations">) {
  return <SectionPlaceholder id="conversations" searchParams={searchParams} />;
}

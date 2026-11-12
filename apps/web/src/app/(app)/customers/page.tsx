import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/customers">) {
  return <SectionPlaceholder id="customers" searchParams={searchParams} />;
}

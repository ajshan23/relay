import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export default function Page({ searchParams }: PageProps<"/broadcasts">) {
  return <SectionPlaceholder id="broadcasts" searchParams={searchParams} />;
}

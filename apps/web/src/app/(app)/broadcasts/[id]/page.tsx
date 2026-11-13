import { BroadcastDetail } from "@/components/broadcasts/detail";

export const instant = false;

export default async function Page({ params }: PageProps<"/broadcasts/[id]">) {
  const { id } = await params;
  return <BroadcastDetail id={id} />;
}

import { BroadcastEditor } from "@/components/broadcasts/editor";

export const instant = false;

export default async function Page({ params }: PageProps<"/broadcasts/[id]/edit">) {
  const { id } = await params;
  return <BroadcastEditor id={id} />;
}

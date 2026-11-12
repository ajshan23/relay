import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptInvitation } from "@/components/account/accept-invitation";
import { AuthLoading } from "@/components/account/auth-frame";

export const metadata: Metadata = { title: "Join a business · Relay" };

/** The id comes from the link, so it is read inside Suspense and the frame still prerenders. */
async function WithId({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AcceptInvitation id={id} />;
}

export default function AcceptInvitationPage({ params }: PageProps<"/accept-invitation/[id]">) {
  return (
    <Suspense fallback={<AuthLoading />}>
      <WithId params={params} />
    </Suspense>
  );
}

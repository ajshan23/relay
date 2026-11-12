"use client";

import { Icon } from "@relay/ui/components/icon";
import { Button } from "@relay/ui/ui/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient, signOut, useSession } from "@/lib/auth-client";
import { AuthHeading, AuthLoading } from "./auth-frame";
import { authErrorMessage, withNext } from "./auth-helpers";

type Invitation = {
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
  role: string;
};

type Load =
  | { state: "loading" }
  | { state: "ready"; invitation: Invitation }
  | { state: "error"; code: string | undefined; message: string };

const roleWords: Record<string, { label: string; title: string; detail: string }> = {
  owner: {
    label: "an owner",
    title: "Owner",
    detail: "You'll be able to manage everything, including every branch and the team.",
  },
  admin: { label: "an admin", title: "Admin", detail: "You'll be able to manage every branch and the team." },
  member: {
    label: "a team member",
    title: "Team member",
    detail: "You'll work in the branches you're added to.",
  },
};

/** Join a business from an invitation link. Signed-out visitors are sent to sign in or sign up first. */
export function AcceptInvitation({ id }: { id: string }) {
  const { data: session, isPending } = useSession();

  if (isPending) return <AuthLoading />;
  if (!session) return <SignedOut id={id} />;
  return <SignedIn id={id} email={session.user.email} />;
}

function SignedOut({ id }: { id: string }) {
  const back = `/accept-invitation/${id}`;
  return (
    <>
      <AuthHeading
        title="You've been invited to a team on Relay"
        description="Sign in, or create an account with the email address the invitation was sent to. You'll come straight back here to join."
      />
      <div className="flex flex-col gap-2">
        <Button asChild className="h-10 w-full text-[14px]">
          <Link href={withNext("/sign-in", back)}>Sign in</Link>
        </Button>
        <Button asChild variant="outline" className="h-10 w-full text-[14px]">
          <Link href={withNext("/sign-up", back)}>Create account</Link>
        </Button>
      </div>
    </>
  );
}

function SignedIn({ id, email }: { id: string; email: string }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authClient.organization
      .getInvitation({ query: { id } })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (data) setLoad({ state: "ready", invitation: data });
        else
          setLoad({
            state: "error",
            code: error?.code,
            message: authErrorMessage(
              error,
              "We couldn't open this invitation. Check the link, or ask for a new one.",
            ),
          });
      })
      .catch(() => {
        if (!cancelled)
          setLoad({
            state: "error",
            code: undefined,
            message: "We couldn't open this invitation. Try again.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function join(invitation: Invitation) {
    setJoining(true);
    setJoinError(null);
    const { error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error) {
      setJoinError(authErrorMessage(error, "Couldn't join. Try again."));
      setJoining(false);
      return;
    }
    await authClient.organization.setActive({ organizationId: invitation.organizationId });
    router.replace("/today");
    router.refresh();
  }

  if (load.state === "loading") return <AuthLoading label="Opening your invitation" />;

  if (load.state === "error") {
    const wrongPerson = load.code === "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";
    return (
      <>
        <AuthHeading title="This invitation can't be used" />
        <div className="flex flex-col gap-4">
          <p className="flex gap-2 text-sm">
            <Icon name="alert" className="mt-0.5 shrink-0 text-muted-foreground" />
            <span>
              {load.message}
              {wrongPerson ? ` You're signed in as ${email}.` : null}
            </span>
          </p>
          {wrongPerson ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                await signOut();
                router.replace(withNext("/sign-in", `/accept-invitation/${id}`));
              }}
            >
              Sign in with another email
            </Button>
          ) : (
            <Button asChild variant="outline" className="w-full">
              <Link href="/today">Go to Relay</Link>
            </Button>
          )}
        </div>
      </>
    );
  }

  const { invitation } = load;
  const role = roleWords[invitation.role] ?? { label: invitation.role, title: invitation.role, detail: "" };

  return (
    <>
      <AuthHeading
        title={`Join ${invitation.organizationName}`}
        description={`${invitation.inviterEmail} invited you to join as ${role.label}.`}
      />
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Business</dt>
          <dd className="truncate font-medium">{invitation.organizationName}</dd>
          <dt className="text-muted-foreground">Your role</dt>
          <dd className="font-medium">{role.title}</dd>
          <dt className="text-muted-foreground">Joining as</dt>
          <dd className="truncate">{email}</dd>
        </dl>
        {role.detail ? <p className="text-[13px] text-muted-foreground">{role.detail}</p> : null}
        {joinError ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive">
            {joinError}
          </p>
        ) : null}
        <Button className="h-10 w-full text-[14px]" disabled={joining} onClick={() => join(invitation)}>
          {joining ? "Joining" : `Join ${invitation.organizationName}`}
        </Button>
      </div>
    </>
  );
}

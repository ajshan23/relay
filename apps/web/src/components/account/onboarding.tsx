"use client";

import { FieldGroup } from "@relay/ui/components/field";
import { Form, FormError, FormField, useZodForm } from "@relay/ui/components/form";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { ApiError, api, type Me } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { AuthFooter, AuthFrame, AuthHeading, AuthLoading, authButton, authControl } from "./auth-frame";
import { authErrorMessage } from "./auth-helpers";

type Stage =
  | { step: "loading" }
  | { step: "business"; person: Person }
  | { step: "branch"; businessName: string };

/** Who is signing up: their current name, and whether it is only the placeholder taken from the email. */
type Person = { name: string; placeholder: boolean };

const noPerson: Person = { name: "", placeholder: true };

/**
 * First run after sign-up: name the business, then add its first branch, with a live preview
 * of the workspace beside the form. Skips what is already done; people with both go to Today.
 */
export function Onboarding() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ step: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadStart()
      .then((next) => {
        if (cancelled) return;
        if (next === "sign-in") router.replace("/sign-in?next=%2Fonboarding");
        else if (next === "done") router.replace("/today");
        else setStage(next);
      })
      .catch(() => {
        if (!cancelled) setStage({ step: "business", person: noPerson });
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <AuthFrame panel="onboarding">
      {stage.step === "loading" ? (
        <AuthLoading />
      ) : (
        <>
          {stage.step === "business" ? (
            <BusinessStep
              person={stage.person}
              onDone={(businessName) => setStage({ step: "branch", businessName })}
            />
          ) : (
            <BranchStep
              businessName={stage.businessName}
              onDone={() => {
                router.replace("/today");
                router.refresh();
              }}
            />
          )}
          <AuthFooter>
            <Progress step={stage.step === "business" ? 1 : 2} />
          </AuthFooter>
        </>
      )}
    </AuthFrame>
  );
}

/** "Step 1 of 2" with two short bars: the setup really is a sequence. */
function Progress({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <span className="text-[13px]">Step {step} of 2</span>
      <span className="flex w-16 gap-1" aria-hidden>
        {[1, 2].map((n) => (
          <span
            key={n}
            className={n <= step ? "h-1 flex-1 rounded-full bg-primary" : "h-1 flex-1 rounded-full bg-border"}
          />
        ))}
      </span>
    </div>
  );
}

/** Works out where to start from `/api/me`. */
async function loadStart(): Promise<"sign-in" | "done" | Stage> {
  let me: Me | null = null;
  try {
    me = await api<Me>("/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return "sign-in";
    // /api/me not reachable: fall back to the session so a signed-out visitor still lands on sign-in.
    const { data } = await authClient.getSession();
    if (!data) return "sign-in";
  }

  if (me?.organization) {
    if (me.branches.length > 0) return "done";
    return { step: "branch", businessName: me.organization.name };
  }

  // A business may exist without being the active one on this session (for example after signing in again).
  const { data: orgs } = await authClient.organization.list();
  const first = orgs?.[0];
  if (first) {
    await authClient.organization.setActive({ organizationId: first.id });
    return { step: "branch", businessName: first.name };
  }
  const name = me?.user.name ?? "";
  const placeholder = !name || name === me?.user.email.split("@")[0];
  return { step: "business", person: { name: placeholder ? "" : name, placeholder } };
}

/** "Rosa's Bakery" gives "rosas-bakery". */
function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "business";
}

const slugTaken = new Set(["ORGANIZATION_ALREADY_EXISTS", "ORGANIZATION_SLUG_ALREADY_TAKEN"]);

const businessSchema = z.object({
  person: z.string().trim().min(1, "Enter your name.").max(80, "Keep it under 80 characters."),
  name: z.string().trim().min(1, "Enter your business name.").max(80, "Keep it under 80 characters."),
});

/** Step 1: the person's name (sign-up only asks for email and password) and the business name. */
function BusinessStep({ person, onDone }: { person: Person; onDone: (name: string) => void }) {
  const form = useZodForm(businessSchema, { defaultValues: { person: person.name, name: "" } });

  return (
    <>
      <AuthHeading title="Set up your business" description="Two quick details. You can change both later." />
      <Form
        form={form}
        onSubmit={async ({ person: personName, name }) => {
          if (personName !== person.name) {
            const { error: nameError } = await authClient.updateUser({ name: personName });
            if (nameError) throw new Error(authErrorMessage(nameError));
          }
          const base = slugify(name);
          for (let attempt = 0; attempt < 4; attempt++) {
            const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
            const { data, error } = await authClient.organization.create({ name, slug });
            if (data) {
              // New businesses become active automatically; make sure of it before adding a branch.
              await authClient.organization.setActive({ organizationId: data.id });
              onDone(data.name);
              return;
            }
            if (!error?.code || !slugTaken.has(error.code)) throw new Error(authErrorMessage(error));
          }
          throw new Error("Couldn't save that name. Try a slightly different one.");
        }}
      >
        <FieldGroup>
          <FormField control={form.control} name="person" label="Your name">
            {({ field, control }) => (
              <TextInput
                {...field}
                {...control}
                className={authControl}
                autoFocus={!person.name}
                autoComplete="name"
                placeholder="Sara Malik"
              />
            )}
          </FormField>
          <FormField control={form.control} name="name" label="Business name">
            {({ field, control }) => (
              <TextInput
                {...field}
                {...control}
                className={authControl}
                autoFocus={!!person.name}
                autoComplete="organization"
                placeholder="Lumen Dental"
              />
            )}
          </FormField>
          <FormError />
          <Button type="submit" className={`mt-1 ${authButton}`}>
            {form.formState.isSubmitting ? "Saving" : "Continue"}
          </Button>
        </FieldGroup>
      </Form>
    </>
  );
}

const branchSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for this branch.").max(80, "Keep it under 80 characters."),
  timezone: z.string().min(1, "Choose a time zone."),
});

function timeZoneOptions(current: string) {
  const zones = Intl.supportedValuesOf("timeZone");
  const all = zones.includes(current) ? zones : [current, ...zones];
  return all.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ").replaceAll("/", " / ") }));
}

function BranchStep({ businessName, onDone }: { businessName: string; onDone: () => void }) {
  // Only rendered after mount, so reading the browser's time zone here can't cause a hydration mismatch.
  const defaultZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const options = useMemo(() => timeZoneOptions(defaultZone), [defaultZone]);
  const form = useZodForm(branchSchema, { defaultValues: { name: "", timezone: defaultZone } });

  return (
    <>
      <AuthHeading
        title="Add your first branch"
        description={`A clinic, shop or outlet of ${businessName}. With one location, use the area name.`}
      />
      <Form
        form={form}
        onSubmit={async ({ name, timezone }) => {
          try {
            await api("/branches", { method: "POST", json: { name, timezone } });
          } catch (err) {
            if (err instanceof ApiError && err.status === 403) {
              throw new Error("Only the owner or an admin can add branches. Ask them to add one.");
            }
            throw new Error("Couldn't add the branch. Try again.");
          }
          onDone();
        }}
      >
        <FieldGroup>
          <FormField control={form.control} name="name" label="Branch name">
            {({ field, control }) => (
              <TextInput {...field} {...control} className={authControl} autoFocus placeholder="Marina" />
            )}
          </FormField>
          <FormField
            control={form.control}
            name="timezone"
            label="Time zone"
            hint="Sets opening hours and the day your reports start."
          >
            {({ field, control }) => (
              <SelectField
                {...control}
                ref={field.ref}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                options={options}
                className={authControl}
              />
            )}
          </FormField>
          <FormError />
          <Button type="submit" className={`mt-1 ${authButton}`}>
            {form.formState.isSubmitting ? "Opening your workspace" : "Open my workspace"}
          </Button>
        </FieldGroup>
      </Form>
    </>
  );
}

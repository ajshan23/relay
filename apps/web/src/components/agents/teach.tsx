"use client";

import type { AgentSettings } from "@relay/core/agents";
import { Segmented } from "@relay/ui/components/choice";
import { Field, FieldGroup } from "@relay/ui/components/field";
import { Panel, Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Checkbox } from "@relay/ui/ui/checkbox";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useContactsMeta } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { api, type BranchMember } from "@/lib/api";
import { errorText } from "./agents-page";
import { type Agent, useAgentActions, useAgents } from "./queries";

/** Teach: who the agent is, its job in plain words, and when it hands a chat to the team. */

type Draft = Pick<
  AgentSettings,
  | "name"
  | "role"
  | "instructions"
  | "tone"
  | "languages"
  | "model"
  | "voiceNotes"
  | "photos"
  | "voiceReplies"
  | "handoff"
  | "editableFields"
>;

const tones = [
  { value: "friendly", label: "Friendly" },
  { value: "warm and caring", label: "Warm and caring" },
  { value: "professional", label: "Professional" },
  { value: "short and to the point", label: "Short and to the point" },
  { value: "cheerful", label: "Cheerful" },
];

const draftOf = (a: Agent): Draft => ({
  name: a.name,
  role: a.role,
  instructions: a.instructions,
  tone: a.tone,
  languages: a.languages,
  model: a.model,
  voiceNotes: a.voiceNotes ?? "accurate",
  photos: a.photos ?? "accurate",
  voiceReplies: a.voiceReplies ?? "off",
  handoff: a.handoff,
  editableFields: a.editableFields,
});

export function TeachView({
  agent,
  canManage,
  voiceReady = false,
}: {
  agent: Agent;
  canManage: boolean;
  /** A voice service is set up on the server. */
  voiceReady?: boolean;
}) {
  const { update } = useAgentActions();
  const starters = useAgents().data?.starters ?? [];
  const branch = useBranch().branch;
  const meta = useContactsMeta();
  const members = useQuery({
    queryKey: ["branch-members", branch.id],
    queryFn: () => api<{ members: BranchMember[] }>(`/branches/${branch.id}/members`).then((r) => r.members),
  });
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent));
  const [languages, setLanguages] = useState(agent.languages.join(", "));
  // A save elsewhere (or another person's) refreshes the form when nothing is being edited.
  const saved = useMemo(() => draftOf(agent), [agent]);
  const dirty = JSON.stringify({ ...draft, languages: splitLanguages(languages) }) !== JSON.stringify(saved);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved agent changes, not on every edit
  useEffect(() => {
    if (!dirty) {
      setDraft(saved);
      setLanguages(saved.languages.join(", "));
    }
  }, [saved]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const nameError = draft.name.trim() ? undefined : "Give your agent a name";
  const textFields = (meta.data?.fields ?? []).filter((f) =>
    ["text", "number", "date", "email", "phone"].includes(f.type),
  );

  const save = () =>
    update.mutate(
      { id: agent.id, ...draft, name: draft.name.trim(), languages: splitLanguages(languages) },
      {
        onSuccess: () =>
          notify.success("Saved", { description: `${draft.name.trim()} uses this from the next chat.` }),
        onError: (err) => notify.error("Not saved", { description: errorText(err) }),
      },
    );

  return (
    <div className="flex flex-col gap-8">
      <Section title="Who it is" description="How your agent introduces itself and sounds to customers.">
        <Panel>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" error={nameError} required>
                <TextInput
                  value={draft.name}
                  maxLength={40}
                  disabled={!canManage}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field label="Role" hint="One line, e.g. “Front desk” or “Sales assistant”." optional>
                <TextInput
                  value={draft.role}
                  maxLength={120}
                  disabled={!canManage}
                  onChange={(e) => set("role", e.target.value)}
                />
              </Field>
              <Field label="Tone">
                <SelectField
                  options={
                    tones.some((t) => t.value === draft.tone)
                      ? tones
                      : [...tones, { value: draft.tone, label: draft.tone }]
                  }
                  value={draft.tone}
                  disabled={!canManage}
                  onValueChange={(v) => set("tone", v)}
                />
              </Field>
              <Field
                label="Languages"
                hint="Leave empty to reply in whatever language the customer writes. Or list them: English, Hindi, Arabic."
                optional
              >
                <TextInput
                  value={languages}
                  disabled={!canManage}
                  placeholder="Customer's language"
                  onChange={(e) => setLanguages(e.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
        </Panel>
      </Section>

      <Section
        title="Its job"
        description="Write it like you'd brief a new team member: what to help with, what to ask, what never to do."
        actions={
          canManage ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] text-muted-foreground">Start from:</span>
              {starters.map((s) => (
                <Button
                  key={s.id}
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setDraft((d) => ({ ...d, instructions: s.instructions, role: d.role || s.role }))
                  }
                >
                  {s.label}
                </Button>
              ))}
            </div>
          ) : null
        }
      >
        <Panel>
          <Field
            label="Instructions"
            hideLabel
            hint="Your agent answers facts (prices, timings) from its knowledge, not from here."
          >
            <TextArea
              value={draft.instructions}
              minRows={8}
              maxRows={20}
              maxLength={8000}
              disabled={!canManage}
              placeholder="e.g. Greet customers, answer questions about our treatments and prices, and when someone wants an appointment ask for their preferred day and time, then hand the chat to the team."
              onChange={(e) => set("instructions", e.target.value)}
            />
          </Field>
        </Panel>
      </Section>

      <Section
        title="Handing over to your team"
        description="It always hands over when a customer asks for a person, is upset, or asks something it doesn't know."
      >
        <Panel>
          <FieldGroup>
            <Field
              label="Also hand over when"
              optional
              hint="e.g. “Anyone asking about a refund or a complaint.”"
            >
              <TextArea
                value={draft.handoff.when}
                minRows={2}
                maxLength={1000}
                disabled={!canManage}
                onChange={(e) => set("handoff", { ...draft.handoff, when: e.target.value })}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Give the chat to">
                <SelectField
                  options={[
                    { value: "", label: "Anyone on the team (unassigned)" },
                    ...(members.data ?? []).map((m) => ({ value: m.userId, label: m.name })),
                  ]}
                  value={draft.handoff.assignToUserId ?? ""}
                  disabled={!canManage}
                  onValueChange={(v) => set("handoff", { ...draft.handoff, assignToUserId: v || null })}
                />
              </Field>
              <Field
                label="Message to the customer"
                optional
                hint="Sent as it steps back. Leave empty to say nothing."
              >
                <TextInput
                  value={draft.handoff.message}
                  maxLength={500}
                  disabled={!canManage}
                  onChange={(e) => set("handoff", { ...draft.handoff, message: e.target.value })}
                />
              </Field>
            </div>
          </FieldGroup>
        </Panel>
      </Section>

      <Section
        title="Contact details it may save"
        description="When a customer tells it these, your agent fills them in on their contact card."
      >
        <Panel>
          {textFields.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {textFields.map((f) => {
                const on = draft.editableFields.includes(f.key);
                return (
                  <label key={f.key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={on}
                      disabled={!canManage}
                      onCheckedChange={(v) =>
                        set(
                          "editableFields",
                          v
                            ? [...draft.editableFields, f.key]
                            : draft.editableFields.filter((k) => k !== f.key),
                        )
                      }
                    />
                    {f.label}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Your contacts have no custom fields yet. Add some in Contacts to let your agent fill them in.
            </p>
          )}
        </Panel>
      </Section>

      <Section
        title="Thinking"
        description="Fast suits most businesses. Smart thinks harder and costs more per reply."
      >
        <Segmented
          aria-label="Model"
          value={draft.model}
          disabled={!canManage}
          onChange={(v) => set("model", v)}
          options={[
            { value: "fast", label: "Fast" },
            { value: "smart", label: "Smart" },
          ]}
          className="self-start"
        />
      </Section>

      <Section
        title="Voice notes"
        description="Turn customers' voice notes into text so your agent can answer them. Your team sees the text under each voice note too."
      >
        <Segmented
          aria-label="Voice notes"
          value={draft.voiceNotes}
          disabled={!canManage}
          onChange={(v) => set("voiceNotes", v)}
          options={[
            { value: "off", label: "Off" },
            { value: "accurate", label: "Accurate" },
            { value: "best", label: "More accurate" },
          ]}
          className="self-start"
        />
        <p className="text-[13px] text-muted-foreground">
          {draft.voiceNotes === "off"
            ? "Your agent asks customers to type instead."
            : draft.voiceNotes === "best"
              ? "Better with accents, noise and mixed languages. 2 credits per minute of audio. Notes over 3 minutes aren't heard."
              : "Good for most voice notes. 1 credit per minute of audio. Notes over 3 minutes aren't heard."}
        </p>
      </Section>

      <Section
        title="Photos"
        description="Let your agent look at photos customers send, like a product they want or a screenshot, and find it in your catalogue. Your team sees what it saw under each photo too."
      >
        <Segmented
          aria-label="Photos"
          value={draft.photos}
          disabled={!canManage}
          onChange={(v) => set("photos", v)}
          options={[
            { value: "off", label: "Off" },
            { value: "accurate", label: "Accurate" },
            { value: "best", label: "More accurate" },
          ]}
          className="self-start"
        />
        <p className="text-[13px] text-muted-foreground">
          {draft.photos === "off"
            ? "Your agent asks customers to describe what they need."
            : draft.photos === "best"
              ? "Better at small text, model numbers and prices. 2 credits per photo."
              : "Good for most photos. 1 credit per photo."}
        </p>
      </Section>

      <Section
        title="Reply with voice"
        description="Let your agent answer with a WhatsApp voice note in your chosen voice, in English, Arabic or Hindi. Cards, buttons and hand-overs stay as they are."
      >
        <Segmented
          aria-label="Reply with voice"
          value={draft.voiceReplies}
          disabled={!canManage || !voiceReady}
          onChange={(v) => set("voiceReplies", v)}
          options={[
            { value: "off", label: "Off" },
            { value: "voice_notes", label: "To voice notes" },
            { value: "always", label: "Always" },
          ]}
          className="self-start"
        />
        <p className="text-[13px] text-muted-foreground">
          {!voiceReady
            ? "Voice replies aren't set up on this server yet."
            : draft.voiceReplies === "off"
              ? "Your agent always replies in text."
              : draft.voiceReplies === "voice_notes"
                ? "When a customer sends a voice note, your agent answers with one. 1 extra credit per voice reply."
                : "Your agent answers every message with a voice note, and adds the text when it has a link or a long number. 1 extra credit per voice reply."}
        </p>
      </Section>

      {canManage ? (
        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
          {dirty ? <span className="mr-auto text-[13px] text-muted-foreground">Unsaved changes</span> : null}
          <Button
            variant="ghost"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setDraft(saved);
              setLanguages(saved.languages.join(", "));
            }}
          >
            Discard
          </Button>
          <Button disabled={!dirty || !!nameError || update.isPending} onClick={save}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function splitLanguages(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

"use client";

import type { AutomationDefinition, RunRules } from "@relay/core/automations";
import { Segmented, SwitchRow } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { SelectField } from "@relay/ui/components/select-field";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Textarea } from "@relay/ui/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError } from "@/lib/api";
import { type AutomationSummary, automationKeys, type BranchNumber, type SaveBody } from "./queries";

/** Name, number, and the run rules (who may enter, when a run stops). Rules publish with the steps. */
export function AutomationSettings({
  automation,
  def,
  numbers,
  readOnly,
  onRules,
  saveDetails,
}: {
  automation: AutomationSummary;
  def: AutomationDefinition;
  numbers: BranchNumber[];
  readOnly: boolean;
  onRules: (rules: RunRules) => void;
  /** The editor's save queue (one save at a time, so details and draft saves never collide). */
  saveDetails: (body: Omit<SaveBody, "revision">) => Promise<unknown>;
}) {
  const [name, setName] = useState(automation.name);
  const [description, setDescription] = useState(automation.description ?? "");
  const [number, setNumber] = useState(automation.channelAccountId ?? "");
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  const { branch } = useBranch();
  const rules = def.rules;
  const setRule = (patch: Partial<RunRules>) => onRules({ ...rules, ...patch });

  // A live automation keeps its number: the trigger and every waiting run use it, and its templates
  // are picked per number. Pause it to move it to another number (it's checked again on resume).
  const numberLocked = automation.status === "live";
  const numberChanged = number !== (automation.channelAccountId ?? "");

  const save = async () => {
    setSaving(true);
    try {
      await saveDetails({
        name,
        description: description || null,
        channelAccountId: numberChanged && !numberLocked ? number || undefined : undefined,
      });
      notify.success("Saved");
      qc.invalidateQueries({ queryKey: automationKeys.one(branch.id, automation.id) });
      // Templates (and their status) are per number.
      if (numberChanged) qc.invalidateQueries({ queryKey: automationKeys.options(branch.id, automation.id) });
    } catch (err) {
      notify.error("Not saved", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 overflow-y-auto px-6 py-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Details</h2>
        <fieldset disabled={readOnly} className="flex flex-col gap-4">
          <Field label="Name">
            <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" optional>
            <Textarea
              rows={2}
              value={description}
              maxLength={300}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field
            label="WhatsApp number"
            hint={
              numberLocked
                ? "It's live on this number. Pause it to move it to another number."
                : "The trigger listens on this number and every step sends from it. Two numbers need two automations."
            }
          >
            <SelectField
              disabled={numberLocked}
              value={number}
              onValueChange={setNumber}
              placeholder="Pick a number"
              options={numbers.map((n) => ({
                value: n.id,
                label: `${n.displayName}${n.displayPhone ? ` · ${n.displayPhone}` : ""}`,
              }))}
            />
          </Field>
          <Button className="self-start" onClick={() => void save()} disabled={saving || !name.trim()}>
            Save details
          </Button>
        </fieldset>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">Who enters</h2>
          <p className="text-sm text-muted-foreground">Saved with the draft; they apply once you publish.</p>
        </div>
        <fieldset disabled={readOnly} className="flex flex-col divide-y">
          <div className="flex flex-col gap-2 py-2.5">
            <span className="text-sm font-medium">A contact can go through it</span>
            <Segmented
              aria-label="Re-entry"
              value={rules.reentry}
              onChange={(reentry) =>
                setRule({
                  reentry,
                  cooldownHours: reentry === "cooldown" ? (rules.cooldownHours ?? 24) : undefined,
                })
              }
              options={[
                { value: "every_time", label: "Every time" },
                { value: "once", label: "Only once" },
                { value: "cooldown", label: "Once every…" },
              ]}
            />
            {rules.reentry === "cooldown" ? (
              <div className="flex items-center gap-2 text-sm">
                <TextInput
                  type="number"
                  min={1}
                  className="w-24"
                  size="sm"
                  aria-label="Hours"
                  value={rules.cooldownHours ?? 24}
                  onChange={(e) => setRule({ cooldownHours: Math.max(1, Number(e.target.value) || 1) })}
                />
                hours
              </div>
            ) : null}
          </div>
          <SwitchRow
            label="Not while they're in another automation"
            description="So two automations never talk to the same person at once."
            checked={rules.skipIfInAnotherRun}
            onCheckedChange={(v) => setRule({ skipIfInAnotherRun: v })}
          />
          <SwitchRow
            label="Not when a team member is assigned to the chat"
            checked={rules.skipIfAssigned}
            onCheckedChange={(v) => setRule({ skipIfAssigned: v })}
          />
        </fieldset>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">How it writes</h2>
        <fieldset disabled={readOnly} className="flex flex-col divide-y">
          <SwitchRow
            label="Show “typing…” before each message"
            description="Customers see it typing for a moment (1–4 seconds, longer for longer messages), like a person. It also marks their last message as read, so it only shows when read receipts are on for this number."
            checked={rules.typing !== false}
            onCheckedChange={(v) => setRule({ typing: v })}
          />
        </fieldset>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">When it stops</h2>
        <fieldset disabled={readOnly} className="flex flex-col divide-y">
          <SwitchRow
            label="When a team member replies in the chat"
            description="The person takes over; the automation stops."
            checked={rules.stopOnAgentReply}
            onCheckedChange={(v) => setRule({ stopOnAgentReply: v })}
          />
          <SwitchRow
            label="When the contact opts out (STOP)"
            checked={rules.stopOnOptOut}
            onCheckedChange={(v) => setRule({ stopOnOptOut: v })}
          />
        </fieldset>
      </section>
    </div>
  );
}

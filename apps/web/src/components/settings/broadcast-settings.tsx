"use client";

import { Panel, Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { notify } from "@relay/ui/components/toast";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import {
  type BroadcastRules,
  useBroadcastRules,
  useSaveBroadcastRules,
} from "@/components/broadcasts/queries";
import { ApiError } from "@/lib/api";

/**
 * Settings → Broadcasts: rules for every broadcast in the business, checked as each message goes out.
 * Owners and admins change them; everyone else sees them.
 */
export function BroadcastSettings() {
  const data = useBroadcastRules();
  const save = useSaveBroadcastRules();
  if (!data.data) return <Skeleton className="h-48 w-full" />;
  const { rules, canEdit } = data.data;
  const change = (patch: Partial<BroadcastRules>) =>
    save.mutate(
      { ...rules, ...patch },
      {
        onSuccess: () => notify.success("Saved"),
        onError: (err) =>
          notify.error("Couldn't save", { description: err instanceof ApiError ? err.message : undefined }),
      },
    );

  return (
    <Section
      title="Broadcasts"
      description="Rules every broadcast follows, so customers aren't flooded and your team isn't interrupted."
    >
      <Panel padding="lg" className="flex flex-col divide-y">
        <div className="flex flex-col gap-3 pb-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Limit marketing messages per person</span>
              <span className="block max-w-xl text-xs text-muted-foreground">
                Across all broadcasts, in any 7 days. People who reached it are skipped. Update messages
                (appointments, orders) aren't counted or limited.
              </span>
            </span>
            <Switch
              checked={rules.frequencyCap !== null}
              disabled={!canEdit || save.isPending}
              onCheckedChange={(on) => change({ frequencyCap: on ? 2 : null })}
              aria-label="Limit marketing messages per person"
            />
          </label>
          {rules.frequencyCap !== null ? (
            <div className="flex items-center gap-2 text-sm">
              At most
              <SelectField
                aria-label="Marketing messages per 7 days"
                value={String(rules.frequencyCap)}
                disabled={!canEdit || save.isPending}
                onValueChange={(v) => change({ frequencyCap: Number(v) })}
                options={[1, 2, 3, 4, 5, 7, 10].map((n) => ({
                  value: String(n),
                  label: `${n} message${n > 1 ? "s" : ""}`,
                }))}
                className="w-36"
              />
              every 7 days
            </div>
          ) : null}
        </div>
        <label className="flex items-center justify-between gap-4 pt-5">
          <span>
            <span className="block text-sm font-medium">Skip people in a live chat</span>
            <span className="block max-w-xl text-xs text-muted-foreground">
              Someone whose open chat is assigned to a teammate doesn't get a broadcast in the middle of that
              conversation.
            </span>
          </span>
          <Switch
            checked={rules.skipLiveChats}
            disabled={!canEdit || save.isPending}
            onCheckedChange={(skipLiveChats) => change({ skipLiveChats })}
            aria-label="Skip people in a live chat"
          />
        </label>
        {!canEdit ? (
          <p className="pt-4 text-xs text-muted-foreground">Only owners and admins can change these.</p>
        ) : null}
      </Panel>
    </Section>
  );
}

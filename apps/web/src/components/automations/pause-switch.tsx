"use client";

import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Switch } from "@relay/ui/ui/switch";
import { ApiError } from "@/lib/api";
import { type AutomationStatus, useAutomationAction } from "./queries";

/*
 * Pause and resume an automation where people look for it: a switch on each row of the list and a
 * button in the editor's header. Pausing stops new runs; runs already in chats finish (stop one from
 * its chat or the Runs tab). Resuming checks the live version again (number, problems).
 */

type Props = { id: string; name: string; status: AutomationStatus; hasLiveVersion: boolean };

function usePauseToggle({ id, name, status }: Props) {
  const action = useAutomationAction(id);
  const live = status === "live";
  const toggle = () =>
    action.mutate(live ? "pause" : "resume", {
      onSuccess: () =>
        live
          ? notify.success(`${name} is paused`, {
              description: "No new runs start. Runs already in chats finish.",
            })
          : notify.success(`${name} is live again`),
      onError: (err) =>
        notify.error(live ? "Not paused" : "Not resumed", {
          description: err instanceof ApiError ? err.message : undefined,
        }),
    });
  return { live, toggle, busy: action.isPending };
}

/** For the list: an on/off switch, shown only once the automation has been published. */
export function PauseSwitch(props: Props) {
  const { live, toggle, busy } = usePauseToggle(props);
  if (!props.hasLiveVersion || (props.status !== "live" && props.status !== "paused")) return null;
  return (
    <Switch
      checked={live}
      disabled={busy}
      onCheckedChange={toggle}
      aria-label={live ? `Pause ${props.name}` : `Resume ${props.name}`}
    />
  );
}

/** For the editor header: a Pause / Resume button. */
export function PauseButton(props: Props) {
  const { live, toggle, busy } = usePauseToggle(props);
  if (!props.hasLiveVersion || (props.status !== "live" && props.status !== "paused")) return null;
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={toggle}>
      {live ? "Pause" : "Resume"}
    </Button>
  );
}

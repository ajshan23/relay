"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";

type Ready = { ok: boolean; checks: { postgres: boolean; redis: boolean } };
type State = { kind: "loading" } | { kind: "down" } | { kind: "up"; ready: Ready };

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3201";

function Row({ label, ok }: { label: string; ok: boolean | undefined }) {
  return (
    <li className="flex items-center justify-between py-2 text-sm">
      <span>{label}</span>
      {ok === undefined ? (
        <Badge variant="outline">Checking</Badge>
      ) : ok ? (
        <Badge variant="secondary">Connected</Badge>
      ) : (
        <Badge variant="destructive">Not reachable</Badge>
      )}
    </li>
  );
}

export function SystemStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/health/ready`)
      .then((res) => res.json() as Promise<Ready>)
      .then((ready) => !cancelled && setState({ kind: "up", ready }))
      .catch(() => !cancelled && setState({ kind: "down" }));
    return () => {
      cancelled = true;
    };
  }, []);

  const api = state.kind === "loading" ? undefined : state.kind === "up";
  const checks = state.kind === "up" ? state.ready.checks : undefined;
  const dependent = (value: boolean | undefined) => (state.kind === "down" ? false : value);

  return (
    <ul className="divide-y">
      <Row label="API" ok={api} />
      <Row label="Database" ok={dependent(checks?.postgres)} />
      <Row label="Queue" ok={dependent(checks?.redis)} />
    </ul>
  );
}

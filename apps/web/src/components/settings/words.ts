import type { SelectOption } from "@relay/ui/components/select-field";
import { ApiError, type OrgRole } from "@/lib/api";

export const orgRoleLabel: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** Turns a failed call into a short sentence for a toast or form. */
export function errorText(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "forbidden":
        return err.message && err.message !== err.code
          ? err.message
          : "You don't have permission to do that.";
      case "not_found":
        return "That branch is no longer here. Refresh the page.";
      case "last_branch":
        return "This is your only branch. Add another branch before you archive this one.";
      case "not_in_organization":
        return "That person is not in your team any more.";
      case "invalid_input":
        return err.message && err.message !== err.code ? err.message : "Check the details and try again.";
      case "no_active_organization":
        return "Pick a business first.";
      default:
        return err.message && err.message !== err.code ? err.message : fallback;
    }
  }
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection.";
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** "America/New_York" reads as "New York · America", so typing a city finds it in the list. */
export function timezoneLabel(tz: string): string {
  const parts = tz.replaceAll("_", " ").split("/");
  if (parts.length < 2) return parts[0] ?? tz;
  const [region, ...place] = parts;
  return `${place.join(" / ")} · ${region}`;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every timezone the browser knows, plus `include` if it is missing from that list (for example "UTC"). */
export function timezoneOptions(include: string[] = []): SelectOption[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const all = Array.from(new Set([...zones, ...include.filter(Boolean)]));
  return all
    .map((tz) => ({ value: tz, label: timezoneLabel(tz) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Better Auth client calls resolve to `{ data, error }` instead of throwing.
 * This unwraps them so callers can use try/catch like everywhere else.
 */
export async function unwrap<T>(
  call: Promise<{ data: T | null; error: { message?: string; status?: number } | null }>,
): Promise<T> {
  const { data, error } = await call;
  if (error) throw new Error(error.message || "Something went wrong. Try again.");
  return data as T;
}

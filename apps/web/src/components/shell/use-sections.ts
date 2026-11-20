"use client";

import type { Permission } from "@relay/core/permissions";
import { useMe } from "@/lib/me";
import { useBranch } from "./branch-context";
import type { SectionId } from "./nav-config";

/** A section shows when they hold any of these in the branch they're looking at. */
const sectionNeeds: Partial<Record<SectionId, Permission[]>> = {
  conversations: ["chats.view", "chats.view_unassigned", "chats.view_all"],
  contacts: ["contacts.view"],
  agents: ["agent.view"],
  automations: ["automations.view"],
  broadcasts: ["broadcasts.view"],
};

/** Which sections of the app this person can open in the active branch. */
export function useSectionAccess() {
  const { can } = useMe();
  const { branch } = useBranch();
  return (id: SectionId) => {
    const needs = sectionNeeds[id];
    return !needs || needs.some((p) => can(p, branch?.id));
  };
}

/** Settings pages: shown when they can use them (each page still checks for itself). */
export const settingsNeeds: Record<string, Permission[] | undefined> = {
  "/settings/team": ["team.view"],
  "/settings/roles": ["team.view"],
  "/settings/usage": ["usage.view"],
  "/settings/channels": ["numbers.view"],
  "/settings/templates": ["templates.view"],
};

export function useSettingsAccess() {
  const { canAnywhere } = useMe();
  return (href: string) => {
    const needs = settingsNeeds[href];
    return !needs || needs.some((p) => canAnywhere(p));
  };
}

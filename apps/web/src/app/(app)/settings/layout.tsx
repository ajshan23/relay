import { PageHeader } from "@relay/ui/components/page-header";
import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl pb-12">
      <PageHeader title="Settings" description="Your branches and the people who work in them." />
      <SettingsTabs />
      <div className="px-5 pt-6 sm:px-8">{children}</div>
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import { useAiUsage } from "../../../../components/app/settings/use-ai-usage";
import { UsageSection } from "../../../../components/app/settings/usage-section";
import { Intro, Page } from "@pistachio/web-account";

export default function UsageSettingsPage(): ReactNode {
  const { usage, error } = useAiUsage();
  return (
    <Page>
      <Intro title="Model usage" lede="What the agent, memory search, and read-aloud have spent through your account, on every device." />
      <UsageSection usage={usage} error={error} />
    </Page>
  );
}

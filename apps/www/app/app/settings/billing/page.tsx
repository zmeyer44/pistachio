"use client";

import type { ReactNode } from "react";
import { BillingSection } from "../../../../components/app/settings/billing-section";
import { useAiUsage } from "../../../../components/app/settings/use-ai-usage";
import { Intro, Page } from "@pistachio/web-account";

export default function BillingSettingsPage(): ReactNode {
  const { usage, setUsage } = useAiUsage();
  return (
    <Page>
      <Intro title="Plan & billing" lede="Model usage is included with your account. Put your own monthly ceiling on it here." />
      <BillingSection usage={usage} onUsage={setUsage} />
    </Page>
  );
}

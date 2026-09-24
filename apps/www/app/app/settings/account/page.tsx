"use client";

import type { ReactNode } from "react";
import { AccountSection } from "../../../../components/app/settings/account-section";
import { Intro, Page } from "@pistachio/web-account";

export default function AccountSettingsPage(): ReactNode {
  return (
    <Page>
      <Intro title="Account" lede="What the control plane knows about you, your password, and this browser's place among your devices." />
      <AccountSection />
    </Page>
  );
}

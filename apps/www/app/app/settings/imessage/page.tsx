"use client";

import type { ReactNode } from "react";
import { IMessageSection } from "../../../../components/app/settings/imessage-section";
import { Intro, Page } from "@pistachio/web-account";

export default function IMessageSettingsPage(): ReactNode {
  return (
    <Page>
      <Intro title="iMessage" lede="Get agent questions and finished results by text, and answer them by replying." />
      <IMessageSection />
    </Page>
  );
}

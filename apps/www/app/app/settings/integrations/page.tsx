"use client";

import type { ReactNode } from "react";
import { IntegrationsSection } from "../../../../components/app/settings/integrations-section";
import { Intro, Page } from "@pistachio/web-account";

export default function IntegrationsSettingsPage(): ReactNode {
  return (
    <Page>
      <Intro
        title="Integrations"
        lede="Apps the agent may use directly through their API — Gmail and Google Calendar — with a grant you gave once on your Mac."
      />
      <IntegrationsSection />
    </Page>
  );
}

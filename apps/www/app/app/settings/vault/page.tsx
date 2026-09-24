"use client";

import type { ReactNode } from "react";
import { VaultSection } from "../../../../components/app/settings/vault-section";
import { Intro, Page } from "@pistachio/web-account";

export default function VaultSettingsPage(): ReactNode {
  return (
    <Page>
      <Intro
        title="Vault"
        lede="Sign-in details and other sensitive values the agent may type for you, without ever seeing them."
      />
      <VaultSection />
    </Page>
  );
}
